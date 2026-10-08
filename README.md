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

The bar also has a reasoning slider and three speed icons for Standard, Fast and Ultrafast. Speed icons select Codex's native choices for the current model/account and report unavailable choices. This bridge's Claude entries advertise no additional speed tiers; the icons do not enable a Claude Code fast mode. The bar's README records its verification limits.

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
- A message you send while a tool runs is added to that tool's result, including base64 image attachments. Full-history replays retain messages before or after the result, using the pending call's marker as the boundary; earlier messages are not sent again. So is a message sent after stopping the turn, if Codex returned the results. Image URLs in this MCP continuation appear as URLs rather than image pixels because MCP image blocks require base64 data.
- If a new message arrives on the task without those results, the bridge stops the waiting Claude process. It then resumes the session normally, and the unanswered call and anything Codex recorded appear as context.
- Claude subprocesses receive the current Codex chat's UUID as `CODEX_THREAD_ID`, including during compaction. Local helpers can use it to locate the right chat. When the request has no valid chat UUID, the bridge removes any inherited value rather than borrowing its launcher's identity.

**Verified so far (September 2026, Claude Code 2.1.281, Codex CLI 0.155):** in real Opus turns through the Codex CLI, `exec` ran a shell command that Codex itself executed and displayed. Computer Use read desktop and Chrome state. Two Codex calls followed by Claude's own Bash all finished in one Claude process. The desktop app's task tools (pin, rename, messaging) and the in-app browser weren't tested through this path at the time of writing.

**History:** a September 2026 prototype that connected Claude straight to the desktop app-tools server was rejected by the app's native-pipe peer check, and was removed. Don't disable that check to work around this.

### GPT and Claude sub-agents

Claude can use Codex's `collaboration` tools to spawn GPT or Claude children, receive their replies, and send follow-ups. The bridge declares Claude's collaboration arguments as plaintext with `encrypted_function_args: []`; without that field, Codex treats the message as ciphertext and GPT rejects it with `invalid_encrypted_content`. Native OpenAI encrypted messages remain untouched.

Claude Code's native background `Agent` tasks have a different lifetime: the bridge runs one Claude process per turn, and those background tasks end when that process exits. Claude is told to wait for native foreground agents before finishing, or use the offered Codex collaboration tools for work across turns, subject to the user's delegation instructions. This is guidance, not a guarantee that Claude will always choose the right tool; the bridge does not keep native background agents alive.

Codex delivers tasks and results as `agent_message` items. The bridge passes their readable text to Claude with the sender identified, including messages received while a Codex tool runs. When a child reply preempts `wait_agent`, Codex can omit both the wait call and its result from the next request. The bridge matches the surviving session marker to the pending wait in that same thread, then delivers the actual mailbox message without killing Claude and recording a false user cancellation. Human messages and Stop retain the existing cancellation path; another thread cannot wake the parent’s pending tool.

Messages from another desktop chat use a different shape: a `codex_app.send_message_to_thread` output containing `<codex_delegation>`, with an item ID and no `call_id`. The bridge preserves the whole delivery and its source chat, distinguishing it from a tool result or a new human instruction/permission. Unread deliveries are attached at the next Codex tool continuation, or passed on the next Claude turn, even if Codex recorded them before a later bridge marker. Delivered IDs are retained in the existing session state to prevent duplicate delivery across resumptions, service reloads and forked compaction. The bridge cannot inject a message before Codex sends it in a request, or guarantee that Claude follows it; it does not poll transcripts or interrupt native work to fetch messages.

Verified on October 6, 2026 with the installed Codex binary against both an isolated bridge and the installed service: an Opus 5.5 parent spawned GPT-6.1 Sol and Fable 5.1 children, received both expected replies, then continued the GPT child and verified its previous reply. This does not repair already-recorded malformed encrypted items in failed children; spawn a fresh child after updating. Claude still cannot decrypt genuinely encrypted OpenAI content.

### Pasted text and Agent Flow messages

