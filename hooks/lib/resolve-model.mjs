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
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf.subarray(0, bytesRead).toString('utf8');
}

/**
 * Widening tail windows tried in order when hunting for the transcript's
 * last assistant turn. A window that already covers the whole file is the
 * last one tried — there is nothing to gain from re-reading at a larger size.
 */
const TRANSCRIPT_WINDOW_BYTES = [262144, 2097152];

/**
 * Scan `text` — a tail slice of transcript JSONL — bottom-up for the
 * session's last assistant turn: the first entry, scanning from the end,
 * that is neither a sidechain (subagent) turn nor a non-assistant message.
 * Stops there regardless of whether its model normalizes — an older turn is
 * never "the session's model", even when the last one turns out unusable.
 *
 * Returns `{ found: false }` when no qualifying entry appears in this slice
 * (it may still exist further back, outside the window), or
 * `{ found: true, model }` once one is located (`model` may be null).
 */
function lastAssistantModel(text) {
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
    const isSidechain = Boolean(entry?.isSidechain) || Boolean(entry?.message?.isSidechain);
    if (isSidechain) continue; // a subagent turn, not the session's own
    if (entry?.type !== 'assistant') continue;
    return { found: true, model: normalizeModel(entry?.message?.model ?? entry?.model) };
  }
  return { found: false, model: null };
}

/**
 * Last assistant-message model recorded in a transcript JSONL, or null.
 * Grows the tail window (256 KiB, then 2 MiB, then the whole file) so a
 * huge final line isn't cut off before its `model` key — stopping as soon
 * as a window yields a qualifying entry, or once a window already covers
 * the whole file.
 */
function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  let size;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return null;
  }

  const windows = [...TRANSCRIPT_WINDOW_BYTES, size];
  for (const maxBytes of windows) {
    const coversWholeFile = maxBytes >= size;
    let text;
    try {
      text = tailFile(transcriptPath, maxBytes);
    } catch {
      return null;
    }
    const result = lastAssistantModel(text);
    if (result.found) return result.model;
    if (coversWholeFile) break;
  }
  return null;
}

/** First `model` key found across project then user settings, or null. */
function modelFromSettings(cwd, homeDir) {
  // homedir() is a real production path whenever homeDir isn't supplied, and
  // it can throw if neither HOME/USERPROFILE nor the OS lookup resolves —
  // fail open by treating that as "no user-scope candidate" rather than
  // letting the throw propagate.
  let home = homeDir;
  if (!home) {
    try {
      home = homedir();
    } catch {
      home = null;
    }
  }
  const candidates = [
    cwd && join(cwd, '.claude', 'settings.local.json'),
    cwd && join(cwd, '.claude', 'settings.json'),
    home && join(home, '.claude', 'settings.json'),
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
