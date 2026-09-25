import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import WebSocket from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-test-'));
process.env.CODEX_CLAUDE_BRIDGE_HOME = tmp;
const fakeClaude = new URL('./fixtures/fake-claude.js', import.meta.url).pathname;
fs.chmodSync(fakeClaude, 0o755);
const claudeLog = path.join(tmp, 'claude.log');
process.env.FAKE_CLAUDE_LOG = claudeLog;

const { createBridge } = await import('../src/server.js');
const { DEFAULTS, findCodexComputerUseMcpConfig } = await import('../src/config.js');
const { State } = await import('../src/state.js');
const { mergeCatalog } = await import('../src/catalog.js');

let upstream;
let upstreamRequests = [];
let upstreamUpgradeRequests = [];
// Raw bytes the bridge wrote to the fake upstream over WebSocket (decode with decodeClientTextFrames).
let upstreamWsData = Buffer.alloc(0);
let bridge;
let port;
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-work-'));
const fakeMcpConfig = path.join(tmp, 'computer-use.json');
fs.writeFileSync(fakeMcpConfig, '{}');

const GPT_MODEL = {
  slug: 'gpt-6-sol',
  display_name: 'GPT-6 Sol',
  description: 'gpt',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'medium', description: 'm' }],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
  availability_nux: null,
  upgrade: null,
  comp_hash: 'abc',
  guardian: { x: 1 },
};

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      upstreamRequests.push({ url: req.url, headers: req.headers, body: raw.toString('utf8') });
      if (req.url.startsWith('/backend-api/codex/models')) {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"up1"' });
        return res.end(JSON.stringify({ models: [GPT_MODEL] }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n');
    });
  });
  upstream.on('upgrade', (req, socket) => {
    upstreamUpgradeRequests.push({ url: req.url, headers: req.headers });
    const accept = crypto.createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (chunk) => {
      upstreamWsData = Buffer.concat([upstreamWsData, chunk]);
      socket.write(Buffer.from([0x81, 0x02, 0x4f, 0x4b]));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const config = {
    ...DEFAULTS,
    port: 0,
    upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    claudePath: fakeClaude,
    codexComputerUseMcpConfig: fakeMcpConfig,
    keepAliveSeconds: 60,
    logLevel: 'error',
  };
  bridge = createBridge(config, new State(path.join(tmp, 'state.json')));
  await new Promise((r) => bridge.server.listen(0, '127.0.0.1', r));
  port = bridge.server.address().port;
});

after(() => {
  bridge.server.close();
  upstream.close();
});

function request(pathname, { method = 'POST', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { authorization: 'Bearer test', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function parseSse(data) {
  return data
    .split('\n\n')
    .filter((b) => b.includes('data: '))
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
}

function webSocketTurn(socket, body) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', onMessage); reject(new Error('WebSocket turn timed out')); }, 3000);
    const onMessage = (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'response.completed' || event.type === 'error') {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(event);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'response.create', ...body }));
  });
}

