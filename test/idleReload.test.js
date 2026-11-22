// Verifies reload safety and model-list refresh with disposable bridge processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { parseMarker } from '../src/codexInput.js';

async function startReloadBridge(t, scenario, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb reload test '));
  fs.cpSync(new URL('../src', import.meta.url), path.join(directory, 'src'), { recursive: true });
  fs.symlinkSync(new URL('../node_modules', import.meta.url).pathname, path.join(directory, 'node_modules'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const fixtureLog = path.join(directory, 'claude.log');
  const releaseFile = path.join(directory, 'release');
  const child = spawn(process.execPath, [path.join(directory, 'src/server.js')], {
    env: { ...process.env, CODEX_CLAUDE_BRIDGE_HOME: directory, CODEX_CLAUDE_BRIDGE_PORT: String(port), CODEX_CLAUDE_BRIDGE_CLAUDE: new URL('./fixtures/fake-claude.js', import.meta.url).pathname, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: fixtureLog, FAKE_CLAUDE_HOLD_FILE: releaseFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (data) => { log += data; });
  child.stderr.on('data', (data) => { log += data; });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill('SIGKILL');
    if (fs.existsSync(fixtureLog)) {
      for (const line of fs.readFileSync(fixtureLog, 'utf8').trim().split('\n')) {
        const pid = JSON.parse(line).pid;
        if (pid) { try { process.kill(pid); } catch {} } // An old bridge can exit with its waiting fixture still alive; clean up only this test's logged child.
      }
    }
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const readyDeadline = Date.now() + 2000;
  while (!log.includes('listening on') && child.exitCode === null && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(log, /listening on/);
  return { directory, releaseFile, fixtureLog, child, closed, log: () => log, url: `http://127.0.0.1:${port}/backend-api/codex/responses` };
}

test('model data hot swaps on an existing GPT WebSocket without restarting it', { timeout: 8000 }, async (t) => {
  const upstream = http.createServer((_req, res) => res.end(JSON.stringify({ models: [{ slug: 'gpt-test', visibility: 'list', priority: 1 }] })));
  const wss = new WebSocketServer({ server: upstream });
  let connections = 0;
  wss.on('connection', (socket) => {
    connections++;
    socket.on('message', () => socket.send('GPT_OK'));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); upstream.close(); });
  const bridge = await startReloadBridge(t, 'tools', { upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex` });
  const socket = new WebSocket(bridge.url.replace('http:', 'ws:'), { headers: { 'x-codex-routing-hint': 'model=gpt-test' } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const gptReply = () => {
    const reply = once(socket, 'message');
    socket.send(JSON.stringify({ model: 'gpt-test', input: [] }));
    return reply.then(([data]) => data.toString());
  };
  assert.equal(await gptReply(), 'GPT_OK');
  const file = path.join(bridge.directory, 'src/models.json');
  const added = { slug: 'claude-hot-test', displayName: 'Hot test', claudeModel: 'fake-added-model' };
  fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, 'utf8')), added]));
  const catalog = await (await fetch(bridge.url.replace('/responses', '/models'))).json();
  assert.ok(catalog.models.some((model) => model.slug === added.slug));
  assert.equal(catalog.models.find((model) => model.slug === 'claude-fable-5-1').visibility, 'hide');
  assert.equal(catalog.models.find((model) => model.slug === 'claude-fable-5-2').visibility, 'list');
  assert.equal(await gptReply(), 'GPT_OK');
  assert.equal(connections, 1, 'the original GPT transport stays open');
  const frameModel = { ...added, claudeModel: 'fake-frame-model' };
  fs.writeFileSync(file, JSON.stringify([frameModel])); // No HTTP refresh precedes the next frame: the existing connection must observe the edit itself.
  const completed = new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'response.completed') { socket.off('message', onMessage); resolve(event); }
      if (event.type === 'error') reject(new Error(JSON.stringify(event)));
    };
    socket.on('message', onMessage);
  });
  socket.send(JSON.stringify({ model: added.slug, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context><cwd>${bridge.directory}</cwd></environment_context>` }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ] }));
  assert.equal((await completed).response.end_turn, true);
  const call = JSON.parse(fs.readFileSync(bridge.fixtureLog, 'utf8').trim().split('\n').at(-1));
  assert.equal(call.args[call.args.indexOf('--model') + 1], frameModel.claudeModel);
  const fresh = { ...added, slug: 'claude-fresh-hint-test' };
  fs.writeFileSync(file, JSON.stringify([fresh])); // No HTTP request or existing-socket frame precedes this new model's upgrade.
  const hinted = new WebSocket(bridge.url.replace('http:', 'ws:'), { headers: { 'x-codex-routing-hint': `model=${fresh.slug}` } });
  t.after(() => hinted.terminate());
  await once(hinted, 'open');
  assert.equal(connections, 1, 'a newly added Claude hint is accepted locally without opening another GPT socket');
  const generated = once(hinted, 'message');
  hinted.send(JSON.stringify({ model: fresh.slug, generate: false, input: [] }));
  assert.equal(JSON.parse((await generated)[0].toString()).type, 'response.created');
  assert.equal(bridge.child.exitCode, null, bridge.log());
});

test('model reload preserves running and retired Claude routes and rejects broken edits', { timeout: 8000 }, async (t) => {
  const bridge = await startReloadBridge(t, 'hold-native');
  const health = () => fetch(new URL('/health', bridge.url)).then((response) => response.json());
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context><cwd>${bridge.directory}</cwd></environment_context>` }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ];
  const request = (model) => fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) });
  const response = await request('claude-fable-5-1');
  const reader = response.body.getReader();
  await reader.read();
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(bridge.fixtureLog) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(bridge.fixtureLog));
  const added = { slug: 'claude-hot-test', displayName: 'Hot test', claudeModel: 'fake-added-model' };
  const modelFile = path.join(bridge.directory, 'src/models.json');
  fs.writeFileSync(modelFile, JSON.stringify([added]));
  let live = await health();
  assert.deepEqual(live.models, [added.slug]);
  assert.equal(live.diagnostics.claude.running, 1, 'the already-admitted native turn remains alive');
  fs.writeFileSync(bridge.releaseFile, 'finish');
  let body = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; body += new TextDecoder().decode(chunk.value); }
  assert.match(body, /response.completed/);
  assert.match(await (await request('claude-fable-5-1')).text(), /response.completed/, 'removed catalogue entries remain routable for existing chats');
  const configFile = path.join(bridge.directory, 'config.json');
  fs.writeFileSync(configFile, '{');
  assert.deepEqual((await health()).models, [added.slug]);
  fs.writeFileSync(configFile, JSON.stringify({ models: [added, added] }));
  assert.deepEqual((await health()).models, [added.slug]);
  fs.writeFileSync(configFile, JSON.stringify({ models: null }));
  assert.deepEqual((await health()).models, [added.slug]);
  fs.writeFileSync(configFile, JSON.stringify({ models: [{ ...added, hidden: 'true' }] }));
  assert.deepEqual((await health()).models, [added.slug]);
  assert.equal(bridge.log().split('invalid model configuration; keeping the last valid model catalog').length - 1, 1, 'a broken edit logs once until recovery');
  const replacement = { ...added, slug: 'claude-next-test', claudeModel: 'fake-next-model' };
  fs.writeFileSync(configFile, JSON.stringify({ models: [replacement], claudePath: '/not-a-real-cli', port: 1 }));
  live = await health();
  assert.deepEqual(live.models, [replacement.slug]);
  assert.equal(live.diagnostics.pid, bridge.child.pid);
  assert.match(await (await request(replacement.slug)).text(), /response.completed/, 'unrelated executable settings are not hot swapped');
  const calls = fs.readFileSync(bridge.fixtureLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args[call.args.indexOf('--model') + 1]), ['claude-fable-5-1', 'claude-fable-5-1', 'fake-next-model']);
  assert.equal(bridge.child.exitCode, null, bridge.log());
});

test('source reload waits for a Claude turn between Codex tool responses', { timeout: 8000 }, async (t) => {
  const bridge = await startReloadBridge(t, 'codex-tools');
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use a Codex tool' }] }];
  const tools = [{ type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] }];
  const request = async (items) => {
    const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': 'reload-owner' }, body: JSON.stringify({ model: 'claude-opus-5-5', input: items, tools }) });
    const text = await response.text();
    return text.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'response.completed').response;
  };
  const first = await request(input);
  const call = first.output.find((item) => item.type === 'function_call');
  assert.ok(call);
  fs.appendFileSync(path.join(bridge.directory, 'src/toolDisplay.js'), '\n'); // Only the isolated source copy changes; the production watcher and active chats are untouched.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(bridge.child.exitCode, null, `Reload must wait for the native turn, even after its HTTP response ends: ${bridge.log()}`);
  const finished = await request([...input, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'reload waited correctly' }]);
  assert.equal(finished.end_turn, true);
  assert.match(finished.output.find((item) => item.type === 'message').content[0].text, /reload waited correctly/);
  await bridge.closed;
  assert.equal(bridge.child.exitCode, 0, bridge.log());
  const marker = parseMarker(finished.output.find((item) => item.encrypted_content)?.encrypted_content);
  assert.ok(marker, 'the completed response must carry its session marker');
  const saved = JSON.parse(fs.readFileSync(path.join(bridge.directory, 'state.json'), 'utf8'));
  assert.equal(saved.sessions[marker.sid]?.lastTurnId, marker.turnId, 'reload must save the final marker that Codex received');
  assert.equal(saved.sessions[marker.sid]?.threadId, 'reload-owner');
});

test('source reload waits for disconnected compaction without saving an undelivered marker', { timeout: 8000 }, async (t) => {
  const bridge = await startReloadBridge(t, 'hold-compact');
  const session = '11111111-1111-4111-8111-111111111111';
  const input = [
    { type: 'reasoning', summary: [], encrypted_content: `ccb:v1:${session}:initial` },
    { type: 'compaction_trigger' },
  ];
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', input }),
  });
  const reader = response.body.getReader();
  await reader.read();
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(path.join(bridge.directory, 'claude.log')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(bridge.directory, 'claude.log')), `the native compaction must have started: ${bridge.log()}`);
  await reader.cancel();
  fs.appendFileSync(path.join(bridge.directory, 'src/toolDisplay.js'), '\n');
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(bridge.child.exitCode, null, `Reload must wait for compaction after its HTTP response disconnects: ${bridge.log()}`);
  fs.writeFileSync(bridge.releaseFile, 'finish');
  await bridge.closed;
  assert.equal(bridge.child.exitCode, 0, bridge.log());
  const stateFile = path.join(bridge.directory, 'state.json');
  const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  assert.equal(saved.sessions?.[session], undefined, 'the disconnected response cannot publish a new session marker');
});
