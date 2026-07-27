import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeModel } from './resolve-model.mjs';

/**
 * Parse the leading `---` frontmatter block into a flat key/value map.
 * Deliberately a YAML subset: agent frontmatter is flat scalars. Trailing
 * ` #` comments are stripped, matching how the docs' own examples annotate.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;

  const out = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

/** Recursively collect `<name>.md` under a directory. */
function searchDir(dir, name, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === `${name}.md`) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = searchDir(join(dir, entry.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a subagent type to its definition file, in Claude Code's own
 * precedence order: project, then user, then plugin cache.
 * Returns null for built-ins, which have no file on disk.
 */
export function findAgentFile(subagentType, cwd, homeDir) {
  if (typeof subagentType !== 'string' || !subagentType.trim()) return null;
  // Plugin-scoped names arrive as `plugin:agent`.
  const name = subagentType.trim().split(':').pop();
  if (!name) return null;

  const home = homeDir || homedir();
  const roots = [
    cwd && join(cwd, '.claude', 'agents'),
    join(home, '.claude', 'agents'),
    join(home, '.claude', 'plugins', 'cache'),
  ].filter(Boolean);

  for (const root of roots) {
    const found = searchDir(root, name);
    if (found) return found;
  }
  return null;
}

/**
 * Read an agent's model policy.
 * Returns null when no definition exists, so the caller fails open.
 */
export function readAgentPolicy(subagentType, cwd, homeDir) {
  const path = findAgentFile(subagentType, cwd, homeDir);
  if (!path) return null;

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!frontmatter) return null;

  const model = normalizeModel(frontmatter.model);
  const declared = String(frontmatter['model-policy'] ?? '').trim().toLowerCase();
  // A pin with no resolvable model has nothing to pin (spec section 4, row 4).
  const pinned = declared === 'pinned' && model !== null;

  return { model, pinned, path };
}
