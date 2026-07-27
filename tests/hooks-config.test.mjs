import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A typo in an event name, matcher, or script path leaves the plugin
// completely inert with an otherwise-green suite: every unit test below
// exercises hooks/*.mjs directly and would never notice that hooks.json
// itself fails to wire them up. This file is the only thing that reads
// hooks.json as Claude Code would.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'hooks/hooks.json'), 'utf8');

test('hooks.json parses as JSON', () => {
  assert.doesNotThrow(() => JSON.parse(raw));
});

const config = JSON.parse(raw);

test('both SessionStart and PreToolUse are registered', () => {
  assert.ok(Array.isArray(config.hooks?.SessionStart) && config.hooks.SessionStart.length > 0,
    'SessionStart must be registered');
  assert.ok(Array.isArray(config.hooks?.PreToolUse) && config.hooks.PreToolUse.length > 0,
    'PreToolUse must be registered');
});

test('the PreToolUse matcher covers both Task and Agent — the real tool name is Agent', () => {
  const matcher = config.hooks.PreToolUse[0].matcher;
  assert.match(matcher, /\bTask\b/, 'the historical name');
  assert.match(matcher, /\bAgent\b/, 'the name confirmed live against Claude Code 2.1.220');
});

test('the SessionStart matcher covers startup, resume, clear, compact, and fork', () => {
  const matcher = config.hooks.SessionStart[0].matcher;
  for (const event of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    assert.match(matcher, new RegExp(`\\b${event}\\b`), `matcher must include "${event}"`);
  }
});

test('every .mjs path referenced by a hook command exists on disk', () => {
  const commands = [];
  for (const eventGroups of Object.values(config.hooks)) {
    for (const group of eventGroups) {
      for (const h of group.hooks) {
        if (h.command) commands.push(h.command);
      }
    }
  }
  assert.ok(commands.length > 0, 'expected at least one hook command to check');

  for (const command of commands) {
    const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+\.mjs)/.exec(command);
    assert.ok(match, `command must reference a ${'${CLAUDE_PLUGIN_ROOT}'}-relative .mjs path: ${command}`);
    const relPath = match[1];
    const fullPath = join(root, relPath);
    assert.ok(existsSync(fullPath), `${relPath} referenced by hooks.json does not exist on disk`);
  }
});
