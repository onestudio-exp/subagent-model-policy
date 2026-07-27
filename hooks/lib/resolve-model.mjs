import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Model aliases the Agent tool's `model` parameter accepts. */
export const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Normalize any model identifier to an alias the Agent tool accepts.
 * Returns null for anything unrecognised, so callers fail open rather than
 * emitting a value the tool would reject.
 */
export function normalizeModel(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (ALIASES.includes(v)) return v;
  // Beyond a bare alias, only treat it as a Claude model ID if it says so.
  if (!v.includes('claude')) return null;
  for (const alias of ALIASES) {
    if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(v)) return alias;
  }
  return null;
}

/** Read at most the final `maxBytes` of a file, as UTF-8. */
function tailFile(path, maxBytes = 262144) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

/** Last assistant-message model recorded in a transcript JSONL, or null. */
function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = tailFile(transcriptPath);
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // truncated first line, or a partial write
    }
    const model = normalizeModel(entry?.message?.model ?? entry?.model);
    if (model) return model;
  }
  return null;
}

/** First `model` key found across project then user settings, or null. */
function modelFromSettings(cwd, homeDir) {
  const candidates = [
    cwd && join(cwd, '.claude', 'settings.local.json'),
    cwd && join(cwd, '.claude', 'settings.json'),
    join(homeDir || homedir(), '.claude', 'settings.json'),
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const model = normalizeModel(parsed.model);
        if (model) return model;
      }
    } catch {
      continue; // missing or corrupt — try the next candidate
    }
  }
  return null;
}

/**
 * Resolve the session's model. Stops at the first source that yields a
 * usable value; later sources are not consulted. Returns null when every
 * source misses, so the caller fails open.
 */
export function resolveSessionModel({ model, transcriptPath, cwd, homeDir } = {}) {
  const direct = normalizeModel(model);
  if (direct) return { model: direct, source: 'session-start' };

  const fromTranscript = modelFromTranscript(transcriptPath);
  if (fromTranscript) return { model: fromTranscript, source: 'transcript' };

  const fromSettings = modelFromSettings(cwd, homeDir);
  if (fromSettings) return { model: fromSettings, source: 'settings' };

  return null;
}
