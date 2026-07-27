import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smp-state-'));
process.env.SUBAGENT_MODEL_POLICY_STATE_DIR = dir;

const { stateDir, writeSessionModel, readSessionModel } = await import('../hooks/lib/state.mjs');

test('stateDir honours the environment override', () => {
  assert.equal(stateDir(), dir);
});

test('a written session model reads back', () => {
  assert.equal(writeSessionModel('abc123', 'opus', 'session-start'), true);
  assert.deepEqual(readSessionModel('abc123'), { model: 'opus', source: 'session-start' });
});

test('an unknown session id reads back as null', () => {
  assert.equal(readSessionModel('never-written'), null);
});

test('a corrupt state file reads back as null instead of throwing', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'corrupt.json'), '{{{');
  assert.doesNotThrow(() => readSessionModel('corrupt'));
  assert.equal(readSessionModel('corrupt'), null);
});

test('a state file missing the model field reads back as null', () => {
  writeFileSync(join(dir, 'partial.json'), JSON.stringify({ source: 'transcript' }));
  assert.equal(readSessionModel('partial'), null);
});

test('session ids are sanitised so they cannot escape the state directory', () => {
  writeSessionModel('../../escape', 'opus', 'session-start');
  assert.deepEqual(readSessionModel('../../escape'), { model: 'opus', source: 'session-start' });
  // The traversal must have been flattened into a single file inside `dir`.
  assert.ok(readdirSync(dir).some((f) => f.includes('escape')));
});

test('an unwritable state directory returns false instead of throwing', () => {
  const prev = process.env.SUBAGENT_MODEL_POLICY_STATE_DIR;
  // A path under an existing *file* can never be created as a directory.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  process.env.SUBAGENT_MODEL_POLICY_STATE_DIR = join(blocker, 'nested');
  assert.doesNotThrow(() => writeSessionModel('s', 'opus', 'session-start'));
  assert.equal(writeSessionModel('s', 'opus', 'session-start'), false);
  process.env.SUBAGENT_MODEL_POLICY_STATE_DIR = prev;
});
