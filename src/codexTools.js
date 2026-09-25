// Lets Claude call the tools Codex offers its own models, while Codex still runs them.
//
// Claude Code sees Codex's tools through a small per-turn MCP server. When Claude calls
// one, the bridge ends the current Codex response with a normal tool call item and
// leaves the Claude process waiting. Codex runs the tool itself (with its own
// approvals, UI cards, task tools, in-app browser and turn metadata) and sends the
// result in its next request; the bridge hands that result to the waiting MCP call and
// keeps streaming the same Claude turn into the new response.
//
// Why not connect Claude straight to Codex's tool servers: the desktop app-tools pipe
// rejected Claude-launched clients by code-signing identity, and the in-app browser is
// only available to Codex's own executor (see LEARNINGS.md, 2026-09-25).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { rid } from './responsesStream.js';
import { classifyUserText } from './codexInput.js';

// Claude sees each tool as mcp__codex__<name>.
export const CODEX_TOOLS_SERVER = 'codex';
const CLAUDE_TOOL_PREFIX = `mcp__${CODEX_TOOLS_SERVER}__`;
const MAX_TOOL_NAME_LENGTH = 64 - CLAUDE_TOOL_PREFIX.length; // Claude's API rejects tool names longer than 64 characters.

// Codex tool calls waiting for Codex's result, keyed by call_id, across all requests.
const waitingCalls = new Map();

/** True when a Claude tool name refers to a Codex-run tool. */
export function isCodexToolName(name) {
  return typeof name === 'string' && name.startsWith(CLAUDE_TOOL_PREFIX);
}

/**
 * Converts the `tools` array of a Codex request into MCP tool definitions for Claude.
 * @returns {Map<string, { name: string, namespace?: string, custom: boolean, mcpTool: object }>} keyed by MCP tool name
 */
export function codexToolCatalog(tools) {
  const catalog = new Map();
  const add = (tool, namespace) => {
    if (tool?.type !== 'function' && tool?.type !== 'custom') return; // Hosted tools such as web_search run on OpenAI's side; Claude Code has its own.
    if (typeof tool.name !== 'string' || !tool.name) return;
    const prefix = namespace ? `${namespace.name.replace(/^mcp__/, '')}__` : ''; // mcp__cua_repl/js becomes cua_repl__js, keeping Claude's full name short.
    const mcpName = `${prefix}${tool.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME_LENGTH);
    const description = [namespace?.description, tool.description].filter(Boolean).join('\n\n');
    const custom = tool.type === 'custom';
    catalog.set(mcpName, {
      name: tool.name,
      namespace: namespace?.name,
      custom,
      mcpTool: {
        name: mcpName,
        // Freeform tools take raw text rather than JSON, so Claude passes it in one string field.
        description: custom
          ? `${description}\n\nPass the tool's raw input text as \`input\`.${tool.format?.definition ? ` It must match this ${tool.format.syntax || ''} grammar:\n${tool.format.definition}` : ''}`
          : description,
        inputSchema: custom
          ? { type: 'object', properties: { input: { type: 'string', description: 'Raw input for this freeform Codex tool, not JSON-encoded.' } }, required: ['input'] }
          : tool.parameters || { type: 'object', properties: {} },
      },
    });
  };
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'namespace') for (const nested of tool.tools || []) add(nested, tool);
    else add(tool, null);
  }
  return catalog;
}

/**
 * Serves the Codex tool catalog to one Claude process over MCP (JSON-RPC lines on a private socket).
 * `onCall` receives each tool call; the call stays open until `reply` is called.
 */
export class CodexToolServer {
  constructor(catalog, onCall) {
    this.catalog = catalog;
    this.onCall = onCall;
  }