function envContext(cwd) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n</environment_context>` }],
  };
}
const perms = {
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: '<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing.\n</permissions instructions>' }],
};
const agents = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nBe terse.\n</INSTRUCTIONS>' }],
};
const memory = {
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: '## Memory\nRead memory when relevant.\n========= MEMORY_SUMMARY BEGINS =========\nRemember the project.\n========= MEMORY_SUMMARY ENDS =========' }],
};
const userMsg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function responsesBody(model, input, extra = {}) {
  return JSON.stringify({ model, instructions: 'codex base prompt', input, tools: [{ type: 'function', name: 'shell' }], stream: true, reasoning: { effort: 'xhigh' }, ...extra });
}

const readClaudeLog = () => fs.readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Decodes the masked client-to-server text frames the bridge sent to the fake
// upstream. The fake never agrees to permessage-deflate, so payloads are plain.
function decodeClientTextFrames(buf) {
  const texts = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) {
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    const mask = buf.subarray(off, off + 4);
    off += 4;
    if (off + len > buf.length) break;
    const payload = Buffer.alloc(len);
    for (let k = 0; k < len; k++) payload[k] = buf[off + k] ^ mask[k % 4];
    if (opcode === 0x1) texts.push(payload.toString('utf8'));
    i = off + len;
  }
  return texts;
}

test('model catalog adds Claude models after GPT', async () => {
  const r = await request('/backend-api/codex/models?client_version=1.0', { method: 'GET' });
  assert.equal(r.status, 200);
  const { models } = JSON.parse(r.data);
  assert.deepEqual(models.map((m) => m.slug), ['gpt-6-sol', 'claude-opus-5-5', 'claude-fable-5-1']);
  const opus = models[1];
  assert.equal(opus.display_name, 'Opus 5.5');
  assert.equal(models[2].display_name, 'Fable 5.1', 'picker names always include the model version');
  assert.equal(opus.comp_hash, 'abc', 'keeps comp_hash so switching models does not force compaction');
  assert.equal(opus.guardian, undefined);
  assert.ok(opus.priority > 1);
  assert.ok(r.headers.etag.startsWith('"ccb-'));
  assert.ok(upstreamRequests.at(-1).url.includes('client_version=1.0'));
  assert.equal(upstreamRequests.at(-1).headers.authorization, 'Bearer test');
});

test('hidden upstream models stay available without appearing in the picker', () => {
  const hiddenModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  const olderModels = hiddenModels.map((slug, index) => ({ ...GPT_MODEL, slug, priority: index + 4 }));
  const models = mergeCatalog({ ...DEFAULTS, hiddenModels }, new State(path.join(tmp, 'hidden-state.json')), [GPT_MODEL, ...olderModels]);
  for (const slug of hiddenModels) assert.equal(models.find((model) => model.slug === slug).visibility, 'hide');
  assert.equal(models.find((model) => model.slug === 'gpt-6-sol').visibility, 'list');
  assert.deepEqual(models.slice(-2).map((model) => model.slug), ['claude-opus-5-5', 'claude-fable-5-1']);
});

test('Claude turn streams text, reasoning, web search and a marker; second turn resumes', async () => {
  fs.rmSync(claudeLog, { force: true });
  const input1 = [perms, agents, memory, envContext(workdir), userMsg('fix the bug')];
  const r1 = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', input1), headers: { 'content-type': 'application/json' } });
  assert.equal(r1.status, 200);
  const ev = parseSse(r1.data);
  const types = ev.map((e) => e.type);
  assert.equal(types[0], 'response.created');
  assert.equal(types.at(-1), 'response.completed');
  const done = ev.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const messages = done.filter((i) => i.type === 'message');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content[0].text, "I'll check the file.");
  assert.equal(messages[0].phase, 'commentary');
  assert.equal(messages[1].content[0].text, 'Done.');
  assert.equal(messages[1].phase, 'final_answer');
  const reasoning = done.filter((i) => i.type === 'reasoning');
  assert.ok(reasoning.some((i) => i.summary[0]?.text === 'Considering the repo.'));
  assert.ok(reasoning.some((i) => i.summary[0]?.text === '**Editing** `src/a.ts` (+2 −1)'));
  const web = done.find((i) => i.type === 'web_search_call');
  assert.deepEqual(web.action, { type: 'search', query: 'node zstd' });
  assert.equal(web.status, 'completed');
  const marker = reasoning.at(-1);
  assert.match(marker.encrypted_content, /^ccb:v1:/);
  assert.deepEqual(marker.summary, []);
  const completed = ev.at(-1).response;
  assert.equal(completed.usage.input_tokens, 1120);
  assert.equal(completed.usage.output_tokens, 55);
  assert.equal(completed.end_turn, true);

  const call1 = readClaudeLog()[0];
  assert.equal(call1.cwd, fs.realpathSync(workdir));
  assert.ok(call1.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(call1.args.slice(call1.args.indexOf('--effort'), call1.args.indexOf('--effort') + 2), ['--effort', 'xhigh']);
  assert.ok(!call1.args.includes('--resume'));
  assert.ok(call1.args[call1.args.indexOf('--append-system-prompt') + 1].includes('Be terse.'));
  assert.ok(call1.args[call1.args.indexOf('--append-system-prompt') + 1].includes('Remember the project.'));
  const mcpConfig = JSON.parse(call1.args[call1.args.indexOf('--mcp-config') + 1]);
  assert.equal(mcpConfig.mcpServers.cua_repl.env.CODEX_CUA_MCP_CONFIG_PATH, fakeMcpConfig);
  assert.equal(mcpConfig.mcpServers.cua_repl.env.CODEX_CUA_MODEL, 'claude-opus-5-5');
  assert.ok(mcpConfig.mcpServers.cua_repl.env.CODEX_CUA_SESSION_ID);
  assert.ok(mcpConfig.mcpServers.cua_repl.env.CODEX_CUA_TURN_ID);
  const sent1 = JSON.parse(call1.stdin);
  assert.equal(sent1.message.content[0].text, 'fix the bug');

  // Turn 2: Codex resends history including our output items plus the new prompt.
  const sid = marker.encrypted_content.split(':')[2];
  const input2 = [...input1, ...done, userMsg('now add a test')];
  await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', input2), headers: { 'content-type': 'application/json' } });
  const call2 = readClaudeLog()[1];
  assert.equal(call2.args[call2.args.indexOf('--resume') + 1], sid);
  assert.equal(JSON.parse(call2.stdin).message.content[0].text, 'now add a test');

});

test('an explicit full-permission configuration applies to missing modes and resumed turns, while plan mode remains plan', async () => {
  const originalModes = bridge.config.permissionModes;
  const originalDefault = bridge.config.defaultPermissionMode;
  bridge.config.permissionModes = Object.fromEntries(Object.keys(originalModes).map((mode) => [mode, 'bypassPermissions']));
  bridge.config.defaultPermissionMode = 'bypassPermissions';
  try {
    for (const mode of [null, 'workspace-write', 'read-only', 'danger-full-access']) {
      const modeInput = mode ? [{ ...perms, content: [{ type: 'input_text', text: `\`sandbox_mode\` is \`${mode}\`` }] }] : [];
      const before = readClaudeLog().length;
      const input = [...modeInput, envContext(workdir), userMsg('permission check')];
      const first = await request('/backend-api/codex/responses', { headers: { 'content-type': 'application/json' }, body: responsesBody('claude-opus-5-5', input) });
      const output = parseSse(first.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
      assert.ok(readClaudeLog().at(-1).args.includes('--dangerously-skip-permissions'), `new turn: ${mode}`);
      await request('/backend-api/codex/responses', { headers: { 'content-type': 'application/json' }, body: responsesBody('claude-opus-5-5', [...input, ...output, userMsg('continue')]) });
      const args = readClaudeLog().at(-1).args;
      assert.ok(args.includes('--dangerously-skip-permissions'), `resumed turn: ${mode}`);
      assert.ok(args.includes('--resume'));
      assert.equal(readClaudeLog().length, before + 2);
    }
    const plan = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<collaboration_mode># Plan Mode</collaboration_mode>' }] };
    await request('/backend-api/codex/responses', { headers: { 'content-type': 'application/json' }, body: responsesBody('claude-opus-5-5', [plan, envContext(workdir), userMsg('plan only')]) });
    const args = readClaudeLog().at(-1).args;
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  } finally {
    bridge.config.permissionModes = originalModes;
    bridge.config.defaultPermissionMode = originalDefault;
  }
});

