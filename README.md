# claude-in-codex

**Use Claude models inside the OpenAI Codex app.** Claude models appear in Codex's model picker next to GPT. Pick one, and that chat runs on your own **Claude Code CLI**, covered by your Claude subscription. GPT requests still use your ChatGPT login, but pass through the local bridge.

```
Codex app ──► 127.0.0.1:18787 ──┬─ GPT model    → chatgpt.com over WebSocket or HTTP (your ChatGPT login)
                                └─ Claude model → `claude -p` in the chat's project folder (your Claude login)
                                                   └─ Codex's own tools, run by Codex (see below)
```

**How it works, in short:**

1. The installer adds one line to `~/.codex/config.toml`, so Codex sends its model requests to a small local service instead of straight to OpenAI.
2. The service adds your Claude models to Codex's model list.
3. When you send a message, the service checks its model, including on an already-open WebSocket. GPT requests go on to OpenAI. Claude requests start your `claude` CLI in the chat's project folder.
4. Claude Code's output is translated into the events Codex already shows: replies, thinking, tool steps and plans. Claude edits the real files, so its changes appear in Codex's diff view as usual.
5. Each Codex chat is tied to its own Claude Code session, so the next message carries on where the last one stopped.

For WebSocket follow-ups, Codex may send only the new message plus `previous_response_id`. The bridge retains the latest Claude response context on that connection and expands this reference before resuming Claude. This preserves earlier messages, the project folder, and permission instructions. The cache stays in memory, is separate for each connection, and disappears when the connection closes. An unknown reference returns `previous_response_not_found` so the client can resend full history rather than silently start an empty session.

Claude Code does all the work: its own agent loop, tools, CLAUDE.md, skills and MCP servers. Codex is the window. The bridge, a small local service named `codex-claude-bridge`, never reads or stores any credentials. For GPT it relays Codex's own requests to OpenAI; for Claude it runs the official `claude` binary.

> Unofficial side project. Not affiliated with or endorsed by OpenAI or Anthropic. You're responsible for using each service within its terms.

## Requirements

