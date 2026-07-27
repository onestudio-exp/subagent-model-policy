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
