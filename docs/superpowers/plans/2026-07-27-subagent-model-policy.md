# subagent-model-policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Claude Code plugin that forces every subagent onto the session's model unless the agent is explicitly pinned.

**Architecture:** A `SessionStart` hook resolves the session's model and caches it to a per-session state file. A `PreToolUse` hook on the subagent tool reads that state, inspects the target agent's frontmatter, and rewrites the per-invocation `model` parameter — which outranks frontmatter in Claude Code's resolution order. Pure functions live in `hooks/lib/`; the two hook entry points only marshal stdin/stdout. Every failure path exits 0 with empty stdout.

**Tech Stack:** Node ≥ 20 ESM (`.mjs`), `node:test` + `node:assert/strict`, no runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-27-subagent-model-policy-design.md`](../specs/2026-07-27-subagent-model-policy-design.md)

## Global Constraints

- **Fail open, always.** Every error path exits `0` with empty stdout. No hook may ever emit `permissionDecision: "deny"`. (Spec §8)
- **No runtime dependencies.** Node built-ins only. No `jq`, no Bash, no npm installs — must run on Windows, macOS, and Linux. (Spec §10)
- **Never write to agent definition files.** Read-only access to everything under `.claude/agents/`. (Spec §3)
- **Only durable write** is `~/.claude/subagent-model-policy/sessions/<session_id>.json`. (Spec §3)
- **Model aliases emitted to the Agent tool must be one of** `opus`, `sonnet`, `haiku`, `fable`. Never emit a full model ID. (Spec §6)
- **All model identifiers are normalized before any comparison or emission**, on both sides. (Spec §6)
- **ESM only.** `"type": "module"` in `package.json`; all files `.mjs`.
- **Full suite runs as `npm test`**, which is `node --test tests/*.mjs`. A bare
  `node --test tests/` fails on Node 25 + Windows — the runner treats the
  directory as a test file and reports a synthetic failure. Node expands the
  glob itself, so this works under `cmd`, PowerShell, and POSIX shells alike.
- **State directory is overridable** via `SUBAGENT_MODEL_POLICY_STATE_DIR` so tests never touch the real `~/.claude`.

---

### Task 1: Repo scaffolding and plugin manifests

**Files:**
- Create: `package.json`
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Test: `tests/manifests.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` → runs `node --test tests/`. Manifest files at the paths above.

- [ ] **Step 1: Write the failing test**

Create `tests/manifests.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

test('plugin.json declares the plugin name and version', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'subagent-model-policy');
  assert.match(plugin.version, /^\d+\.\d+\.\d+/);
  assert.ok(plugin.description.length > 20);
});

test('marketplace.json points at this directory as the plugin source', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'subagent-model-policy');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'subagent-model-policy');
  assert.equal(market.plugins[0].source, './');
});

test('package.json is ESM with a test script', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.scripts.test, /node --test/);
  assert.equal(pkg.dependencies, undefined, 'must have zero runtime dependencies');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manifests.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory ... package.json`

- [ ] **Step 3: Write the manifests**

`package.json`:

```json
{
  "name": "subagent-model-policy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Keeps Claude Code subagents on the same model as your session.",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "subagent-model-policy",
  "version": "0.1.0",
  "description": "Keeps Claude Code subagents on the same model as your session. Subagents inherit the session model unless explicitly pinned with `model-policy: pinned`.",
  "author": {
    "name": "OneStudio"
  }
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "subagent-model-policy",
  "version": "0.1.0",
  "description": "Keeps Claude Code subagents on the same model as your session.",
  "owner": {
    "name": "OneStudio"
  },
  "plugins": [
    {
      "name": "subagent-model-policy",
      "source": "./",
      "description": "SessionStart captures the session model; PreToolUse rewrites subagent model calls so subagents inherit unless explicitly pinned."
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin tests/manifests.test.mjs
git commit -m "feat: scaffold plugin manifests and test harness"
```

---

### Task 2: Model identifier normalization

Normalization is the foundation every later task compares against. It must map aliases and full model IDs to a single alias, and return `null` for anything it does not recognise so callers fail open.

**Files:**
- Create: `hooks/lib/resolve-model.mjs`
- Test: `tests/resolve-model.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeModel(value: unknown) => 'opus'|'sonnet'|'haiku'|'fable'|null`

- [ ] **Step 1: Write the failing test**

Create `tests/resolve-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel } from '../hooks/lib/resolve-model.mjs';

test('aliases pass through unchanged', () => {
  for (const a of ['opus', 'sonnet', 'haiku', 'fable']) {
    assert.equal(normalizeModel(a), a);
  }
});

test('full model IDs map to their alias', () => {
  assert.equal(normalizeModel('claude-opus-5'), 'opus');
  assert.equal(normalizeModel('claude-sonnet-5'), 'sonnet');
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(normalizeModel('claude-fable-5'), 'fable');
});

test('legacy and cloud-prefixed IDs still resolve', () => {
  assert.equal(normalizeModel('claude-3-5-sonnet-20241022'), 'sonnet');
  assert.equal(normalizeModel('us.anthropic.claude-opus-5-v1:0'), 'opus');
});

test('case and surrounding whitespace are ignored', () => {
  assert.equal(normalizeModel('  OPUS '), 'opus');
  assert.equal(normalizeModel('Claude-Sonnet-5'), 'sonnet');
});

test('unrecognised identifiers return null so callers fail open', () => {
  assert.equal(normalizeModel('claude-neptune-9'), null);
  assert.equal(normalizeModel('gpt-4'), null);
  assert.equal(normalizeModel('inherit'), null);
  assert.equal(normalizeModel(''), null);
  assert.equal(normalizeModel('   '), null);
});

test('non-string input returns null rather than throwing', () => {
  assert.equal(normalizeModel(undefined), null);
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel(42), null);
  assert.equal(normalizeModel({ model: 'opus' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/resolve-model.test.mjs`
Expected: FAIL — `Cannot find module .../hooks/lib/resolve-model.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/lib/resolve-model.mjs`:

```js
/** Model aliases the Agent tool's `model` parameter accepts. */
export const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Normalize any model identifier to an alias the Agent tool accepts.
 * Returns null for anything unrecognised, so callers fail open rather than
 * emitting a value the tool would reject.
 */
