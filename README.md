# subagent-model-policy

A Claude Code plugin that keeps **subagents on the same model as your session**.

> **Policy:** subagents inherit the session model, unless the agent is explicitly pinned.

---

## The problem

You are working in an Opus session. You dispatch a subagent. It runs on Haiku:

```
● Agent(Implement Task 1: manifests)  Haiku 4.5
  L PowerShell(cd C:\Users\Pc\Herd\subagent-model-policy; node --test tests 2>&1)
```

You only noticed because Claude Code prints the model next to the agent name. The
output itself carries no warning, no transcript note, and no indication that the
work you are about to trust was done by a cheaper model than the one you chose.

That is the failure this plugin exists to remove: **a silent quality regression
that the person it happens to cannot see.**

### Why it happens

Claude Code resolves a subagent's model in a fixed order:

```
1. CLAUDE_CODE_SUBAGENT_MODEL environment variable
2. per-invocation `model` parameter
3. agent definition `model:` frontmatter
4. main session model
```

**Slot 3 is the leak.** The official subagent template in the Claude Code docs
declares `model: sonnet`, so most community and marketplace agents carry that
line by copy-paste rather than by intent — and it outranks your session model
every time.

Slot 2 leaks too, more quietly: any caller that passes an explicit `model` on the
`Agent(...)` call overrides your session, whether or not that was considered.

---

## What this does

A `PreToolUse` hook writes **slot 2**, which outranks the frontmatter in slot 3.
That is the entire mechanism.

Redirects are visible in the transcript rather than silent:

```
Agent(Explore)
  ↳ model policy: sonnet → opus (inherit)
```

A `SessionStart` hook caches the session model beforehand, because `PreToolUse`
receives no model field of its own.

**The skill that ships with this plugin is documentation only — it enforces
nothing.** A skill is advisory context a model can drift away from, which is
precisely why enforcement lives in hooks.

---

## Install

```
/plugin marketplace add onestudio-exp/subagent-model-policy
/plugin install subagent-model-policy@subagent-model-policy
```

Then **start a fresh session.** Installing mid-session means `SessionStart` has
already run, so nothing was captured and the policy stays inert until next time.

### Check it is live

```
/subagent-model-policy:subagent-model
```

Plugin commands are namespaced `plugin:command` — the bare `/subagent-model`
will not resolve. This name is verified against a real install, not inferred.

```
subagent-model-policy

  state directory  ok  ~/.claude/subagent-model-policy/sessions
  session model    ok  opus (via settings)
  cached sessions  ok  3

Policy is live. Subagents inherit the session model unless pinned.
```

`session model FAIL` almost always means the plugin was installed mid-session.
Start a fresh session.

### Uninstall

```
claude plugin uninstall subagent-model-policy@subagent-model-policy
claude plugin marketplace remove subagent-model-policy
```

---

## Opting an agent out

Add `model-policy: pinned` to any agent that genuinely should keep its own model
— mechanical, high-volume, low-judgement work:

```markdown
---
name: log-scanner
description: Scans build logs for known error signatures. Read-only, mechanical.
tools: Read, Grep, Glob
model: haiku
model-policy: pinned
---
```

**A pin is final.** The policy never overrides it.

Rules, exactly:

| Frontmatter | Result |
| --- | --- |
| `model-policy: pinned` **with** a `model:` | Pinned. Left alone. |
| No `model-policy:` key | Subject to the policy. |
| `model-policy:` with any other value | Subject to the policy (`doctor` flags it as a likely typo). |
| `model-policy: pinned` **without** a `model:` | Subject to the policy — nothing to pin. |

Value matching is trimmed and case-insensitive.

### Pin deliberately, not reflexively

The default exists because a cheaper model on judgement work is a regression
nobody sees. Pin for work that is genuinely mechanical, not for work that merely
*feels* routine.

---

## Known limitation: no per-call escape hatch

**Only agent definitions can be pinned.** An explicit `model` passed on an
individual `Agent(...)` call is rewritten like anything else:

```js
Agent({ subagent_type: "reviewer", model: "haiku", ... })   // -> runs on your session model
```

This is intentional — accidental per-call model choices are exactly what the
policy is for — but it means **the Agent tool's own optional `model` override is
not a way around the policy.**

The practical consequence, worth knowing before you install: if you run
subagent-driven workflows that deliberately dispatch cheap workers for mechanical
tasks, **those will now all run on your session model, and cost accordingly.**
The only remedy today is a `model-policy: pinned` agent definition. If you need
per-call cheap dispatch, this plugin is not currently compatible with that.

---

