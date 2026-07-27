import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'skills/subagent-model-policy/SKILL.md'), 'utf8');

test('the skill has valid frontmatter with name and description', () => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
  assert.ok(fm, 'SKILL.md must open with a frontmatter block');
  assert.match(fm[1], /^name:\s*subagent-model-policy$/m);
  assert.match(fm[1], /^description:\s*\S/m);
});

test('the skill documents the exact opt-out syntax', () => {
  assert.match(skill, /model-policy:\s*pinned/);
});

test('the skill states that it does not enforce the policy itself', () => {
  assert.match(skill, /hook/i);
  assert.match(skill, /does not enforce|enforces nothing|not the enforcement/i);
});
