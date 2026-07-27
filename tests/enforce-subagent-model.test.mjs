import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './helpers/run-hook.mjs';

const SCRIPT = 'hooks/enforce-subagent-model.mjs';
const tmp = (p = 'smp-enforce-') => mkdtempSync(join(tmpdir(), p));

function seedState(sessionId, model, source = 'session-start') {
  const dir = tmp('smp-state-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ model, source }));
  return dir;
}

function seedAgent(name, frontmatter) {
  const root = tmp('smp-proj-');
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody.\n`);
  return root;
}

/** A transcript JSONL whose last main-session assistant turn names `model`. */
function seedTranscript(model) {
  const dir = tmp('smp-transcript-');
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { model } }));
  return path;
}

/**
 * A "turn one" transcript: it exists and has real content, but carries no
 * assistant entry at all — assistant turns are flushed only after the turn
 * completes, so this is what the file looks like on the very first tool call
 * of a session (spec §6, "Source strength, and why the transcript is not
 * enough"), mirroring the measured
 * `{"tp_present":true,"exists":true,"bytes":49038,"assistantModels":[]}`.
 * `modelFromTranscript` must miss on this and let the hook fall back to the
 * cache — this is the fixture the last fix attempt did not have.
 */
function seedTurnOneTranscript() {
  const dir = tmp('smp-transcript-turn1-');
  const path = join(dir, 'transcript.jsonl');
  const lines = [
    { type: 'queue-operation', op: 'enqueue' },
    { type: 'attachment', name: 'notes.txt' },
    { type: 'user', message: { role: 'user', content: 'do a thing' } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

const call = (sessionId, toolInput, cwd, transcriptPath) => ({
  session_id: sessionId,
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  cwd,
  transcript_path: transcriptPath,
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

// --- Fix 1: resolve at dispatch time, preferring the transcript ------------
// The session model must be resolved fresh at PreToolUse time, not merely
// read from the SessionStart cache — see spec §5/§6 (corrected 2026-07-27).

test('dispatch-time fix 1a: the transcript wins over a stale cache', async () => {
  const state = seedState('s15', 'sonnet'); // stale: session-start cache says sonnet
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const transcript = seedTranscript('claude-opus-5'); // ground truth at dispatch time: opus
  const r = await runHook(SCRIPT, call('s15', { subagent_type: 'copied' }, cwd, transcript),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'opus', 'transcript must win over the cache');
});

test('dispatch-time fix 1b: with no transcript_path at all, the cache fallback still works', async () => {
  const state = seedState('s16', 'opus');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('s16', { subagent_type: 'copied' }, cwd /* no transcript */),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'opus', 'cache fallback must still work');
});

test('dispatch-time fix 1c: an unreadable/missing transcript falls back to the cache without throwing', async () => {
  const state = seedState('s17', 'opus');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const missingTranscript = join(tmp('smp-missing-'), 'does-not-exist.jsonl');
  const r = await runHook(SCRIPT, call('s17', { subagent_type: 'copied' }, cwd, missingTranscript),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(parse(r.stdout).updatedInput.model, 'opus', 'must fall back to the cache, not throw');
});

test('dispatch-time fix 1d: neither transcript nor cache yields a model — emits nothing, exit 0', async () => {
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const missingTranscript = join(tmp('smp-missing-'), 'nope.jsonl');
  const r = await runHook(SCRIPT, call('never-seeded', { subagent_type: 'copied' }, cwd, missingTranscript),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: tmp('smp-empty-') });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('dispatch-time fix 1e (regression for the Critical): a deliberate `model: opus` matching the true session model is left alone, even with a stale sonnet cache', async () => {
  const state = seedState('s18', 'sonnet'); // the stale cache that produced the original defect
  const cwd = seedAgent('deliberate', 'name: deliberate\nmodel: opus'); // deliberately declared, unpinned
  const transcript = seedTranscript('claude-opus-5'); // the real session is on opus
  const r = await runHook(SCRIPT, call('s18', { subagent_type: 'deliberate' }, cwd, transcript),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '',
    'must not downgrade opus->sonnet: under the old cache-only resolution this was the exact harm the plugin exists to prevent');
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

// --- Weak-source no-downgrade rule (spec §6, "Source strength, and why the
// transcript is not enough") -------------------------------------------------
// `settings` is a weak source: configuration, not observation. A weak source
// may upgrade a subagent but must never downgrade one — the previous fix
// (preferring the transcript) still left this hole open on turn one, when
// the transcript exists but carries no assistant entry yet.

test('THE CRITICAL REGRESSION: a weak (settings) session model must not downgrade a deliberate declaration, even on a real turn-one transcript', async () => {
  const state = seedState('w1', 'sonnet', 'settings'); // weak: settings.json says sonnet
  const cwd = seedAgent('deliberate', 'name: deliberate\nmodel: opus'); // deliberately declared, unpinned
  const transcript = seedTurnOneTranscript(); // exists, has content, no assistant turn yet
  const r = await runHook(SCRIPT, call('w1', { subagent_type: 'deliberate' }, cwd, transcript),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '',
    'a weak (settings) source must never downgrade opus->sonnet — this is the Critical this fix exists for');
});

test('THE CRITICAL REGRESSION, without any transcript_path at all: same weak-source downgrade must still not happen', async () => {
  const state = seedState('w1b', 'sonnet', 'settings');
  const cwd = seedAgent('deliberate', 'name: deliberate\nmodel: opus');
  const r = await runHook(SCRIPT, call('w1b', { subagent_type: 'deliberate' }, cwd /* no transcript_path */),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', 'no transcript at all must fall to the cache and still honour the no-downgrade rule');
});

test('weak-source upgrade still works: settings says opus, agent declares sonnet -> rewritten to opus', async () => {
  const state = seedState('w2', 'opus', 'settings');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('w2', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'opus', 'an upgrade from a weak source must still work — this is the plugin\'s actual use case');
});

test('weak-source upgrade still works: settings says sonnet, agent declares haiku -> rewritten to sonnet', async () => {
  const state = seedState('w3', 'sonnet', 'settings');
  const cwd = seedAgent('cheap', 'name: cheap\nmodel: haiku');
  const r = await runHook(SCRIPT, call('w3', { subagent_type: 'cheap' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'sonnet');
});

test('strong source (session-start cache) may still downgrade: sonnet session, agent declares opus -> rewritten to sonnet', async () => {
  const state = seedState('w4', 'sonnet', 'session-start');
  const cwd = seedAgent('deliberate', 'name: deliberate\nmodel: opus');
  const r = await runHook(SCRIPT, call('w4', { subagent_type: 'deliberate' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'sonnet', 'a strong source is a proven session model — that downgrade is legitimate inheritance');
});

test('strong source (a populated transcript) may still downgrade: sonnet transcript, agent declares opus -> rewritten to sonnet', async () => {
  const state = seedState('w5', 'opus', 'settings'); // would matter only if the transcript missed
  const cwd = seedAgent('deliberate', 'name: deliberate\nmodel: opus');
  const transcript = seedTranscript('claude-sonnet-5'); // populated: this is rung 2, strong
  const r = await runHook(SCRIPT, call('w5', { subagent_type: 'deliberate' }, cwd, transcript),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(parse(r.stdout).updatedInput.model, 'sonnet', 'a populated transcript is strong evidence and may downgrade');
});

test('weak source, fable as the session model: emits nothing (unranked)', async () => {
  const state = seedState('w6', 'fable', 'settings');
  const cwd = seedAgent('copied', 'name: copied\nmodel: sonnet');
  const r = await runHook(SCRIPT, call('w6', { subagent_type: 'copied' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.stdout.trim(), '', 'fable is unranked; a weak-source comparison against it must invent no ordering');
});

test('weak source, fable as the agent declaration: emits nothing (unranked)', async () => {
  const state = seedState('w7', 'sonnet', 'settings');
  const cwd = seedAgent('storyteller', 'name: storyteller\nmodel: fable');
  const r = await runHook(SCRIPT, call('w7', { subagent_type: 'storyteller' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.stdout.trim(), '', 'fable is unranked; a weak-source comparison against it must invent no ordering');
});

test('a pinned agent stays pinned even under a weak source that would otherwise upgrade it', async () => {
  const state = seedState('w8', 'opus', 'settings');
  const cwd = seedAgent('scanner', 'name: scanner\nmodel: haiku\nmodel-policy: pinned');
  const r = await runHook(SCRIPT, call('w8', { subagent_type: 'scanner' }, cwd),
    { SUBAGENT_MODEL_POLICY_STATE_DIR: state });
  assert.equal(r.stdout.trim(), '', 'a pin is final regardless of source or rank');
});
