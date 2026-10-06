// Codex records an incoming chat message as an unsolicited tool output, without a call_id.
export const chatDelivery = {
  type: 'function_call_output',
  id: 'fco_chat_delivery',
  name: 'send_message_to_thread',
  namespace: 'codex_app',
  output: '<codex_delegation>\n  <source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id>\n  <input>Remember apricot. This message is additive; continue the existing work.</input>\n</codex_delegation>',
};