test('computer-use config follows Codex plugin enablement', () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-codex-'));
  const pluginDir = path.join(codexRoot, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.917.62051');
  fs.mkdirSync(pluginDir, { recursive: true });
  const mcpConfig = path.join(pluginDir, '.mcp.json');
  fs.writeFileSync(mcpConfig, '{}');
  fs.writeFileSync(path.join(codexRoot, 'config.toml'), '[plugins."unified-computer-use@openai-bundled"]\nenabled = true\n');
  assert.equal(findCodexComputerUseMcpConfig(codexRoot), mcpConfig);
  fs.writeFileSync(path.join(codexRoot, 'config.toml'), '[plugins."unified-computer-use@openai-bundled"]\nenabled = false\n');
  assert.equal(findCodexComputerUseMcpConfig(codexRoot), null);
  fs.rmSync(codexRoot, { recursive: true, force: true });
});

test('computer-use proxy adds Codex turn metadata to MCP tool calls', async () => {
  const fakePluginConfig = path.join(tmp, 'fake-plugin.json');
  fs.writeFileSync(fakePluginConfig, JSON.stringify({ mcpServers: { cua_repl: { command: process.execPath, args: [new URL('./fixtures/fake-mcp.js', import.meta.url).pathname], enabled_tools: ['js', 'turn_ended'] } } }));
  const child = spawn(process.execPath, [new URL('../src/cuaMcpProxy.js', import.meta.url).pathname], {
    env: {
      ...process.env,
      CODEX_CUA_MCP_CONFIG_PATH: fakePluginConfig,
      CODEX_CUA_SESSION_ID: 'thread-1',
      CODEX_CUA_TURN_ID: 'turn-1',
      CODEX_CUA_MODEL: 'claude-fable-5-1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = readline.createInterface({ input: child.stdout });
  const nextResponse = () => new Promise((resolve) => responses.once('line', (line) => resolve(JSON.parse(line))));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} })}\n`);
  assert.deepEqual((await nextResponse()).result.tools.map((tool) => tool.name), ['js']);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState()' } } })}\n`);
  assert.deepEqual((await nextResponse()).result['x-codex-turn-metadata'], {
    session_id: 'thread-1', turn_id: 'turn-1', model: 'claude-fable-5-1',
  });
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
});

