import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
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

/**
 * Bound on recursive directory descent. The plugin cache nests several
 * levels before reaching an `agents/` folder
 * (`<marketplace>/<plugin>/<version>/agents/...`), so this must cover that
 * plus any subdirectories within `agents/` itself.
 */
const MAX_SEARCH_DEPTH = 8;

/** Recursively find the first `<name>.md` under a directory. */
function searchDir(dir, name, depth = 0) {
  if (depth > MAX_SEARCH_DEPTH) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // missing, unreadable, or not a directory
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === `${name}.md`) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = searchDir(join(dir, entry.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Recursively collect every `<name>.md` found under a literal `agents` path
 * segment beneath `dir`. The plugin cache holds `agents/`, `commands/`,
 * `skills/`, `hooks/` and docs side by side (spec §7), so a same-named file
 * elsewhere (e.g. `commands/review.md`) must never be mistaken for
 * `agents/review.md`.
 */
function collectPluginAgentMatches(dir, name, depth, insideAgents, results) {
  if (depth > MAX_SEARCH_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing, unreadable, or not a directory
  }
  if (insideAgents) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name === `${name}.md`) results.push(join(dir, entry.name));
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childInsideAgents = insideAgents || entry.name === 'agents';
    collectPluginAgentMatches(join(dir, entry.name), name, depth + 1, childInsideAgents, results);
  }
}

/**
 * True when `filePath` sits under `pluginName`'s own plugin directory inside
 * the plugin-cache `root`. Cache layout is
 * `<root>/<marketplace>/<plugin>/<version>/...`, so relative to `root` the
 * plugin name is always at index 1 (index 0 is the marketplace) — confirmed
 * against a real `~/.claude/plugins/cache` (e.g.
 * `claude-plugins-official/vercel/0.45.1/agents/...`). Checking only that
 * index — never "does this string appear anywhere in the path" — is what
 * keeps a marketplace that happens to be *named* after another plugin from
 * being mistaken for it. Compared case-insensitively (Windows and macOS
 * default to case-insensitive filesystems), and `relative()`'s own separator
 * is split defensively on both `/` and `\`.
 */
function isUnderPlugin(root, filePath, pluginName) {
  if (!pluginName) return false;
  const segments = relative(root, filePath).split(/[\\/]+/);
  return segments[1] !== undefined && segments[1].toLowerCase() === pluginName.toLowerCase();
}

/**
 * Search the plugin cache for `<name>.md` under an `agents/` directory.
 * When `pluginQualifier` is given (a `plugin:agent`-style lookup), only a
 * match inside that plugin's own directory (relative index 1 under `root`)
 * counts — an unresolved qualifier returns null rather than falling back to
 * an arbitrary same-named match elsewhere in the cache. Falling back would
 * mean a qualified lookup for a pinned agent could resolve to a different,
 * unpinned plugin's same-named agent and have the hook override what looks
 * like a pin — a spec §3 non-goal violation ("does not override explicitly
 * pinned agents"). Failing open (null) is cheaper than guessing.
 * Unqualified (bare-name) lookups are unaffected and keep the broad search.
 */
function findInPluginCache(root, name, pluginQualifier) {
  const matches = [];
  collectPluginAgentMatches(root, name, 0, false, matches);
  if (matches.length === 0) return null;
  if (pluginQualifier) {
    return matches.find((path) => isUnderPlugin(root, path, pluginQualifier)) ?? null;
  }
  return matches[0];
}

/**
 * `homedir()` is a real production path whenever `homeDir` isn't supplied,
 * and it can throw if neither `HOME`/`USERPROFILE` nor the OS lookup
 * resolves. Failing open means treating that as "no user scope available",
 * never propagating the throw.
 */
function safeHomeDir(homeDir) {
  if (homeDir) return homeDir;
  try {
    return homedir();
  } catch {
    return null;
  }
}

/**
 * Resolve a subagent type to its definition file, in Claude Code's own
 * precedence order: project, then user, then plugin cache.
 * Returns null for built-ins, which have no file on disk.
 */
export function findAgentFile(subagentType, cwd, homeDir) {
  if (typeof subagentType !== 'string' || !subagentType.trim()) return null;

  // Plugin-scoped names arrive as `plugin:agent`; the leading segment
  // narrows the plugin-cache search, the trailing segment is the filename.
  const parts = subagentType.trim().split(':');
  const name = parts[parts.length - 1].trim();
  if (!name) return null;
  const pluginQualifier = parts.length > 1 ? parts[0].trim() || null : null;

  const home = safeHomeDir(homeDir);

  const projectAndUserRoots = [
    cwd && join(cwd, '.claude', 'agents'),
    home && join(home, '.claude', 'agents'),
  ].filter(Boolean);

  for (const root of projectAndUserRoots) {
    const found = searchDir(root, name);
    if (found) return found;
  }

  if (home) {
    const found = findInPluginCache(join(home, '.claude', 'plugins', 'cache'), name, pluginQualifier);
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
