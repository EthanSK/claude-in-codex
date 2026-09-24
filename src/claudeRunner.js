import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { rid, usageObject } from './responsesStream.js';
import { makeMarker } from './codexInput.js';
import { describeToolUse, describeToolError } from './toolDisplay.js';

const BRIDGE_NOTE = [
  'You are running inside the Codex desktop app through a local bridge; the user picked you in Codex\'s model picker.',
  'The user sees your text replies and a one-line summary of each tool you use; they do not see raw tool output.',
  'Codex renders Markdown. Refer to files by path relative to the working directory.',
  'You cannot show interactive permission prompts or ask multiple-choice questions here: if you need a decision, ask in plain text and end your turn.',
].join('\n');

const EFFORT = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
  persistent: 'max',
};

let capabilityCache = null;
export async function claudeCapabilities(claudePath) {
  if (capabilityCache) return capabilityCache;
  const help = await new Promise((resolve) => {
    execFile(claudePath, ['--help'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve(err && !stdout ? '' : `${stdout}\n${stderr}`),
    );
  });
  capabilityCache = {
    ok: help.length > 0,
    permissionPrompts: help.includes('--permission-prompts'),
    effort: help.includes('--effort'),
    partial: help.includes('--include-partial-messages'),
  };
  return capabilityCache;
}

// Serialize turns per Claude session so two requests never resume the same session at once.
const sessionLocks = new Map();
async function withSessionLock(key, fn) {
  const prev = sessionLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  const queued = prev.then(() => next);
  sessionLocks.set(key, queued);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Compare the promise stored in the map; comparing `next` leaked every completed session key.
    if (sessionLocks.get(key) === queued) sessionLocks.delete(key);
  }
}

export function permissionArgs(mode) {
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', mode];
}

/**
 * Runs one Claude Code turn and streams it into Codex.
 * @returns {Promise<void>}
 */