Agent Flow's speech and typed-text wrappers remain the current user request. When selected text precedes a request in the same message, the bridge preserves both verbatim, including the quotation boundaries. A selection-only block remains context. Older bridge versions treated these complete XML-led messages as earlier context and could substitute `(continue)` for the current request.

Codex can put a long paste in `Pasted text.txt`, followed by an empty `My request` heading. The bridge preserves the attachment references and the notice that the pasted text contains the request; Claude still needs to read those files and any referenced canonical prompt. An empty heading does not mean there is no request. To investigate a missed instruction, compare the Codex user message with the Claude transcript and its file-read results: successful delivery and reading do not prove that Claude followed the instruction. Regression tests use a fake Claude runner to check delivery on new and resumed turns, not model obedience.

### Switching models mid-chat

Switch freely. Switching doesn't make Codex compact the chat.

| Switch | What the next model sees |
|---|---|
| GPT → Claude, first time in a chat | A new Claude session with the chat so far as text: your messages, GPT's replies, and GPT's commands with their output (each output cut to 2,000 characters). Only the latest 60,000 text characters are passed. Earlier user and tool-result images are also passed as image blocks, labelled as history. GPT's reasoning is encrypted by OpenAI, so Claude never sees it. |
| Back to Claude later | Claude resumes its own session and gets only what happened since its last reply. |
| Claude → GPT | Claude's replies, as normal assistant messages. Not Claude's thinking or tool steps. Claude's file changes are on disk, so GPT can read them. |
| You edit an earlier message | Claude starts a new session from the chat as it now looks. |
| Fork that reaches the bridge | Its own fork of the parent chat's Claude session. |

### Compaction

Codex still decides when to compact: automatically, or when you run `/compact`. The bridge reports Claude's real token count and context window, so Codex's context meter is accurate. When Codex compacts a Claude chat, the bridge runs Claude Code's own `/compact` on the Claude session. Claude Code can also compact by itself during a turn ("Compacted context").

A side chat that inherits another chat's Claude session forks it before compaction, including when the inherited marker is older than the parent's latest turn. Older bridge versions compacted and reassigned the parent's session instead, causing the parent to start fresh on its next message. Failed compaction now returns an error without replacing Codex's history with a success marker. Existing sessions affected before the fix are not rewritten.

Compacted history doesn't carry across models:

- After Claude compacts, GPT gets a note that earlier Claude turns were compacted. It can't see their details.
- After GPT compacts, OpenAI's summary is encrypted, so Claude can't read it. Claude gets a note in its place.

For long chats, stick mainly to one model and switch for second opinions.

### Cost and caching

- Each model uses its own account: Claude your Claude login, GPT your ChatGPT login. A model switch can make the next provider process the transferred context under that account's allowance.
- A fresh Claude session often has the largest uncached input: Claude Code's setup, your AGENTS.md, the skills list and transferred chat. Shared prefixes can already be cached, and later compaction or setting changes can also create fresh cache writes, so the first message is not always the most expensive.
- Normal follow-ups resume the same Claude Code session. A new `claude` process does not imply a fresh conversation or cache miss; the provider caches matching prompt prefixes on its server. Cache hits depend on an unchanged prefix and an unexpired entry, and changing models, tools or reasoning settings can reduce reuse. Claude Code manages this cache; the bridge does not force a new model session for ordinary follow-ups or cache generated answers.
- Check the native Claude transcript's `usage.cache_read_input_tokens`, `cache_creation_input_tokens` and `input_tokens` to see actual reuse. Count each assistant message ID once because a streamed message can be recorded in several parts. This measures cached input, not a subscription discount or a guarantee for future turns.
- OpenAI can reuse a cached prefix when switching back to GPT, but Claude's replies and Codex tool calls/results are new input, and Claude's private native-tool history stays in Claude Code.

