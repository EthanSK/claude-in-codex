import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_HOME =
  process.env.CODEX_CLAUDE_BRIDGE_HOME || path.join(os.homedir(), '.codex-claude-bridge');

// Codex treats a base URL ending in /backend-api/codex as the ChatGPT backend,
// which keeps every GPT feature (remote compaction, model catalog, etc.) on.
export const BASE_PATH = '/backend-api/codex';

// Reuse Codex's installed computer-use server only when the user enabled that plugin.
export function findCodexComputerUseMcpConfig(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  let enabled = false;
  try {
    let inPluginSection = false;
    for (const line of fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inPluginSection = trimmed === '[plugins."unified-computer-use@openai-bundled"]';
      } else if (inPluginSection && /^enabled\s*=\s*true(?:\s*(?:#.*)?)?$/.test(trimmed)) {
        enabled = true;
      } else if (inPluginSection && /^enabled\s*=\s*false(?:\s*(?:#.*)?)?$/.test(trimmed)) {
        enabled = false;
      }
    }
  } catch {
    return null;
  }
  if (!enabled) return null;

  const cache = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
  try {
    const versions = fs.readdirSync(cache).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const config = path.join(cache, version, '.mcp.json');
      if (fs.existsSync(config)) return config;
    }
  } catch {
    return null;
  }
  return null;
}

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 18787,
  // Where GPT traffic is forwarded, unchanged.
  upstream: 'https://chatgpt.com/backend-api/codex',
  // Absolute path is best when running under launchd (PATH is minimal there).
  claudePath: 'claude',
  // Models added to Codex's picker. `claudeModel` is passed to `claude --model`.
  // Every displayName includes the model version (e.g. "Fable 5.1", not "Fable"), so
  // the picker always shows exactly which model a chat runs on.
  models: [
    {
      slug: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      claudeModel: 'claude-opus-5-5',
      description: 'Claude Opus 5.5, running through your Claude Code CLI.',
    },
    {
      slug: 'claude-fable-5-1',
      displayName: 'Fable 5.1',
      claudeModel: 'claude-fable-5-1',
      description: 'Claude Fable 5.1, running through your Claude Code CLI.',
    },
  ],
  // Keep selected upstream models usable in existing chats while omitting them from the picker.
  hiddenModels: [],
  // Codex sandbox_mode -> Claude Code permission mode.
  permissionModes: {
    'danger-full-access': 'bypassPermissions',
    'workspace-write': 'acceptEdits',
    'read-only': 'dontAsk',
  },
  defaultPermissionMode: 'acceptEdits',
  // Context window advertised to Codex until Claude Code reports the real one.
  defaultContextWindow: 200000,
  // GPT model used for Codex housekeeping requests (titles, summaries) made while a
  // Claude model is selected. null = highest-priority GPT model in the catalog.
  fallbackModel: null,
  // Extra text appended to Claude Code's system prompt for every bridged turn.
  extraSystemPrompt: '',
  // Claude can use the same app-backed browser and desktop MCP server as Codex.
  codexComputerUseMcpConfig: findCodexComputerUseMcpConfig(),
  // Seconds between keep-alive events while Claude works silently.
  keepAliveSeconds: 15,
  // Set to a directory to dump sanitized request bodies for debugging.
  debugDumpDir: null,
  logLevel: 'info',
};

export function loadConfig() {
  const file = path.join(BRIDGE_HOME, 'config.json');
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[bridge] could not read ${file}: ${err.message}`);
    }
  }
  const config = {
    ...DEFAULTS,
    ...user,
    permissionModes: { ...DEFAULTS.permissionModes, ...(user.permissionModes || {}) },
  };
  if (process.env.CODEX_CLAUDE_BRIDGE_PORT) config.port = Number(process.env.CODEX_CLAUDE_BRIDGE_PORT);
  if (process.env.CODEX_CLAUDE_BRIDGE_UPSTREAM) config.upstream = process.env.CODEX_CLAUDE_BRIDGE_UPSTREAM;
  if (process.env.CODEX_CLAUDE_BRIDGE_CLAUDE) config.claudePath = process.env.CODEX_CLAUDE_BRIDGE_CLAUDE;
  config.upstream = config.upstream.replace(/\/+$/, '');
  return config;
}