test('rollback to an earlier point starts a fresh session with the transcript', async () => {
  fs.rmSync(claudeLog, { force: true });
  const input1 = [envContext(workdir), userMsg('first')];
  const r1 = await request('/backend-api/codex/responses', { body: responsesBody('claude-fable-5-1', input1), headers: { 'content-type': 'application/json' } });
  const out1 = parseSse(r1.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const input2 = [...input1, ...out1, userMsg('second')];
  const r2 = await request('/backend-api/codex/responses', { body: responsesBody('claude-fable-5-1', input2), headers: { 'content-type': 'application/json' } });
  const out2 = parseSse(r2.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  assert.ok(out2.length);
  // User edits "second" -> Codex drops turn 2 and sends turn 1 history + edited prompt.
  const input3 = [...input1, ...out1, userMsg('second, edited')];
  await request('/backend-api/codex/responses', { body: responsesBody('claude-fable-5-1', input3), headers: { 'content-type': 'application/json' } });
  const calls = readClaudeLog();
  assert.equal(calls.length, 3);
  assert.ok(calls[1].args.includes('--resume'));
  assert.ok(!calls[2].args.includes('--resume'), 'stale marker -> new session');
  assert.match(JSON.parse(calls[2].stdin).message.content[0].text, /Assistant \(earlier in this Codex thread\):\nDone\./);
  const text = JSON.parse(calls[2].stdin).message.content[0].text;
  assert.match(text, /<codex_context>/);
  assert.match(text, /User:\nfirst/);
  assert.match(text, /second, edited$/);
});

test('model switch GPT -> Claude carries GPT output as context', async () => {
  fs.rmSync(claudeLog, { force: true });
  const input1 = [envContext(workdir), userMsg('a')];
  const r1 = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', input1), headers: { 'content-type': 'application/json' } });
  const out1 = parseSse(r1.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const gptTurn = [
    userMsg('b (to gpt)'),
    { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c1' },
    { type: 'function_call_output', call_id: 'c1', output: 'file1\nfile2' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'GPT listed files' }] },
  ];
  const input2 = [...input1, ...out1, ...gptTurn, userMsg('c (to claude)')];
  await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', input2), headers: { 'content-type': 'application/json' } });
  const call = readClaudeLog()[1];
  assert.ok(call.args.includes('--resume'));
  const text = JSON.parse(call.stdin).message.content[0].text;
  assert.match(text, /User:\nb \(to gpt\)/);
  assert.match(text, /\[shell call\]/);
  assert.match(text, /file1/);
  assert.match(text, /GPT listed files/);
  assert.match(text, /c \(to claude\)$/);
});

test('GPT requests pass through; bridge items are stripped; zstd bodies decoded', async () => {
  upstreamRequests = [];
  const plain = responsesBody('gpt-6-sol', [userMsg('hi')]);
  const r = await request('/backend-api/codex/responses', { body: plain, headers: { 'content-type': 'application/json', 'chatgpt-account-id': 'acc' } });
  assert.equal(r.status, 200);
  assert.match(r.data, /response.completed/);
  assert.equal(upstreamRequests[0].body, plain, 'untouched body forwarded as-is');
  assert.equal(upstreamRequests[0].headers['chatgpt-account-id'], 'acc');

  const withBridge = responsesBody('gpt-6-sol', [
    userMsg('hi'),
    { id: 'msg_ccb_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'claude said' }], phase: 'final_answer' },
    { id: 'rs_ccb_1', type: 'reasoning', summary: [], encrypted_content: 'ccb:v1:s:t' },
    { id: 'ws_ccb_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q' } },
  ]);
  if (typeof zlib.zstdCompressSync === 'function') {
    await request('/backend-api/codex/responses', {
      body: zlib.zstdCompressSync(Buffer.from(withBridge)),
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
    });
  } else {
    await request('/backend-api/codex/responses', { body: withBridge, headers: { 'content-type': 'application/json' } });
  }
  const fwd = upstreamRequests[1];
  assert.equal(fwd.headers['content-encoding'], undefined);
  const b = JSON.parse(fwd.body);
  assert.equal(b.input.length, 2);
  assert.equal(b.input[1].id, undefined);
  assert.equal(b.input[1].content[0].text, 'claude said');
});

test('housekeeping calls with a Claude model go to GPT', async () => {
  upstreamRequests = [];
  await request('/backend-api/codex/responses', {
    body: JSON.stringify({ model: 'claude-opus-5-5', input: [userMsg('title this')], tools: [], stream: true }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(JSON.parse(upstreamRequests[0].body).model, 'gpt-6-sol');
});

test('plan mode maps to Claude plan mode and returns a proposed_plan block', async () => {
  fs.rmSync(claudeLog, { force: true });
  process.env.FAKE_CLAUDE_SCENARIO = 'plan';
  const collab = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<collaboration_mode># Plan Mode (Conversational)\n...</collaboration_mode>' }] };
  const r = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [perms, collab, envContext(workdir), userMsg('plan it')]), headers: { 'content-type': 'application/json' } });
  delete process.env.FAKE_CLAUDE_SCENARIO;
  const call = readClaudeLog()[0];
  assert.deepEqual(call.args.slice(call.args.indexOf('--permission-mode'), call.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  const final = parseSse(r.data).filter((e) => e.type === 'response.output_item.done' && e.item.type === 'message').at(-1).item;
  assert.equal(final.phase, 'final_answer');
  assert.match(final.content[0].text, /<proposed_plan>\n1\. Do X\n2\. Do Y\n<\/proposed_plan>$/);
});

test('Claude errors surface as a message, not a retryable failure', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = 'error';
  const r = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [envContext(workdir), userMsg('x')]), headers: { 'content-type': 'application/json' } });
  delete process.env.FAKE_CLAUDE_SCENARIO;
  const ev = parseSse(r.data);
  assert.equal(ev.at(-1).type, 'response.completed');
  const final = ev.filter((e) => e.type === 'response.output_item.done' && e.item.type === 'message').at(-1).item;
  assert.match(final.content[0].text, /Usage limit reached/);
});

test('compaction of a Claude thread runs /compact and returns one compaction item', async () => {
  fs.rmSync(claudeLog, { force: true });
  const input1 = [envContext(workdir), userMsg('a')];
  const r1 = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', input1), headers: { 'content-type': 'application/json' } });
  const out1 = parseSse(r1.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const r2 = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [...input1, ...out1, { type: 'compaction_trigger' }]), headers: { 'content-type': 'application/json' } });
  const items = parseSse(r2.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  assert.equal(items.filter((i) => i.type === 'compaction').length, 1);
  const calls = readClaudeLog();
  assert.ok(calls[1].args.includes('/compact'));
  // Next turn after compaction resumes the same session.
  const cmp = items.find((i) => i.type === 'compaction');
  await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [envContext(workdir), cmp, userMsg('after')]), headers: { 'content-type': 'application/json' } });
  const last = readClaudeLog().at(-1);
  assert.ok(last.args.includes('--resume'));
  assert.equal(JSON.parse(last.stdin).message.content[0].text, 'after');
});

