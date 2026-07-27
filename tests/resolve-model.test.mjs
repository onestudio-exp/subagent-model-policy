import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel, rankOf, sourceStrength, mayRewrite } from '../hooks/lib/resolve-model.mjs';

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

// --- Real settings.json values (Fix 2) --------------------------------------
// The cache rung reads settings.json directly, so a user on any of these
// real, live values must not silently lose policy coverage.

test('a context-window suffix like sonnet[1m] normalizes to its base alias — same model family', () => {
  assert.equal(normalizeModel('sonnet[1m]'), 'sonnet');
});

test('opusplan is deliberately left unresolved (null): it means "opus for planning, sonnet otherwise" and cannot be honestly collapsed to one alias', () => {
  assert.equal(normalizeModel('opusplan'), null);
});

test('default is deliberately left unresolved (null): it names no specific model', () => {
  assert.equal(normalizeModel('default'), null);
});

// --- Word-boundary behaviour (Fix 8) ----------------------------------------
// normalizeModel's only non-trivial line is the word-boundary regex applied
// to full Claude model IDs. A bare alias substring inside a longer word must
// never be mistaken for a boundary match.

test('a bare alias appearing as a substring inside a longer word is not a boundary match', () => {
  assert.equal(normalizeModel('claude-octopus-5'), null, '"opus" inside "octopus" is not a match');
  assert.equal(normalizeModel('claude-affable-model'), null, '"fable" inside "affable" is not a match');
  assert.equal(normalizeModel('claude-sonnets-5'), null, '"sonnet" immediately followed by another letter is not a match');
});

// --- Rank table, source strength, and the downgrade decision (spec §6,
// "Source strength, and why the transcript is not enough") ------------------

test('rankOf ranks opus above sonnet above haiku', () => {
  assert.ok(rankOf('opus') > rankOf('sonnet'));
  assert.ok(rankOf('sonnet') > rankOf('haiku'));
});

test('rankOf leaves fable unranked — it is a different kind of model, not a cheaper or dearer one', () => {
  assert.equal(rankOf('fable'), null);
});

test('rankOf never ranks an unknown alias', () => {
  assert.equal(rankOf('neptune'), null);
  assert.equal(rankOf('claude-opus-5'), null, 'rankOf takes an already-normalized alias, not a full model ID');
  assert.equal(rankOf(undefined), null);
  assert.equal(rankOf(null), null);
  assert.equal(rankOf(''), null);
});

test('sourceStrength: transcript and session-start are strong, settings is weak', () => {
  assert.equal(sourceStrength('transcript'), 'strong');
  assert.equal(sourceStrength('session-start'), 'strong');
  assert.equal(sourceStrength('settings'), 'weak');
});

test('sourceStrength treats an unrecognised source as weak — the conservative default', () => {
  assert.equal(sourceStrength('unknown'), 'weak');
  assert.equal(sourceStrength('some-future-source'), 'weak');
  assert.equal(sourceStrength(undefined), 'weak');
});

test('mayRewrite: a strong source may always rewrite, including a downgrade', () => {
  assert.equal(mayRewrite('transcript', 'sonnet', 'opus'), true);
  assert.equal(mayRewrite('session-start', 'sonnet', 'opus'), true);
  assert.equal(mayRewrite('transcript', 'haiku', 'opus'), true);
});

test('mayRewrite: a weak source may upgrade (session outranks or equals the declared model)', () => {
  assert.equal(mayRewrite('settings', 'opus', 'sonnet'), true);
  assert.equal(mayRewrite('settings', 'sonnet', 'haiku'), true);
  assert.equal(mayRewrite('settings', 'opus', 'haiku'), true);
});

test('mayRewrite: a weak source may never downgrade (the Critical this task fixes)', () => {
  assert.equal(mayRewrite('settings', 'sonnet', 'opus'), false);
  assert.equal(mayRewrite('settings', 'haiku', 'sonnet'), false);
  assert.equal(mayRewrite('settings', 'haiku', 'opus'), false);
});

test('mayRewrite: a weak source with fable on either side never rewrites — no ordering is invented', () => {
  assert.equal(mayRewrite('settings', 'fable', 'sonnet'), false);
  assert.equal(mayRewrite('settings', 'sonnet', 'fable'), false);
  assert.equal(mayRewrite('settings', 'fable', 'fable'), false);
});

test('mayRewrite: a strong source is not subject to the fable exemption — it may still rewrite when different', () => {
  assert.equal(mayRewrite('transcript', 'opus', 'fable'), true);
  assert.equal(mayRewrite('session-start', 'fable', 'sonnet'), true);
});