- macOS (the installer uses a LaunchAgent; see [Other platforms](#other-platforms))
- The **Codex** app (or Codex CLI), signed in with ChatGPT
- **Claude Code** installed and signed in: `claude auth login`
- **Node.js 22.15+** (Node 20+ works too; the installer then turns off Codex's request compression, which older Node can't decode)

## Setup

```bash
git clone https://github.com/EthanSK/claude-in-codex.git
cd claude-in-codex
./scripts/install.sh
```

Then **quit Codex completely (Cmd+Q) and reopen it**. Open the model picker: your Claude models are listed after the GPT ones. Pick one and send a message.

The installer:

1. Finds `node` and `claude`.
2. Installs the bridge's Node dependency with `npm ci`.
3. Writes `~/.codex-claude-bridge/config.json`.
4. Starts a background service on `127.0.0.1:18787` that runs at login and restarts if it crashes. Logs go to `~/Library/Logs/codex-claude-bridge.log`.
5. Backs up `~/.codex/config.toml`, then adds one line at the top:
   ```toml
   openai_base_url = "http://127.0.0.1:18787/backend-api/codex" # codex-claude-bridge
   ```

**Uninstall:** `./scripts/uninstall.sh` stops the service and removes that line. Restart Codex afterwards.

### Optional model bar

[Codex Model Bar](https://github.com/EthanSK/codex-model-bar) is a separate macOS companion app with one button per model below the Codex window. It reads Codex's model list, so the Claude models supplied by this bridge appear alongside GPT models. The bar switches the open task through Codex's own `/model` menu. The bridge works without it; the bar's repository has its own source-build and Accessibility setup instructions.

On macOS, `RunAtLoad` and `KeepAlive` in `~/Library/LaunchAgents/com.codex-claude-bridge.plist` start the bridge when you log in and restart it after an exit. Check registration with `launchctl print gui/$(id -u)/com.codex-claude-bridge` and check the listener with `curl http://127.0.0.1:18787/health`. This reduces interruptions, but it cannot cover a failed login, a missing Node installation, a port conflict, or other system failures.

## What you get

| In Codex | In Claude Code |
|---|---|
| Model picker entry (default: Opus 5.5, Fable 5.1) | `claude --model …` |
| Reasoning effort | `--effort` (low … max) |
| Full access / workspace-write / read-only | `bypassPermissions` / `acceptEdits` / `dontAsk` |
| Plan mode | `--permission-mode plan`; the plan comes back as Codex's plan card |
| Chat's project folder | working directory |
| AGENTS.md, including your global one | appended to Claude's system prompt |
| Your Codex skills | listed for Claude, which reads a SKILL.md when a task matches |
| Codex memory block | included in Claude's system prompt when Codex sends it |
| Codex's tools (`exec`, Computer Use, sub-agents, questions, …) | offered to Claude as `mcp__codex__*`; Codex runs each call itself and returns the result to the same Claude turn |
| Each chat | its own Claude session (`--resume`) |
| Forked chats that reach the bridge | their own fork of the parent's session (`--fork-session`) |
| Compact (auto or `/compact`) | Claude Code's `/compact` |
| Stop button | interrupts Claude |
| Attached images | passed to Claude |

In the chat:

- Claude's text streams as normal replies.
- Thinking and each tool step (edits with +/− line counts, commands, searches, todo lists, subagents) show in Codex's thinking/status area.
- Web searches and page fetches show as Codex's native search cards.
- File changes appear in Codex's diff view like any other change in your repo.

Codex housekeeping requests made while a Claude model is selected, such as thread titles, are answered by your top GPT model.

### Claude runs as Claude Code, not as a model inside Codex's agent

Claude uses Claude Code's own tools (shell, file edits, subagents, …), plus the CLAUDE.md, memory, skills and MCP servers from your Claude Code setup. From Codex it gets your AGENTS.md, your Codex skills list and memory block, the chat's folder, the permission mode and the chat so far. That's why your AGENTS.md rules and Codex skills still apply. Claude Code records its system prompt when a session starts, so a later change to Codex memory may need a new Claude session or compaction to take effect.

### Codex's own tools, run by Codex

Each Codex request lists the tools Codex offers its own models. The bridge gives those tools to Claude as a small per-turn MCP server, named `codex`, so Claude sees names such as `mcp__codex__exec`, `mcp__codex__cua_repl__js` and `mcp__codex__request_user_input`. Claude doesn't connect to those tools directly. When Claude calls one:

1. The bridge ends the current Codex response with an ordinary tool call, as a GPT model would.
2. Codex runs the tool with its own executor. That covers its approvals, tool cards, task and app tools inside `exec`, and turn metadata for Computer Use.
3. Codex sends the result in its next request. The bridge passes it to the Claude process that is still waiting, and that process carries on in the new response.

Claude keeps its built-in tools and is told to use them for ordinary file and shell work. The Codex tools are for things only Codex can do. Hosted tools such as Codex's web search are left out because Claude Code has its own. When Codex offers Computer Use this way, the bridge stops starting its direct Computer Use connection. Codex's own executor supplies the right task context for it, including the in-app browser. The direct connection is now only a fallback for requests that don't include those tools.

Other details:

- Codex applies its own approval policy to these calls, so they are pre-approved in Claude (`--allowedTools mcp__codex`). Plan mode is the exception: there, Claude's read-only rules still apply.
- Codex's `exec` tool lists every nested tool in its description, about 17 KB. For bridged turns the bridge raises Claude Code's 2,048-character MCP description limit (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`) to the longest Codex description. That higher limit also applies to your other MCP servers in those turns.
- One MCP call can wait up to 24 hours (`MCP_TOOL_TIMEOUT`), because some tools wait on you, such as a question.
- Questions use Codex's question card, not Claude Code's own `AskUserQuestion`, which Codex can't show; the bridge turns that tool off when Codex offers a card. The desktop app's `request_user_input_async` only accepts the question, and your answer reaches Claude as your message, attached to a later tool result or starting its next turn. The CLI's `request_user_input` only works in Plan mode, so elsewhere Claude asks in plain text.
- A message you send while a tool runs is added to that tool's result. So is one sent after stopping the turn, if Codex returned the results.
- If a new message arrives on the task without those results, the bridge stops the waiting Claude process. It then resumes the session normally, and the unanswered call and anything Codex recorded appear as context.

**Verified so far (September 2026, Claude Code 2.1.281, Codex CLI 0.155):** in real Opus turns through the Codex CLI, `exec` ran a shell command that Codex itself executed and displayed. Computer Use read desktop and Chrome state. Two Codex calls followed by Claude's own Bash all finished in one Claude process. The desktop app's task tools (pin, rename, messaging) and the in-app browser weren't tested through this path at the time of writing.

**History:** a September 2026 prototype that connected Claude straight to the desktop app-tools server was rejected by the app's native-pipe peer check, and was removed. Don't disable that check to work around this.

### Switching models mid-chat

Switch freely. Switching doesn't make Codex compact the chat.

| Switch | What the next model sees |
|---|---|
| GPT → Claude, first time in a chat | A new Claude session with the chat so far as text: your messages, GPT's replies, and GPT's commands with their output (each output cut to 2,000 characters). Only the latest 60,000 characters are passed. GPT's reasoning is encrypted by OpenAI, so Claude never sees it. |
| Back to Claude later | Claude resumes its own session and gets only what happened since its last reply. |
| Claude → GPT | Claude's replies, as normal assistant messages. Not Claude's thinking or tool steps. Claude's file changes are on disk, so GPT can read them. |
| You edit an earlier message | Claude starts a new session from the chat as it now looks. |
| Fork that reaches the bridge | Its own fork of the parent chat's Claude session. |

### Compaction

Codex still decides when to compact: automatically, or when you run `/compact`. The bridge reports Claude's real token count and context window, so Codex's context meter is accurate. When Codex compacts a Claude chat, the bridge runs Claude Code's own `/compact` on the Claude session. Claude Code can also compact by itself during a turn ("Compacted context").

Compacted history doesn't carry across models:

- After Claude compacts, GPT gets a note that earlier Claude turns were compacted. It can't see their details.
- After GPT compacts, OpenAI's summary is encrypted, so Claude can't read it. Claude gets a note in its place.

For long chats, stick mainly to one model and switch for second opinions.

### Cost and caching

- Each model uses its own account: Claude your Claude login, GPT your ChatGPT login. Switching doesn't bill anything twice.
- The first Claude message in a chat costs the most. Claude Code's system prompt, your AGENTS.md, the skills list and the pasted chat are all new.
- Every later message continues the same Claude Code session. Each message starts a new `claude` process, but Anthropic's prompt cache is on the server, so the earlier conversation is read from the cache. For example, a follow-up in a chat of about 100k tokens, sent 6 minutes after the last reply, read about 99k tokens from the cache and only added about 4k new ones.
- If a chat sits idle long enough for the cache to expire, the next message caches the history again, once.
- Switching back to GPT only adds Claude's replies as new input. OpenAI's prompt cache can still cover the earlier part of the chat.

## Configuration

`~/.codex-claude-bridge/config.json` (every key is optional):

```json
{
  "port": 18787,
  "claudePath": "/Users/you/.local/bin/claude",
  "models": [
    { "slug": "claude-opus-5-5", "displayName": "Opus 5.5", "claudeModel": "claude-opus-5-5" },
    { "slug": "claude-fable-5-1", "displayName": "Fable 5.1", "claudeModel": "claude-fable-5-1" },
    { "slug": "claude-sonnet-5", "displayName": "Sonnet 5", "claudeModel": "claude-sonnet-5" }
  ],
  "hiddenModels": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  "permissionModes": { "workspace-write": "auto" },
  "fallbackModel": "gpt-5.5",
  "extraSystemPrompt": "",
  "debugDumpDir": null
}
```

- `models`: what appears in the picker. `claudeModel` is anything `claude --model` accepts (an alias or a full model name). Put the version in `displayName` (e.g. "Sonnet 5") so the picker shows exactly which model you get.
- `hiddenModels`: optional upstream model slugs to hide from the picker. They remain in the catalog so existing chats can still use them. The example hides the three GPT-5.6 entries; the default is an empty list.
- `permissionModes`: maps Codex's sandbox mode to a Claude Code permission mode.
- `defaultPermissionMode`: the Claude permission mode when Codex omits sandbox information or sends an unrecognized mode. Defaults to `acceptEdits`, which can still deny commands needing approval in a non-interactive turn.
- `fallbackModel`: the GPT model that answers housekeeping requests.
- `codexComputerUseMcpConfig`: found automatically when Codex's bundled Computer Use plugin is explicitly enabled. It's used only when a Codex request doesn't already offer Computer Use as a Codex-run tool. Set it to `null` to disable that fallback, or to a `.mcp.json` path to override discovery.

After changing the config, restart the service, then restart Codex so it reloads the model list:

```bash
launchctl kickstart -k gui/$(id -u)/com.codex-claude-bridge
```

Code changes in `src/` are picked up automatically once every request and WebSocket connection closes. A long-lived GPT WebSocket can delay that restart; check the service's PID or a fresh `listening on` log line before claiming the new code is live. If a restart is needed, wait for active turns to finish before using the command above.

### Full permissions for Claude turns

If you want every ordinary Claude turn to run with permission bypass, merge these keys into your local `~/.codex-claude-bridge/config.json`, preserving its other settings, then restart the bridge:

```json
{
  "defaultPermissionMode": "bypassPermissions",
  "permissionModes": {
    "danger-full-access": "bypassPermissions",
    "workspace-write": "bypassPermissions",
    "read-only": "bypassPermissions"
  }
}
```

This is an explicit local opt-in: it overrides Codex's read-only and workspace permission labels for Claude. Explicit Plan mode still uses Claude's plan mode. Other installations keep the original permission mapping unless their owner chooses this configuration.

The bridge passes `--dangerously-skip-permissions` on both new and resumed turns. `-p` selects non-interactive print mode; it does not grant tool permissions by itself. With Claude Code 2.1.281, real bridge tests completed Write, Edit, and Bash operations outside the working directory without an interactive confirmation, including on a resumed session. The flag does not grant macOS privacy permissions or administrator access, and Claude's managed policies still apply. See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

## Troubleshooting

- **Claude models don't show in the picker.** Quit Codex completely (Cmd+Q) and reopen it. Check `curl http://127.0.0.1:18787/health` and that `~/.codex/config.toml` starts with the `openai_base_url` line.
- **The installer says the port is in use.** Something else is on 18787; the installer names it. Run `CODEX_CLAUDE_BRIDGE_PORT=18888 ./scripts/install.sh`. The default isn't 8787 because that's `wrangler dev`'s default.
- **Claude is selected but GPT answers.** Update the bridge (`git pull`); Codex's request format changes between versions. Then check the log for `claude turn model=…` lines.
- **"Claude Code stopped: …" in a reply.** That's Claude Code's own error (auth, usage limit, unknown model name). Run the same model in a terminal with `claude -p --model <name> "hi"` to see it directly.
- **An Opus side chat stays on Thinking or says the model is unsupported with a ChatGPT account.** Update and reinstall the bridge, then verify the service has restarted. Codex can start a side chat with an Opus WebSocket or prewarm one over a GPT WebSocket and send Opus on that same connection. Older bridge versions rejected the first route or forwarded the second to OpenAI. The bridge now accepts Claude WebSockets and routes each message by its model. If the error persists, compare its timestamp with `local routed websocket`, `proxied GPT websocket`, and `claude turn` in the bridge log.
- **Claude forgets the immediately preceding side-chat message.** Older bridge versions ignored `previous_response_id`, treating each abbreviated WebSocket follow-up as a new session. Update and restart the bridge. For a chat affected before the fix, restate any missing context once; the lost context was never included in that Claude session. Verify with “Remember the test word apricot”, followed by “What test word did I just give you?”. New follow-ups should log `resume=…` with the same Claude session instead of `new-session`.
- **Codex repeatedly logs WebSocket HTTP 426 during startup prewarming.** Update the bridge and verify the service restarted. Some current Codex clients omit the model hint in the upgrade; the bridge now accepts that connection and routes each later message by its model. The installed service can remain on old code while long-lived connections are open.
- **A GPT side chat of a Claude thread reports that encrypted content could not be verified.** If the item ID starts with `cmp_ccb_`, `msg_ccb_`, `rs_ccb_`, or `ws_ccb_`, update the bridge and verify the service has restarted. Those items were created by the bridge; older versions could forward them to OpenAI when GPT used a WebSocket. The bridge now removes or translates them on GPT's HTTP and WebSocket routes.
- **Logs:** `tail -f ~/Library/Logs/codex-claude-bridge.log`

## Limits

- Claude's tool calls don't go through Codex's approval prompts. Permissions come from the mapping above.
- Codex 0.155 usually tells the bridge which model is connecting in the WebSocket handshake, but some startup prewarm clients omit the hint. The bridge accepts both forms and checks each message: Claude turns run locally, while GPT remains on WebSocket. A connection without a GPT hint only opens an upstream GPT socket when a GPT message arrives, using that message's model as its routing hint. The bridge remains a local hop, and its latency versus a direct GPT connection has not been measured.
- Forked Claude sessions that reach the bridge get their own Claude session.
- The fallback direct Computer Use connection goes through Claude Code's permissions, not Codex's approval prompts. Codex-run tools use Codex's own approvals.
- This depends on Codex's internal request format, which can change with Codex updates. The tests pin the shapes the bridge relies on.
- Model requests on the configured local Codex route go through the bridge, GPT included. If the service isn't running, GPT on that route stops working too. `./scripts/uninstall.sh` restores Codex's direct OpenAI route.
- Codex's desktop-app instructions aren't passed to Claude. Claude Code's own memory still applies alongside the Codex memory block when one is supplied.

### Can GPT bypass the bridge?

Not while keeping Claude and GPT in this same model picker with this configuration. Codex's `openai_base_url` changes the base URL of the built-in OpenAI provider for every model request. The bridge therefore receives GPT requests too. [Codex documents this setting](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers) for local or hosted model proxies, routers and data-residency endpoints; the bridge uses that routing ability to add Claude models to the normal catalog. Remove the `openai_base_url` line (or run `./scripts/uninstall.sh`) and restart Codex to restore its direct GPT transport; the Claude picker entries then disappear. A future Codex feature for per-model provider routing could remove this trade-off.

## Other platforms

The server runs on Node with one WebSocket dependency. On Linux or Windows:

1. Run `npm ci`, then start it yourself: `node src/server.js`.
2. Add the `openai_base_url` line above to `~/.codex/config.toml`.
3. Restart Codex.

## How it works

The bridge is an OpenAI Responses API endpoint on localhost:

- **`GET /models`** fetches Codex's normal model catalog and adds the Claude models.
- **`GET /responses` WebSocket upgrades**, with GPT, Claude, or no model hint, are accepted locally. The bridge forwards GPT messages to OpenAI with Codex's authentication and handles Claude messages on that same connection with Claude Code. Claude follow-ups resolve their connection-local `previous_response_id`; a switch from Claude to GPT replays the reconstructed history after removing bridge-only items.
- **`POST /responses` with a GPT model** is forwarded to OpenAI untouched, apart from removing bridge-only items from the history.
- **`POST /responses` with a Claude model** runs `claude -p --input-format stream-json --output-format stream-json --resume <session>` and translates Claude Code's events into the Responses events Codex renders: text, reasoning summaries, web search calls and plan blocks. An invisible marker in each reply ties a Codex chat to its Claude session.

It only accepts requests from this Mac. It refuses requests from web pages (anything with a browser `Origin` header) and requests with an unexpected `Host`, so a website can't use it to run Claude.

## Development

```bash
npm test     # fake claude + fake OpenAI upstream; no network, no accounts
npm start    # run in the foreground
```

MIT licensed.
