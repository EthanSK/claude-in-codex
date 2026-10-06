import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeUserMessage, classifyUserText, makeMarker, parseCodexRequest } from '../src/codexInput.js';

const userMessage = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

test('Agent Flow authored wrappers stay current prompts on new and resumed turns', () => {
  for (const tag of ['speech', 'speech_segment', 'typed_text', 'potential_tts', 'agent_flow_context']) {
    const text = `<${tag} start_at="1" end_at="2">Do not build yet. Answer my questions first.</${tag}>`;
    assert.equal(classifyUserText(text), 'prompt');
    for (const resumed of [false, true]) {
      const marker = { type: 'reasoning', encrypted_content: makeMarker('session', 'turn') };
      const input = resumed ? [userMessage('Earlier work'), marker, userMessage(text)] : [userMessage(text)];
      const parsed = parseCodexRequest({ input }, () => resumed);
      assert.equal(parsed.promptText, text);
      assert.equal(parsed.context, '');
      assert.equal(buildClaudeUserMessage(parsed, { newSession: !resumed }).message.content[0].text, text);
    }
  }
});

test('selection-led requests keep the selected text quoted and the request current', () => {
  const selection = '<app_selection index="1"><text>Earlier plan: build it.</text></app_selection>';
  for (const request of ['\n\nDo not build yet. Answer my questions first.', '\n<speech>Do not build yet.</speech>', '\n## My request:\nExplain this first.']) {
    const text = selection + request;
    const parsed = parseCodexRequest({ input: [userMessage(text)] });
    assert.equal(parsed.promptText, text);
    assert.equal(parsed.context, '');
    assert.equal(buildClaudeUserMessage(parsed, { newSession: true }).message.content[0].text, text);
  }
  assert.equal(classifyUserText(selection), 'context');
});

test('a large selection cannot truncate the current request by treating it as historical context', () => {
  const text = `<codex_selection><text>${'Earlier quotation. '.repeat(5000)}</text></codex_selection>\n\nStop implementing and answer first.`;
  const parsed = parseCodexRequest({ input: [userMessage(text)] });
  assert.equal(parsed.promptText, text);
  assert.equal(parsed.context, '');
});

test('pasted-text attachments with an empty My request preserve the user request notice', () => {
  const text = '\n# Files pasted by the user:\n\n## Planning brief: /tmp/Pasted text.txt\n\nPasted text contains the user\'s request.\n\n## My request:\n\n';
  const parsed = parseCodexRequest({ input: [userMessage(text)] });
  assert.equal(parsed.promptText, text);
  assert.equal(buildClaudeUserMessage(parsed, { newSession: true }).message.content[0].text, text);
});

test('injected context and instruction sources retain their original classifications', () => {
  for (const [text, kind] of [
    ['<environment_context><cwd>/project</cwd></environment_context>', 'environment'],
    ['<user_instructions>Project rules</user_instructions>', 'agents_md'],
    ['# AGENTS.md instructions\nProject rules', 'agents_md'],
    ['<turn_aborted>User stopped</turn_aborted>', 'aborted'],
    ['<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', 'context'],
    ['<send_user_message_question_reply>[{"answer":"Stop"}]</send_user_message_question_reply>', 'prompt'],
  ]) assert.equal(classifyUserText(text), kind);
});
