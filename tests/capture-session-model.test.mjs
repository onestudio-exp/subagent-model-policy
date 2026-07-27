import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './helpers/run-hook.mjs';

const SCRIPT = 'hooks/capture-session-model.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'smp-capture-'));

test('captures the SessionStart model into the state file', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, {
    session_id: 'sess-1',
    hook_event_name: 'SessionStart',
    model: 'claude-opus-5',
    cwd: tmp(),
  }, { SUBAGENT_MODEL_POLICY_STATE_DIR: state });

  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', 'SessionStart capture must be silent');
  const written = JSON.parse(readFileSync(join(state, 'sess-1.json'), 'utf8'));
  assert.equal(written.model, 'opus');
  assert.equal(written.source, 'session-start');
});

test('malformed stdin exits 0 and writes nothing', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, '{{{ not json', { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(readdirSync(state), [], 'nothing should have been written');
});

test('empty stdin exits 0', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, '', { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('an unresolvable session model writes nothing but still exits 0', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, {
    session_id: 'sess-2',
    hook_event_name: 'SessionStart',
    model: 'claude-neptune-9',
    cwd: tmp(),
  }, { SUBAGENT_MODEL_POLICY_STATE_DIR: state, HOME: tmp(), USERPROFILE: tmp() });

  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(state), []);
});
