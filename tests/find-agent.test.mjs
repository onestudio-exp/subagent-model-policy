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

// --- M5: built-ins short-circuit before any filesystem walk ----------------

test('every known built-in short-circuits to null without touching the filesystem', () => {
  const root = tmp();
  const home = tmp();
  for (const name of ['Explore', 'Plan', 'general-purpose', 'claude', 'statusline-setup']) {
    assert.equal(readAgentPolicy(name, root, home), null);
    // Case-insensitive: matching either case is strictly safer than under-matching.
    assert.equal(readAgentPolicy(name.toUpperCase(), root, home), null);
  }
});

test('a plugin-qualified name sharing a built-in\'s name is not short-circuited — it is a real agent', () => {
  const root = tmp();
  const home = tmp();
  writePluginFile(home, 'marketplace-a', 'some-plugin', '1.0.0', 'agents', 'Explore', 'name: Explore\nmodel: haiku');
  const got = readAgentPolicy('some-plugin:Explore', root, home);
  assert.equal(got?.model, 'haiku', 'a plugin: qualified lookup must still resolve normally, even for a built-in-like name');
});

test('a project-scope agent file named after a built-in resolves normally, not short-circuited', () => {
  const root = tmp();
  const home = tmp();
  writeAgent(root, '.claude/agents', 'claude', 'name: claude\nmodel: haiku');
  const got = readAgentPolicy('claude', root, home);
  assert.notEqual(got, null, 'a real on-disk file must win over the built-in short-circuit');
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'haiku', pinned: false });
  assert.ok(got.path, 'path must be populated, never a partial object');
});

test('a user-scope agent file named after a built-in resolves normally, not short-circuited', () => {
  const root = tmp();
  const home = tmp();
  writeAgent(home, '.claude/agents', 'Plan', 'name: Plan\nmodel: haiku');
  const got = readAgentPolicy('Plan', root, home);
  assert.notEqual(got, null, 'a real on-disk file must win over the built-in short-circuit');
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'haiku', pinned: false });
  assert.ok(got.path, 'path must be populated, never a partial object');
});

test('a built-in name with no file anywhere still returns null', () => {
  const root = tmp();
  const home = tmp();
  assert.equal(readAgentPolicy('claude', root, home), null);
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

test('plugin scope: a qualifier naming a plugin absent from the cache returns null, even when a same-named agent exists under a different plugin', () => {
  const root = tmp();
  const home = tmp();
  // No "ghost" plugin exists anywhere in the cache, but "reviewer" exists
  // under an unrelated plugin. A qualified lookup for ghost:reviewer must
  // never fall back to that arbitrary match — if the real agent is pinned
  // and this unrelated one is not, that fallback would silently override
  // the pin (spec §3 non-goal: "does not override explicitly pinned agents").
  writePluginFile(home, 'mkt', 'other-plugin', '1.0.0', 'agents', 'reviewer', 'name: reviewer\nmodel: opus');
  assert.equal(readAgentPolicy('ghost:reviewer', root, home), null,
    'an unresolved qualifier must fail open (null), never resolve to an arbitrary same-named agent');
});

test('plugin scope: qualifier matches the plugin segment specifically, not a marketplace merely named after another plugin', () => {
  const root = tmp();
  const home = tmp();
  // A marketplace that happens to be named "plugin-b", hosting an unrelated
  // plugin "plugin-a" — the string "plugin-b" appears in this path, but only
  // as the marketplace segment, never as the plugin segment. Named so it
  // sorts (and so is enumerated) ahead of the marketplace below on this
  // filesystem's directory order — confirmed empirically — so a check that
  // merely tested "does 'plugin-b' appear anywhere in the path" would return
  // this wrong match first, rather than passing by enumeration-order luck.
  writePluginFile(home, 'plugin-b', 'plugin-a', '1.0.0', 'agents', 'scanner', 'name: scanner\nmodel: sonnet');
  // The real "plugin-b" plugin, shipped under an unrelated marketplace name.
  writePluginFile(home, 'unrelated-marketplace', 'plugin-b', '1.0.0', 'agents', 'scanner', 'name: scanner\nmodel: haiku');

  const got = readAgentPolicy('plugin-b:scanner', root, home);
  assert.equal(got.model, 'haiku', 'must resolve to the real plugin-b plugin, not a marketplace merely named plugin-b');
  assert.ok(
    got.path.includes(join('unrelated-marketplace', 'plugin-b')),
    `expected path to run through unrelated-marketplace/plugin-b, got ${got.path}`,
  );
});
