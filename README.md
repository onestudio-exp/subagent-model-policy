# subagent-model-policy

A Claude Code plugin that keeps subagents on the **same model as your session**.

> **Policy:** subagents inherit the session model, unless the agent is explicitly pinned.

## The problem

Claude Code resolves a subagent's model in this order:

```
1. CLAUDE_CODE_SUBAGENT_MODEL environment variable
2. per-invocation `model` parameter
3. agent definition `model:` frontmatter
4. main session model
```

Slot 3 is the leak. The official subagent template in the Claude Code docs
declares `model: sonnet`, so most community and marketplace agents carry that
line by copy-paste rather than by intent — and it outranks your session model.

The result: you work in an Opus session, dispatch an agent, and quietly get
Sonnet output. No warning, no transcript note.

## What this does

A `PreToolUse` hook rewrites the per-invocation `model` parameter (slot 2) to
your session's model, which beats the frontmatter in slot 3. Redirects are shown
in the transcript:

```
Agent(Explore)
  ↳ model policy: sonnet → opus (inherit)
```

## Install

```
/plugin marketplace add onestudio-exp/subagent-model-policy
```

## Opting an agent out

Add `model-policy: pinned` to any agent that should keep its own model — useful
for genuinely mechanical work that does not need your session's model:

```markdown
---
name: log-scanner
description: Scans build logs for known error signatures. Read-only, mechanical.
tools: Read, Grep, Glob
model: haiku
model-policy: pinned
---
```

A pin is final. Everything else follows the session.

## Checking it works

```
/subagent-model doctor
```

Verifies the hooks are registered, the session model was detected, and the state
file is being written.

## Design notes

- **Fails open, always.** Any error — unreadable state, malformed input, unknown
  model, missing agent file — exits cleanly and does nothing. A broken policy
  never blocks a subagent from spawning.
- **Never edits your agent files.** Enforcement happens at call time; every file
  on disk stays byte-identical.
- **Stores nothing durable.** The only state is a per-session cache of your
  session's model, keyed by session id. Deleting it is always safe.
- **Node, not Bash.** Claude Code ships Node, so there is no `jq` or shell
  dependency — this works on Windows as well as macOS and Linux.

Full design and rationale:
[`docs/superpowers/specs/2026-07-27-subagent-model-policy-design.md`](docs/superpowers/specs/2026-07-27-subagent-model-policy-design.md)

## License

MIT © OneStudio
