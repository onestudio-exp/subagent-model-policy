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
 * That fix alone is still not enough: on the *first* tool call of a session
 * the transcript typically exists but holds no assistant turn yet (spec §6,
 * "Source strength, and why the transcript is not enough"), so resolution
 * still falls to the cache — and the cache may itself be `settings.json`, a
 * **weak** source (configuration, not observation, and stale under
 * `--model`/`/model`). A weak source is therefore never allowed to downgrade
 * the subagent below its effective model — see `mayRewrite` in
 * `lib/resolve-model.mjs`, which this hook defers to rather than deciding
 * inline.
 *
 * Always exits 0. Emits nothing unless a rewrite is warranted.
 */
import { normalizeModel, modelFromTranscript, mayRewrite } from './lib/resolve-model.mjs';
import { readSessionModel } from './lib/state.mjs';
import { readAgentPolicy } from './lib/find-agent.mjs';
import { readStdin } from './lib/stdin.mjs';

/**
 * Resolve the session model as it stands right now, at dispatch time, along
 * with the source it came from — the source is needed downstream to apply
 * the weak-source no-downgrade rule (spec §6):
 *
 *   modelFromTranscript(transcript_path)   -- primary: ground truth, strong
 *     ?? readSessionModel(session_id)      -- fallback: the SessionStart
 *                                             cache, whose own recorded
 *                                             source (session-start or
 *                                             settings) travels with it
 *     ?? null                              -- fail open
 *
 * `modelFromTranscript` never throws (it fails closed to null on any read
 * error), so an unreadable, missing, or not-yet-populated transcript falls
 * through to the cache on its own.
 */
function resolveDispatchModel(input) {
  const fromTranscript = modelFromTranscript(input.transcript_path);
  if (fromTranscript) return { model: fromTranscript, source: 'transcript' };

  const cached = readSessionModel(input.session_id);
  if (!cached) return null;
  const model = normalizeModel(cached.model);
  return model ? { model, source: cached.source } : null;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  const toolInput = input.tool_input ?? {};

  const resolved = resolveDispatchModel(input);
  if (!resolved) return; // no usable session model from either source — fail open
  const { model: sessionModel, source } = resolved;

  const agent = readAgentPolicy(toolInput.subagent_type, input.cwd);
  if (!agent) return; // built-in or missing definition — fail open
  if (agent.pinned) return; // explicit opt-out is final

  // What the subagent would run on if this hook emitted nothing.
  const effective = normalizeModel(toolInput.model) ?? agent.model ?? sessionModel;
  if (effective === sessionModel) return; // already correct — stay quiet
  if (!mayRewrite(source, sessionModel, effective)) return; // weak source, would downgrade — stay quiet

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecisionReason: `model policy: ${effective} → ${sessionModel} (inherit)`,
      updatedInput: { ...toolInput, model: sessionModel },
    },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