export function normalizeModel(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (ALIASES.includes(v)) return v;
  // Beyond a bare alias, only treat it as a Claude model ID if it says so.
  if (!v.includes('claude')) return null;
  for (const alias of ALIASES) {
    if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(v)) return alias;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/resolve-model.test.mjs`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/resolve-model.mjs tests/resolve-model.test.mjs
git commit -m "feat: normalize model identifiers to Agent tool aliases"
```

---

### Task 3: Session model fallback ladder

**Files:**
- Modify: `hooks/lib/resolve-model.mjs` (append)
- Test: `tests/resolve-session-model.test.mjs`

**Interfaces:**
- Consumes: `normalizeModel` from Task 2
- Produces: `resolveSessionModel({ model, transcriptPath, cwd, homeDir }) => { model: string, source: 'session-start'|'transcript'|'settings' } | null`

The ladder **stops at the first source that yields a usable value** (Spec §6).

- [ ] **Step 1: Write the failing test**

Create `tests/resolve-session-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionModel } from '../hooks/lib/resolve-model.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'smp-'));

function writeTranscript(dir, entries) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
  return p;
}

function writeSettings(dir, rel, obj) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(obj));
}

test('rung 1: SessionStart model wins and short-circuits the ladder', () => {
  const dir = tmp();
  const transcript = writeTranscript(dir, [{ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }]);
  const got = resolveSessionModel({ model: 'claude-opus-5', transcriptPath: transcript, cwd: dir, homeDir: dir });
  assert.deepEqual(got, { model: 'opus', source: 'session-start' });
});

test('rung 2: falls to transcript when SessionStart model is absent', () => {
  const dir = tmp();
  const transcript = writeTranscript(dir, [
    { type: 'assistant', message: { model: 'claude-sonnet-5' } },
    { type: 'assistant', message: { model: 'claude-opus-5' } },
  ]);
  const got = resolveSessionModel({ transcriptPath: transcript, cwd: dir, homeDir: dir });
  assert.deepEqual(got, { model: 'opus', source: 'transcript' }, 'uses the LAST assistant message');
});

test('rung 2: an unrecognised transcript model does not stop the ladder', () => {
  const dir = tmp();
  const transcript = writeTranscript(dir, [{ type: 'assistant', message: { model: 'claude-neptune-9' } }]);
  writeSettings(dir, '.claude/settings.json', { model: 'sonnet' });
  const got = resolveSessionModel({ transcriptPath: transcript, cwd: dir, homeDir: dir });
  assert.deepEqual(got, { model: 'sonnet', source: 'settings' });
});

test('rung 3: project settings outrank user settings', () => {
  const dir = tmp();
  const home = tmp();
  writeSettings(dir, '.claude/settings.json', { model: 'sonnet' });
  writeSettings(home, '.claude/settings.json', { model: 'opus' });
  const got = resolveSessionModel({ cwd: dir, homeDir: home });
  assert.deepEqual(got, { model: 'sonnet', source: 'settings' });
});

test('rung 3: falls back to user settings when the project has none', () => {
  const dir = tmp();
  const home = tmp();
  writeSettings(home, '.claude/settings.json', { model: 'claude-opus-5' });
  const got = resolveSessionModel({ cwd: dir, homeDir: home });
  assert.deepEqual(got, { model: 'opus', source: 'settings' });
});

test('rung 4: returns null when every source misses', () => {
  const dir = tmp();
  assert.equal(resolveSessionModel({ cwd: dir, homeDir: dir }), null);
});

test('a corrupt transcript or settings file never throws', () => {
  const dir = tmp();
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{{{not json\nalso not json');
  writeSettings(dir, '.claude/settings.json', 'not-an-object');
  assert.doesNotThrow(() => resolveSessionModel({ transcriptPath: bad, cwd: dir, homeDir: dir }));
  assert.equal(resolveSessionModel({ transcriptPath: bad, cwd: dir, homeDir: dir }), null);
});

test('a missing transcript path is skipped silently', () => {
  const dir = tmp();
  writeSettings(dir, '.claude/settings.json', { model: 'haiku' });
  const got = resolveSessionModel({ transcriptPath: join(dir, 'nope.jsonl'), cwd: dir, homeDir: dir });
  assert.deepEqual(got, { model: 'haiku', source: 'settings' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/resolve-session-model.test.mjs`
Expected: FAIL — `resolveSessionModel is not a function`

- [ ] **Step 3: Write minimal implementation**

Append the functions below to `hooks/lib/resolve-model.mjs`. **Hoist the three
`import` lines to the top of the file, above the existing `ALIASES` export** —
they are shown here with the code they serve, but ESM imports belong at the top
and a reviewer will flag them mid-file.

```js
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read at most the final `maxBytes` of a file, as UTF-8. */
function tailFile(path, maxBytes = 262144) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

/** Last assistant-message model recorded in a transcript JSONL, or null. */
function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = tailFile(transcriptPath);
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // truncated first line, or a partial write
    }
    const model = normalizeModel(entry?.message?.model ?? entry?.model);
    if (model) return model;
  }
  return null;
}

/** First `model` key found across project then user settings, or null. */
function modelFromSettings(cwd, homeDir) {
  const candidates = [
    cwd && join(cwd, '.claude', 'settings.local.json'),
    cwd && join(cwd, '.claude', 'settings.json'),
    join(homeDir || homedir(), '.claude', 'settings.json'),
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const model = normalizeModel(parsed.model);
        if (model) return model;
      }
    } catch {
      continue; // missing or corrupt — try the next candidate
    }
  }
  return null;
}

/**
 * Resolve the session's model. Stops at the first source that yields a
 * usable value; later sources are not consulted. Returns null when every
 * source misses, so the caller fails open.
 */
export function resolveSessionModel({ model, transcriptPath, cwd, homeDir } = {}) {
  const direct = normalizeModel(model);
  if (direct) return { model: direct, source: 'session-start' };

  const fromTranscript = modelFromTranscript(transcriptPath);
  if (fromTranscript) return { model: fromTranscript, source: 'transcript' };

  const fromSettings = modelFromSettings(cwd, homeDir);
  if (fromSettings) return { model: fromSettings, source: 'settings' };

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/resolve-session-model.test.mjs`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/resolve-model.mjs tests/resolve-session-model.test.mjs
git commit -m "feat: resolve session model via first-success fallback ladder"
```

---

### Task 4: Per-session state file

**Files:**
- Create: `hooks/lib/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `stateDir() => string`
  - `writeSessionModel(sessionId: string, model: string, source: string) => boolean`
  - `readSessionModel(sessionId: string) => { model: string, source: string } | null`

`SUBAGENT_MODEL_POLICY_STATE_DIR` overrides the location so tests never touch the real `~/.claude`.

- [ ] **Step 1: Write the failing test**

Create `tests/state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smp-state-'));
process.env.SUBAGENT_MODEL_POLICY_STATE_DIR = dir;

const { stateDir, writeSessionModel, readSessionModel } = await import('../hooks/lib/state.mjs');

test('stateDir honours the environment override', () => {
  assert.equal(stateDir(), dir);
});

test('a written session model reads back', () => {
  assert.equal(writeSessionModel('abc123', 'opus', 'session-start'), true);
  assert.deepEqual(readSessionModel('abc123'), { model: 'opus', source: 'session-start' });
});

test('an unknown session id reads back as null', () => {
  assert.equal(readSessionModel('never-written'), null);
});

test('a corrupt state file reads back as null instead of throwing', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'corrupt.json'), '{{{');
  assert.doesNotThrow(() => readSessionModel('corrupt'));
  assert.equal(readSessionModel('corrupt'), null);
});

test('a state file missing the model field reads back as null', () => {
  writeFileSync(join(dir, 'partial.json'), JSON.stringify({ source: 'transcript' }));
  assert.equal(readSessionModel('partial'), null);
});

test('session ids are sanitised so they cannot escape the state directory', () => {
  writeSessionModel('../../escape', 'opus', 'session-start');
  assert.deepEqual(readSessionModel('../../escape'), { model: 'opus', source: 'session-start' });
  // The traversal must have been flattened into a single file inside `dir`.
  assert.ok(readdirSync(dir).some((f) => f.includes('escape')));
});

test('an unwritable state directory returns false instead of throwing', () => {
  const prev = process.env.SUBAGENT_MODEL_POLICY_STATE_DIR;
  // A path under an existing *file* can never be created as a directory.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  process.env.SUBAGENT_MODEL_POLICY_STATE_DIR = join(blocker, 'nested');
  assert.doesNotThrow(() => writeSessionModel('s', 'opus', 'session-start'));
  assert.equal(writeSessionModel('s', 'opus', 'session-start'), false);
  process.env.SUBAGENT_MODEL_POLICY_STATE_DIR = prev;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/state.test.mjs`
Expected: FAIL — `Cannot find module .../hooks/lib/state.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/lib/state.mjs`:

```js
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where per-session model state lives. Overridable for tests. */
export function stateDir() {
  return (
    process.env.SUBAGENT_MODEL_POLICY_STATE_DIR ||
    join(homedir(), '.claude', 'subagent-model-policy', 'sessions')
  );
}

/** Flatten a session id to a safe single filename — no path traversal. */
function stateFile(sessionId) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  return join(stateDir(), `${safe}.json`);
}

/** Persist the session's model. Returns false on any failure. */
export function writeSessionModel(sessionId, model, source) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(stateFile(sessionId), JSON.stringify({ model, source }), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Read the session's model, or null if absent, corrupt, or incomplete. */
export function readSessionModel(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'));
    if (!parsed || typeof parsed.model !== 'string' || !parsed.model) return null;
    return { model: parsed.model, source: parsed.source ?? 'unknown' };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/state.test.mjs`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/state.mjs tests/state.test.mjs
git commit -m "feat: per-session model state with sanitised ids and fail-safe IO"
```

---

### Task 5: Agent definition lookup and pin detection

This task implements the §4 truth table. Getting the degenerate rows right is the point — `pinned` with no `model:` must NOT count as pinned.

**Files:**
- Create: `hooks/lib/find-agent.mjs`
- Test: `tests/find-agent.test.mjs`

**Interfaces:**
- Consumes: `normalizeModel` from Task 2
- Produces:
  - `parseFrontmatter(text: string) => Record<string,string>|null`
  - `findAgentFile(subagentType: string, cwd: string, homeDir?: string) => string|null`
  - `readAgentPolicy(subagentType: string, cwd: string, homeDir?: string) => { model: string|null, pinned: boolean, path: string } | null`

`readAgentPolicy` returns `null` when no definition file exists — built-ins included — so the caller fails open (Spec §7).

- [ ] **Step 1: Write the failing test**

Create `tests/find-agent.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, readAgentPolicy } from '../hooks/lib/find-agent.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'smp-agent-'));

