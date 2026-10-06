import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function startReloadBridge(t, scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-reload-test-'));
  fs.cpSync(new URL('../src', import.meta.url), path.join(directory, 'src'), { recursive: true });
  fs.symlinkSync(new URL('../node_modules', import.meta.url).pathname, path.join(directory, 'node_modules'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
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
  return { directory, releaseFile, child, closed, log: () => log, url: `http://127.0.0.1:${port}/backend-api/codex/responses` };
}

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
});

test('source reload waits for compaction after its HTTP client disconnects', { timeout: 8000 }, async (t) => {
  const bridge = await startReloadBridge(t, 'hold-compact');
  const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', input: [{ type: 'reasoning', summary: [], encrypted_content: 'ccb:v1:11111111-1111-4111-8111-111111111111:initial' }, { type: 'compaction_trigger' }] }) });
  const reader = response.body.getReader();
  await reader.read();
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(path.join(bridge.directory, 'claude.log')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(bridge.directory, 'claude.log')), 'the native compaction must have started');
  await reader.cancel();
  fs.appendFileSync(path.join(bridge.directory, 'src/toolDisplay.js'), '\n');
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(bridge.child.exitCode, null, `Reload must wait for compaction after its HTTP response disconnects: ${bridge.log()}`);
  fs.writeFileSync(bridge.releaseFile, 'finish');
  await bridge.closed;
  assert.equal(bridge.child.exitCode, 0, bridge.log());
});
