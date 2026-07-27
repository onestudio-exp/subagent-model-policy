---
description: Check that the subagent model policy is live and see the captured session model.
---

Run the policy self-test and report the result to the user.

Run this exactly, substituting the current session id:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/doctor.mjs" "$CLAUDE_SESSION_ID"
```

Then explain the output in one or two sentences:

- **All `ok`** — the policy is live. Subagents inherit this session's model
  unless their definition carries `model-policy: pinned`.
- **`session model FAIL`** — the `SessionStart` hook did not run for this
  session, usually because the plugin was installed mid-session. Tell the user
  to start a fresh session.
- **`state directory FAIL`** — nothing has been captured yet on this machine.
  Same fix: start a fresh session.

Do not attempt to repair anything. This command only reports.
