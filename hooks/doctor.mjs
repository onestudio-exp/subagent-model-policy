#!/usr/bin/env node
/** Self-test for subagent-model-policy. Usage: node doctor.mjs <session_id> */
import { existsSync, readdirSync } from 'node:fs';
import { stateDir, readSessionModel } from './lib/state.mjs';

const sessionId = process.argv[2];
const dir = stateDir();
const rows = [];
let healthy = true;

function row(label, ok, detail) {
  rows.push({ label, ok, detail });
  if (!ok) healthy = false;
}

row('state directory', existsSync(dir), dir);

if (!sessionId) {
  row('session id', false, 'no session id given — pass $CLAUDE_SESSION_ID');
} else {
  const state = readSessionModel(sessionId);
  row('session model', Boolean(state),
    state ? `${state.model} (via ${state.source})` : `no state captured for ${sessionId}`);
}

let count = 0;
try {
  count = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
} catch { /* directory may not exist yet */ }
row('cached sessions', true, String(count));

const width = Math.max(...rows.map((r) => r.label.length));
console.log('subagent-model-policy\n');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(width)}  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.detail}`);
}
console.log(healthy
  ? '\nPolicy is live. Subagents inherit the session model unless pinned.'
  : '\nPolicy is NOT live. Start a fresh session so SessionStart can run.');

process.exit(healthy ? 0 : 1);
