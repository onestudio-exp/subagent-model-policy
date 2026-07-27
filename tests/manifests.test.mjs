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

test('plugin.json declares an author name — README claims MIT © OneStudio', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.author?.name, 'OneStudio');
});

test('marketplace.json points at this directory as the plugin source', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'subagent-model-policy');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'subagent-model-policy');
  assert.equal(market.plugins[0].source, './');
});

test('marketplace.json declares an owner name — required by /plugin marketplace add', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.owner?.name, 'OneStudio');
});

test('package.json is ESM with a test script', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.scripts.test, /node --test/);
  assert.equal(pkg.dependencies, undefined, 'must have zero runtime dependencies');
});
