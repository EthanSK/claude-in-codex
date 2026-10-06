import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesStream } from '../src/responsesStream.js';
import { sanitizeInputForOpenAI } from '../src/codexInput.js';

test('Claude collaboration calls explicitly declare plaintext arguments to Codex', () => {
  for (const name of ['spawn_agent', 'send_message', 'followup_task']) {
    const events = [];
    const stream = new ResponsesStream({ write: (chunk) => events.push(JSON.parse(chunk.split('\ndata: ')[1])) }, { model: 'claude-opus-5-5' });
    const args = { message: 'Remember apricot.' };
    stream.codexToolCall({ callId: 'call_1', entry: { name, namespace: 'collaboration', custom: false }, args });
    for (const event of events) {
      assert.deepEqual(event.item.encrypted_function_args, [], 'omitting this field makes Codex deliver plain words as ciphertext');
      assert.deepEqual(JSON.parse(event.item.arguments), args);
    }
    const replay = sanitizeInputForOpenAI(stream.output);
    assert.deepEqual(replay.input[0].encrypted_function_args, []);
    assert.equal(replay.input[0].id, undefined);
  }
});

test('other tools do not receive collaboration encryption metadata', () => {
  for (const entry of [{ name: 'spawn_agent', namespace: 'unrelated', custom: false }, { name: 'list_agents', namespace: 'collaboration', custom: false }, { name: 'exec', custom: true }]) {
    const stream = new ResponsesStream({ write() {} }, { model: 'claude-opus-5-5' });
    stream.codexToolCall({ callId: 'call_1', entry, args: { input: 'text(1)' } });
    assert.equal(Object.hasOwn(stream.output[0], 'encrypted_function_args'), false);
  }
});