  /** Starts listening and returns the socket path for the MCP proxy. */
  async listen() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-tools-')); // mkdtemp makes a 0700 directory, so only this user can reach the socket.
    this.socketPath = path.join(this.dir, 'mcp.sock');
    this.server = net.createServer((socket) => this.serve(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    return this.socketPath;
  }

  serve(socket) {
    socket.on('error', () => {});
    const send = (message) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    readline.createInterface({ input: socket }).on('line', (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      const { id, method, params } = request;
      if (id === undefined || id === null) return; // Notifications need no reply.
      if (method === 'initialize') {
        send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: CODEX_TOOLS_SERVER, version: '1' } } });
      } else if (method === 'tools/list') {
        send({ id, result: { tools: [...this.catalog.values()].map((entry) => entry.mcpTool) } });
      } else if (method === 'tools/call') {
        const entry = this.catalog.get(params?.name);
        if (!entry) {
          send({ id, result: { content: [{ type: 'text', text: `Codex does not offer a tool named ${params?.name}.` }], isError: true } });
          return;
        }
        this.onCall({
          callId: rid('call_ccb_'),
          entry,
          args: params.arguments || {},
          toolUseId: params._meta?.['claudecode/toolUseId'],
          queuedAt: Date.now(),
          reply: (content) => send({ id, result: { content } }),
        });
      } else if (method === 'ping') {
        send({ id, result: {} });
      } else {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    });
  }

  close() {
    this.server?.close();
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Remembers calls handed to Codex so its next request can resume the waiting Claude turn. */
export function waitForCodexResults(calls, turn) {
  for (const call of calls) waitingCalls.set(call.callId, turn);
}

/** Forgets calls whose Claude process has ended. */
export function forgetCodexCalls(callIds) {
  for (const callId of callIds) waitingCalls.delete(callId);
}

/**
 * Finds a Claude turn waiting on tool results in this request's input.
 * @returns {{ turn: object, outputs: Map<string, unknown>, userText: string } | null}
 */
export function findCodexResults(input) {
  if (!Array.isArray(input)) return null;
  let turn = null;
  let lastOutput = -1;
  const outputs = new Map();
  input.forEach((item, index) => {
    if (item?.type !== 'function_call_output' && item?.type !== 'custom_tool_call_output') return;
    const waiting = waitingCalls.get(item.call_id);
    if (!waiting) return;
    turn = waiting;
    lastOutput = index;
    outputs.set(item.call_id, item.output);
  });
  if (!turn) return null;
  // Messages after the results were sent while the tool ran (or after stopping the turn); Codex would show them to GPT too.
  const userText = [];
  for (const item of input.slice(lastOutput + 1)) {
    if (item?.type !== 'message' || item.role !== 'user') continue;
    for (const part of item.content || []) {
      if (part?.type !== 'input_text') continue;
      const kind = classifyUserText(part.text);
      if (kind === 'prompt') userText.push(part.text);
      else if (kind === 'aborted') userText.push('(The user stopped the turn while this tool was running.)');
    }
  }
  return { turn, outputs, userText: userText.join('\n\n') };
}

/** Cancels Claude turns in this Codex thread that are still waiting for tool results. */
export async function cancelWaitingCodexTurns(threadId) {
  if (!threadId) return;
  const turns = new Set([...waitingCalls.values()].filter((turn) => turn.threadId === threadId));
  await Promise.all([...turns].map((turn) => turn.cancel()));
}

/** Converts a Codex tool output (string or content items) into MCP content blocks. */
export function codexOutputToMcp(output) {
  let items = [];
  if (typeof output === 'string') items = [{ type: 'input_text', text: output }];
  else if (Array.isArray(output)) items = output;
  else if (output && typeof output === 'object') items = [{ type: 'input_text', text: typeof output.content === 'string' ? output.content : JSON.stringify(output) }];
  const content = [];
  for (const item of items) {
    if (typeof item?.text === 'string') {
      content.push({ type: 'text', text: item.text });
    } else if (typeof item?.image_url === 'string') {
      const image = item.image_url.match(/^data:([^;,]+);base64,(.*)$/s);
      content.push(image ? { type: 'image', mimeType: image[1], data: image[2] } : { type: 'text', text: item.image_url });
    }
  }
  return content.length ? content : [{ type: 'text', text: '(The tool returned no output.)' }];
}
