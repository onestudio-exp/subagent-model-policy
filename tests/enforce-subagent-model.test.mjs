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
