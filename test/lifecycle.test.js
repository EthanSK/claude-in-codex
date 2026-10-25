import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-lifecycle-'));
process.env.CODEX_CLAUDE_BRIDGE_HOME = tmp;
const fakeClaude = new URL('./fixtures/fake-claude.js', import.meta.url).pathname;
fs.chmodSync(fakeClaude, 0o755);
const claudeLog = path.join(tmp, 'claude.log');
process.env.FAKE_CLAUDE_LOG = claudeLog;

const { createBridge } = await import('../src/server.js');
const { DEFAULTS } = await import('../src/config.js');
const { State } = await import('../src/state.js');
const { createProcessStopper, closeStdioAfterExit, hasPendingProcessCleanup } = await import('../src/processControl.js');

// Bridge info lines, captured so lifecycle events can be asserted without printing them.
const logLines = [];
const consoleLog = console.log;
console.log = (...parts) => logLines.push(parts.join(' '));

let upstream;
let upstreamRequests = [];
let upstreamFrames = 0;
let bridge;
let port;
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-lifecycle-work-'));
const spawnedPids = new Set();

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamRequests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n');
    });
  });
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {
      upstreamFrames++;
      socket.write(Buffer.from([0x81, 0x02, 0x4f, 0x4b]));
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = {
    ...DEFAULTS,
    upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    claudePath: fakeClaude,
    codexComputerUseMcpConfig: null,
    keepAliveSeconds: 60,
    logLevel: 'info',
    claudeStopGraceMs: 150,
  };
  bridge = createBridge(config, new State(path.join(tmp, 'state.json')));
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  port = bridge.server.address().port;
});

