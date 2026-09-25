import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { rid, usageObject } from './responsesStream.js';
import { makeMarker } from './codexInput.js';
import { describeToolUse, describeToolError } from './toolDisplay.js';
import {
  CODEX_TOOLS_SERVER,
  CodexToolServer,
  codexToolCatalog,
  codexOutputToMcp,
  forgetCodexCalls,
  isCodexToolName,
  waitForCodexResults,
} from './codexTools.js';

const BRIDGE_NOTE = [
  'You are running inside the Codex desktop app through a local bridge; the user picked you in Codex\'s model picker.',
  'The user sees your text replies and a one-line summary of each tool you use; they do not see raw tool output.',
  'Codex renders Markdown. Refer to files by path relative to the working directory.',
].join('\n');

// Without Codex's question tool (older Codex, or a request that does not offer it), questions have to be plain text.
const PLAIN_TEXT_QUESTIONS_NOTE = 'You cannot show interactive permission prompts or ask multiple-choice questions here: if you need a decision, ask in plain text and end your turn.';

const CODEX_TOOLS_NOTE = [
  `Tools named \`mcp__${CODEX_TOOLS_SERVER}__*\` are the Codex app's own tools, the same ones Codex gives GPT. Codex runs them itself, shows them in its UI and applies its own approvals.`,
  'Use them for abilities only Codex has, such as the task and app tools inside `exec` (filter `ALL_TOOLS` there to find them), Computer Use and the in-app browser, Codex sub-agents, and asking the user questions when that tool is offered.',
  'Prefer your built-in tools for ordinary file and shell work.',
].join('\n');

/**
 * Tells Claude to ask through Codex's question card instead of Claude Code's AskUserQuestion, which Codex cannot show.
 * The desktop app offers `request_user_input_async` (it only accepts the question; the answer arrives later as a user
 * message), while the CLI offers `request_user_input` (the answer is the tool result).
 */