function writeAgent(root, scopeRel, name, frontmatter) {
  const dir = join(root, scopeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody text.\n`);
}

test('parseFrontmatter reads key/value pairs and strips trailing comments', () => {
  const fm = parseFrontmatter('---\nname: x\nmodel: haiku   # deliberate\n---\nbody');
  assert.equal(fm.name, 'x');
  assert.equal(fm.model, 'haiku');
});

test('parseFrontmatter returns null when there is no frontmatter block', () => {
  assert.equal(parseFrontmatter('no frontmatter here'), null);
  assert.equal(parseFrontmatter(''), null);
});

// --- Spec section 4 truth table -------------------------------------------

test('row 1: `pinned` plus a model is pinned', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'scanner', 'name: scanner\nmodel: haiku\nmodel-policy: pinned');
  const got = readAgentPolicy('scanner', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'haiku', pinned: true });
});

test('row 2: no model-policy key is subject to policy', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'copied', 'name: copied\nmodel: sonnet');
  const got = readAgentPolicy('copied', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'sonnet', pinned: false });
});

test('row 3: an unrecognised model-policy value is subject to policy', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'typo', 'name: typo\nmodel: sonnet\nmodel-policy: pined');
  assert.equal(readAgentPolicy('typo', root, root).pinned, false);
});

test('row 4: `pinned` with no model is subject to policy — nothing to pin', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'empty', 'name: empty\nmodel-policy: pinned');
  const got = readAgentPolicy('empty', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: null, pinned: false });
});

test('the pinned value is trimmed and case-insensitive', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'shouty', 'name: shouty\nmodel: haiku\nmodel-policy:   PINNED  ');
  assert.equal(readAgentPolicy('shouty', root, root).pinned, true);
});

test('a pin is recognised when the model is written as a full ID', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents', 'full', 'name: full\nmodel: claude-haiku-4-5-20251001\nmodel-policy: pinned');
  const got = readAgentPolicy('full', root, root);
  assert.deepEqual({ model: got.model, pinned: got.pinned }, { model: 'haiku', pinned: true });
});

// --- Scope resolution ------------------------------------------------------

test('project scope outranks user scope', () => {
  const root = tmp();
  const home = tmp();
  writeAgent(root, '.claude/agents', 'dup', 'name: dup\nmodel: sonnet');
  writeAgent(home, '.claude/agents', 'dup', 'name: dup\nmodel: opus');
  assert.equal(readAgentPolicy('dup', root, home).model, 'sonnet');
});

test('user scope is found when the project has no such agent', () => {
  const root = tmp();
  const home = tmp();
  writeAgent(home, '.claude/agents', 'userly', 'name: userly\nmodel: opus');
  assert.equal(readAgentPolicy('userly', root, home).model, 'opus');
});

test('agents nested in subdirectories are found', () => {
  const root = tmp();
  writeAgent(root, '.claude/agents/team', 'nested', 'name: nested\nmodel: sonnet');
  assert.equal(readAgentPolicy('nested', root, root).model, 'sonnet');
});

test('a missing definition returns null so the caller fails open', () => {
  const root = tmp();
  assert.equal(readAgentPolicy('does-not-exist', root, root), null);
  assert.equal(readAgentPolicy('Explore', root, root), null, 'built-ins have no file on disk');
});

test('a blank or non-string subagent type returns null without throwing', () => {
  const root = tmp();
  assert.equal(readAgentPolicy('', root, root), null);
  assert.equal(readAgentPolicy(undefined, root, root), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/find-agent.test.mjs`
Expected: FAIL — `Cannot find module .../hooks/lib/find-agent.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/lib/find-agent.mjs`:

```js
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeModel } from './resolve-model.mjs';

/**
 * Parse the leading `---` frontmatter block into a flat key/value map.
 * Deliberately a YAML subset: agent frontmatter is flat scalars. Trailing
 * ` #` comments are stripped, matching how the docs' own examples annotate.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;

  const out = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

/** Recursively collect `<name>.md` under a directory. */
function searchDir(dir, name, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === `${name}.md`) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = searchDir(join(dir, entry.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a subagent type to its definition file, in Claude Code's own
 * precedence order: project, then user, then plugin cache.
 * Returns null for built-ins, which have no file on disk.
 */
export function findAgentFile(subagentType, cwd, homeDir) {
  if (typeof subagentType !== 'string' || !subagentType.trim()) return null;
  // Plugin-scoped names arrive as `plugin:agent`.
  const name = subagentType.trim().split(':').pop();
  if (!name) return null;

  const home = homeDir || homedir();
  const roots = [
    cwd && join(cwd, '.claude', 'agents'),
    join(home, '.claude', 'agents'),
    join(home, '.claude', 'plugins', 'cache'),
  ].filter(Boolean);

  for (const root of roots) {
    const found = searchDir(root, name);
    if (found) return found;
  }
  return null;
}

/**
 * Read an agent's model policy.
 * Returns null when no definition exists, so the caller fails open.
 */
export function readAgentPolicy(subagentType, cwd, homeDir) {
  const path = findAgentFile(subagentType, cwd, homeDir);
  if (!path) return null;

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!frontmatter) return null;

  const model = normalizeModel(frontmatter.model);
  const declared = String(frontmatter['model-policy'] ?? '').trim().toLowerCase();
  // A pin with no resolvable model has nothing to pin (spec section 4, row 4).
  const pinned = declared === 'pinned' && model !== null;

  return { model, pinned, path };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/find-agent.test.mjs`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/find-agent.mjs tests/find-agent.test.mjs
git commit -m "feat: resolve agent definitions and detect explicit model pins"
```

---

### Task 6: SessionStart hook entry point

**Files:**
- Create: `hooks/capture-session-model.mjs`
- Create: `tests/helpers/run-hook.mjs`
- Test: `tests/capture-session-model.test.mjs`

**Interfaces:**
- Consumes: `resolveSessionModel` (Task 3), `writeSessionModel` (Task 4)
- Produces: an executable hook script reading JSON on stdin, writing nothing on stdout.
- Produces: `runHook(scriptPath, inputObject, env) => Promise<{ code, stdout, stderr }>` test helper, reused by Task 7.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/run-hook.mjs`:

```js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Pipe `input` (object or raw string) to a hook script; capture its output. */
export function runHook(relScript, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, relScript)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
```

Create `tests/capture-session-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './helpers/run-hook.mjs';

const SCRIPT = 'hooks/capture-session-model.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'smp-capture-'));

test('captures the SessionStart model into the state file', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, {
    session_id: 'sess-1',
    hook_event_name: 'SessionStart',
    model: 'claude-opus-5',
    cwd: tmp(),
  }, { SUBAGENT_MODEL_POLICY_STATE_DIR: state });

  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', 'SessionStart capture must be silent');
  const written = JSON.parse(readFileSync(join(state, 'sess-1.json'), 'utf8'));
  assert.equal(written.model, 'opus');
  assert.equal(written.source, 'session-start');
});

test('malformed stdin exits 0 and writes nothing', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, '{{{ not json', { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(readdirSync(state), [], 'nothing should have been written');
});

test('empty stdin exits 0', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, '', { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('an unresolvable session model writes nothing but still exits 0', async () => {
  const state = tmp();
  const r = await runHook(SCRIPT, {
    session_id: 'sess-2',
    hook_event_name: 'SessionStart',
    model: 'claude-neptune-9',
    cwd: tmp(),
  }, { SUBAGENT_MODEL_POLICY_STATE_DIR: state, HOME: tmp(), USERPROFILE: tmp() });

  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(state), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/capture-session-model.test.mjs`
Expected: FAIL — `Cannot find module .../hooks/capture-session-model.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/capture-session-model.mjs`:

```js
#!/usr/bin/env node
/**
 * SessionStart hook: resolve this session's model and cache it, so the
 * PreToolUse hook can read it later. PreToolUse receives no model field of
 * its own, which is the reason this second hook exists at all.
 *
 * Always exits 0 with empty stdout.
 */
import { resolveSessionModel } from './lib/resolve-model.mjs';
import { writeSessionModel } from './lib/state.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const input = JSON.parse(raw);
  const resolved = resolveSessionModel({
    model: input.model,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
  });
  if (!resolved) return;

  writeSessionModel(input.session_id, resolved.model, resolved.source);
}

main().catch(() => {}).finally(() => process.exit(0));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/capture-session-model.test.mjs`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add hooks/capture-session-model.mjs tests/helpers/run-hook.mjs tests/capture-session-model.test.mjs
git commit -m "feat: SessionStart hook caches the session model"
```

---

### Task 7: PreToolUse enforcement hook

This is the task that implements the policy. It covers spec test cases 1–9, 11, and 12.

**Files:**
- Create: `hooks/enforce-subagent-model.mjs`
- Test: `tests/enforce-subagent-model.test.mjs`

**Interfaces:**
- Consumes: `normalizeModel` (Task 2), `readSessionModel` (Task 4), `readAgentPolicy` (Task 5), `runHook` (Task 6)
- Produces: hook JSON on stdout when — and only when — a rewrite is warranted:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecisionReason": "model policy: sonnet → opus (inherit)",
    "updatedInput": { "subagent_type": "…", "prompt": "…", "model": "opus" }
  }
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/enforce-subagent-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './helpers/run-hook.mjs';

const SCRIPT = 'hooks/enforce-subagent-model.mjs';
const tmp = (p = 'smp-enforce-') => mkdtempSync(join(tmpdir(), p));

function seedState(sessionId, model) {
  const dir = tmp('smp-state-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ model, source: 'session-start' }));
  return dir;
}

function seedAgent(name, frontmatter) {
  const root = tmp('smp-proj-');
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody.\n`);
  return root;
}

const call = (sessionId, toolInput, cwd) => ({
  session_id: sessionId,
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  cwd,
  tool_input: { prompt: 'do a thing', ...toolInput },
});

const parse = (stdout) => JSON.parse(stdout).hookSpecificOutput;

// --- Case 1: pinned agent keeps its model ---------------------------------
test('case 1: a pinned agent keeps its configured model', async () => {
  const state = seedState('s1', 'opus');
  const cwd = seedAgent('scanner', 'name: scanner\nmodel: haiku\nmodel-policy: pinned');
  const r = await runHook(SCRIPT, call('s1', { subagent_type: 'scanner' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', 'no rewrite for a pinned agent');
});

// --- Case 2: inherited agent follows the session --------------------------
test('case 2: an unpinned agent is redirected to the session model', async () => {
  const state = seedState('s2', 'opus');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s2', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });

  const out = parse(r.stdout);
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.updatedInput.model, 'opus');
  assert.equal(out.updatedInput.prompt, 'do a thing', 'other tool input must be preserved');
  assert.equal(out.updatedInput.subagent_type, 'copied');
  assert.match(out.permissionDecisionReason, /sonnet.*opus/);
});

// --- Case 3: no-op when already matching ----------------------------------
test('case 3: no rewrite when the agent already matches the session', async () => {
  const state = seedState('s3', 'opus');
  const cwd = seedAgent('aligned', 'name: aligned\nmodel: opus');
  const r = await runHook(SCRIPT, call('s3', { subagent_type: 'aligned' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.stdout.trim(), '');
});

// --- Cases 4-9: fail open --------------------------------------------------
test('case 4: an unknown session model fails open', async () => {
  const state = seedState('s4', 'claude-neptune-9');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s4', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('case 5: a missing state file fails open', async () => {
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('never-seeded', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: tmp('smp-empty-') });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('case 6: malformed stdin fails open', async () => {
  const r = await runHook(SCRIPT, '{{{ not json at all',
    { SUBAGENT_MODEL_POLICY_STATE_DIR: tmp('smp-empty-') });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('case 7: a missing agent definition fails open', async () => {
  const state = seedState('s7', 'opus');
  const r = await runHook(SCRIPT, call('s7', { subagent_type: 'does-not-exist' }, tmp()),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('case 8: a corrupt state file fails open', async () => {
  const dir = tmp('smp-state-');
  writeFileSync(join(dir, 's8.json'), '{{{');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s8', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('case 9: no fixture ever emits a deny decision', async () => {
  const state = seedState('s9', 'opus');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const inputs = [
    call('s9', { subagent_type: 'copied' }, cwd),
    call('s9', { subagent_type: 'does-not-exist' }, cwd),
    call('missing', { subagent_type: 'copied' }, cwd),
    call('s9', {}, cwd),
  ];
  for (const input of inputs) {
    const r = await runHook(SCRIPT, input, { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('"deny"'), 'the policy must never block a subagent');
  }
});

// --- Cases 11-12: normalization -------------------------------------------
test('case 11: a full session model ID is emitted as an alias', async () => {
  const state = seedState('s11', 'claude-opus-5');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s11', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'opus');
});

test('case 12: a pin is honoured when the model is a full ID', async () => {
  const state = seedState('s12', 'opus');
  const cwd = seedAgent('full', 'name: full\nmodel: claude-haiku-4-5-20251001\nmodel-policy: pinned');
  const r = await runHook(SCRIPT, call('s12', { subagent_type: 'full' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.stdout.trim(), '');
});

// --- Effective-model precedence (spec section 5) ---------------------------
test('a caller-supplied model outranks frontmatter when deciding to rewrite', async () => {
  const state = seedState('s13', 'opus');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s13', { subagent_type: 'copied', model: 'haiku' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.match(parse(r.stdout).permissionDecisionReason, /haiku.*opus/);
});

test('no rewrite when the caller already asked for the session model', async () => {
  const state = seedState('s14', 'opus');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s14', { subagent_type: 'copied', model: 'opus' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.stdout.trim(), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/enforce-subagent-model.test.mjs`
Expected: FAIL — `Cannot find module .../hooks/enforce-subagent-model.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/enforce-subagent-model.mjs`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green, 14 tests in this file

- [ ] **Step 5: Commit**

```bash
git add hooks/enforce-subagent-model.mjs tests/enforce-subagent-model.test.mjs
git commit -m "feat: PreToolUse hook redirects unpinned subagents to the session model"
```

---

### Task 8: Hook registration and live matcher discovery

Two facts cannot be settled by fixtures (Spec §9). This task resolves both against a running Claude Code before the plugin is declared working.

**Files:**
- Create: `hooks/hooks.json`
- Create: `docs/verification/2026-07-27-live-checks.md`

**Interfaces:**
- Consumes: both hook scripts from Tasks 6 and 7
- Produces: a `hooks.json` Claude Code loads on plugin install

- [ ] **Step 1: Write the registration**

Create `hooks/hooks.json`:

```json
{
  "description": "Keep subagents on the session's model unless explicitly pinned",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/capture-session-model.mjs\"",
            "async": false
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Task|Agent",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/enforce-subagent-model.mjs\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Install the plugin locally from the working tree**

```bash
claude plugin marketplace add C:/Users/Pc/Herd/subagent-model-policy
claude plugin install subagent-model-policy@subagent-model-policy
```

Then in a fresh Claude Code session run `/hooks` and confirm both entries appear
under `SessionStart` and `PreToolUse`.

- [ ] **Step 3: Discover the real tool name**

Temporarily add a catch-all logging hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{require('fs').appendFileSync(require('os').tmpdir()+'/tool-names.log',JSON.parse(d).tool_name+'\\n')}catch{}process.exit(0)})\""
          }
        ]
      }
    ]
  }
}
```

Spawn any subagent, then read the log:

```bash
cat "$TMPDIR/tool-names.log" | sort -u
```

Record whether the subagent tool reports as `Task` or `Agent`. **Remove the
catch-all hook afterwards.** The shipped matcher `Task|Agent` covers both — this
step exists to prove the hook actually fires, not to change the matcher.

- [ ] **Step 4: Determine whether `updatedInput` applies without `permissionDecision`**

With the plugin installed and a session on Opus, spawn a subagent whose
definition declares `model: sonnet` and no pin. Then read the session transcript
to see which model the subagent actually ran on:

```bash
node -e "const fs=require('fs');const p=process.argv[1];for(const l of fs.readFileSync(p,'utf8').split('\n')){if(!l.trim())continue;try{const e=JSON.parse(l);if(e.message?.model)console.log(e.type,e.message.model)}catch{}}" <transcript.jsonl>
```

- If the subagent ran on **opus** → the rewrite applies without
  `permissionDecision`. Leave the implementation as-is.
- If it ran on **sonnet** → the rewrite was ignored. Add
  `"permissionDecision": "allow"` to the `hookSpecificOutput` in
  `hooks/enforce-subagent-model.mjs`, re-run `npm test`, and document in the
  README that Agent calls are auto-approved as a consequence.

**Do not ask the subagent which model it is.** Models misreport their own
identity; the transcript is the only ground truth.

- [ ] **Step 5: Verify the custom frontmatter key is inert (spec test case 10)**

Create a scratch agent at `~/.claude/agents/smp-pin-check.md`:

```markdown
---
name: smp-pin-check
description: Scratch agent verifying that model-policy is an inert frontmatter key.
tools: Read
model: haiku
model-policy: pinned
---

Reply with the single word: ok
```

Spawn it. It must launch with no frontmatter warning and stay on haiku. If
Claude Code rejects the unknown key, switch the opt-out to a body marker
`<!-- model-policy: pinned -->`, update `parseFrontmatter` to also scan the body
for that marker, update the §4 docs, and re-run `npm test`. Delete the scratch
agent when done.

- [ ] **Step 6: Record the findings**

Write `docs/verification/2026-07-27-live-checks.md` with the actual observed
values — the real `tool_name`, whether `permissionDecision` was needed, and
whether the custom key was accepted. Include the transcript lines as evidence.
Do not write this file before running the checks.

- [ ] **Step 7: Commit**

```bash
git add hooks/hooks.json docs/verification/2026-07-27-live-checks.md
git commit -m "feat: register SessionStart and PreToolUse hooks, verify live behaviour"
```

---

### Task 9: `/subagent-model doctor` command

**Files:**
- Create: `hooks/doctor.mjs`
- Create: `commands/subagent-model.md`
- Test: `tests/doctor.test.mjs`

**Interfaces:**
- Consumes: `stateDir`, `readSessionModel` (Task 4)
- Produces: `node hooks/doctor.mjs <session_id>` printing a human-readable status report; exit 0 when healthy, 1 when the policy is not live.

- [ ] **Step 1: Write the failing test**

Create `tests/doctor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runDoctor(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'hooks/doctor.mjs'), ...args],
      { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('reports the captured session model when state exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  writeFileSync(join(dir, 'live.json'), JSON.stringify({ model: 'opus', source: 'session-start' }));
  const r = await runDoctor(['live'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /session model\s+ok/i);
  assert.match(r.stdout, /opus/);
  assert.match(r.stdout, /session-start/);
});

test('reports a failure when no state was captured for the session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor(['missing'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /session model\s+FAIL/i);
});

test('always reports the state directory it inspected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor(['whatever'], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.ok(r.stdout.includes(dir));
});

test('a missing session id argument does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-doc-'));
  const r = await runDoctor([], { SUBAGENT_MODEL_POLICY_STATE_DIR: dir });
  assert.ok(r.code === 0 || r.code === 1);
  assert.match(r.stdout, /session id/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/doctor.test.mjs`
Expected: FAIL — `Cannot find module .../hooks/doctor.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `hooks/doctor.mjs`:

```js
#!/usr/bin/env node
/** Self-test for subagent-model-policy. Usage: node doctor.mjs <session_id> */
import { existsSync, readdirSync } from 'node:fs';
import { stateDir, readSessionModel } from './lib/state.mjs';

const sessionId = process.argv[2];
const dir = stateDir();
const rows = [];
let healthy = true;

function row(label, ok, detail) {
  rows.push({ label, ok, detail });
  if (!ok) healthy = false;
}

row('state directory', existsSync(dir), dir);

if (!sessionId) {
  row('session id', false, 'no session id given — pass $CLAUDE_SESSION_ID');
} else {
  const state = readSessionModel(sessionId);
  row('session model', Boolean(state),
    state ? `${state.model} (via ${state.source})` : `no state captured for ${sessionId}`);
}

let count = 0;
try {
  count = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
} catch { /* directory may not exist yet */ }
row('cached sessions', true, String(count));

const width = Math.max(...rows.map((r) => r.label.length));
console.log('subagent-model-policy\n');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(width)}  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.detail}`);
}
console.log(healthy
  ? '\nPolicy is live. Subagents inherit the session model unless pinned.'
  : '\nPolicy is NOT live. Start a fresh session so SessionStart can run.');

process.exit(healthy ? 0 : 1);
```

- [ ] **Step 4: Write the slash command**

Create `commands/subagent-model.md`:

```markdown
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites green

- [ ] **Step 6: Commit**

```bash
git add hooks/doctor.mjs commands/subagent-model.md tests/doctor.test.mjs
git commit -m "feat: add /subagent-model doctor self-test"
```

---

### Task 10: Skill documentation

The skill is documentation and tooling only — it enforces nothing (Spec §5).

**Files:**
- Create: `skills/subagent-model-policy/SKILL.md`
- Test: `tests/skill.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: a skill Claude Code loads on plugin install

- [ ] **Step 1: Write the failing test**

Create `tests/skill.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'skills/subagent-model-policy/SKILL.md'), 'utf8');

test('the skill has valid frontmatter with name and description', () => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
  assert.ok(fm, 'SKILL.md must open with a frontmatter block');
  assert.match(fm[1], /^name:\s*subagent-model-policy$/m);
  assert.match(fm[1], /^description:\s*\S/m);
});

test('the skill documents the exact opt-out syntax', () => {
  assert.match(skill, /model-policy:\s*pinned/);
});

test('the skill states that it does not enforce the policy itself', () => {
  assert.match(skill, /hook/i);
  assert.match(skill, /does not enforce|enforces nothing|not the enforcement/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skill.test.mjs`
Expected: FAIL — `ENOENT ... skills/subagent-model-policy/SKILL.md`

- [ ] **Step 3: Write the skill**

Create `skills/subagent-model-policy/SKILL.md`:

```markdown
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites green

- [ ] **Step 5: Commit**

```bash
git add skills/subagent-model-policy/SKILL.md tests/skill.test.mjs
git commit -m "docs: add subagent-model-policy skill"
```

---

### Task 11: End-to-end verification and publish

**Files:**
- Modify: `README.md`
- Modify: `docs/verification/2026-07-27-live-checks.md`

**Interfaces:**
- Consumes: everything
- Produces: a pushed, installable plugin at `onestudio-exp/subagent-model-policy`

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS — every suite, zero failures. Record the total test count.

- [ ] **Step 2: Verify a real subagent obeys the policy**

In a fresh Claude Code session on Opus with the plugin installed:

1. Create a scratch agent `~/.claude/agents/smp-e2e.md` with `model: sonnet`,
   no pin, `tools: Read`, and a one-line body.
2. Spawn it.
3. Read the session transcript JSONL and confirm the subagent's assistant
   messages record an **opus** model.
4. Add `model-policy: pinned` to the same file, start a fresh session, spawn it
   again, and confirm it now records **sonnet**.
5. Delete the scratch agent.

Both directions must hold. One passing direction only proves the hook fires, not
that the pin is honoured.

- [ ] **Step 3: Update the README with verified behaviour**

Replace any claim in `README.md` that the live checks contradicted — in
particular, if `permissionDecision: "allow"` turned out to be required, document
that Agent calls are auto-approved and why.

- [ ] **Step 4: Commit and push**

```bash
git add README.md docs/verification/2026-07-27-live-checks.md
git commit -m "docs: record end-to-end verification results"
git push origin main
```

- [ ] **Step 5: Verify the install path a teammate will actually use**

On a clean state (`claude plugin marketplace remove subagent-model-policy` first
if the local one is still registered):

```bash
claude plugin marketplace add onestudio-exp/subagent-model-policy
claude plugin install subagent-model-policy@subagent-model-policy
```

Start a fresh session, run `/subagent-model doctor`, and confirm every row reads
`ok`. This is the last gate — the plugin is not done until the published path
works, not just the local one.

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
| --- | --- |
| §2 Policy | Tasks 5, 7 |
| §3 Non-goals | Global Constraints; asserted in Tasks 4, 7 (cases 4–9) |
| §4 Opt-out truth table | Task 5, all four rows tested individually |
| §5 Mechanism + effective model | Tasks 6, 7, 8 |
| §5 Visibility (`permissionDecisionReason`) | Task 7, case 2 |
| §6 Fallback ladder + normalization | Tasks 2, 3 |
| §7 Agent lookup + scope precedence | Task 5 |
| §8 Fail open | Tasks 4, 6, 7 — cases 4–9 |
| §9 Test cases 1–12 | Cases 1–9, 11, 12 in Task 7; case 10 in Task 8 Step 5 |
| §9 Live checks | Task 8, Steps 3–4 |
| §10 Repo layout | Tasks 1, 8, 9, 10 |
| §11 Module boundaries | Tasks 2–5 are the `lib/` modules; 6–7 the entry points |
| §12 Assumption 1 (org access) | Confirmed before planning; Task 11 Step 5 verifies the install path |

**Type consistency:** `normalizeModel` returns `alias|null` and is used that way
in Tasks 3, 5, and 7. `readAgentPolicy` returns `{model, pinned, path}|null` and
Task 7 checks `!agent` before `agent.pinned`. `readSessionModel` returns
`{model, source}|null`; Task 7 and Task 9 both handle the null branch.
`runHook(relScript, input, env)` is defined in Task 6 and reused unchanged in
Tasks 7 and 9.

**Known deliberate gap:** built-in agents (`Explore`, `Plan`, `general-purpose`)
have no definition file, so Task 7 fails open on them and an explicit
per-call `model` on a built-in is not corrected. This is Spec §7's documented
consequence, accepted during design review.
