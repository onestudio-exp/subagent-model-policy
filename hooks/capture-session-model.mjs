#!/usr/bin/env node
/**
 * SessionStart hook: resolve this session's model and cache it, so the
 * PreToolUse hook can read it later. PreToolUse receives no model field of
 * its own, which is the reason this second hook exists at all.
 *
 * Always exits 0 with empty stdout.
 */
import { resolveSessionModel } from './lib/resolve-model.mjs';
import { writeSessionModel } from './lib/state.mjs';
import { readStdin } from './lib/stdin.mjs';

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  const resolved = resolveSessionModel({
    model: input.model,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
  });
  if (!resolved) return;

  writeSessionModel(input.session_id, resolved.model, resolved.source);
}

main().catch(() => {}).finally(() => process.exit(0));
