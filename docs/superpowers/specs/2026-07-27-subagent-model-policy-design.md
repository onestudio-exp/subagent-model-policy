# Design: `subagent-model-policy`

**Status:** approved, pending implementation
**Date:** 2026-07-27
**Repo:** `github.com/onestudio-exp/subagent-model-policy`
**Audience:** OneStudio team — installed org-wide as a Claude Code plugin

---

## 1. Problem

A subagent frequently runs on a different — usually cheaper — model than the
session that spawned it. Someone working in an Opus session dispatches an agent
and silently gets Sonnet output, with no indication it happened.

Claude Code resolves a subagent's model in a fixed order:

```
1. CLAUDE_CODE_SUBAGENT_MODEL environment variable
2. per-invocation `model` parameter
3. agent definition `model:` frontmatter
4. main session model
```

Slot 3 is the leak. The official subagent template in the Claude Code docs
declares `model: sonnet`, so most community and marketplace agents carry that
line by copy-paste rather than by intent. It then outranks the session model for
every invocation.

The cost is invisible: no warning, no transcript note. The only symptom is work
that is quietly worse than the model you thought you were paying for.

---

## 2. Policy

> **Subagents inherit the session model, unless the agent is explicitly pinned.**

That is the entire rule. Stated as consequences:

| Situation | Result |
| --- | --- |
| Agent declares no `model:` | Runs session model (already true; policy is a no-op) |
| Agent declares `model: sonnet`, session is Opus | Runs **Opus** — declaration overridden |
| Agent declares `model: haiku` **and** is pinned | Runs **Haiku** — declaration honoured |
| Session switches to Sonnet | All non-pinned subagents follow to Sonnet |

The policy targets *accidental* model declarations. Pinning is how intent gets
recorded, so that a deliberate cheap agent survives and a copy-pasted one does
not.

---

## 3. Non-goals

Each item is a deliberate refusal, not an oversight.

- **Does not modify agent definition files.** No rewriting `model: sonnet` to
  `inherit` on disk. Enforcement happens entirely at call time; every agent file
  on the machine stays byte-identical.
- **Does not persist policy decisions.** The only state written is a per-session
  cache of the session's model, keyed by `session_id`. Nothing accumulates,
  nothing needs migrating, and deleting the state directory is always safe.
- **Does not override explicitly pinned agents.** A pin is final. There is no
  "policy wins anyway" mode and no force flag.
- **Never blocks Agent execution.** If policy evaluation fails for any reason,
  the subagent spawns exactly as it would have without this plugin installed.
- **Does not change the main session's model**, and does not set or read
  `CLAUDE_CODE_SUBAGENT_MODEL`. That variable sits above this mechanism in the
  resolution order — if anyone sets it, it wins and the policy stands down.
- **Does not manage effort, tools, or permissions.** Model only.

---

## 4. The opt-out: `model-policy: pinned`

An agent opts out by adding **one frontmatter key** to its own definition file:

```markdown
---
name: log-scanner
description: Scans build logs for known error signatures. Read-only, mechanical.
tools: Read, Grep, Glob
model: haiku
model-policy: pinned          # opts this agent out of the inherit policy
---

You scan logs for known error patterns and return matches. Do not interpret.
```

"Explicit opt-out" means precisely this:

| Frontmatter state | Hook behaviour |
| --- | --- |
| `model-policy: pinned` **and** `model:` present | **Pinned.** Hook emits nothing; the declared `model:` resolves normally. |
| `model-policy:` absent | Subject to policy — `model:` (if any) is overridden with the session model. |
| `model-policy:` present with any other value | Subject to policy. Not an error; `doctor` reports it as a probable typo. |
| `model-policy: pinned` but **no** `model:` | Subject to policy — there is nothing to pin. `doctor` flags it as a likely mistake. |

Value comparison is trimmed and case-insensitive, so `Pinned` and `PINNED` both
work.

**Why a custom key is safe.** `model-policy` is read by this plugin's hook,
never by Claude Code. Claude Code ignores frontmatter keys outside its supported
set, so the key is inert to everything else. This assumption is verified by test
case 10 (§8). If Claude Code turns out to reject unknown keys, the fallback is a
body marker — `<!-- model-policy: pinned -->` — parsed the same way, with no
other change to this design.

---

## 5. Implementation mechanism

§2 states the policy; this section states the mechanism, which is replaceable
without changing the policy.

Slot 2 of the resolution order — the per-invocation `model` parameter — is the
only programmable lever, and writing it beats frontmatter. A `PreToolUse` hook
can write it through `updatedInput`.

But `PreToolUse` **cannot see the session model**. There is no `model` field in
its input and no `$CLAUDE_MODEL` environment variable; only `SessionStart`
receives one. `SubagentStart` is context-only and cannot alter a model. So the
mechanism splits across two hooks joined by a state file:

