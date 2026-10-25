import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { diagnostics, diagnosticsSnapshot, formatFields, logLifecycle, startResourceMonitor } from '../src/diagnostics.js';

const collector = () => {
  const lines = [];
  return { lines, log: { info: (line) => lines.push(line) } };
};

test('lifecycle fields stay on one bounded line, even for hostile header values', () => {
  const line = formatFields({ thread: 'evil\nresources fake=1', model: 'gpt-6-sol', count: 3.74, empty: '', missing: undefined, long: 'x'.repeat(5000) });
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /^thread="evil\\nresources fake=1" model=gpt-6-sol count=3\.7 long=x+$/);
  assert.ok(line.length < 500, 'long values are truncated');
  const { lines, log } = collector();
  logLifecycle(log, 'spawn', { turn: 'turn_test' });
  assert.match(lines[0], /^lifecycle spawn turn=turn_test running=\d+ waiting=\d+ stopping=\d+ compacting=\d+$/);
});

test('process counters stay correct through waiting, resume, stop and exit', () => {
  const before = diagnosticsSnapshot().claude;
  diagnostics.processStarted({ id: 'turn_counter', threadId: 'thread-counter', pid: 123 });
  diagnostics.processWaiting('turn_counter');
  assert.equal(diagnosticsSnapshot().claude.waiting, before.waiting + 1);
  assert.equal(diagnosticsSnapshot().turns.find((turn) => turn.turn === 'turn_counter').thread, 'thread-counter');
  assert.ok(diagnostics.processResumed('turn_counter') >= 0);
  assert.equal(diagnostics.processResumed('turn_counter'), null, 'a second resume is not double-counted');
  diagnostics.processWaiting('turn_counter');
  assert.ok(diagnostics.processStopping('turn_counter', 'gpt-switch'));
  assert.equal(diagnostics.processStopping('turn_counter', 'new-request'), null, 'the first stop reason wins');
  const ended = diagnostics.processEnded('turn_counter');
  assert.equal(ended.endReason, 'gpt-switch');
  assert.equal(ended.handoffs, 2);
  assert.equal(diagnostics.processEnded('turn_counter'), null, 'exit is recorded once');
  const after = diagnosticsSnapshot().claude;
  assert.deepEqual([after.running, after.waiting, after.stopping], [before.running, before.waiting, before.stopping]);
  assert.equal(after.totals.cancelled, before.totals.cancelled + 1);
  assert.equal(after.totals.exited, before.totals.exited + 1);
});

test('closed sockets and their cached context leave the snapshot', () => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 4096 });
  diagnostics.trackSocket(socket, 'client');
  diagnostics.setContextBytes(socket, 1000);
  let ws = diagnosticsSnapshot().websockets;
  assert.equal(ws.clients, 1);
  assert.equal(ws.bufferedBytes, 4096);
  assert.equal(ws.cachedContextBytes, 1000);
  socket.emit('close');
  ws = diagnosticsSnapshot().websockets;
  assert.deepEqual([ws.clients, ws.cachedContexts, ws.cachedContextBytes], [0, 0, 0]);
  const aborted = Object.assign(new EventEmitter(), { readyState: 3, bufferedAmount: 0 });
  diagnostics.trackSocket(aborted, 'upstream');
  assert.equal(diagnosticsSnapshot().websockets.upstreams, 0, 'a socket already CLOSED without an event is dropped');
});

test('the resource monitor logs at start and for long waits, buffered sockets and heartbeats only', async () => {
  const { lines, log } = collector();
  const record = diagnostics.processStarted({ id: 'turn_monitor', threadId: 'thread-monitor', pid: 456 });
  diagnostics.processWaiting('turn_monitor');
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0 });
  diagnostics.trackSocket(socket, 'client');
  const state = { stats: () => ({ sessions: 2, catalogKeys: 1, catalogBodies: 1, stateBytes: 10, catalogBytes: 20, writes: 3, bytesWritten: 30, skippedWrites: 1 }) };
  const stop = startResourceMonitor({ log, state, intervalMs: 20, heartbeatMs: 10_000, idleHeartbeatMs: 10_000, rssStepBytes: Number.MAX_SAFE_INTEGER, bufferedWarnBytes: 1000, waitingThresholdsSeconds: [60] });
  try {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^resources reason=start rssMiB=[\d.]+ .*waiting=\d+ .*sessions=2 .*stateWrites=3 .*waitingTurns="?turn_monitor@thread-monitor:0s/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(lines.length, 1, 'nothing changed, so nothing is logged');
    record.waitingSince = Date.now() - 61_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(lines.filter((line) => line.includes('reason=long-wait')).length, 1, 'each threshold is reported once per wait');
    socket.bufferedAmount = 5000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(lines.filter((line) => line.includes('ws-buffered')).length, 1, 'buffer growth is reported once until it drains');
  } finally {
    stop();
    diagnostics.processEnded('turn_monitor');
    socket.emit('close');
  }
  const count = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(lines.length, count, 'stop() clears the timer');
});