export async function runClaudeTurn({ config, state, stream, parsed, modelCfg, effort, userMessage, log, req }) {
  const caps = await claudeCapabilities(config.claudePath);
  if (!caps.ok) {
    stream.textDelta(
      `Couldn't start Claude Code (\`${config.claudePath}\`). Check it's installed and logged in (\`claude auth login\`), then set \`claudePath\` in ~/.codex-claude-bridge/config.json if it isn't on PATH.`,
    );
    stream.closeOpen('final_answer');
    stream.complete(usageObject());
    return;
  }

  const permissionMode = parsed.planMode
    ? 'plan'
    : config.permissionModes[parsed.sandboxMode] || config.defaultPermissionMode;
  let cwd = parsed.cwd && fs.existsSync(parsed.cwd) ? parsed.cwd : os.homedir();
  // Canonicalise the cwd (resolve symlinks). Claude reports tool file paths from its
  // own process.cwd(), which Node always resolves — on macOS /tmp and /var are
  // symlinks into /private, so a Codex cwd of /var/... yields file paths under
  // /private/var/... and describeToolUse() could never strip the cwd prefix,
  // leaving every "Editing/Reading ..." summary as a long absolute path.
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    // keep the unresolved path; existsSync passed so this is a permissions edge case
  }

  const lockKey = parsed.resume?.sid || rid('new_');
  await withSessionLock(lockKey, async () => {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      modelCfg.claudeModel,
      ...permissionArgs(permissionMode),
    ];
    if (caps.partial) args.push('--include-partial-messages');
    if (caps.permissionPrompts) args.push('--permission-prompts', 'none');
    const effortLevel = EFFORT[String(effort || '').toLowerCase()];
    if (caps.effort && effortLevel) args.push('--effort', effortLevel);
    if (parsed.resume) args.push('--resume', parsed.resume.sid);
    if (parsed.fork) args.push('--fork-session');
    const skills = parsed.skills
      ? `The user's Codex skills are listed below. They are in addition to your own Claude Code skills. When a task matches one, read its SKILL.md with the Read tool and follow it, exactly as you would one of your own skills. When the user names a skill (e.g. $name), use it.\n\n${parsed.skills}`
      : '';
    const system = [BRIDGE_NOTE, config.extraSystemPrompt, ...parsed.agentsMd, skills, parsed.codexMemory]
      .filter(Boolean)
      .join('\n\n');
    args.push('--append-system-prompt', system);
    if (config.codexComputerUseMcpConfig) {
      const mcpConfig = {
        mcpServers: {
          cua_repl: {
            command: process.execPath,
            args: [fileURLToPath(new URL('./cuaMcpProxy.js', import.meta.url))],
            env: {
              CODEX_CUA_MCP_CONFIG_PATH: config.codexComputerUseMcpConfig,
              CODEX_CUA_SESSION_ID: parsed.threadId || rid('ccb_session_'),
              CODEX_CUA_TURN_ID: parsed.codexTurnId || rid('ccb_turn_'),
              CODEX_CUA_MODEL: modelCfg.claudeModel,
            },
          },
        },
      };
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    log.info(
      `claude turn model=${modelCfg.claudeModel} mode=${permissionMode} effort=${effortLevel || '-'} cwd=${cwd} ${
        parsed.resume ? `${parsed.fork ? 'fork' : 'resume'}=${parsed.resume.sid}` : 'new-session'
      }`,
    );

    const child = spawn(config.claudePath, args, {
      cwd,
      env: { ...process.env, CODEX_CLAUDE_BRIDGE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let finished = false;
    const onClientGone = () => {
      if (finished) return;
      log.info('codex closed the stream; stopping claude');
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 4000).unref();
    };
    // res 'close' fires on normal finish too; only act if we hadn't finished writing.
    stream.res.on('close', () => {
      if (!stream.res.writableFinished) onClientGone();
    });
    void req;

    const keepAlive = setInterval(() => stream.keepAlive(), config.keepAliveSeconds * 1000);

    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(userMessage)}\n`);

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    const ctx = {
      sid: parsed.resume?.sid || null,
      cwd,
      streamedMessageIds: new Set(),
      currentMessageId: null,
      thinkingOpen: false,
      tools: new Map(), // tool_use_id -> { name, web }
      plan: null,
      lastUsage: null,
      result: null,
      model: modelCfg.claudeModel,
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      try {
        handleEvent(ev, ctx, stream);
      } catch (err) {
        log.error(`event handling failed: ${err.stack || err}`);
      }
    });

    const exitCode = await new Promise((resolve) => {
      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        resolve(-1);
      });
      child.on('close', (code) => resolve(code));
    });
    await new Promise((r) => setImmediate(r));
    finished = true;
    clearInterval(keepAlive);

    if (stream.closed) return;

    const r = ctx.result;
    if (ctx.plan) {
      stream.closeOpen('commentary');
      stream.textDelta(`<proposed_plan>\n${ctx.plan.trim()}\n</proposed_plan>`);
    }
    if (!r || r.is_error) {
      const reason = r?.result || r?.errors?.join?.('\n') || lastLines(stderr) || `claude exited with code ${exitCode}`;
      if (stream.hasOpenMessage()) stream.closeOpen('commentary');
      stream.textDelta(`**Claude Code stopped:** ${reason}`);
      log.error(`claude failed (code ${exitCode}): ${reason}`);
    }
    stream.closeOpen('final_answer');

    if (ctx.sid) {
      const turnId = rid('t');
      stream.marker(makeMarker(ctx.sid, turnId));
      state.recordTurn(ctx.sid, turnId, parsed.threadId);
    }

    const u = ctx.lastUsage || {};
    const contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const outputTokens = r?.usage?.output_tokens ?? u.output_tokens ?? 0;
    for (const mu of Object.values(r?.modelUsage || {})) {
      if (mu?.contextWindow) state.setContextWindow(modelCfg.slug, mu.contextWindow);
    }
    stream.complete(usageObject({ input: contextTokens, cached: u.cache_read_input_tokens || 0, output: outputTokens }));
  });
}

function lastLines(s, n = 6) {
  return String(s || '')
    .trim()
    .split('\n')
    .slice(-n)
    .join('\n');
}

export function handleEvent(ev, ctx, stream) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init' && ev.session_id) ctx.sid = ev.session_id;
      if (ev.subtype === 'compact_boundary') stream.reasoning('**Compacted context**');
      return;

    case 'stream_event': {
      if (ev.parent_tool_use_id) return; // subagent internals
      const e = ev.event || {};
      if (e.type === 'message_start') {
        ctx.currentMessageId = e.message?.id || null;
        if (ctx.currentMessageId) ctx.streamedMessageIds.add(ctx.currentMessageId);
        return;
      }
      if (e.type === 'content_block_start') {
        const b = e.content_block || {};
        if (b.type === 'thinking') {
          ctx.thinkingOpen = true;
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          if (stream.hasOpenMessage()) stream.closeOpen('commentary');
        }
        return;
      }
      if (e.type === 'content_block_delta') {
        const d = e.delta || {};
        if (d.type === 'text_delta') stream.textDelta(d.text);
        else if (d.type === 'thinking_delta') stream.reasoningDelta(d.thinking);
        return;
      }
      if (e.type === 'content_block_stop' && ctx.thinkingOpen) {
        ctx.thinkingOpen = false;
        stream.closeOpen('commentary');
      }
      return;
    }

    case 'assistant': {
      if (ev.parent_tool_use_id) return;
      const msg = ev.message || {};
      if (msg.usage) ctx.lastUsage = msg.usage;
      const alreadyStreamed = msg.id && ctx.streamedMessageIds.has(msg.id);
      for (const block of msg.content || []) {
        if (block.type === 'text' && !alreadyStreamed) {
          stream.textDelta(block.text);
        } else if (block.type === 'thinking' && !alreadyStreamed && block.thinking) {
          stream.reasoning(block.thinking);
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          if (ctx.tools.has(block.id)) continue;
          const shown = describeToolUse(block, ctx.cwd);
          const entry = { name: block.name, description: block.input?.description };
          ctx.tools.set(block.id, entry);
          if (!shown) continue;
          if (shown.kind === 'web') entry.web = stream.webSearchStart(shown.action);
          else if (shown.kind === 'plan') ctx.plan = shown.plan;
          else stream.reasoning(shown.text);
        }
      }
      return;
    }

    case 'user': {
      if (ev.parent_tool_use_id) return;
      for (const block of ev.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const entry = ctx.tools.get(block.tool_use_id);
        if (!entry) continue;
        if (entry.web) {
          stream.webSearchDone(entry.web);
          entry.web = null;
        }
        if (block.is_error && entry.name !== 'ExitPlanMode') {
          stream.reasoning(describeToolError(entry.name, block.content, entry.description));
        }
      }
      return;
    }

    case 'result':
      ctx.result = ev;
      if (ev.session_id) ctx.sid = ev.session_id;
      for (const entry of ctx.tools.values()) {
        if (entry.web) {
          stream.webSearchDone(entry.web);
          entry.web = null;
        }
      }
      return;

    default:
  }
}

/** Runs Claude Code's /compact on a session (used when Codex asks to compact a Claude thread). */
export async function compactSession({ config, sid, cwd, log }) {
  const args = ['-p', '--resume', sid, '--output-format', 'json', '/compact'];
  return new Promise((resolve) => {
    // stdin must be closed: `claude -p` waits for piped stdin otherwise.
    const child = spawn(config.claudePath, args, {
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    const done = (code) => {
      clearTimeout(timer);
      if (code !== 0) log.error(`compact failed for ${sid} (code ${code}): ${stderr.trim().slice(-500)}`);
      let sessionId = sid;
      try {
        sessionId = JSON.parse(stdout).session_id || sid;
      } catch {
        // keep old id
      }
      resolve({ ok: code === 0, sessionId });
    };
    child.on('error', () => done(-1));
    child.on('close', done);
  });
}
