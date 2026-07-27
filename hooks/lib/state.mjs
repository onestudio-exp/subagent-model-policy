import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where per-session model state lives. Overridable for tests. */
export function stateDir() {
  return (
    process.env.SUBAGENT_MODEL_POLICY_STATE_DIR ||
    join(homedir(), '.claude', 'subagent-model-policy', 'sessions')
  );
}

/** Flatten a session id to a safe single filename — no path traversal. */
function stateFile(sessionId) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  return join(stateDir(), `${safe}.json`);
}

/** Persist the session's model. Returns false on any failure. */
export function writeSessionModel(sessionId, model, source) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(stateFile(sessionId), JSON.stringify({ model, source }), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Read the session's model, or null if absent, corrupt, or incomplete. */
export function readSessionModel(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'));
    if (!parsed || typeof parsed.model !== 'string' || !parsed.model) return null;
    return { model: parsed.model, source: parsed.source ?? 'unknown' };
  } catch {
    return null;
  }
}
