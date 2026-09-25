#!/usr/bin/env node
// Stand-in for the Claude Code CLI: records its argv/stdin and emits stream-json.
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

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
  const sid = resumeIdx >= 0 && !args.includes('--fork-session') ? args[resumeIdx + 1] : crypto.randomUUID();
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
  if (scenario === 'codex-tools') {
    callCodexTool(sid, msg1, out).catch((error) => {
      console.error(error);
      process.exit(1);
    });
    return;
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

// Acts as Claude Code's MCP client: lists the bridge's Codex tools, calls one and waits for Codex's result.
async function callCodexTool(sid, messageId, out) {
  const server = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.codex;
  const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  let nextId = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    replies.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const { result } = await rpc('tools/list', {});
  if (log) fs.appendFileSync(`${log}.codex-tools`, `${JSON.stringify({ tools: result.tools, descriptionLimit: process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, toolTimeout: process.env.MCP_TOOL_TIMEOUT })}\n`);
  const name = process.env.FAKE_CODEX_TOOL || 'codex_app__list_threads';
  const input = name === 'exec' ? { input: 'text(1)' } : { limit: 5 };
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: messageId, content: [{ type: 'text', text: "I'll check the file." }, { type: 'tool_use', id: 'tu_codex', name: `mcp__codex__${name}`, input }] } });
  const called = await rpc('tools/call', { name, arguments: input, _meta: { 'claudecode/toolUseId': 'tu_codex' } });
  out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_codex', content: called.result.content }] } });
  const text = `Codex said: ${called.result.content.map((part) => part.text ?? `[${part.type} ${part.mimeType}]`).join(' | ')}`;
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_codex_2' } } });
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_codex_2', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: { output_tokens: 7 } });
  mcp.kill();
}