[Anthropic's prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) explains that caching reuses processed input and does not change output generation.

### Checking transport and model quality

A healthy `/health` response only proves the service is up. Correlate the selected model and effort in the bridge log with the native Claude transcript; inspect the delivered user messages and tool results when an instruction or screenshot appears missing. Repeated `resume=…` lines and real cache-read counters establish continuity and reuse. They do not prove the model followed every instruction.

The bridge keeps Claude Code's own agent and selectively transfers Codex context, instructions and tools. It does not forward Codex's entire base/system prompt wholesale or make the two harnesses identical. Long text history and individual historical tool outputs have the limits described above; genuine OpenAI encrypted context cannot be read by Claude, and Claude's compaction marker cannot provide its private summary to GPT. These boundaries can change what the next model knows, even when its selected model and reasoning effort are correct.

`SendMessage {"to":"…","summary":"…"}` in Claude's tool summaries is Claude Code messaging one of its native agents. It is different from Codex's cross-chat messaging tool; the opaque recipient is an internal agent ID. Inspect the matching native tool call to find its task and actual message rather than guessing from the truncated summary.

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

Code changes in `src/` are picked up automatically once every request and WebSocket connection closes and native Claude work has finished. Codex tool handoffs close one response while Claude waits for the result; the watcher now waits for that turn, and for compaction even if its HTTP client disconnected. A long-lived GPT WebSocket can still delay restart; check the service's PID or a fresh `listening on` log line before claiming the new code is live. If a restart is needed, wait for active turns to finish before using the command above.

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

- **The picker shrinks to GPT-5.5, Opus and Fable, or the current model says Custom.** Older Codex clients receive a different GPT catalogue from newer desktop clients. Earlier bridge versions kept one shared fallback, so an older client could replace the desktop's list during an upstream outage. The bridge now keeps successful catalogues separately by endpoint, request query (including client version) and account context. If no matching cached list exists, it returns a catalogue error instead of a successful incomplete list. Update/reload the bridge, then reopen the affected chat's picker after Codex refreshes its model list. A different client's success does not establish that this chat refreshed.

- **Claude models don't show in the picker.** Quit Codex completely (Cmd+Q) and reopen it. Check `curl http://127.0.0.1:18787/health` and that `~/.codex/config.toml` starts with the `openai_base_url` line.
- **The installer says the port is in use.** Something else is on 18787; the installer names it. Run `CODEX_CLAUDE_BRIDGE_PORT=18888 ./scripts/install.sh`. Reinstalling also updates the existing bridge-managed Codex route to the new port, preserving other settings. The default isn't 8787 because that's `wrangler dev`'s default.
- **Claude is selected but GPT answers.** Update the bridge (`git pull`); Codex's request format changes between versions. Then check the log for `claude turn model=…` lines.
- **"Couldn't start Claude Code" while the CLI works.** Check `claude --help` and `claude auth status` separately. Older bridge versions permanently cached a failed 15-second startup probe, so a slow CLI startup could block every subsequent Claude turn until the bridge restarted. Current versions cache only successful probes, scoped to the executable path; a failed probe is checked again on the next request. Update and restart an older running service at a safe boundary. A capability-probe failure does not establish that login expired.
- **"Claude Code stopped: …" in a reply.** That's Claude Code's own error (auth, usage limit, unknown model name). Run the same model in a terminal with `claude -p --model <name> "hi"` to see it directly.
- **An Opus side chat stays on Thinking or says the model is unsupported with a ChatGPT account.** Update and reinstall the bridge, then verify the service has restarted. Codex can start a side chat with an Opus WebSocket or prewarm one over a GPT WebSocket and send Opus on that same connection. Older bridge versions rejected the first route or forwarded the second to OpenAI. The bridge now accepts Claude WebSockets and routes each message by its model. Older versions also made a new side chat wait until its parent task's running Opus turn finished; a `claude session … is busy` log line means a turn is waiting for another one on the same session. If the error persists, compare its timestamp with `local routed websocket`, `proxied GPT websocket`, and `claude turn` in the bridge log.
- **Claude forgets the immediately preceding side-chat message.** Older bridge versions ignored `previous_response_id`, treating each abbreviated WebSocket follow-up as a new session. Update and restart the bridge. For a chat affected before the fix, restate any missing context once; the lost context was never included in that Claude session. Verify with “Remember the test word apricot”, followed by “What test word did I just give you?”. New follow-ups should log `resume=…` with the same Claude session instead of `new-session`.
- **Codex repeatedly logs WebSocket HTTP 426 during startup prewarming.** Update the bridge and verify the service restarted. Some current Codex clients omit the model hint in the upgrade; the bridge now accepts that connection and routes each later message by its model. The installed service can remain on old code while long-lived connections are open.
- **A GPT side chat of a Claude thread reports that encrypted content could not be verified.** If the item ID starts with `cmp_ccb_`, `msg_ccb_`, `rs_ccb_`, or `ws_ccb_`, update the bridge and verify the service has restarted. Those items were created by the bridge; older versions could forward them to OpenAI when GPT used a WebSocket. The bridge now removes or translates them on GPT's HTTP and WebSocket routes.
- **Claude says Codex Computer Use or task tools are unavailable.** Verify the running service has loaded the tool-handoff update: new turns should log `codex tools for claude:` with `cua_repl__js`, and an actual call should log `handed js to codex`. A current checkout alone is not enough; persistent WebSockets can leave an older process running. Restart at a safe boundary, then retry the existing task. Codex still applies its own Computer Use app approvals. A standalone CLI test cannot establish desktop-only browser support; keep policy-loading errors and app-access refusals separate from bridge routing failures.
- **The whole bridge restarts after `write EPIPE` or an invalid WebSocket frame.** Earlier versions left client connection errors unhandled, so one disconnected or malformed client could crash the shared service. Current versions log the connection error and close only that client; tests exercise both GPT and locally routed WebSockets. This does not prevent upstream outages or repair the disconnected turn.
- **A stopped request runs later.** Earlier versions could start a queued Claude request after its Codex response had already closed. The runner now checks the response again after acquiring the session, before starting Claude; the stopped request cannot consume a new model turn or run tools.
- **A Codex tool is aborted after 30 silent minutes.** Claude Code has a separate idle timeout for stdio MCP tools; setting `MCP_TOOL_TIMEOUT` alone did not override it. The per-turn Codex MCP server now sets its own 24-hour timeout too. A real Claude Code 2.1.292 / Fable 5.1 test waited for a delayed result beyond a deliberately shortened idle limit and continued correctly. This is not a 24-hour endurance test, and it cannot make a Codex app tool that never returns succeed; stopping the turn still cancels the waiting process.
- **Claude misses a message relayed from another desktop chat.** Earlier versions recognized collaboration mailbox items but ignored the desktop app's tool-output-shaped delivery during continuations, or cut it to a historical tool-output limit. Update/reload the bridge and verify the installed process changed. A real isolated Fable 5.1 test received the full synthetic delivery before a later marker, recalled its word on the next turn, and received it only once. Compare the actual Codex delivery with the native Claude transcript; a message recorded in Codex is not proof that it reached Claude, and successful delivery is not proof that the model obeyed it.
- **Sending from a side chat fails with `sendRequest.bind is not a function`.** This is a separate Codex desktop bug, also observed with GPT: [openai/codex #51790](https://github.com/openai/codex/issues/51790). In desktop build 26.1002.52244, the parent-chat lookup binds a remote RPC method as though it were a local JavaScript function. The exact installed lookup reproduces the error with Cap'n Web 0.11.1; forwarding its arguments through a local callback fixes the isolated lookup. Already-loaded opening history bypasses that callback, so the same desktop build can work in one chat and fail in another; the introducing update has not been established. This does not establish an installed app repair or successful message delivery. Updating/restarting this Claude bridge cannot change that desktop callback. A native app repair must keep the archive manifest, enabled framework integrity seal and code signatures consistent; copying only a changed archive and plist is insufficient. Re-signing under another team can affect login, Computer Use and privacy grants, so qualify those separately before replacing the working app. Preserve the failed message and verify a delivery receipt after a repaired desktop build; repeated sends are not evidence of delivery, and a manually pasted request may already have reached the main chat.
- **Uninstall leaves Codex pointing at the stopped bridge.** An older uninstaller failed to replace the config when removing its only line produced an empty file. Current versions remove that route even from a one-line config; other settings are preserved.
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
