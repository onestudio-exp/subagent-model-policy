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

test('a missing session id argument does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor([], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.ok(r.code === 0 || r.code === 1);
  assert.match(r.stdout, /session id/i);
});
