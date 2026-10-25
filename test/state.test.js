import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-state-'));
process.env.CODEX_CLAUDE_BRIDGE_HOME = directory;
const { State, CATALOG_KEY_LIMIT, catalogFileFor } = await import('../src/state.js');

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

const catalog = (slug, size = 2000) => [{ slug, display_name: slug, visibility: 'list', priority: 1, base_instructions: 'x'.repeat(size) }];

function stateFile(name) {
  const dir = fs.mkdtempSync(path.join(directory, `${name}-`));
  return path.join(dir, 'state.json');
}

test('legacy state migrates catalogs out of state.json, deduplicated and bounded, without writing at startup', async () => {
  const file = stateFile('legacy');
  const shared = catalog('gpt-6-astra', 20000);
  const upstreamCatalogs = {};
  for (let i = 0; i < 30; i++) upstreamCatalogs[`key-${i}`] = i === 29 ? catalog('gpt-account-b') : shared; // Most request contexts received the same list.
  const sessions = { 'session-1': { lastTurnId: 't1', threadId: 'thread-1', agentMessageIds: ['m1'], updatedAt: '2026-10-25T00:00:00.000Z' } };
  const legacyText = JSON.stringify({ sessions, contextWindows: { 'claude-opus-5-5': 1000000 }, upstreamModels: shared, upstreamCatalogs }, null, 2);
  fs.writeFileSync(file, legacyText);

  const state = new State(file);
  assert.equal(fs.readFileSync(file, 'utf8'), legacyText, 'constructing State must not rewrite the file (a failed second instance must not overwrite a running bridge)');
  assert.equal(fs.existsSync(catalogFileFor(file)), false);
  const stats = state.stats();
  assert.equal(stats.catalogKeys, CATALOG_KEY_LIMIT);
  assert.equal(stats.catalogBodies, 2, 'identical catalogs are stored once');
  assert.deepEqual(state.upstreamCatalog('key-29'), catalog('gpt-account-b'), 'the newest legacy contexts survive the bound');
  assert.deepEqual(state.upstreamCatalog('key-28'), shared);
  assert.equal(state.upstreamCatalog('key-0'), null, 'the oldest legacy contexts are dropped');
  assert.deepEqual(state.upstreamModels(), shared);
  assert.equal(state.ownerThread('session-1'), 'thread-1');
  assert.deepEqual(state.agentMessageIds('session-1'), ['m1']);

  state.recordTurn('session-2', 't2', 'thread-2');
  await new Promise((resolve) => setTimeout(resolve, 300)); // The ordinary 200 ms marker write, not an explicit flush.
  assert.ok(fs.existsSync(catalogFileFor(file)), 'migrated catalogs reach disk no later than the state file that drops them');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.upstreamCatalogs, undefined, 'catalogs no longer live in the per-turn state file');
  assert.equal(saved.upstreamModels, undefined);
  assert.equal(saved.catalogs, undefined);
  assert.deepEqual(saved.contextWindows, { 'claude-opus-5-5': 1000000 });
  assert.ok(fs.statSync(file).size < 2000, `state.json shrank to ${fs.statSync(file).size} bytes`);
  const catalogs = JSON.parse(fs.readFileSync(catalogFileFor(file), 'utf8'));
  assert.equal(Object.keys(catalogs.keys).length, CATALOG_KEY_LIMIT);
  assert.equal(Object.keys(catalogs.bodies).length, 2);

  const reloaded = new State(file);
  assert.deepEqual(reloaded.upstreamCatalog('key-29'), catalog('gpt-account-b'));
  assert.deepEqual(reloaded.upstreamModels(), shared);
  assert.equal(reloaded.isLatestTurn('session-2', 't2'), true, 'the turn marker is durable');
  assert.equal(reloaded.ownerThread('session-2'), 'thread-2');
});

test('unchanged catalogs and unchanged state cause no disk writes', () => {
  const file = stateFile('unchanged');
  const state = new State(file);
  state.setUpstreamModels(catalog('gpt-6-astra'), 'desktop');
  state.flush();
  assert.equal(state.stats().writes, 1, 'the first catalog is written');
  for (let i = 0; i < 50; i++) state.setUpstreamModels(catalog('gpt-6-astra'), 'desktop'); // Codex refetches the model list often.
  assert.equal(state.timer, null, 'an unchanged catalog does not even schedule a write');
  state.flush();
  assert.equal(state.stats().writes, 1);
  assert.equal(state.stats().unchangedCatalogs, 50);

  state.setUpstreamModels(catalog('gpt-6-astra'), 'cli'); // Same list for another client: one more key, still one body.
  state.flush();
  assert.equal(state.stats().writes, 2);
  assert.equal(state.stats().catalogBodies, 1);

  state.recordTurn('session', 'turn-1', 'thread');
  state.flush();
  const writesAfterTurn = state.stats().writes;
  const catalogMtime = fs.statSync(catalogFileFor(file)).mtimeMs;
  assert.equal(writesAfterTurn, 3, 'a turn rewrites only the small state file');
  state.save();
  state.flush();
  assert.equal(state.stats().writes, writesAfterTurn, 'identical state content is not rewritten');
  assert.equal(state.stats().skippedWrites, 1);
  assert.equal(fs.statSync(catalogFileFor(file)).mtimeMs, catalogMtime);
});

