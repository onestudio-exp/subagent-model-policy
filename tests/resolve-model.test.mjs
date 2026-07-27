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
