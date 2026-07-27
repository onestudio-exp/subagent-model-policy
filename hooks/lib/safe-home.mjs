import { homedir } from 'node:os';

/**
 * `homedir()` is a real production path everywhere in this plugin, and it
 * can throw if neither HOME/USERPROFILE nor the OS user-info lookup
 * resolves. Every module that needs the user's home directory must fail
 * open rather than propagate that throw — this is the single shared guard,
 * used by `lib/state.mjs`, `lib/find-agent.mjs`, and `lib/resolve-model.mjs`,
 * so the fail-open behaviour lives in one place instead of being
 * reimplemented (and potentially forgotten) three times.
 *
 * Returns the home directory, or null if it could not be determined.
 */
export function safeHomeDir() {
  try {
    return homedir();
  } catch {
    return null;
  }
}
