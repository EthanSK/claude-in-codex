import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCodexResults, waitForCodexResults, forgetCodexCalls } from '../src/codexTools.js';
import { chatDelivery } from './fixtures/codex-delegation.js';

test('a chat delivery survives a later tool marker and is acknowledged only after delivery', () => {
  const turn = { threadId: 'chat-receiver', agentMessageIds: new Set() };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:later-call' };
  const call = { type: 'function_call', call_id: 'chat-result', name: 'request_user_input_async' };
  const output = { type: 'function_call_output', call_id: call.call_id, output: '{"accepted":true}' };
  waitForCodexResults([{ callId: call.call_id, entry: { name: call.name } }], turn, marker.encrypted_content);
  try {
    for (const input of [[marker, call, output, chatDelivery], [chatDelivery, marker, call, output], [marker, call, chatDelivery, output]]) {
      const result = findCodexResults(input, turn.threadId);
      assert.equal(result.outputs.get(call.call_id), output.output);
      assert.ok(result.userText.includes(chatDelivery.output));
      assert.deepEqual(result.agentMessageIds, [chatDelivery.id]);
      assert.equal(turn.agentMessageIds.size, 0, 'finding a delivery must not mark it received before the native reply');
    }
    turn.agentMessageIds.add(chatDelivery.id);
    const replay = findCodexResults([marker, call, output, chatDelivery], turn.threadId);
    assert.equal(replay.userText, '');
    assert.deepEqual(replay.agentMessageIds, []);
    assert.equal(findCodexResults([marker, call, output, chatDelivery], 'another-thread'), null);
  } finally {
    forgetCodexCalls([call.call_id]);
  }
});

test('a tool-shaped chat delivery can wake a lone collaboration wait', () => {
  const turn = { threadId: 'chat-wait', agentMessageIds: new Set() };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:chat-wait' };
  const entry = { namespace: 'collaboration', name: 'wait_agent' };
  waitForCodexResults([{ callId: 'chat-wait', entry }], turn, marker.encrypted_content);
  try {
    const result = findCodexResults([marker, chatDelivery], turn.threadId);
    assert.equal(result.turn, turn);
    assert.ok(result.userText.includes(chatDelivery.output));
    assert.match(result.outputs.get('chat-wait'), /not a user cancellation/);
    turn.agentMessageIds.add(chatDelivery.id);
    assert.equal(findCodexResults([marker, chatDelivery], turn.threadId), null, 'a replayed delivery must not wake a later wait');
  } finally {
    forgetCodexCalls(['chat-wait']);
  }
});

test('a mailbox delivery wakes Claude waiting on Codex wait_agent without a false user cancellation', () => {
  const turn = { threadId: 'parent' };
  const entry = { namespace: 'collaboration', name: 'wait_agent' };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:pending-wait' };
  waitForCodexResults([{ callId: 'pending-wait', entry }], turn, marker.encrypted_content);
  const wait = { type: 'function_call', call_id: 'pending-wait', namespace: 'collaboration', name: 'wait_agent' };
  const message = { type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'Child finished: apricot' }] };
  try {
    const result = findCodexResults([wait, message]);
    assert.equal(result.turn, turn);
    assert.match(result.outputs.get('pending-wait'), /not a user cancellation/);
    assert.match(result.userText, /Codex agent message from \/root\/child to \/root:\nChild finished: apricot/);
    const preempted = findCodexResults([marker, message], 'parent');
    assert.equal(preempted.turn, turn, 'Codex removes the wait call when a ready mailbox reply preempts it');
    assert.match(preempted.outputs.get('pending-wait'), /not a user cancellation/);
    assert.match(preempted.userText, /Child finished: apricot/);
    assert.equal(findCodexResults([marker, message], 'fork'), null, 'an inherited marker must not resume a different thread');
    assert.equal(findCodexResults([message, marker]), null, 'historical mailbox content must not wake a pending wait');
    for (const text of ['Stop now.', '<turn_aborted>User stopped</turn_aborted>']) {
      for (const boundary of [wait, marker]) assert.equal(findCodexResults([boundary, message, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }]), null, 'a human stop or new request keeps the existing cancellation path');
    }
    waitForCodexResults([{ callId: 'pending-wait', entry: { ...entry, name: 'spawn_agent' } }], turn, marker.encrypted_content);
    assert.equal(findCodexResults([{ ...wait, name: 'spawn_agent' }, message]), null, 'do not invent results for other pending tools');
    assert.equal(findCodexResults([marker, message]), null, 'a marker does not make a non-wait tool resumable without results');
    waitForCodexResults([{ callId: 'pending-wait', entry }], turn, marker.encrypted_content);
    assert.equal(findCodexResults([wait, message, { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }]), null, 'a new human image must not be mistaken for mailbox-only delivery');
    assert.equal(findCodexResults([wait]), null);
    waitForCodexResults([{ callId: 'parallel-tool', entry: { namespace: 'functions', name: 'exec' } }], turn, marker.encrypted_content);
    assert.equal(findCodexResults([marker, message]), null, 'do not manufacture the missing result of a parallel tool');
  } finally {
    forgetCodexCalls(['pending-wait', 'parallel-tool']);
  }
});

test('tool continuations keep new text and image pixels on either side of the tool result', () => {
  const turn = { threadId: 'image-thread' };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:image-turn' };
  const call = { type: 'custom_tool_call', call_id: 'image-call', name: 'exec' };
  const output = { type: 'custom_tool_call_output', call_id: call.call_id, output: 'finished' };
  const historical = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old request' }, { type: 'input_image', image_url: 'data:image/png;base64,OLD' }] };
  const current = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check this screenshot instead.' }, { type: 'input_image', image_url: 'data:image/png;base64,NEW' }] };
  waitForCodexResults([{ callId: call.call_id, entry: { name: 'exec' } }], turn, marker.encrypted_content);
  try {
    for (const arrivals of [[current, output], [output, current]]) {
      const result = findCodexResults([historical, marker, call, ...arrivals], turn.threadId);
      assert.equal(result.userText, 'Check this screenshot instead.');
      assert.deepEqual(result.userAttachments, [{ type: 'image', mimeType: 'image/png', data: 'NEW' }]);
      assert.equal(result.outputs.get(call.call_id), 'finished');
    }
    const delta = findCodexResults([output, current], turn.threadId);
    assert.equal(delta.userText, 'Check this screenshot instead.');
    assert.deepEqual(delta.userAttachments, [{ type: 'image', mimeType: 'image/png', data: 'NEW' }]);
    const imageOnly = findCodexResults([marker, call, output, { ...current, content: current.content.slice(1) }], turn.threadId);
    assert.equal(imageOnly.userText, '');
    assert.deepEqual(imageOnly.userAttachments, [{ type: 'image', mimeType: 'image/png', data: 'NEW' }]);
    assert.equal(findCodexResults([marker, call, current], turn.threadId), null, 'a new image without a result still cancels the waiting turn');
    assert.equal(findCodexResults([marker, call, output, current], 'another-thread'), null);
  } finally {
    forgetCodexCalls([call.call_id]);
  }
});
