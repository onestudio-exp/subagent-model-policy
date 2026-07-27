#!/usr/bin/env node
/**
 * PreToolUse hook on the subagent tool.
 *
 * Writes the per-invocation `model` parameter, which outranks the agent's
 * `model:` frontmatter in Claude Code's resolution order. That is the whole
 * mechanism: slot 2 beats slot 3.
 *
 * The session model is resolved fresh here, at dispatch time, preferring the
 * transcript (rung 2 — ground truth by now) over the SessionStart cache
 * (rung 3's fallback). See spec §5/§6, corrected 2026-07-27: resolving only
 * once at SessionStart can never see rungs 1-2, which leaves settings.json
 * to decide every time — the exact defect that let a pinned/deliberate
 * `model: opus` get silently downgraded to a stale cached `sonnet`.
 *
 * Always exits 0. Emits nothing unless a rewrite is warranted.
 */
import { normalizeModel, modelFromTranscript } from './lib/resolve-model.mjs';
import { readSessionModel } from './lib/state.mjs';
import { readAgentPolicy } from './lib/find-agent.mjs';
import { readStdin } from './lib/stdin.mjs';

/**
 * Resolve the session model as it stands right now, at dispatch time:
 *   modelFromTranscript(transcript_path)   -- primary: ground truth
 *     ?? readSessionModel(session_id)      -- fallback: the SessionStart cache
 *     ?? null                              -- fail open
 * `modelFromTranscript` never throws (it fails closed to null on any read
 * error), so an unreadable or missing transcript falls through to the cache
 * on its own.
 */
function resolveDispatchModel(input) {
  const fromTranscript = modelFromTranscript(input.transcript_path);
  if (fromTranscript) return fromTranscript;

  const cached = readSessionModel(input.session_id);
  return cached ? normalizeModel(cached.model) : null;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  const toolInput = input.tool_input ?? {};

  const sessionModel = resolveDispatchModel(input);
  if (!sessionModel) return; // no usable session model from either source — fail open

  const agent = readAgentPolicy(toolInput.subagent_type, input.cwd);
  if (!agent) return; // built-in or missing definition — fail open
  if (agent.pinned) return; // explicit opt-out is final

  // What the subagent would run on if this hook emitted nothing.
  const effective = normalizeModel(toolInput.model) ?? agent.model ?? sessionModel;
  if (effective === sessionModel) return; // already correct — stay quiet

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecisionReason: `model policy: ${effective} → ${sessionModel} (inherit)`,
      updatedInput: { ...toolInput, model: sessionModel },
    },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
