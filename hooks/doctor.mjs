#!/usr/bin/env node
/** Self-test for subagent-model-policy. Usage: node doctor.mjs <session_id> */
import { existsSync, readdirSync } from 'node:fs';
import { stateDir, readSessionModel } from './lib/state.mjs';

const sessionId = process.argv[2];
const dir = stateDir();
const rows = [];
let healthy = true;

function row(label, status, detail, gates = true) {
  rows.push({ label, status, detail });
  if (gates && status !== 'ok') healthy = false;
}

row('state directory', existsSync(dir) ? 'ok' : 'FAIL', dir);

if (!sessionId) {
  row('session id', 'FAIL',
    'no session id given — the /subagent-model command supplies ${CLAUDE_SESSION_ID} ' +
    'automatically; running doctor.mjs directly requires passing a session id explicitly ' +
    'as an argument, e.g. node hooks/doctor.mjs <session_id>');
} else {
  const state = readSessionModel(sessionId);
  row('session model', state ? 'ok' : 'FAIL',
    state ? `${state.model} (via ${state.source})` : `no state captured for ${sessionId}`);
}

let count = 0;
let cachedStatus = 'ok';
try {
  count = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
} catch (err) {
  // A missing directory is expected (nothing captured yet) and stays 'ok' with count 0.
  // Any other failure (permissions, ACLs, etc.) is worth surfacing distinctly, but it
  // is informational only — it must never flip the exit code.
  cachedStatus = err && err.code === 'ENOENT' ? 'ok' : 'unknown';
}
row('cached sessions', cachedStatus, String(count), false);

const width = Math.max(...rows.map((r) => r.label.length));
const statusWidth = Math.max(...rows.map((r) => r.status.length));
console.log('subagent-model-policy\n');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(width)}  ${r.status.padEnd(statusWidth)}  ${r.detail}`);
}
console.log(healthy
  ? '\nPolicy is live. Subagents inherit the session model unless pinned.'
  : '\nPolicy is NOT live. Start a fresh session so SessionStart can run.');

process.exit(healthy ? 0 : 1);