after(async () => {
  console.log = consoleLog;
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

const userMsg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const envContext = { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${workdir}</cwd>\n</environment_context>` }] };
const tools = [{ type: 'namespace', name: 'codex_app', description: 'Codex app tools.', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] }];
const body = (model, input, extra = {}) => JSON.stringify({ model, instructions: 'codex base prompt', input, tools, stream: true, ...extra });

function request(pathname, { method = 'POST', payload, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const responses = (thread, payload) => request('/backend-api/codex/responses', { payload, headers: thread ? { 'thread-id': thread } : {} });
const doneItems = (data) => data.split('\n\n').filter((block) => block.includes('data: ')).map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6))).filter((event) => event.type === 'response.output_item.done').map((event) => event.item);
const lastEvent = (data) => data.split('\n\n').filter((block) => block.includes('data: ')).map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6))).at(-1);
const claudeCalls = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const health = async () => JSON.parse((await request('/health', { method: 'GET' })).data).diagnostics;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(predicate, ms = 4000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Starts a Claude turn that hands a Codex tool call back and waits for its result. */
async function handOff(thread, { webSocket } = {}) {
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  try {
    const before = claudeCalls().length;
    const input = [envContext, userMsg(`list my tasks in ${thread}`)];
    let items;
    if (webSocket) {
      const completed = await webSocketTurn(webSocket, { ...JSON.parse(body('claude-opus-5-5', input)), client_metadata: { thread_id: thread } });
      items = completed.response.output;
    } else {
      items = doneItems((await responses(thread, body('claude-opus-5-5', input))).data);
    }
    await waitFor(() => claudeCalls().length > before, 2000, 'the fake Claude log');
    const call = claudeCalls().at(-1);
    spawnedPids.add(call.pid);
    if (call.grandchildPid) spawnedPids.add(call.grandchildPid);
    return { input, items, call: items.find((item) => item.type === 'function_call'), pid: call.pid, grandchildPid: call.grandchildPid };
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}

function webSocketTurn(socket, frame) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket turn timed out')), 3000);
    const onMessage = (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'response.completed' || event.type === 'error') {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(event);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'response.create', ...frame }));
  });
}

async function openSocket(headers = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`, { headers });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}

test('a GPT agent turn in the same chat stops the Claude process still waiting for its Codex tool result', async () => {
  const thread = 'switch-to-gpt';
  const before = await health();
  const handoff = await handOff(thread);
  assert.ok(handoff.call, 'Claude handed a tool call to Codex');
  const waiting = await health();
  assert.equal(waiting.claude.waiting, before.claude.waiting + 1);
  const entry = waiting.turns.find((turn) => turn.pid === handoff.pid);
  assert.deepEqual({ thread: entry.thread, state: entry.state, kind: entry.kind, handoffs: entry.handoffs }, { thread, state: 'waiting', kind: 'turn', handoffs: 1 });
  assert.doesNotMatch(JSON.stringify(waiting), /list my tasks/, 'diagnostics never carry prompt text');

  upstreamRequests = [];
  const switched = await responses(thread, body('gpt-6-sol', [...handoff.input, ...handoff.items, userMsg('carry on in GPT')]));
  assert.equal(switched.status, 200);
  assert.equal(upstreamRequests.length, 1, 'the GPT turn still reaches OpenAI');
  await waitFor(() => !alive(handoff.pid), 4000, 'the abandoned Claude process to exit');
  await waitFor(async () => (await health()).claude.waiting === before.claude.waiting, 2000, 'the waiting count to drop');
  const after = await health();
  assert.equal(after.claude.running, before.claude.running);
  assert.equal(after.claude.stopping, 0);
  assert.equal(after.claude.totals.cancelled, before.claude.totals.cancelled + 1);
  assert.equal(after.claude.totals.exited, after.claude.totals.spawned, 'every spawned process was counted out exactly once');
  assert.ok(logLines.some((line) => line.includes('lifecycle model-switch') && line.includes(`thread=${thread}`) && line.includes('route=http')));
  assert.ok(logLines.some((line) => line.includes('lifecycle exit') && line.includes(`pid=${handoff.pid}`) && line.includes('reason=gpt-switch')));
});

test('GPT traffic in other chats, housekeeping, prewarms, auxiliary calls and unidentified requests leave a waiting tool alone', async () => {
  const thread = 'keep-waiting';
  const handoff = await handOff(thread);
  const continuing = [...handoff.input, ...handoff.items, userMsg('a GPT side chat inherits this history')];
  await responses('another-chat', body('gpt-6-sol', continuing)); // A side chat or sub-agent has its own thread ID, even with the parent's pending call in its history.
  await responses(thread, JSON.stringify({ model: 'gpt-6-sol', input: [...continuing], stream: true })); // Housekeeping: no tools or environment.
  await responses(thread, body('gpt-6-sol', [envContext, userMsg('Review this proposed command.')])); // An agent-shaped GPT call sharing the thread ID without the pending call is not this chat moving on.
  assert.ok(logLines.some((line) => line.includes('lifecycle model-switch-kept-waiting') && line.includes(`thread=${thread}`)));
  await responses(null, body('gpt-6-sol', continuing));
  const socket = await openSocket({ 'x-codex-routing-hint': 'model=gpt-6-sol' });
  try {
    const prewarmed = new Promise((resolve) => socket.once('message', resolve));
    socket.send(JSON.stringify({ type: 'response.create', ...JSON.parse(body('gpt-6-sol', continuing)), generate: false, client_metadata: { thread_id: thread } })); // Picking GPT in the picker can prewarm with the whole chat; only a real GPT turn moves on.
    await prewarmed;
  } finally {
    socket.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(alive(handoff.pid), 'none of those requests may stop the waiting Claude process');
  assert.equal((await health()).turns.find((turn) => turn.pid === handoff.pid)?.state, 'waiting');

  const output = { type: 'function_call_output', call_id: handoff.call.call_id, output: 'two tasks' };
  const finished = await responses(thread, body('claude-opus-5-5', [...handoff.input, ...handoff.items, output]));
  assert.equal(lastEvent(finished.data).response.end_turn, true);
  assert.match(doneItems(finished.data).find((item) => item.type === 'message').content[0].text, /Codex said: two tasks/);
  assert.equal(claudeCalls().at(-1).pid, handoff.pid, 'the same Claude process received the long-running tool result');
});

test('a dropped WebSocket keeps the waiting turn for a reconnect, and a GPT turn on the new socket stops it', async () => {
  const thread = 'ws-switch';
  const first = await openSocket();
  const handoff = await handOff(thread, { webSocket: first });
  assert.ok(handoff.call);
  first.close();
  await once(first, 'close');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(alive(handoff.pid), 'a reconnecting client must still be able to return the tool result');

  const second = await openSocket();
  try {
    const before = upstreamFrames;
    const reply = new Promise((resolve) => second.once('message', (data) => resolve(data.toString())));
    second.send(JSON.stringify({ type: 'response.create', ...JSON.parse(body('gpt-6-sol', [...handoff.input, ...handoff.items, userMsg('switch this chat to GPT')])), client_metadata: { thread_id: thread } })); // A reconnect has no cached response, so Codex replays the chat, including the pending call.
    assert.equal(await reply, 'OK');
    assert.ok(upstreamFrames > before, 'the GPT frame reached the upstream socket');
    await waitFor(() => !alive(handoff.pid), 4000, 'the waiting Claude process to exit');
    assert.ok(logLines.some((line) => line.includes('lifecycle model-switch') && line.includes(`thread=${thread}`) && line.includes('route=websocket')));
  } finally {
    second.close();
  }
  await waitFor(async () => (await health()).websockets.clients === 0, 2000, 'closed sockets to leave diagnostics');
});

test('stopping a wedged Claude process escalates to SIGKILL for it and its descendants, then the chat resumes', async () => {
  const thread = 'wedged-claude';
  process.env.FAKE_CLAUDE_IGNORE_STOP = '1';
  process.env.FAKE_CLAUDE_GRANDCHILD = '1';
  let handoff;
  try {
    handoff = await handOff(thread);
  } finally {
    delete process.env.FAKE_CLAUDE_IGNORE_STOP;
    delete process.env.FAKE_CLAUDE_GRANDCHILD;
  }
  assert.ok(alive(handoff.pid) && alive(handoff.grandchildPid));
  const started = Date.now();
  const next = await responses(thread, body('claude-opus-5-5', [...handoff.input, ...handoff.items, userMsg('never mind, do this instead')]));
  assert.equal(lastEvent(next.data).response.end_turn, true, 'the new request runs after the old process is gone');
  assert.ok(Date.now() - started < 5000, 'cancellation is bounded');
  await waitFor(() => !alive(handoff.pid) && !alive(handoff.grandchildPid), 2000, 'the wedged tree to be killed');
  assert.ok(logLines.some((line) => line.includes('lifecycle signal') && line.includes(`pid=${handoff.pid}`) && line.includes('signal=SIGTERM')));
  assert.ok(logLines.some((line) => line.includes('lifecycle signal') && line.includes(`pid=${handoff.pid}`) && line.includes('signal=SIGKILL')));
  assert.ok(logLines.some((line) => line.includes('lifecycle exit') && line.includes(`pid=${handoff.pid}`) && line.includes('reason=new-request')));
  const latest = claudeCalls().at(-1);
  assert.notEqual(latest.pid, handoff.pid);
  assert.ok(latest.args.includes('--resume'), 'the cancelled session is resumed, not lost');
});

test('a politely exiting parent cannot leave a stubborn MCP descendant behind, and unrelated processes survive', async () => {
  const script = "const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', \"process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] }); c.stdout.once('data', () => console.log(c.pid)); process.on('SIGINT', () => process.exit(0)); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  spawnedPids.add(unrelated.pid);
  const [line] = await once(child.stdout, 'data');
  const grandchild = Number(String(line).trim());
  spawnedPids.add(grandchild);
  const escalations = [];
  const stopper = createProcessStopper(child, { graceMs: 100, killGraceMs: 100, onEscalate: (signal) => escalations.push(signal) });
  stopper.stop();
  stopper.stop();
  await once(child, 'exit');
  assert.ok(hasPendingProcessCleanup(), 'idle reload cannot skip orphan cleanup just because the parent exited');
  await waitFor(() => !alive(grandchild), 2000, 'the orphaned MCP process to exit');
  await waitFor(() => !hasPendingProcessCleanup(), 2000, 'cleanup completion');
  assert.deepEqual(escalations, ['SIGTERM', 'SIGKILL']);
  assert.ok(alive(unrelated.pid), 'nothing outside the captured tree is signalled');
});

test('a parent that shuts down its own child needs no escalation', async () => {
  const script = "const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); console.log(c.pid); process.on('SIGINT', () => { c.kill(); c.once('exit', () => process.exit(0)); }); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(child.stdout, 'data');
  const grandchild = Number(String(line).trim());
  spawnedPids.add(child.pid);
  spawnedPids.add(grandchild);
  const escalations = [];
  createProcessStopper(child, { graceMs: 100, killGraceMs: 100, onEscalate: (signal) => escalations.push(signal) }).stop();
  await once(child, 'exit');
  await waitFor(() => !hasPendingProcessCleanup(), 2000, 'graceful cleanup completion');
  assert.deepEqual(escalations, []);
  assert.equal(alive(grandchild), false);
});

test('stdio is released when a descendant keeps the exited process\'s output pipe open', async () => {
  const script = "const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); console.log(c.pid); setTimeout(() => process.exit(0), 50);";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  let forced = 0;
  closeStdioAfterExit(child, 150, () => forced++);
  const closed = once(child, 'close');
  await once(child, 'exit');
  await waitFor(() => output.trim().length > 0, 1000, 'the grandchild pid');
  spawnedPids.add(Number(output.trim()));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('close never fired')), 2000))]);
  assert.equal(forced, 1);
});