## When the session model can only be guessed

Sometimes the session model cannot be observed, only inferred from
`settings.json` — which goes stale under `--model` and `/model`. Sources
therefore carry a **strength**:

| Source | Strength | Why |
| --- | --- | --- |
| Transcript | strong | The model the session demonstrably just used |
| `SessionStart` report | strong | Claude Code's own statement of the session's model |
| `settings.json` | **weak** | Configuration, not observation |

**A weak source may never downgrade.** On weak evidence the policy will still
*upgrade* an agent that declares something cheaper, but it will never rewrite a
declaration to something cheaper.

This is not caution for its own sake. Before this rule existed, the plugin was
measured **downgrading a deliberate `model: opus` agent to Sonnet** in a session
running `--model opus`, because `settings.json` disagreed — causing the precise
harm it was built to prevent. Every failure mode found in review was a downgrade,
so a source that cannot prove itself is not allowed to cause one.

---

## Verified behaviour

Every claim below was measured against **Claude Code 2.1.220**, reading the model
each subagent actually ran on from its own transcript — never by asking the
subagent, which cannot reliably report its own identity.

Run through the real marketplace install, in a project with no hooks of its own:

| Agent | Frontmatter | Pinned | Actually ran on | |
| --- | --- | --- | --- | --- |
| `copypasta` | `model: sonnet` | no | `claude-opus-5` | redirected |
| `deliberate` | `model: haiku` | **yes** | `claude-haiku-4-5-20251001` | pin honoured |
| `architect` | `model: opus` | no | `claude-opus-5` | not downgraded on weak evidence |

Mechanism facts settled by live check rather than assumption:

- The subagent tool reports its name as **`Agent`**, not `Task`. The shipped
  matcher covers both.
- `updatedInput` applies **without** `permissionDecision`. This matters for
  safety: sending `permissionDecision: "allow"` would auto-approve every Agent
  call and silently widen permissions. The plugin does not send it, because it
  does not need to.
- `model-policy:` is inert to Claude Code, which ignores unknown frontmatter keys.

Full evidence — including a probe of ours that produced a false negative, and a
review finding that turned out to be wrong:
[`docs/verification/2026-07-27-live-checks.md`](docs/verification/2026-07-27-live-checks.md)

### Known residual

The transcript is treated as a strong source but is always **one turn stale** —
assistant turns are flushed only after a turn completes. Immediately after a
mid-session `/model` upgrade, the hook may still see the previous model and
downgrade a deliberate choice. The window is a single dispatch. Recorded in
`live-checks.md` §6 rather than left implicit.

---

## Design notes

- **Fails open, always.** Any error — unreadable state, malformed input, unknown
  model, missing agent file — exits `0` and does nothing. A broken policy must
  never stop a subagent from spawning. The hook emits `permissionDecision: "deny"`
  nowhere in the codebase; that is a property of the code, not of a test.
- **Never edits your agent files.** Enforcement happens at call time; every file
  on disk stays byte-identical.
- **Stores nothing durable.** The only write is a per-session cache of your
  session's model, keyed by session id. Deleting
  `~/.claude/subagent-model-policy/` is always safe.
- **Ignores `CLAUDE_CODE_SUBAGENT_MODEL`.** That variable outranks this plugin;
  if you set it, it wins and the policy stands down.
- **Node, not Bash.** Claude Code ships Node, so there is no `jq` or shell
  dependency — this works on Windows as well as macOS and Linux. Zero runtime
  dependencies.

Full design and rationale:
[`docs/superpowers/specs/2026-07-27-subagent-model-policy-design.md`](docs/superpowers/specs/2026-07-27-subagent-model-policy-design.md)

---

## Development

```bash
npm test        # node --test tests/*.mjs  -- 117 tests, no network, deterministic
```

A bare `node --test tests/` fails on Node 25 + Windows — the runner treats the
directory as a test file. Use `npm test`.

```
hooks/
  hooks.json                   SessionStart + PreToolUse registration
  capture-session-model.mjs    caches the session model
  enforce-subagent-model.mjs   rewrites the per-invocation model
  doctor.mjs                   self-test behind the slash command
  lib/                         resolve-model, find-agent, state, safe-home, stdin
commands/subagent-model.md     /subagent-model-policy:subagent-model
skills/subagent-model-policy/  documentation, not enforcement
tests/                         unit + child-process integration
docs/                          spec, plan, live verification
```

Hook entry points hold no decision logic — they read stdin, call into `lib/`, and
write stdout. Every decision is unit-testable without spawning a hook.

---

## License

MIT © OneStudio
