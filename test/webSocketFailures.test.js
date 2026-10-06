import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

async function startBridge(t, injectBrokenPipe = false, upstream) {
  const script = `
    import { createBridge } from ${JSON.stringify(new URL('../src/server.js', import.meta.url).href)};
    import { DEFAULTS } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
    import { EventEmitter } from 'node:events';
    const { server } = createBridge({ ...DEFAULTS, logLevel: 'error', upstream: ${JSON.stringify(upstream)} ?? DEFAULTS.upstream });
    server.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ port: server.address().port }));
      if (${injectBrokenPipe}) {
        const socket = new EventEmitter();
        socket.remoteAddress = '127.0.0.1';
        socket.destroy = () => { socket.destroyed = true; };
        socket.end = () => queueMicrotask(() => socket.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        server.emit('upgrade', { url: '/bad-route', headers: { host: 'localhost' }, socket }, socket, Buffer.alloc(0));
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  const lines = readline.createInterface({ input: child.stdout });
  const ready = await Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    closed.then(() => { throw new Error(`Bridge exited before listening: ${stderr}`); }),
  ]);
  return { child, port: ready.port, stderr: () => stderr };
}

test('a broken pipe during upgrade rejection does not crash other chats', { timeout: 5000 }, async (t) => {
  const bridge = await startBridge(t, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/health`);
  assert.equal(response.status, 200);
  assert.equal(bridge.child.exitCode, null, bridge.stderr());
  assert.match(bridge.stderr(), /write EPIPE/);
});

for (const route of ['unhinted', 'GPT']) test(`a malformed ${route} WebSocket client frame closes only that connection`, { timeout: 5000 }, async (t) => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  t.after(() => { for (const client of upstream.clients) client.terminate(); upstream.close(); });
  const bridge = await startBridge(t, false, `http://127.0.0.1:${upstream.address().port}/backend-api/codex`);
  const socket = net.createConnection({ host: '127.0.0.1', port: bridge.port });
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await once(socket, 'connect');
  const upgraded = once(socket, 'data');
  const hint = route === 'GPT' ? 'x-codex-routing-hint: model=gpt-test\r\n' : '';
  socket.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${hint}\r\n`);
  assert.match((await upgraded)[0].toString(), /101 Switching Protocols/);
  const disconnected = once(socket, 'close');
  socket.write(Buffer.from([0x81, 0x02, 0x4f, 0x4b])); // Real clients must mask frames; a damaged client previously emitted an unhandled WebSocket error.
  await disconnected;
  const response = await fetch(`http://127.0.0.1:${bridge.port}/health`);
  assert.equal(response.status, 200);
  assert.equal(bridge.child.exitCode, null, bridge.stderr());
});
