#!/usr/bin/env node
/**
 * PreToolUse hook on the subagent tool.
 *
 * Writes the per-invocation `model` parameter, which outranks the agent's
 * `model:` frontmatter in Claude Code's resolution order. That is the whole
 * mechanism: slot 2 beats slot 3.
 *
 * Always exits 0. Emits nothing unless a rewrite is warranted.
 */
import { normalizeModel } from './lib/resolve-model.mjs';
import { readSessionModel } from './lib/state.mjs';
import { readAgentPolicy } from './lib/find-agent.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  const toolInput = input.tool_input ?? {};

  const state = readSessionModel(input.session_id);
  if (!state) return; // no captured session model — fail open

  const sessionModel = normalizeModel(state.model);
  if (!sessionModel) return; // unrecognised — fail open

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
