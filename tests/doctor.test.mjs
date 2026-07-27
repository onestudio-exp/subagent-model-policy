import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runDoctor(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'hooks/doctor.mjs'), ...args],
      { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('reports the captured session model when state exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  writeFileSync(join(dir, 'live.json'), JSON.stringify({ model: 'opus', source: 'session-start' }));
  const r = await runDoctor(['live'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /session model\s+ok/i);
  assert.match(r.stdout, /opus/);
  assert.match(r.stdout, /session-start/);
});

test('reports a failure when no state was captured for the session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor(['missing'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /session model\s+FAIL/i);
});

test('always reports the state directory it inspected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor(['whatever'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.ok(r.stdout.includes(dir));
});

// This suite may itself run inside a live Claude Code session (this repo's
// own tests are routinely exercised that way), which sets CLAUDE_CODE_SESSION_ID
// in the ambient environment. Any test that means to simulate "no session id
// available at all" must explicitly blank both fallback env vars — otherwise
// Fix 10's fallback (below) makes the test's outcome depend on whoever's
// shell happens to run it.
const NO_ENV_SESSION_ID = { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };

test('a missing session id argument does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor([], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir, ...NO_ENV_SESSION_ID });
  assert.ok(r.code === 0 || r.code === 1);
  assert.match(r.stdout, /session id/i);
});

test('the no-session-id hint uses the braced substitution token, not the bare form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor([], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir, ...NO_ENV_SESSION_ID });
  assert.ok(r.stdout.includes('${CLAUDE_SESSION_ID}'));
});

// --- Fix 10: session id falls back to the environment ----------------------
// There is a contested claim that ${CLAUDE_SESSION_ID} does not reach the
// doctor. A live probe confirmed the slash-command substitution itself works,
// but separately found the env var Bash actually receives is named
// CLAUDE_CODE_SESSION_ID, not CLAUDE_SESSION_ID. Rather than bet on one name,
// doctor.mjs falls back through both.

test('falls back to CLAUDE_CODE_SESSION_ID when no argument is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  writeFileSync(join(dir, 'env-sess.json'), JSON.stringify({ model: 'opus', source: 'session-start' }));
  const r = await runDoctor([], {
    SUBAGENT_MODEL_POLICY_STATE_DIR: dir,
    CLAUDE_CODE_SESSION_ID: 'env-sess',
    CLAUDE_SESSION_ID: '',
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /session model\s+ok/i);
  assert.match(r.stdout, /opus/);
});

test('falls back to the bare CLAUDE_SESSION_ID when CLAUDE_CODE_SESSION_ID is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  writeFileSync(join(dir, 'bare-sess.json'), JSON.stringify({ model: 'haiku', source: 'session-start' }));
  const r = await runDoctor([], {
    SUBAGENT_MODEL_POLICY_STATE_DIR: dir,
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_SESSION_ID: 'bare-sess',
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /session model\s+ok/i);
  assert.match(r.stdout, /haiku/);
});

test('an explicit argument takes precedence over both environment variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  writeFileSync(join(dir, 'arg-sess.json'), JSON.stringify({ model: 'sonnet', source: 'session-start' }));
  writeFileSync(join(dir, 'env-sess.json'), JSON.stringify({ model: 'opus', source: 'session-start' }));
  const r = await runDoctor(['arg-sess'], {
    SUBAGENT_MODEL_POLICY_STATE_DIR: dir,
    CLAUDE_CODE_SESSION_ID: 'env-sess',
  });
  assert.match(r.stdout, /sonnet/);
  assert.doesNotMatch(r.stdout, /opus/);
});

// --- Fix 9: the closing verdict must not misdiagnose a missing session id --

test('closing verdict: a missing session id blames the invocation, not "start a fresh session" (which cannot fix it)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor([], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir, ...NO_ENV_SESSION_ID });
  assert.equal(r.code, 1);
  const lastLine = r.stdout.trim().split('\n').pop();
  assert.doesNotMatch(lastLine, /start a fresh session/i,
    'starting a fresh session cannot fix an invocation that never supplied a session id');
});

test('closing verdict: an unknown-but-present session id keeps the fresh-session advice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor(['no-such-session'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.equal(r.code, 1);
  const lastLine = r.stdout.trim().split('\n').pop();
  assert.match(lastLine, /start a fresh session/i);
});