test('a catalog whose content changes on every fetch is written at most once per window, without delaying session markers', async () => {
  const file = stateFile('volatile');
  const state = new State(file, { catalogSaveDelayMs: 600 });
  for (let i = 0; i < 20; i++) state.setUpstreamModels([{ slug: 'gpt-6-astra', fetched: i }], 'desktop'); // For example a per-request field in the upstream list.
  state.recordTurn('session', 'turn-1', 'thread');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.session.lastTurnId, 'turn-1', 'the turn marker keeps its prompt 200 ms write');
  assert.equal(fs.existsSync(catalogFileFor(file)), false, 'catalog changes wait for their own window');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(state.stats().writes, 2, 'one state write and one catalog write for 20 catalog changes');
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogFileFor(file), 'utf8')).bodies[state.data.catalogs.keys.desktop.hash], [{ slug: 'gpt-6-astra', fetched: 19 }]);
  assert.equal(state.stats().catalogBodies, 1, 'superseded bodies are released');
});

test('per-context catalogs stay separate, evict least recently used contexts and release unused bodies', () => {
  const file = stateFile('bounded');
  const state = new State(file, { catalogKeyLimit: 3 });
  state.setUpstreamModels(catalog('gpt-old-client'), 'old-client');
  state.setUpstreamModels(catalog('gpt-desktop'), 'desktop');
  state.setUpstreamModels(catalog('gpt-account-b'), 'account-b');
  assert.deepEqual(state.upstreamCatalog('old-client'), catalog('gpt-old-client'), 'an outage serves each context its own list');
  state.setUpstreamModels(catalog('gpt-new-client'), 'new-client'); // Exceeds the bound: the least recently used context goes.
  assert.equal(state.upstreamCatalog('desktop'), null);
  assert.deepEqual(state.upstreamCatalog('old-client'), catalog('gpt-old-client'), 'serving a fallback counts as use');
  assert.deepEqual(state.upstreamCatalog('account-b'), catalog('gpt-account-b'));
  assert.equal(state.stats().catalogBodies, 3, 'the evicted context\'s body is released');
  state.flush();
  const restored = new State(file, { catalogKeyLimit: 3 });
  assert.deepEqual(restored.upstreamCatalog('new-client'), catalog('gpt-new-client'));
  assert.equal(restored.upstreamCatalog('desktop'), null);
});

test('continuous saves still write within the debounce window instead of postponing forever', async () => {
  const file = stateFile('debounce');
  const state = new State(file);
  const started = Date.now();
  let turn = 0;
  while (Date.now() - started < 700) {
    state.recordTurn('busy-session', `turn-${++turn}`, 'thread');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.ok(state.stats().writes >= 2, `got ${state.stats().writes} writes during 700 ms of continuous activity`);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).sessions['busy-session'].lastTurnId;
  assert.notEqual(onDisk, undefined);
  state.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions['busy-session'].lastTurnId, `turn-${turn}`);
});

test('a damaged catalog file starts empty without losing sessions', () => {
  const file = stateFile('damaged');
  fs.writeFileSync(file, JSON.stringify({ sessions: { s: { lastTurnId: 't', threadId: 'thread' } }, contextWindows: {} }));
  fs.writeFileSync(catalogFileFor(file), '{not json');
  const state = new State(file);
  assert.equal(state.upstreamModels(), null);
  assert.equal(state.stats().catalogKeys, 0);
  assert.equal(state.ownerThread('s'), 'thread');
});

test('failed catalog migration preserves fallback catalogs and new session markers, then retries cleanly', () => {
  const file = stateFile('migration-failure');
  const models = catalog('gpt-fallback');
  const legacy = { sessions: {}, upstreamModels: models, upstreamCatalogs: { desktop: models } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const state = new State(file);
  state.recordTurn('session', 'turn-1', 'thread');
  const original = fs.writeFileSync;
  const originalError = console.error;
  try {
    console.error = () => {};
    fs.writeFileSync = (target, ...args) => {
      if (String(target).startsWith(catalogFileFor(file))) throw new Error('simulated catalog disk failure');
      return original(target, ...args);
    };
    state.flush();
  } finally {
    fs.writeFileSync = original;
    console.error = originalError;
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.upstreamCatalogs, legacy.upstreamCatalogs, 'failed migration cannot discard the only durable fallback copy');
  assert.equal(saved.sessions.session.lastTurnId, 'turn-1', 'catalog failure must not prevent durable turn markers');
  assert.deepEqual(new State(file).upstreamCatalog('desktop'), models, 'a restart still recovers the fallback');
  state.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).upstreamCatalogs, undefined);
  assert.deepEqual(new State(file).upstreamCatalog('desktop'), models);
});