```
SessionStart
  └─ capture-session-model.mjs
       resolve session model (§6)
       write ~/.claude/subagent-model-policy/sessions/<session_id>.json

PreToolUse   matcher: "Task|Agent"
  └─ enforce-subagent-model.mjs
       read state for session_id             ─ missing? → fail open
       read tool_input.subagent_type
       locate agent definition (§7)          ─ missing? → fail open
       pinned?                               ─ yes?     → fail open
       normalize session model to alias      ─ unknown? → fail open
       already equal to effective model?     ─ yes?     → fail open (no-op)
       └─ emit updatedInput.model = <alias>
                + permissionDecisionReason for visibility
```

**"Effective model"** is what the subagent would run on if the hook emitted
nothing: `tool_input.model` when the caller passed one, otherwise the
definition's `model:` frontmatter, otherwise the session model. The hook rewrites
only when the effective model differs from the session model after
normalization — so a caller that already asked for the session model, and an
agent whose frontmatter already matches, both produce no output and no
transcript noise.

**The skill is documentation and tooling only.** It carries the policy
statement, the install and uninstall flow, and the `doctor` entry point. It
enforces nothing. A skill is advisory context that a model can drift away from,
which is exactly why enforcement lives in hooks instead.

### Visibility

When the hook rewrites a model it returns a `permissionDecisionReason`, so the
redirect is visible in the transcript rather than silent:

```
Agent(Explore)
  ↳ model policy: sonnet → opus (inherit)
```

Without this, a hook that quietly stops working is indistinguishable from one
that is working correctly.

---

## 6. Resolving the session model

**The ladder stops at the first source that yields a usable value.** Sources are
tried in order; the first success wins and the rest are not consulted.

| # | Source | Why it can miss |
| --- | --- | --- |
| 1 | `SessionStart` hook input `model` field | Documented as "not guaranteed to be present" |
| 2 | `transcript_path` JSONL — the **main session's** last assistant message | Ground truth, but written asynchronously and may lag |
| 3 | `settings.json` `"model"` — project, then user | Absent if the session model came from `--model` |
| 4 | *(none)* | → **fail open**, emit nothing |

### Reading rung 2 correctly

Two constraints on the transcript scan, both load-bearing:

**Only the main session's assistant turns count.** A transcript can carry
sidechain entries — subagent turns. Reading one would cache a *subagent's*
model as the session model and then pin later subagents to it: a
self-reinforcing loop in the exact plugin built to prevent it. The scan
therefore skips any entry marked as a sidechain and any entry that is not an
assistant message, and **stops at the first such entry it finds**. If that
entry's model does not normalize, rung 2 is a miss and the ladder falls to
rung 3 — it does not keep walking backwards into older turns, because an older
turn's model is not "the session's model".

**The read window must contain a complete record.** The scan reads the tail of
the file rather than all of it, so a single record larger than the window would
be truncated past its `model` key and silently missed. The window therefore
grows — 256 KiB, then 2 MiB, then the whole file — until it yields a usable
result or the file is exhausted. A window that starts mid-line is safe on its
own: a truncated JSON fragment always carries unbalanced brackets and fails
`JSON.parse`, so it is skipped rather than misread.

### Normalization

**All model identifiers are normalized to an alias before any comparison or
emission.** Sources 1–3 may return either an alias (`opus`) or a full model ID
(`claude-opus-5`), while the Agent tool's `model` parameter accepts only the
aliases `sonnet`, `opus`, `haiku`, and `fable`.

```
claude-opus-5             → opus
claude-sonnet-5           → sonnet
claude-haiku-4-5-*        → haiku
claude-fable-5            → fable
opus | sonnet | haiku | fable  → unchanged
anything else             → null → fail open
```

Normalization applies on **both sides** of the pinned and equality checks, so a
frontmatter `model: claude-opus-5` and a session model of `opus` are recognised
as the same model and produce no rewrite.

Unrecognised identifiers — a model newer than this build, or a typo — normalize
to `null` and fail open, rather than injecting a value the Agent tool would
reject.

---

## 7. Locating the agent definition

`subagent_type` maps to a definition file, searched in Claude Code's own
precedence order:

1. `<cwd>/.claude/agents/**/<name>.md` — project scope
2. `~/.claude/agents/**/<name>.md` — user scope
3. `~/.claude/plugins/cache/**/agents/<name>.md` — plugin scope; `plugin:agent`
   names split on `:`

Not found → fail open. This covers the built-ins (`Explore`, `Plan`,
`general-purpose`), which have no file on disk.

**Consequence worth naming.** Because a missing definition fails open, built-ins
keep whatever per-call `model` parameter was passed. Built-ins already inherit by
default, so the policy is redundant for them in the normal case — but an
explicit `model: "sonnet"` on `Explore` is *not* corrected. Failing open here is
the conservative choice; the alternative is guessing at an agent we cannot
inspect.

---

## 8. Failure behaviour

Every failure path exits `0` with empty stdout. A broken policy script must never
prevent a subagent from spawning. The worst case is that the plugin does nothing
— never that work stops. This is asserted by test cases 4–9, not merely
intended.

