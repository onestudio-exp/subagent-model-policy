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

Sometimes the session model can only be inferred from `settings.json` rather
than observed directly (the session's own report, or the transcript). That
inference is weaker — `settings.json` goes stale under `--model` and
`/model` — so in that case the policy still **upgrades** an agent that
declares a cheaper model, but it will never rewrite a declaration to
something cheaper on that evidence alone. A downgrade it caused would be the
exact harm this plugin exists to prevent.

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

A pin is final. Everything else follows the session — **including an
explicit `model` passed on the individual `Agent(...)` call itself.** If you
dispatch a subagent with `model: "opus"` right there in the call, and its
definition isn't pinned, the policy rewrites that too. This is intentional
(the whole point is that accidental model choices don't survive), but it does
mean the Agent tool's own optional per-invocation override is not a way
around the policy — only `model-policy: pinned` on the agent's own
definition is.

## Checking it works

```
/subagent-model-policy:subagent-model
```

Plugin commands are namespaced `plugin:command`, so the bare `/subagent-model`
will not resolve. The name is verified against an actual install, not inferred.

Verifies the hooks are registered, the session model was detected, and the state
file is being written. Exits `0` when the policy is live, `1` when it is not.

If it reports `session model FAIL`, the plugin was almost certainly installed
mid-session — `SessionStart` had already run, so nothing was captured. Start a
fresh session.

## Verified behaviour

Both directions were confirmed end to end against Claude Code 2.1.220, reading
the model each subagent actually ran on from its own transcript — not by asking
the subagent, which cannot reliably report its own identity:

| Agent frontmatter | Pinned? | Actually ran on |
| --- | --- | --- |
| `model: sonnet` | no | **opus** — redirected to the session model |
| `model: sonnet` | **yes** | **sonnet** — pin honoured |

Two facts about the mechanism were also settled by live check rather than
assumption, and they are why the plugin is shaped the way it is:

- The subagent tool reports its name as **`Agent`**, not `Task`. The shipped
  matcher covers both.
- `updatedInput` applies **without** `permissionDecision`. That matters for
  safety: sending `permissionDecision: "allow"` would auto-approve every Agent
  call and silently widen permissions. The plugin does not send it, because it
  does not need to.

Full evidence, including one false-negative probe worth not repeating:
[`docs/verification/2026-07-27-live-checks.md`](docs/verification/2026-07-27-live-checks.md)

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
