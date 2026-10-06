import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCodexResults, waitForCodexResults, forgetCodexCalls } from '../src/codexTools.js';

test('a mailbox delivery wakes Claude waiting on Codex wait_agent without a false user cancellation', () => {
  const turn = {};
  waitForCodexResults([{ callId: 'pending-wait' }], turn);
  const wait = { type: 'function_call', call_id: 'pending-wait', namespace: 'collaboration', name: 'wait_agent' };
  const message = { type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'Child finished: apricot' }] };
  try {
    const result = findCodexResults([wait, message]);
    assert.equal(result.turn, turn);
    assert.match(result.outputs.get('pending-wait'), /not a user cancellation/);
    assert.match(result.userText, /Codex agent message from \/root\/child to \/root:\nChild finished: apricot/);
    for (const text of ['Stop now.', '<turn_aborted>User stopped</turn_aborted>']) {
      assert.equal(findCodexResults([wait, message, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }]), null, 'a human stop or new request keeps the existing cancellation path');
    }
    assert.equal(findCodexResults([{ ...wait, name: 'spawn_agent' }, message]), null, 'do not invent results for other pending tools');
    assert.equal(findCodexResults([wait, message, { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }]), null, 'a new human image must not be mistaken for mailbox-only delivery');
    assert.equal(findCodexResults([wait]), null);
  } finally {
    forgetCodexCalls(['pending-wait']);
  }
});
