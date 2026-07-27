---
name: subagent-model-policy
description: Use when a subagent ran on an unexpected model, when deciding whether an agent should be pinned to its own model, or when asked how subagent model selection resolves in Claude Code. Explains the inherit policy and the `model-policy: pinned` opt-out.
---

# Subagent model policy

**Policy:** subagents inherit the session model, unless the agent is explicitly
pinned.

This skill is documentation and tooling. **It does not enforce the policy** —
enforcement lives in two hooks shipped by this plugin, because a skill is
advisory context that a model can drift away from.

## Why subagents drift onto the wrong model

Claude Code resolves a subagent's model in this order:

1. `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
2. per-invocation `model` parameter
3. agent definition `model:` frontmatter
4. main session model

Slot 3 is the leak. The official subagent template in the Claude Code docs
declares `model: sonnet`, so most community and marketplace agents carry that
line by copy-paste rather than by intent — and it outranks the session model.

## How this plugin fixes it

A `SessionStart` hook caches the session's model. A `PreToolUse` hook on the
subagent tool writes slot 2, which outranks slot 3. Redirects are visible in the
transcript:

```
Agent(Explore)
  ↳ model policy: sonnet → opus (inherit)
```

When the session model can only be inferred from `settings.json` — not
observed from the session's own report or the transcript — that evidence is
weaker, since `settings.json` goes stale under `--model` and `/model`. In
that case the hook still upgrades an agent that declares a cheaper model,
but it will never rewrite a declaration to something cheaper on that
evidence alone.

## Pinning an agent

When an agent genuinely should run on its own model — mechanical, high-volume,
low-judgement work — add `model-policy: pinned` to its frontmatter:

```markdown
---
name: log-scanner
description: Scans build logs for known error signatures. Read-only, mechanical.
tools: Read, Grep, Glob
model: haiku
model-policy: pinned
---
```

A pin is final; the policy never overrides it. `model-policy: pinned` without a
`model:` field pins nothing and is ignored.

**Advise a pin only when the work is genuinely mechanical.** The default exists
because a cheaper model on judgement work is a silent quality regression, and
the person who spawned the agent will not see it happen.

## When something looks wrong

Run `/subagent-model doctor`. The usual cause of `session model FAIL` is
installing the plugin mid-session — the `SessionStart` hook has not run yet, so
start a fresh session.

## What this plugin will not do

- It never edits agent definition files.
- It never blocks a subagent from spawning; every failure path is silent.
- It does not touch `CLAUDE_CODE_SUBAGENT_MODEL`. If that variable is set, it
  outranks this plugin and the policy stands down.
