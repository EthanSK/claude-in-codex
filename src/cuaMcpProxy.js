#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const pluginConfigPath = process.env.CODEX_CUA_MCP_CONFIG_PATH;
const sessionId = process.env.CODEX_CUA_SESSION_ID;
const turnId = process.env.CODEX_CUA_TURN_ID;
const model = process.env.CODEX_CUA_MODEL;

if (!pluginConfigPath || !sessionId || !turnId) {
  console.error('Codex Computer Use needs its plugin config and turn metadata.');
  process.exit(1);
}

const pluginConfig = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8')).mcpServers?.cua_repl;
if (!pluginConfig?.command || !Array.isArray(pluginConfig.args)) {
  console.error('The Codex Computer Use MCP config is incomplete.');
  process.exit(1);
}

const child = spawn(pluginConfig.command, pluginConfig.args, {
  cwd: pluginConfig.cwd,
  env: { ...process.env, ...pluginConfig.env },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const allowedTools = Array.isArray(pluginConfig.enabled_tools)
  ? new Set(pluginConfig.enabled_tools.filter((name) => name !== 'turn_ended'))
  : null;
const listRequests = new Set();

// The browser service uses Codex turn metadata to select and audit the right
// browser session; Claude Code does not attach it to MCP calls on its own.
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let forwarded = line;
  try {
    const request = JSON.parse(line);
    if (request.method === 'tools/list' && request.id !== undefined) listRequests.add(request.id);
    if (request.method === 'tools/call') {
      if (request.params?.name === 'turn_ended' || (allowedTools && !allowedTools.has(request.params?.name))) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Tool is not enabled in Codex Computer Use.' } })}\n`);
        return;
      }
      request.params ??= {};
      request.params._meta = {
        ...request.params._meta,
        'x-codex-turn-metadata': { session_id: sessionId, turn_id: turnId, model },
      };
      forwarded = JSON.stringify(request);
    }
  } catch {
    // Let the MCP server report malformed JSON to its client.
  }
  child.stdin.write(`${forwarded}\n`);
});

const output = readline.createInterface({ input: child.stdout });
output.on('line', (line) => {
  let forwarded = line;
  try {
    const response = JSON.parse(line);
    if (listRequests.delete(response.id) && Array.isArray(response.result?.tools)) {
      response.result.tools = response.result.tools.filter((tool) =>
        tool.name !== 'turn_ended' && (!allowedTools || allowedTools.has(tool.name)));
      forwarded = JSON.stringify(response);
    }
  } catch {
    // Forward the original line so the MCP client can diagnose a server error.
  }
  process.stdout.write(`${forwarded}\n`);
});
child.on('error', (error) => console.error(`Could not start Codex Computer Use: ${error.message}`));
child.on('close', (code) => process.exit(code ?? 1));
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
