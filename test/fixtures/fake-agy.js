#!/usr/bin/env node
import assert from 'node:assert/strict';
import readline from 'node:readline';
import fs from 'node:fs';

const sid = '8ec454da-f0d0-48bf-b487-429d0d2005fa';
const emit = (data) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...data })}\n`);
const reply = (id, result) => emit({ id, result });
const update = (sessionUpdate, text) => emit({
  method: 'session/update',
  params: { sessionId: sid, update: { sessionUpdate, content: { type: 'text', text } } },
});

assert.deepEqual(process.argv.slice(2), ['acp', '--include-default-customizations=false', '--sandbox']);
assert.equal(process.env.GEMINI_API_KEY, undefined);

let promptId;
let firstReasoningOnly = false;
let compactedNativeHistory = false;
let toolPromptAttempted = false;
const scenario = process.env.FAKE_AGY_SCENARIO;
const permissions = new Map([
  [101, [sid, 'mcp_codex_echo', 'temporary']],
  [102, ['wrong-session', 'mcp_codex_echo', 'decline']],
  [103, [sid, 'native_command', 'decline']],
]);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === 'initialize') reply(id, { protocolVersion: 1 });
  else if (method === 'session/new' && scenario === 'compact') reply(id, { sessionId: sid });
  else if (method === 'session/load') {
    assert.equal(params.sessionId, sid);
    update('agent_message_chunk', 'Old replayed history');
    reply(id, {});
  } else if (method === 'session/set_config_option') {
    const settings = { model: 'gemini-4-neon', thought_level: 'low', mode: 'plan' };
    assert.equal(params.value, settings[params.configId]);
    reply(id, { configOptions: [{ id: params.configId, currentValue: params.value }] });
  } else if (method === 'session/prompt') {
    if (scenario === 'denied-tool' || scenario === 'approved-tool') {
      if (!toolPromptAttempted) {
        toolPromptAttempted = true;
        promptId = id;
        const name = scenario === 'denied-tool' ? 'native_command' : 'mcp_codex_echo';
        const toolCallId = 'permission-probe';
        emit({
          method: 'session/update',
          params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId, status: 'pending' } },
        });
        emit({
          id: 201, method: 'session/request_permission',
          params: { sessionId: sid, toolCall: { name, toolCallId }, options: [
            { kind: 'allow_once', optionId: 'temporary' },
            { kind: 'reject_once', optionId: 'decline' },
          ] },
        });
      } else {
        assert.equal(scenario, 'denied-tool', 'Never replay a prompt after an approved action');
        assert.match(params.prompt[0].text, /tool request was declined/);
        assert.match(params.prompt[0].text, /tools provided by Codex/);
        update('agent_message_chunk', 'Recovered after a denied tool');
        reply(id, { stopReason: 'end_turn' });
      }
      continue;
    }
    if (scenario === 'compact') {
      if (params.prompt[0].text === '/compact') {
        compactedNativeHistory = true;
      } else {
        assert.match(params.prompt[0].text, /prepare context for the next turn/);
        if (compactedNativeHistory) {
          assert.match(params.prompt.at(-1).text, /finished-tool-token-179/);
          fs.writeFileSync('tool-output-received', 'finished-tool-token-179');
        } else {
          assert.match(params.prompt[1].text, /checkpoint-token-389/);
        }
        update('agent_message_chunk', 'Checkpoint must stay inside Antigravity');
      }
      reply(id, { stopReason: 'end_turn' });
      continue;
    }
    if (scenario === 'reasoning-only') {
      if (!firstReasoningOnly) {
        firstReasoningOnly = true;
        update('agent_thought_chunk', 'First turn ended without an answer');
        reply(id, { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 3 } });
      } else {
        assert.match(params.prompt[0].text, /Finish answering the previous user request/);
        update('agent_message_chunk', 'Visible continuation');
        reply(id, { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 1 } });
      }
      continue;
    }
    assert.deepEqual(params.prompt, [
      { type: 'text', text: 'system notes' },
      { type: 'image', mimeType: 'image/png', data: 'image-data' },
    ]);
    promptId = id;
    for (const [id, [sessionId, name]] of permissions) {
      emit({
        id, method: 'session/request_permission',
        params: {
          sessionId, toolCall: { name }, options: [
            { kind: 'allow_always', optionId: 'persistent' },
            { kind: 'allow_once', optionId: 'temporary' },
            { kind: 'reject_once', optionId: 'decline' },
          ],
        },
      });
    }
  } else if (id === 201) {
    assert.equal(result.outcome.optionId, scenario === 'denied-tool' ? 'decline' : 'temporary');
    reply(promptId, { stopReason: 'end_turn' });
  } else {
    assert.equal(result.outcome.optionId, permissions.get(id)[2]);
    permissions.delete(id);
    if (!permissions.size) {
      update('agent_thought_chunk', 'Thinking');
      update('agent_message_chunk', 'Verified');
      reply(promptId, { stopReason: 'end_turn', usage: { inputTokens: 7, cachedReadTokens: 13, outputTokens: 2, thoughtTokens: 5 } });
    }
  }
}
