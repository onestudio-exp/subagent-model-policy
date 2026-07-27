import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeHomeDir } from './safe-home.mjs';

/**
 * Where per-session model state lives. Overridable for tests.
 *
 * Must never throw — callers such as `doctor.mjs` read it at module scope,
 * outside any try, precisely because it's a diagnostic tool that must not
 * itself crash on the condition it exists to diagnose. `safeHomeDir()`
 * already guards against a throwing `homedir()`; if that still leaves us
 * with no home directory, fall back to `tmpdir()` (which Node itself
 * guarantees not to throw) rather than ever joining a null path.
 */
export function stateDir() {
  if (process.env.SUBAGENT_MODEL_POLICY_STATE_DIR) {
    return process.env.SUBAGENT_MODEL_POLICY_STATE_DIR;
  }
  const home = safeHomeDir();
  if (home) return join(home, '.claude', 'subagent-model-policy', 'sessions');
  return join(tmpdir(), 'subagent-model-policy', 'sessions');
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