---

## 9. Test plan

`tests/run.mjs` pipes JSON fixtures to each hook on stdin and asserts stdout. No
network, no live agents — every case is deterministic.

| # | Case | Fixture | Expected |
| --- | --- | --- | --- |
| 1 | Pinned agent keeps its model | agent `model: haiku` + `model-policy: pinned`; session `opus` | empty stdout — no rewrite |
| 2 | Inherited agent follows session | agent `model: sonnet`, no pin; session `opus` | `updatedInput.model === "opus"` + reason string |
| 3 | No-op when already matching | agent `model: opus`; session `opus` | empty stdout — no redundant rewrite |
| 4 | Unknown model ID fails open | session model `claude-neptune-9` | empty stdout, exit 0 |
| 5 | Missing state file fails open | `session_id` with no state file | empty stdout, exit 0 |
| 6 | Malformed JSON fails open | truncated / non-JSON on stdin | empty stdout, exit 0, no throw |
| 7 | Missing agent definition fails open | `subagent_type: "does-not-exist"` | empty stdout, exit 0 |
| 8 | Corrupt state file fails open | state file containing `{{{` | empty stdout, exit 0 |
| 9 | Hook failure never blocks | state dir unreadable / unwritable | exit 0; and no fixture in 1–8 ever emits `permissionDecision: "deny"` |
| 10 | Custom key is inert | live: agent with `model-policy: pinned` spawns normally | agent launches; no frontmatter warning |
| 11 | Full-ID normalization | session `claude-opus-5`, agent `model: sonnet` | `updatedInput.model === "opus"` (alias, not full ID) |
| 12 | Pin recognised across ID forms | agent `model: claude-haiku-4-5-20251001` + pinned | empty stdout — no rewrite |

### Two facts that fixtures cannot settle

The design rests on both, so each gets a live integration check before the
implementation is considered done.

- **The real `tool_name`.** A temporary catch-all `PreToolUse` hook logs
  `tool_name` while a subagent spawns, confirming whether it is `Task` or
  `Agent`. The shipped matcher is `Task|Agent` either way; this proves it fires.
- **Whether `updatedInput` applies without `permissionDecision`.** The
  preference is to omit it, because `"allow"` auto-approves Agent calls and
  silently widens permissions. If the rewrite is ignored without it, `"allow"`
  is added and the README documents that consequence explicitly.

Ground truth for "which model did the subagent actually run on" is the session
transcript JSONL — **not** asking the subagent, since models misreport their own
identity.

---

## 10. Repo layout

```
onestudio-exp/subagent-model-policy
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   ├── hooks.json                    # SessionStart + PreToolUse registration
│   ├── capture-session-model.mjs
│   ├── enforce-subagent-model.mjs
│   └── lib/
│       ├── resolve-model.mjs         # fallback ladder + alias normalization
│       ├── find-agent.mjs            # subagent_type → definition file
│       └── state.mjs                 # session state read/write
├── commands/
│   └── subagent-model.md             # /subagent-model doctor
├── tests/
│   ├── fixtures/*.json
│   └── run.mjs
├── skills/
│   └── subagent-model-policy/
│       └── SKILL.md
├── docs/superpowers/specs/           # this document
└── README.md
```

Hooks are Node `.mjs`. Claude Code already ships Node, so there is no `jq` and no
Bash dependency — the plugin works on Windows as well as macOS and Linux, which
matters for a repo the whole team installs.

Marketplace metadata follows the existing `onestudio-exp/domain-experts`
convention, so installation is:

```
/plugin marketplace add onestudio-exp/subagent-model-policy
```

---

## 11. Module boundaries

Each unit has one purpose and is testable in isolation.

| Module | Does | Depends on |
| --- | --- | --- |
| `lib/resolve-model.mjs` | Normalizes an identifier to an alias; walks the fallback ladder | filesystem (read-only) |
| `lib/find-agent.mjs` | Resolves `subagent_type` to a file path; parses frontmatter | filesystem (read-only) |
| `lib/state.mjs` | Reads and writes the per-session state file | filesystem |
| `capture-session-model.mjs` | `SessionStart` entry point | `resolve-model`, `state` |
| `enforce-subagent-model.mjs` | `PreToolUse` entry point; emits the hook response | `resolve-model`, `find-agent`, `state` |

The two entry points hold no logic beyond reading stdin, calling into `lib/`, and
writing stdout, so every decision is unit-testable without spawning a hook.

---

## 12. Open assumptions

Carried into implementation and resolved there, not blockers:

1. `Mamoun2020` holds the `member` role in `onestudio-exp` (confirmed active).
   Repo creation may require an owner if the org restricts member repo creation.
2. Test case 10 is a live check. If Claude Code warns on unknown frontmatter
   keys, the opt-out syntax moves to a body marker per §4.
3. Built-in agents are not covered by name (§7). Revisit only if an explicit
   per-call `model` on a built-in proves to be a real problem in practice.
