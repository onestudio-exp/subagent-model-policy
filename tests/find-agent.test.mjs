import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, readAgentPolicy } from '../hooks/lib/find-agent.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'smp-agent-'));

function writeAgent(root, scopeRel, name, frontmatter) {
  const dir = join(root, scopeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody text.\n`);
}

// Plugin cache layout: <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/<kind>/<name>.md
function writePluginFile(home, marketplace, plugin, version, kind, name, frontmatter) {
  const dir = join(home, '.claude', 'plugins', 'cache', marketplace, plugin, version, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody text.\n`);
}

test('parseFrontmatter reads key/value pairs and strips trailing comments', () => {
  const fm = parseFrontmatter('---\nname: x\nmodel: haiku   # deliberate\n---\nbody');
  assert.equal(fm.name, 'x');
  assert.equal(fm.model, 'haiku');
});

test('parseFrontmatter returns null when there is no frontmatter block', () => {
  assert.equal(parseFrontmatter('no frontmatter here'), null);
  assert.equal(parseFrontmatter(''), null);
});

// --- Spec section 4 truth table -------------------------------------------

test('row 1: `pinned` plus a model is pinned', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'scanner', 'name: scanner\nmodel: haiku\nmodel-policy: pinned');
  const got = readAgentPolicy('scanner', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'haiku', pinned: true });
});

test('row 2: no model-policy key is subject to policy', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'copied', 'name: copied\nmodel: sonnet');
  const got = readAgentPolicy('copied', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'sonnet', pinned: false });
});

test('row 3: an unrecognised model-policy value is subject to policy', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'typo', 'name: typo\nmodel: sonnet\nmodel-policy: pined');
  assert.equal(readAgentPolicy('typo', root, root).pinned, false);
});

test('row 4: `pinned` with no model is subject to policy — nothing to pin', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'empty', 'name: empty\nmodel-policy: pinned');
  const got = readAgentPolicy('empty', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: null, pinned: false });
});

test('the pinned value is trimmed and case-insensitive', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'shouty', 'name: shouty\nmodel: haiku\nmodel-policy:   PINNED  ');
  assert.equal(readAgentPolicy('shouty', root, root).pinned, true);
});

test('a pin is recognised when the model is written as a full ID', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'full', 'name: full\nmodel: claude-haiku-4-5-20251001\nmodel-policy: pinned');
  const got = readAgentPolicy('full', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'haiku', pinned: true });
});

// --- Scope resolution ------------------------------------------------------

test('project scope outranks user scope', () => {
  const root = tmp();
  const home = tmp();
  writeAgent(root, '.claude/agents', 'dup', 'name: dup\nmodel: sonnet');
  writeAgent(home, '.claude/agents', 'dup', 'name: dup\nmodel: opus');
  assert.equal(readAgentPolicy('dup', root, home).model, 'sonnet');
});

test('user scope is found when the project has no such agent', () => {
  const root = tmp();
  const home = tmp();
  writeAgent(home, '.claude/agents', 'userly', 'name: userly\nmodel: opus');
  assert.equal(readAgentPolicy('userly', root, home).model, 'opus');
});

test('agents nested in subdirectories are found', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents/team', 'nested', 'name: nested\nmodel: sonnet');
  assert.equal(readAgentPolicy('nested', root, root).model, 'sonnet');
});

test('a missing definition returns null so the caller fails open', () => {
  const root = tmp();
  assert.equal(readAgentPolicy('does-not-exist', root, root), null);
  assert.equal(readAgentPolicy('Explore', root, root), null, 'built-ins have no file on disk');
});

test('a blank or non-string subagent type returns null without throwing', () => {
  const root = tmp();
  assert.equal(readAgentPolicy('', root, root), null);
  assert.equal(readAgentPolicy(undefined, root, root), null);
});

// --- Plugin cache scope (spec §7, scope 3) ---------------------------------

test('plugin scope: an agent under a plugin cache agents/ directory resolves', () => {
  const root = tmp();
  const home = tmp();
  writePluginFile(home, 'marketplace-a', 'plugin-a', '1.0.0', 'agents', 'reviewer', 'name: reviewer\nmodel: opus');
  const got = readAgentPolicy('reviewer', root, home);
  assert.equal(got.model, 'opus');
});

test('plugin scope: a same-named file under commands/ is never mistaken for the one under agents/', () => {
  const root = tmp();
  const home = tmp();
  writePluginFile(home, 'marketplace-a', 'plugin-a', '1.0.0', 'commands', 'reviewer', 'name: reviewer-command\nmodel: opus');
  assert.equal(readAgentPolicy('reviewer', root, home), null, 'a commands/ file alone must never be read as an agent');

  writePluginFile(home, 'marketplace-a', 'plugin-a', '1.0.0', 'agents', 'reviewer', 'name: reviewer\nmodel: haiku');
  const got = readAgentPolicy('reviewer', root, home);
  assert.equal(got.model, 'haiku', 'the commands/ file must not shadow the agents/ one once both exist');
});

test('plugin scope: a plugin-qualified lookup resolves to that plugin, not a same-named agent in another plugin', () => {
  const root = tmp();
  const home = tmp();
  writePluginFile(home, 'marketplace-a', 'plugin-a', '1.0.0', 'agents', 'scanner', 'name: scanner\nmodel: haiku');
  writePluginFile(home, 'marketplace-a', 'plugin-b', '1.0.0', 'agents', 'scanner', 'name: scanner\nmodel: opus');

  assert.equal(readAgentPolicy('plugin-a:scanner', root, home).model, 'haiku');
  assert.equal(readAgentPolicy('plugin-b:scanner', root, home).model, 'opus');
});

test('plugin scope: a bare, unqualified name resolves when it exists only in the plugin cache', () => {
  const root = tmp();
  const home = tmp();
  writePluginFile(home, 'marketplace-a', 'solo-plugin', '2.0.0', 'agents', 'lonely', 'name: lonely\nmodel: sonnet');
  assert.equal(readAgentPolicy('lonely', root, home).model, 'sonnet');
});
