import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normalizeModel } from './resolve-model.mjs';
import { safeHomeDir } from './safe-home.mjs';

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
 * `homeDir` is a test override; production callers omit it and get the
 * real (guarded) home directory from the shared `safeHomeDir()` helper,
 * which never throws even if `homedir()` itself would.
 */
function resolveHomeDir(homeDir) {
  return homeDir || safeHomeDir();
}

/**
 * Names Claude Code ships as built-in subagent types, which normally have no
 * definition file on disk (Claude Code implements them internally). This set
 * is only an optimisation hint, never an authority on what is or isn't a
 * built-in: `findAgentFile` checks it strictly *after* the project- and
 * user-scope searches (see below), so a real on-disk file named e.g.
 * `claude.md` always wins regardless of whether its name appears here. That
 * ordering is also why the broader membership (beyond the three named in
 * spec §7 — `Explore`, `Plan`, `general-purpose`) is harmless to keep: adding
 * `claude` or `statusline-setup` can only skip a redundant plugin-cache walk
 * that would have returned null anyway, never mask a real file.
 *
 * Compared case-insensitively, since Windows and macOS default to
 * case-insensitive filesystems and matching either case is strictly safer
 * than under-matching a reserved name.
 *
 * Only applies to a bare (unqualified) lookup: a `plugin:Explore`-style
 * qualified name is a real plugin agent that merely shares the name, not
 * this built-in, and must still go through the normal search.
 */
const BUILTIN_AGENT_TYPES = new Set(['explore', 'plan', 'general-purpose', 'claude', 'statusline-setup']);

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

  const home = resolveHomeDir(homeDir);

  const projectAndUserRoots = [
    cwd && join(cwd, '.claude', 'agents'),
    home && join(home, '.claude', 'agents'),
  ].filter(Boolean);

  for (const root of projectAndUserRoots) {
    const found = searchDir(root, name);
    if (found) return found;
  }

  // Only short-circuit the (expensive) plugin-cache walk once the cheap
  // project/user directory searches above have both come up empty. A real
  // on-disk file — even one that happens to share a built-in's name, e.g. a
  // user-defined `claude.md` — must always be found, never silently skipped.
  if (!pluginQualifier && BUILTIN_AGENT_TYPES.has(name.toLowerCase())) return null;

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