test('unhinted websocket prewarms GPT and Claude without an upgrade error', async () => {
  upstreamUpgradeRequests = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`, {
    headers: { authorization: 'Bearer test' },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', generate: false }));
    const gptPrewarm = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(data.toString()));
      socket.once('error', reject);
    });
    assert.equal(gptPrewarm, 'OK');
    assert.equal(upstreamUpgradeRequests[0].headers['x-codex-routing-hint'], 'model=gpt-6-astra');

    const priorClaudeCalls = readClaudeLog().length;
    socket.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5', generate: false }));
    const claudePrewarm = await new Promise((resolve, reject) => {
      const onMessage = (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'response.completed') {
          socket.off('message', onMessage);
          resolve(event);
        }
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
    assert.equal(claudePrewarm.response.model, 'claude-opus-5-5');
    assert.equal(readClaudeLog().length, priorClaudeCalls);
  } finally {
    socket.close();
  }
});

test('a fresh Opus websocket side chat reaches Claude and can later switch to GPT', async () => {
  upstreamUpgradeRequests = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`, {
    headers: { 'x-codex-routing-hint': 'model=claude-opus-5-5', authorization: 'Bearer test' },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    assert.match(socket.extensions, /permessage-deflate/);
    assert.equal(upstreamUpgradeRequests.length, 0, 'Claude does not open an OpenAI socket');

    const body = JSON.parse(responsesBody('claude-opus-5-5', [envContext(workdir), userMsg('fresh side hello')]));
    const priorClaudeCalls = readClaudeLog().length;
    socket.send(JSON.stringify({ type: 'response.create', ...body, generate: false }));
    const prewarm = await new Promise((resolve, reject) => {
      const onMessage = (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'response.completed') {
          socket.off('message', onMessage);
          resolve(event);
        }
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
    assert.equal(prewarm.response.model, 'claude-opus-5-5');
    assert.equal(readClaudeLog().length, priorClaudeCalls);

    socket.send(JSON.stringify({ type: 'response.create', ...body, client_metadata: { thread_id: 'fresh-side-test', turn_id: 'fresh-side-turn' } }));
    const events = await new Promise((resolve, reject) => {
      const received = [];
      const timeout = setTimeout(() => reject(new Error('fresh Claude websocket response timed out')), 3000);
      const onMessage = (data) => {
        const event = JSON.parse(data.toString());
        received.push(event);
        if (event.type === 'response.completed') {
          clearTimeout(timeout);
          socket.off('message', onMessage);
          resolve(received);
        }
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
    assert.ok(events.some((event) => event.type === 'response.output_text.delta'));
    assert.equal(events.at(-1).response.model, 'claude-opus-5-5');
    assert.equal(JSON.parse(readClaudeLog().at(-1).stdin).message.content[0].text, 'fresh side hello');
    assert.equal(upstreamUpgradeRequests.length, 0);

    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', input: [] }));
    const gptReply = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(data.toString()));
      socket.once('error', reject);
    });
    assert.equal(gptReply, 'OK');
    assert.equal(upstreamUpgradeRequests.length, 1);
    assert.equal(upstreamUpgradeRequests[0].headers['x-codex-routing-hint'], 'model=gpt-6-sol');
    assert.equal(upstreamUpgradeRequests[0].headers.authorization, 'Bearer test');
  } finally {
    socket.close();
  }
});

test('GPT websocket traffic and auth pass through to upstream', async () => {
  upstreamUpgradeRequests = [];
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-codex-routing-hint: model=gpt-6-sol;tier=priority\r\nAuthorization: Bearer test\r\n\r\n');
    });
    let data = Buffer.alloc(0);
    let handshake = false;
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (!handshake) {
        const boundary = data.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        assert.match(data.subarray(0, boundary).toString(), /^HTTP\/1\.1 101/);
        data = data.subarray(boundary + 4);
        handshake = true;
        socket.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0]));
      }
      if (data.length >= 4) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', reject);
  });
  assert.deepEqual(reply, Buffer.from([0x81, 0x02, 0x4f, 0x4b]));
  assert.equal(upstreamUpgradeRequests.length, 1);
  assert.equal(upstreamUpgradeRequests[0].url, '/backend-api/codex/responses');
  assert.equal(upstreamUpgradeRequests[0].headers.authorization, 'Bearer test');
});

