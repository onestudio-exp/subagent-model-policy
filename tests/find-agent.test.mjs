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