function codexQuestionsNote(questionTool) {
  const lines = [
    `You cannot show interactive permission prompts here. To ask the user for a decision, preference or clarification, call \`mcp__${CODEX_TOOLS_SERVER}__${questionTool.mcpTool.name}\` instead of asking in plain text: Codex shows it as a question card the user answers with a click. Prefer short multiple-choice options. If Codex refuses the tool, ask in plain text instead and end your turn.`, // Seen live: the CLI's request_user_input only works in Plan mode.
  ];
  if (questionTool.name.endsWith('_async')) {
    lines.push('It returns `{"accepted":true}` straight away. The answer arrives later as a user message wrapped in `<send_user_message_question_reply>`, either attached to a later Codex tool result or as your next turn. Keep doing work that does not depend on the answer; if you cannot continue without it, say so and end your turn.');
  }
  return lines.join(' ');
}

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
export async function runClaudeTurn({ config, state, stream, parsed, modelCfg, effort, userMessage, log, req, codexTools }) {
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

  // A side-chat fork only reads the parent's session and writes a new one, so it must not queue behind the parent's running turn.
  // Bug fixed 2026-09-25: a new Opus side chat sat at "Thinking 0s" until its parent's long typecheck turn finished.
  // A real Claude Code fork taken while the parent ran a 40-second foreground command worked, and the parent then finished normally.
  const lockKey = parsed.resume && !parsed.fork ? parsed.resume.sid : rid(parsed.fork ? 'fork_' : 'new_');
  if (sessionLocks.has(lockKey)) log.info(`claude session ${lockKey} is busy; this turn waits for the running one`); // The "claude turn" line only appears once the wait ends.
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
    const catalog = codexToolCatalog(codexTools);
    const questionTool = catalog.get('request_user_input_async') ?? catalog.get('request_user_input'); // The desktop's async card works in every mode; the CLI's request_user_input is Plan-mode only.
    // Claude Code's own question tool has nowhere to appear in Codex, so Codex's question card replaces it.
    if (questionTool) args.push('--disallowedTools', 'AskUserQuestion');
    const questionsNote = questionTool ? codexQuestionsNote(questionTool) : PLAIN_TEXT_QUESTIONS_NOTE;
    const system = [BRIDGE_NOTE, questionsNote, catalog.size ? CODEX_TOOLS_NOTE : '', config.extraSystemPrompt, ...parsed.agentsMd, skills, parsed.codexMemory]
      .filter(Boolean)
      .join('\n\n');
    args.push('--append-system-prompt', system);
    const mcpConfig = { mcpServers: {} };
    const env = { ...process.env, CODEX_CLAUDE_BRIDGE: '1' };
    // Calls Claude makes to Codex's tools; each waits here until Codex returns its result.
    const queuedCodexCalls = [];
    let codexToolServer = null;
    if (catalog.size) {
      codexToolServer = new CodexToolServer(catalog, (call) => {
        queuedCodexCalls.push(call);
        scheduleCodexHandoff();
      });
      mcpConfig.mcpServers[CODEX_TOOLS_SERVER] = {
        command: process.execPath,
        args: [fileURLToPath(new URL('./codexToolsMcpProxy.js', import.meta.url))],
        env: { CODEX_CLAUDE_BRIDGE_TOOLS_SOCKET: await codexToolServer.listen() },
      };
      // Codex runs its tools under its own approval policy, so Claude should not block them too. Plan mode keeps Claude's read-only rules.
      if (permissionMode !== 'plan') args.push('--allowedTools', `mcp__${CODEX_TOOLS_SERVER}`);
      // Codex's `exec` lists every nested tool in its description (about 17 KB); Claude Code otherwise cuts MCP descriptions at 2,048 characters.
      const longestDescription = Math.max(...[...catalog.values()].map((entry) => entry.mcpTool.description.length));
      env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(Math.max(2048, longestDescription));
      // A Codex tool can legitimately wait a long time, for example on the user's answer to a question.
      env.MCP_TOOL_TIMEOUT = String(CODEX_TOOL_TIMEOUT_MS);
    }
    // Codex's own executor already provides Computer Use with the right turn metadata, including the in-app browser; the direct proxy is the fallback.
    const codexRunsComputerUse = [...catalog.values()].some((entry) => entry.namespace === 'mcp__cua_repl');
    if (config.codexComputerUseMcpConfig && !codexRunsComputerUse) {
      mcpConfig.mcpServers.cua_repl = {
        command: process.execPath,
        args: [fileURLToPath(new URL('./cuaMcpProxy.js', import.meta.url))],
        env: {
          CODEX_CUA_MCP_CONFIG_PATH: config.codexComputerUseMcpConfig,
          CODEX_CUA_SESSION_ID: parsed.threadId || rid('ccb_session_'),
          CODEX_CUA_TURN_ID: parsed.codexTurnId || rid('ccb_turn_'),
          CODEX_CUA_MODEL: modelCfg.claudeModel,
        },
      };
    }
    if (Object.keys(mcpConfig.mcpServers).length) args.push('--mcp-config', JSON.stringify(mcpConfig));
    if (catalog.size) log.info(`codex tools for claude: ${[...catalog.keys()].join(', ')}`); // Tool names only; shows which Codex surfaces this turn could reach.

    log.info(
      `claude turn model=${modelCfg.claudeModel} mode=${permissionMode} effort=${effortLevel || '-'} cwd=${cwd} ${
        parsed.resume ? `${parsed.fork ? 'fork' : 'resume'}=${parsed.resume.sid}` : 'new-session'
      }`,
    );

    const child = spawn(config.claudePath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.on('close', resolve));

    let finished = false;
    const stopClaude = () => {
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 4000).unref();
    };
    const onClientGone = () => {
      if (finished) return;
      log.info('codex closed the stream; stopping claude');
      stopClaude();
    };
    // res 'close' fires on normal finish too; only act if we hadn't finished writing.
    const watchClient = (res) => res.on('close', () => {
      if (!res.writableFinished) onClientGone();
    });
    watchClient(stream.res);
    void req;

    const keepAlive = setInterval(() => stream?.keepAlive(), config.keepAliveSeconds * 1000);

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

    // While Codex runs a tool there is no open response (`stream` is null); keep Claude's events for the next one.
    const heldEvents = [];
    const handle = (ev) => {
      if (!stream) {
        heldEvents.push(ev);
        return;
      }
      try {
        handleEvent(ev, ctx, stream);
      } catch (err) {
        log.error(`event handling failed: ${err.stack || err}`);
      }
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
      handle(ev);
    });

    // Handing Claude's Codex tool calls to Codex: end this response with the calls and wait for Codex's next request.
    const waiting = new Map(); // callId -> call handed to Codex
    const turn = {
      threadId: parsed.threadId,
      // Codex sent the results: continue this same Claude process in Codex's new response.
      resume(nextStream, { outputs, userText }) {
        stream = nextStream;
        watchClient(stream.res);
        const calls = [...waiting.values()];
        forgetCodexCalls(waiting.keys());
        waiting.clear();
        calls.forEach((call, index) => {
          const content = outputs.has(call.callId)
            ? codexOutputToMcp(outputs.get(call.callId))
            : [{ type: 'text', text: 'Codex returned no result for this tool call.' }];
          if (userText && index === calls.length - 1) content.push({ type: 'text', text: `The user sent this message while the tool was running:\n\n${userText}` });
          call.reply(content);
        });
        for (const ev of heldEvents.splice(0)) handle(ev);
        scheduleCodexHandoff();
      },
      // The user moved on without returning results (for example after stopping the turn), so this process would wait forever.
      async cancel() {
        log.info('codex did not return tool results; stopping the waiting claude turn');
        stopClaude();
        await exited;
      },
    };
    let handoffTimer = null;
    function scheduleCodexHandoff() {
      if (!stream || handoffTimer || !queuedCodexCalls.length) return;
      // A short pause lets Claude's stdout (text before the call) and any parallel calls arrive first.
      handoffTimer = setTimeout(handOffCodexCalls, 100);
    }
    function handOffCodexCalls() {
      handoffTimer = null;
      if (!stream || !queuedCodexCalls.length) return;
      // Wait (up to a second) until the stdout event naming each call is handled, so its preceding text lands in this response.
      const unseen = queuedCodexCalls.some((call) => call.toolUseId && !ctx.tools.has(call.toolUseId));
      if (unseen && Date.now() - queuedCodexCalls[0].queuedAt < 1000) {
        scheduleCodexHandoff();
        return;
      }
      const calls = queuedCodexCalls.splice(0);
      finishWebSearches(ctx, stream);
      stream.closeOpen('commentary');
      // A marker lets a fresh Claude process resume this session if the bridge restarts before Codex replies.
      if (ctx.sid) {
        const turnId = rid('t');
        stream.marker(makeMarker(ctx.sid, turnId));
        state.recordTurn(ctx.sid, turnId, parsed.threadId);
      }
      for (const call of calls) {
        stream.codexToolCall(call);
        waiting.set(call.callId, call);
      }
      waitForCodexResults(calls, turn);
      log.info(`handed ${calls.map((call) => call.entry.name).join(', ')} to codex`);
      stream.complete(usageSoFar(ctx), { endTurn: false });
      stream = null;
    }

    const exitCode = await new Promise((resolve) => {
      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        resolve(-1);
      });
      exited.then(resolve);
    });
    await new Promise((r) => setImmediate(r));
    finished = true;
    clearInterval(keepAlive);
    clearTimeout(handoffTimer);
    forgetCodexCalls(waiting.keys());
    codexToolServer?.close();

    if (!stream || stream.closed) return;

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

    for (const mu of Object.values(r?.modelUsage || {})) {
      if (mu?.contextWindow) state.setContextWindow(modelCfg.slug, mu.contextWindow);
    }
    stream.complete(usageSoFar(ctx, r?.usage?.output_tokens));
  });
}

// Longest a Claude turn waits for Codex to run one tool before the MCP call times out.
const CODEX_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function usageSoFar(ctx, outputTokens) {
  const u = ctx.lastUsage || {};
  const contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return usageObject({ input: contextTokens, cached: u.cache_read_input_tokens || 0, output: outputTokens ?? u.output_tokens ?? 0 });
}

// Web search cards belong to the response that opened them, so close them before that response ends.
function finishWebSearches(ctx, stream) {
  for (const entry of ctx.tools.values()) {
    if (entry.web) {
      stream.webSearchDone(entry.web);
      entry.web = null;
    }
  }
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
          const entry = { name: block.name, description: block.input?.description };
          ctx.tools.set(block.id, entry);
          if (isCodexToolName(block.name)) continue; // Codex shows its own card for the tool call item.
          const shown = describeToolUse(block, ctx.cwd);
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
        if (block.is_error && entry.name !== 'ExitPlanMode' && !isCodexToolName(entry.name)) {
          stream.reasoning(describeToolError(entry.name, block.content, entry.description));
        }
      }
      return;
    }

    case 'result':
      ctx.result = ev;
      if (ev.session_id) ctx.sid = ev.session_id;
      finishWebSearches(ctx, stream);
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
