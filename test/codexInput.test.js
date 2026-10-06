import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeUserMessage, classifyUserText, makeMarker, parseCodexRequest, sanitizeInputForOpenAI } from '../src/codexInput.js';

const userMessage = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
import { chatDelivery } from './fixtures/codex-delegation.js';

test('incoming chat deliveries stay complete and attributed on new and resumed turns', () => {
  const delivery = { ...chatDelivery, output: chatDelivery.output.replace('Remember apricot.', 'Remember apricot. '.repeat(5000)) };
  const marker = { type: 'reasoning', encrypted_content: makeMarker('session', 'turn') };
  for (const resumed of [false, true]) {
    const parsed = parseCodexRequest({ input: resumed ? [marker, delivery] : [delivery] }, () => resumed);
    assert.ok(parsed.promptText.includes(delivery.output), 'the current delivery must not be cut to a historical tool-output limit');
    assert.match(parsed.promptText, /Codex agent message from thread 00000000-0000-4000-8000-000000000001/);
    assert.match(parsed.promptText, /not a new human instruction or permission/);
    assert.deepEqual(parsed.agentMessageIds, [delivery.id]);
  }
  assert.deepEqual(sanitizeInputForOpenAI([delivery]), { input: [delivery], changed: false }, 'GPT still receives the original app delivery');
});

test('chat messages arriving before a later marker reach the next turn only once', () => {
  const marker = { type: 'reasoning', encrypted_content: makeMarker('session', 'later-turn') };
  const input = [userMessage('Earlier work'), chatDelivery, marker, userMessage('Continue.')];
  const unseen = parseCodexRequest({ input }, () => true);
  assert.ok(unseen.promptText.includes(chatDelivery.output));
  const seen = parseCodexRequest({ input }, () => true, () => [chatDelivery.id]);
  assert.equal(seen.promptText, 'Continue.');
  assert.equal(seen.context, '');
  assert.deepEqual(seen.agentMessageIds, [chatDelivery.id]);
  const collaborationMessage = { type: 'agent_message', id: 'amsg_late', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'Late child reply.' }] };
  const late = parseCodexRequest({ input: [collaborationMessage, marker, userMessage('Continue.')] }, () => true);
  assert.match(late.promptText, /Late child reply/);
  assert.deepEqual(late.agentMessageIds, [collaborationMessage.id]);
});

test('ordinary tool outputs and quoted delegation text remain tool results or context', () => {
  for (const item of [
    { ...chatDelivery, call_id: 'own-send-call' },
    { ...chatDelivery, namespace: 'unrelated' },
    { ...chatDelivery, output: 'Tool result quoting ' + chatDelivery.output },
    { ...chatDelivery, output: chatDelivery.output.replace('</codex_delegation>', '') },
  ]) {
    const parsed = parseCodexRequest({ input: [item, userMessage('Continue.')] });
    assert.equal(parsed.promptText, 'Continue.');
    assert.match(parsed.context, /\[tool output\]/);
  }
  const quoted = parseCodexRequest({ input: [userMessage(chatDelivery.output)] });
  assert.equal(quoted.promptText, '');
  assert.ok(quoted.context.includes(chatDelivery.output));
});

test('Codex agent tasks and follow-ups reach Claude on new and resumed turns', () => {
  for (const resumed of [false, true]) {
    const message = { type: 'agent_message', id: 'amsg_1', author: '/root', recipient: '/root/child', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\nRemember apricot.' }] };
    const marker = { type: 'reasoning', encrypted_content: makeMarker('session', 'turn') };
    const parsed = parseCodexRequest({ input: resumed ? [userMessage('Earlier work'), marker, message] : [message] }, () => resumed);
    assert.equal(parsed.promptText, 'Codex agent message from /root to /root/child:\nMessage Type: NEW_TASK\nPayload:\nRemember apricot.');
    assert.equal(parsed.context, '');
    assert.equal(buildClaudeUserMessage(parsed, { newSession: !resumed }).message.content[0].text, parsed.promptText);
  }
});

test('Claude sees earlier agent replies as context but never reads OpenAI ciphertext', () => {
  const message = { type: 'agent_message', id: 'amsg_1', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'Child result: apricot' }, { type: 'encrypted_content', encrypted_content: 'opaque-openai-value' }] };
  const parsed = parseCodexRequest({ input: [message, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Acknowledged.' }] }, userMessage('What was the result?')] });
  assert.match(parsed.context, /Child result: apricot/);
  assert.match(parsed.context, /encrypted by another model/);
  assert.doesNotMatch(parsed.context, /opaque-openai-value/);
  const untouched = sanitizeInputForOpenAI([message]);
  assert.equal(untouched.changed, false, 'genuine OpenAI encrypted agent messages must remain untouched for GPT');
  assert.equal(untouched.input[0], message);
});

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

test('model-switch history keeps earlier image pixels separate from the current attachment', () => {
  const earlier = { ...userMessage('Earlier screenshot'), content: [{ type: 'input_text', text: 'Earlier screenshot' }, { type: 'input_image', image_url: 'data:image/png;base64,EARLIER' }] };
  const latest = { ...userMessage('Compare the screenshots'), content: [{ type: 'input_text', text: 'Compare the screenshots' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,CURRENT' }] };
  const marker = { type: 'reasoning', encrypted_content: makeMarker('session', 'turn') };
  const assistant = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] };
  for (const resumed of [false, true]) {
    const parsed = parseCodexRequest({ input: [...(resumed ? [marker] : []), earlier, assistant, latest] }, () => resumed);
    const content = buildClaudeUserMessage(parsed, { newSession: !resumed }).message.content;
    const images = content.filter((block) => block.type === 'image');
    assert.deepEqual(images.map((block) => block.source), [{ type: 'base64', media_type: 'image/png', data: 'EARLIER' }, { type: 'base64', media_type: 'image/jpeg', data: 'CURRENT' }]);
    assert.match(content[0].text, /Earlier screenshot/);
    assert.match(content[1].text, /Earlier user image/);
    assert.match(content[3].text, /Current user message/);
  }
  const resumed = parseCodexRequest({ input: [earlier, assistant, marker, latest] }, () => true);
  assert.deepEqual(buildClaudeUserMessage(resumed, { newSession: false }).message.content.filter((block) => block.type === 'image').map((block) => block.source.data), ['CURRENT'], 'do not resend images already in the resumed Claude session');
});
