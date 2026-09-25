#!/usr/bin/env node
// Claude Code starts MCP servers as commands; this one just connects Claude's stdio to
// the bridge's per-turn Codex tool server (src/codexTools.js), which answers the MCP calls.
import net from 'node:net';

const socketPath = process.env.CODEX_CLAUDE_BRIDGE_TOOLS_SOCKET;
if (!socketPath) {
  console.error('The Codex tool bridge needs its socket path.');
  process.exit(1);
}

const socket = net.createConnection(socketPath);
socket.on('error', (error) => {
  console.error(`Could not reach the Codex tool bridge: ${error.message}`);
  process.exit(1);
});
socket.on('close', () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
