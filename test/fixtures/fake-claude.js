#!/usr/bin/env node
// Stand-in for the Claude Code CLI: records its argv/stdin and emits stream-json.
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--permission-prompts --effort --include-partial-messages --resume');
  process.exit(0);
}

const log = process.env.FAKE_CLAUDE_LOG;
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const resumeIdx = args.indexOf('--resume');
  const sid = resumeIdx >= 0 ? args[resumeIdx + 1] : crypto.randomUUID();
  if (log) fs.appendFileSync(log, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

  if (args.includes('/compact')) {
    out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sid });
    return;
  }

  const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'tools';
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
  const msg1 = 'msg_1';
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'message_start', message: { id: msg1 } } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering the repo.' } } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: "I'll check " } } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the file.' } } });
  if (scenario === 'tools') {
    out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'Edit' } } });
    out({
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: null,
      message: {
        id: msg1,
        content: [
          { type: 'text', text: "I'll check the file." },
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: `${process.cwd()}/src/a.ts`, old_string: 'a', new_string: 'b\nc' } },
          { type: 'tool_use', id: 'tu2', name: 'WebSearch', input: { query: 'node zstd' } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 50 },
      },
    });
    out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'tu2', content: 'results' }] } });
    const msg2 = 'msg_2';
    out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'message_start', message: { id: msg2 } } });
    out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } });
    out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: msg2, content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 20, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0, output_tokens: 5 } } });
  }
  if (scenario === 'plan') {
    out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: msg1, content: [{ type: 'tool_use', id: 'tu9', name: 'ExitPlanMode', input: { plan: '1. Do X\n2. Do Y' } }] } });
    out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', is_error: true, content: 'denied' }] } });
  }
  if (scenario === 'error') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', session_id: sid });
    return;
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    session_id: sid,
    usage: { output_tokens: 55 },
    modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } },
  });
});