test('an Opus side-chat turn on a GPT-prewarmed websocket goes to Claude', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`, {
    headers: { 'x-codex-routing-hint': 'model=gpt-6-sol', authorization: 'Bearer test' },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    assert.match(socket.extensions, /permessage-deflate/);
    // Codex can prewarm a side chat as GPT, then select Opus on the same socket.
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', generate: false }));
    const prewarm = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(data.toString()));
      socket.once('error', reject);
    });
    assert.equal(prewarm, 'OK');

    const body = JSON.parse(responsesBody('claude-opus-5-5', [envContext(workdir), userMsg('side hello')]));
    const priorClaudeCalls = readClaudeLog().length;
    socket.send(JSON.stringify({ type: 'response.create', ...body, generate: false }));
    const claudePrewarm = await new Promise((resolve, reject) => {
      const onMessage = (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'response.completed') {
          socket.off('message', onMessage);
          resolve(event);
        }
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
    assert.equal(claudePrewarm.response.model, 'claude-opus-5-5');
    assert.equal(readClaudeLog().length, priorClaudeCalls);

    socket.send(JSON.stringify({ type: 'response.create', ...body, client_metadata: { thread_id: 'side-chat-test', turn_id: 'side-turn-test' } }));
    const events = await new Promise((resolve, reject) => {
      const received = [];
      const timeout = setTimeout(() => reject(new Error('Claude websocket response timed out')), 3000);
      const onMessage = (data) => {
        const event = JSON.parse(data.toString());
        received.push(event);
        if (event.type === 'response.completed') {
          clearTimeout(timeout);
          socket.off('message', onMessage);
          resolve(received);
        }
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
    assert.ok(events.some((event) => event.type === 'response.output_text.delta'));
    assert.equal(events.at(-1).response.model, 'claude-opus-5-5');
    assert.equal(JSON.parse(readClaudeLog().at(-1).stdin).message.content[0].text, 'side hello');

    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', input: [] }));
    const resumedGpt = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(data.toString()));
      socket.once('error', reject);
    });
    assert.equal(resumedGpt, 'OK');
  } finally {
    socket.close();
  }
});

test('side-chat delta requests retain prewarm context, resume Claude, and replay history on a GPT switch', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const body = (input, extra = {}) => JSON.parse(responsesBody('claude-opus-5-5', input, extra));
  try {
    const before = readClaudeLog().length;
    const prewarm = await webSocketTurn(socket, body([perms, agents, envContext(workdir)], { generate: false }));
    assert.equal(readClaudeLog().length, before);
    const first = await webSocketTurn(socket, body([userMsg('remember apricot')], { previous_response_id: prewarm.response.id }));
    const firstCall = readClaudeLog().at(-1);
    assert.equal(firstCall.cwd, fs.realpathSync(workdir));
    assert.ok(firstCall.args.includes('--dangerously-skip-permissions'));
    assert.ok(firstCall.args[firstCall.args.indexOf('--append-system-prompt') + 1].includes('Be terse.'));
    const sid = first.response.output.find((item) => item.encrypted_content?.startsWith('ccb:v1:')).encrypted_content.split(':')[2];
    const second = await webSocketTurn(socket, body([userMsg('what word?')], { previous_response_id: first.response.id }));
    const secondCall = readClaudeLog().at(-1);
    assert.equal(secondCall.args[secondCall.args.indexOf('--resume') + 1], sid);
    assert.equal(secondCall.cwd, fs.realpathSync(workdir));
    assert.ok(secondCall.args.includes('--dangerously-skip-permissions'));
    assert.equal(JSON.parse(secondCall.stdin).message.content[0].text, 'what word?');

    upstreamWsData = Buffer.alloc(0);
    const gptReply = new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', previous_response_id: second.response.id, input: [userMsg('GPT continues')] }));
    assert.equal(await gptReply, 'OK');
    const forwarded = JSON.parse(decodeClientTextFrames(upstreamWsData).at(-1));
    assert.equal(forwarded.previous_response_id, undefined);
    assert.match(JSON.stringify(forwarded.input), /remember apricot/);
    assert.match(JSON.stringify(forwarded.input), /what word\?/);
    assert.match(JSON.stringify(forwarded.input), /GPT continues/);
    assert.doesNotMatch(JSON.stringify(forwarded), /ccb:v1:|msg_ccb_|rs_ccb_/);
  } finally { socket.close(); }
});

test('side-chat response caches stay separate and unknown response IDs require full-context replay', async () => {
  const sockets = [new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`), new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`)];
  await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); })));
  const body = (text, previous_response_id) => JSON.parse(responsesBody('claude-opus-5-5', [userMsg(text)], { previous_response_id }));
  try {
    const a = await webSocketTurn(sockets[0], body('chat A'));
    const b = await webSocketTurn(sockets[1], body('chat B'));
    const before = readClaudeLog().length;
    const wrongSocket = await webSocketTurn(sockets[1], body('wrong parent', a.response.id));
    assert.equal(wrongSocket.error.code, 'previous_response_not_found');
    assert.equal(readClaudeLog().length, before);
    for (const [index, first] of [a, b].entries()) {
      await webSocketTurn(sockets[index], body('continue', first.response.id));
      const sid = first.response.output.find((item) => item.encrypted_content?.startsWith('ccb:v1:')).encrypted_content.split(':')[2];
      const args = readClaudeLog().at(-1).args;
      assert.equal(args[args.indexOf('--resume') + 1], sid);
    }
    const httpResult = await request('/backend-api/codex/responses', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body('missing history', a.response.id)) });
    assert.equal(httpResult.status, 400);
    assert.equal(JSON.parse(httpResult.data).error.code, 'previous_response_not_found');
  } finally { sockets.forEach((socket) => socket.close()); }
});

test('GPT websocket frames drop bridge-only items, so a side chat off a Claude-compacted thread works', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`, {
    headers: { 'x-codex-routing-hint': 'model=gpt-6-sol', authorization: 'Bearer test' },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const nextReply = () => new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
  });
  try {
    // A GPT side chat forked from an Opus thread inherits the bridge's compaction
    // marker and Claude's messages. OpenAI rejects the marker as unverifiable.
    upstreamWsData = Buffer.alloc(0);
    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-6-sol',
      input: [
        { id: 'cmp_ccb_1', type: 'compaction', encrypted_content: 'ccb:v1:s:t' },
        { id: 'msg_ccb_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'claude said' }] },
        userMsg('side question'),
      ],
    }));
    assert.equal(await nextReply(), 'OK');
    const fwd = JSON.parse(decodeClientTextFrames(upstreamWsData).at(-1));
    assert.doesNotMatch(JSON.stringify(fwd), /ccb/, 'no bridge ids or markers reach OpenAI');
    assert.equal(fwd.input.length, 3);
    assert.match(fwd.input[0].content[0].text, /handled by Claude and then compacted/);
    assert.equal(fwd.input[1].id, undefined);
    assert.equal(fwd.input[1].content[0].text, 'claude said');
    assert.equal(fwd.input[2].content[0].text, 'side question');

    // Frames without bridge items are forwarded unchanged.
    upstreamWsData = Buffer.alloc(0);
    const clean = JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', input: [userMsg('plain')] });
    socket.send(clean);
    assert.equal(await nextReply(), 'OK');
    assert.deepEqual(decodeClientTextFrames(upstreamWsData), [clean]);
  } finally {
    socket.close();
  }
});

test('browser origins cannot open a GPT websocket through the bridge', async () => {
  const reply = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-codex-routing-hint: model=gpt-6-sol\r\nOrigin: https://evil.example\r\n\r\n');
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 403/);
});

