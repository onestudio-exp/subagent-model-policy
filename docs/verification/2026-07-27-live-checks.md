# Live checks — 2026-07-27

Spec §9 lists facts that fixtures cannot settle. This records what was actually
observed, with the evidence.

**Environment:** Claude Code 2.1.220, Node v25.2.1, Windows 11 Pro 10.0.26200.

**Method:** every check ran in a disposable sandbox project under the session
scratchpad, with hooks registered in that project's own `.claude/settings.json`
and driven by headless `claude -p`. **The machine's global `~/.claude/settings.json`
was never modified.** Ground truth was read from the transcripts Claude Code
wrote, never by asking a subagent about itself.

---

## 1. The real tool name is `Agent`, not `Task`

A catch-all `PreToolUse` hook logged its own input while a subagent spawned:

```json
{"ev":"PreToolUse","tool":"Agent","input":{"description":"Probe subagent","prompt":"say ok","subagent_type":"probe-agent","run_in_background":false}}
```

**Result:** the subagent-dispatch tool reports `tool_name` as **`Agent`**.

The shipped matcher is `Task|Agent`, which covers both this and the historical
`Task` name. The hook demonstrably fires.

**Second finding from the same log:** `tool_input` carries **no `model` key** when
the caller does not specify one. This confirms the effective-model design in
spec §5 — the hook must fall back to frontmatter, then the session model, rather
than assuming a `model` field is always present.

---

## 2. `updatedInput` applies — and `permissionDecision` is NOT required

This was the open question in spec §9. It was resolved in three steps, because
the first attempt produced a false negative worth recording.

### The false negative

The first probe rewrote `updatedInput.prompt` to `"Reply with exactly the word
RewriteApplied"`. The subagent replied `ok`, which looked like the rewrite being
ignored — with **and** without `permissionDecision: "allow"`.

That conclusion was wrong. The probe agent's own system prompt said *"Reply with
exactly: ok"*, and the subagent followed its system prompt over the injected user
prompt. The rewrite had applied; the test was measuring the wrong thing.

A control ruled out a malformed hook payload: the identical output shape applied
correctly to a `Bash` call, rewriting `echo ORIGINAL_COMMAND_RAN` into
`echo REWRITE_APPLIED_BASH`.

### The decisive test

Rewrite the field the plugin actually writes — `model` — and read the model the
subagent really ran on from its own transcript metadata.

Agent definition declared `model: haiku`. Hook emitted
`updatedInput.model = "opus"`.

**With `permissionDecision: "allow"`:**

```json
{"agentType":"probe-agent","description":"Probe agent test","toolUseId":"toolu_01X2YjxGGHEKZmX5W7g9sZRv","spawnDepth":1,"model":"opus"}
```

**Without any `permissionDecision` field:**

```json
{"agentType":"probe-agent","description":"Probe agent test","toolUseId":"toolu_011zSBuExhm7H7RfmK6oX1Zk","spawnDepth":1,"model":"opus"}
```

Both ran on `opus`, overriding the file's `haiku`. The corresponding transcript
entries record `assistant -> claude-opus-5`.

**Result:** `updatedInput.model` is honoured by the `Agent` tool, and
`permissionDecision` is **not** required for it to apply.

**Consequence for the implementation:** `enforce-subagent-model.mjs` keeps
emitting only `permissionDecisionReason` + `updatedInput`, exactly as specced.
Adding `permissionDecision: "allow"` would auto-approve every Agent call and
silently widen permissions for no benefit. The safer form is also the working
form.

---

## 3. `model-policy: pinned` is inert to Claude Code (spec test case 10)

The probe agent carried `model-policy: pinned` in its frontmatter alongside
`tools`, `model`, `name`, and `description`. It registered and spawned normally
across repeated runs, with no frontmatter warning and no error.

**Result:** the custom key is ignored by Claude Code, as spec §4 assumed. The
body-marker fallback described there is not needed.

---

## Incidental findings

Neither was being tested for. Both are recorded because they cost real debugging
time and affect this plugin.

### Claude Code does not tolerate a UTF-8 BOM in an agent definition

Rewriting the probe agent with PowerShell's `Set-Content -Encoding utf8` (which
emits a BOM on Windows PowerShell 5.1) made Claude Code stop recognising the
agent entirely — it vanished from the available subagent types with no warning,
reporting only that `probe-agent` was undefined. The file content was otherwise
byte-correct; only `EF BB BF` preceded the opening `---`.

Rewriting the same content without a BOM restored it immediately.

This plugin's own `parseFrontmatter` already tolerates a leading BOM
(`/^﻿?---/`), so it reads such a file correctly even though Claude Code
will not load it. That asymmetry is harmless — an agent Claude Code cannot load
never reaches our hook — but it is worth knowing when diagnosing "my agent
disappeared" on Windows.

### Subagent turns are not in the main transcript

Subagent conversations are written to **separate** files:

```
<project>/<session-id>/subagents/agent-<id>.jsonl
<project>/<session-id>/subagents/agent-<id>.meta.json
```

Every entry in the *main* session transcript reported `isSidechain=false`, and
no subagent assistant turn appeared there at all.

This bears on spec §6's rung 2. The sidechain-contamination risk that filter
defends against — reading a subagent's model and caching it as the session's —
appears **not to be reachable in Claude Code 2.1.220**, because subagent turns
never enter the file rung 2 reads. The filter is retained regardless: it is
cheap, it is correct, and it does not depend on an undocumented layout staying
the way it is today.

The `.meta.json` file is also the ground-truth method for verifying which model
a subagent ran on. It records the resolved `model` directly. Use it rather than
asking a subagent to report its own identity.

---

## 4. End-to-end: both directions of the policy

Run with the **real shipped hook scripts** wired into a disposable sandbox
project's `.claude/settings.json`. No global plugin install; the machine's
`~/.claude/settings.json` and plugin config were not modified.

Two agents, both declaring `model: sonnet`, differing only in the pin:

| Agent | Frontmatter | `.meta.json` `model` | Transcript model |
| --- | --- | --- | --- |
| `drifter` | `model: sonnet` | `"opus"` | `claude-opus-5` |
| `pinned-agent` | `model: sonnet` + `model-policy: pinned` | *(key absent)* | `claude-sonnet-5` |

**Result:** the unpinned agent was redirected to the session model; the pinned
agent was left alone.

The pinned case is the stronger evidence of the two. The `model` key is *absent*
from its `.meta.json`, which means the hook emitted nothing at all and no
per-invocation model was passed — resolution fell through to the frontmatter on
its own. Had the hook been overriding indiscriminately and merely happening to
land on `sonnet`, the key would be present. Absence proves silence.

Both actual models were read from the subagents' own transcripts, not inferred
from the metadata alone.

## 5. Doctor, both directions

Against a real captured session:

```
  state directory  ok  C:\Users\Pc\.claude\subagent-model-policy\sessions
  session model    ok  opus (via settings)
  cached sessions  ok  3

Policy is live. Subagents inherit the session model unless pinned.
EXIT=0
```

Against an unknown session id:

```
  session model    FAIL  no state captured for no-such-session-xyz

Policy is NOT live. Start a fresh session so SessionStart can run.
EXIT=1
```

**Incidental, and it validates the design:** the healthy run reports
`opus (via settings)` — **not** `via session-start`. `SessionStart` did not
supply a `model` field, so the ladder fell through rung 1, then rung 2, and
resolved at rung 3. The spec called the `SessionStart` `model` field "not
guaranteed to be present"; in practice, on this build, it was absent. The
fallback ladder is not defensive padding — it is the thing actually doing the
work.
