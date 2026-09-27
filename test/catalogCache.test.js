import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-catalog-'));
process.env.CODEX_CLAUDE_BRIDGE_HOME = directory;
const { createBridge } = await import('../src/server.js');
const { DEFAULTS } = await import('../src/config.js');
const { State } = await import('../src/state.js');

test('catalog fallback preserves client and account lists across outages and restarts', async (t) => {
  let available = true;
  let malformed = false;
  const upstream = http.createServer((req, res) => {
    if (!available) { res.writeHead(503); return res.end(); }
    res.setHeader('content-type', 'application/json');
    const slug = req.headers['chatgpt-account-id'] === 'account-b' ? 'gpt-account-b'
      : req.url.includes('0.145.0') ? 'gpt-5.5' : 'gpt-6-astra';
    res.end(JSON.stringify(malformed ? { models: 'invalid' } : {
      models: [{ slug, display_name: slug, visibility: 'list', priority: 1 }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = { ...DEFAULTS, upstream: `http://127.0.0.1:${upstream.address().port}`, logLevel: 'error' };
  const stateFile = path.join(directory, 'state.json');
  const state = new State(stateFile);
  const bridge = createBridge(config, state);
  const restarted = createBridge(config, new State(path.join(directory, 'unused.json')));
  const servers = [upstream, bridge.server, restarted.server];
  t.after(async () => {
    clearTimeout(state.timer);
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  async function catalog(version, account = 'account-a', server = bridge.server) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/models?client_version=${version}`, {
      headers: { authorization: 'Bearer test', 'chatgpt-account-id': account },
    });
    return { status: response.status, data: await response.json() };
  }
  function gpt(result) { return result.data.models?.filter((m) => !m.slug.startsWith('claude-')).map((m) => m.slug); }
  assert.deepEqual(gpt(await catalog('0.158.0')), ['gpt-6-astra']);
  assert.deepEqual(gpt(await catalog('0.145.0')), ['gpt-5.5']);
  available = false;
  assert.deepEqual(gpt(await catalog('0.158.0')), ['gpt-6-astra'], 'the older client must not replace the desktop fallback');
  available = true;
  assert.deepEqual(gpt(await catalog('0.158.0', 'account-b')), ['gpt-account-b']);
  available = false;
  assert.deepEqual(gpt(await catalog('0.158.0')), ['gpt-6-astra'], 'an old client or other account must not replace the desktop fallback');
  assert.deepEqual(gpt(await catalog('0.145.0')), ['gpt-5.5']);
  assert.deepEqual(gpt(await catalog('0.158.0', 'account-b')), ['gpt-account-b']);
  const uncached = await catalog('0.159.0');
  assert.equal(uncached.status, 503, 'do not publish an incomplete successful catalogue');
  assert.equal(uncached.data.models, undefined);
  state.flush();
  // Restore the persisted data as an actual new service instance would.
  restarted.state.data = new State(stateFile).data;
  await new Promise((resolve) => restarted.server.listen(0, '127.0.0.1', resolve));
  assert.deepEqual(gpt(await catalog('0.158.0', 'account-a', restarted.server)), ['gpt-6-astra']);
  available = true;
  malformed = true;
  assert.deepEqual(gpt(await catalog('0.158.0')), ['gpt-6-astra'], 'malformed responses cannot overwrite the last good list');
});