test('rejects browser-origin requests', async () => {
  const r = await request('/backend-api/codex/models', { method: 'GET', headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('responses-lite requests (tools inside input) still go to Claude', async () => {
  fs.rmSync(claudeLog, { force: true });
  upstreamRequests = [];
  const body = JSON.stringify({
    model: 'claude-opus-5-5',
    instructions: '',
    input: [
      { type: 'additional_tools', id: 'at_1', role: 'developer', tools: [{ type: 'function', name: 'shell' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex, a coding agent...' }] },
      envContext(workdir),
      userMsg('hi what model are u'),
    ],
    stream: true,
  });
  const r = await request('/backend-api/codex/responses', { body, headers: { 'content-type': 'application/json' } });
  assert.equal(upstreamRequests.length, 0, 'must not be sent to GPT');
  assert.match(r.data, /msg_ccb_/);
  const call = readClaudeLog()[0];
  assert.equal(JSON.parse(call.stdin).message.content[0].text, 'hi what model are u');
});

test('catalog marks Claude models as classic (non-lite) request format', async () => {
  const r = await request('/backend-api/codex/models', { method: 'GET' });
  const { models } = JSON.parse(r.data);
  assert.equal(models.find((m) => m.slug === 'claude-opus-5-5').use_responses_lite, false);
});

test('side chat (different thread) forks the parent Claude session; parent keeps its own', async () => {
  fs.rmSync(claudeLog, { force: true });
  const h = (thread) => ({ 'content-type': 'application/json', 'thread-id': thread });
  const input1 = [envContext(workdir), userMsg('main task')];
  const r1 = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', input1), headers: h('main') });
  const out1 = parseSse(r1.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const parentSid = out1.at(-1).encrypted_content.split(':')[2];

  // Side chat: same history, new thread id.
  const rs = await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [...input1, ...out1, userMsg('side question')]), headers: h('side') });
  const sideMarker = parseSse(rs.data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item).at(-1).encrypted_content;
  let calls = readClaudeLog();
  assert.ok(calls[1].args.includes('--fork-session'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], parentSid);
  assert.notEqual(sideMarker.split(':')[2], parentSid, 'side chat gets its own session');

  // Main thread continues its own session untouched.
  await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [...input1, ...out1, userMsg('main continues')]), headers: h('main') });
  calls = readClaudeLog();
  assert.ok(!calls[2].args.includes('--fork-session'));
  assert.equal(calls[2].args[calls[2].args.indexOf('--resume') + 1], parentSid);
});

test('Codex skills catalog is passed to Claude', async () => {
  fs.rmSync(claudeLog, { force: true });
  const dev = {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills\n- write-user-facing-messages: Write UI text (file: r0/write-user-facing-messages/SKILL.md)\n</skills_instructions>' }],
  };
  await request('/backend-api/codex/responses', { body: responsesBody('claude-opus-5-5', [dev, envContext(workdir), userMsg('x')]), headers: { 'content-type': 'application/json' } });
  const call = readClaudeLog()[0];
  const system = call.args[call.args.indexOf('--append-system-prompt') + 1];
  assert.match(system, /write-user-facing-messages/);
  assert.match(system, /read its SKILL\.md/);
});

test('a failed shell command shows its description and last output line, not just the exit code', async () => {
  const { describeToolError } = await import('../src/toolDisplay.js');
  const shown = describeToolError('Bash', 'Exit code 1\nok so far\ncould not create image from display', 'Take a screenshot');
  assert.match(shown, /^\*\*Failed:\*\* Take a screenshot \(exit 1\)/);
  assert.match(shown, /could not create image from display/);
  assert.doesNotMatch(shown, /ok so far/);
  assert.equal(describeToolError('Bash', 'Exit code 2'), '**Command failed** (exit 2)');
  assert.equal(describeToolError('Edit', '<tool_use_error>Found 2 matches</tool_use_error>'), '**Edit failed:** <tool_use_error>Found 2 matches</tool_use_error>');
});

const codexTools = [
  { type: 'function', name: 'request_user_input', description: 'Ask the user.', parameters: { type: 'object', properties: { questions: { type: 'array' } } } },
  { type: 'namespace', name: 'codex_app', description: 'Codex app tools.', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] },
  { type: 'namespace', name: 'mcp__cua_repl', description: 'UI automation.', tools: [{ type: 'function', name: 'js', description: 'x'.repeat(5000), parameters: { type: 'object', properties: { code: { type: 'string' } } } }] },
  { type: 'custom', name: 'exec', description: 'Run JavaScript.', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
  { type: 'web_search' },
];
const codexToolsLog = () => fs.readFileSync(`${claudeLog}.codex-tools`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const doneItems = (data) => parseSse(data).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);

test('Claude calls Codex tools that Codex runs, and the same Claude process continues with the result', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  try {
    fs.rmSync(claudeLog, { force: true });
    fs.rmSync(`${claudeLog}.codex-tools`, { force: true });
    const headers = { 'content-type': 'application/json', 'thread-id': 'tools-thread' };
    const input1 = [perms, envContext(workdir), userMsg('list my tasks')];
    const first = await request('/backend-api/codex/responses', { headers, body: responsesBody('claude-opus-5-5', input1, { tools: codexTools }) });
    const firstEvents = parseSse(first.data);
    const firstItems = doneItems(first.data);
    const commentary = firstItems.find((item) => item.type === 'message');
    assert.equal(commentary.content[0].text, "I'll check the file.");
    assert.equal(commentary.phase, 'commentary');
    const call = firstItems.find((item) => item.type === 'function_call');
    assert.deepEqual({ name: call.name, namespace: call.namespace, arguments: JSON.parse(call.arguments) }, { name: 'list_threads', namespace: 'codex_app', arguments: { limit: 5 } });
    assert.match(call.id, /^fc_ccb_/);
    assert.ok(firstItems.some((item) => item.encrypted_content?.startsWith('ccb:v1:')), 'a marker lets a restarted bridge resume the session');
    assert.equal(firstEvents.at(-1).response.end_turn, false);
    assert.ok(!firstItems.some((item) => item.type === 'reasoning' && item.summary[0]?.text?.includes('mcp__codex')), 'Codex draws its own tool card');

    const claudeCall = readClaudeLog()[0];
    const mcpConfig = JSON.parse(claudeCall.args[claudeCall.args.indexOf('--mcp-config') + 1]);
    assert.ok(mcpConfig.mcpServers.codex);
    assert.equal(mcpConfig.mcpServers.cua_repl, undefined, 'Codex runs Computer Use itself when it offers it');
    assert.equal(claudeCall.args[claudeCall.args.indexOf('--allowedTools') + 1], 'mcp__codex');
    assert.match(claudeCall.args[claudeCall.args.indexOf('--append-system-prompt') + 1], /Codex app's own tools/);
    const listed = codexToolsLog()[0];
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['request_user_input', 'codex_app__list_threads', 'cua_repl__js', 'exec']);
    assert.deepEqual(listed.tools.find((tool) => tool.name === 'exec').inputSchema.required, ['input']);
    assert.match(listed.tools.find((tool) => tool.name === 'exec').description, /start: \/\.\+\//);
    assert.ok(Number(listed.descriptionLimit) >= 5000, 'long Codex tool descriptions are not cut short');
    assert.ok(Number(listed.toolTimeout) >= 60 * 60 * 1000);

    const output = { type: 'function_call_output', call_id: call.call_id, output: [{ type: 'input_text', text: '3 tasks' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' }] };
    const second = await request('/backend-api/codex/responses', { headers, body: responsesBody('claude-opus-5-5', [...input1, ...firstItems, output, userMsg('also pin it')], { tools: codexTools }) });
    const secondEvents = parseSse(second.data);
    const final = doneItems(second.data).find((item) => item.type === 'message');
    assert.equal(final.content[0].text, 'Codex said: 3 tasks | [image image/png] | The user sent this message while the tool was running:\n\nalso pin it');
    assert.equal(final.phase, 'final_answer');
    assert.equal(secondEvents.at(-1).response.end_turn, true);
    assert.equal(readClaudeLog().length, 1, 'no second Claude process');
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
});

test('WebSocket follow-ups carrying only Codex tool results continue the waiting Claude turn', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  process.env.FAKE_CODEX_TOOL = 'exec';
  const socket = new WebSocket(`ws://127.0.0.1:${port}/backend-api/codex/responses`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  try {
    const body = (input, extra = {}) => ({ ...JSON.parse(responsesBody('claude-opus-5-5', input, { tools: codexTools })), ...extra });
    const first = await webSocketTurn(socket, body([perms, envContext(workdir), userMsg('run some js')], { client_metadata: { thread_id: 'ws-tools' } }));
    const call = first.response.output.find((item) => item.type === 'custom_tool_call');
    assert.deepEqual({ name: call.name, input: call.input }, { name: 'exec', input: 'text(1)' });
    assert.equal(first.response.end_turn, false);
    const second = await webSocketTurn(socket, body([{ type: 'custom_tool_call_output', call_id: call.call_id, output: [{ type: 'input_text', text: '1' }] }], { previous_response_id: first.response.id, client_metadata: { thread_id: 'ws-tools' } }));
    assert.equal(second.response.output.find((item) => item.type === 'message').content[0].text, 'Codex said: 1');
    assert.equal(second.response.end_turn, true);
  } finally {
    socket.close();
    delete process.env.FAKE_CLAUDE_SCENARIO;
    delete process.env.FAKE_CODEX_TOOL;
  }
});

test('a new message without the tool results stops the waiting Claude turn before resuming its session', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  try {
    fs.rmSync(claudeLog, { force: true });
    const headers = { 'content-type': 'application/json', 'thread-id': 'abandoned-thread' };
    const input1 = [perms, envContext(workdir), userMsg('list my tasks')];
    const first = await request('/backend-api/codex/responses', { headers, body: responsesBody('claude-opus-5-5', input1, { tools: codexTools }) });
    const firstItems = doneItems(first.data);
    const sid = firstItems.find((item) => item.encrypted_content?.startsWith('ccb:v1:')).encrypted_content.split(':')[2];
    delete process.env.FAKE_CLAUDE_SCENARIO;
    await request('/backend-api/codex/responses', { headers, body: responsesBody('claude-opus-5-5', [...input1, ...firstItems, userMsg('never mind')], { tools: codexTools }) });
    const calls = readClaudeLog();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], sid);
    assert.match(JSON.parse(calls[1].stdin).message.content[0].text, /\[list_threads call\][\s\S]*never mind/);
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
});

test('GPT requests keep bridge-made Codex tool calls, without their bridge ids', async () => {
  const { sanitizeInputForOpenAI } = await import('../src/codexInput.js');
  const call = { type: 'function_call', id: 'fc_ccb_1', call_id: 'call_ccb_1', name: 'list_threads', namespace: 'codex_app', arguments: '{}' };
  const custom = { type: 'custom_tool_call', id: 'ctc_ccb_1', call_id: 'call_ccb_2', name: 'exec', input: 'text(1)' };
  const { input, changed } = sanitizeInputForOpenAI([call, { type: 'function_call_output', call_id: 'call_ccb_1', output: 'ok' }, custom]);
  assert.ok(changed);
  assert.deepEqual(input.map((item) => item.id), [undefined, undefined, undefined]);
  assert.deepEqual(input.map((item) => item.call_id), ['call_ccb_1', 'call_ccb_1', 'call_ccb_2']);
});
