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
