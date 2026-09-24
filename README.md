# claude-in-codex

**Use Claude models inside the OpenAI Codex app.** Claude models appear in Codex's model picker next to GPT. Pick one, and that chat runs on your own **Claude Code CLI**, covered by your Claude subscription. GPT keeps working exactly as before.

```
Codex app ──► 127.0.0.1:18787 ──┬─ GPT model    → chatgpt.com, unchanged (your ChatGPT login)
                                └─ Claude model → `claude -p` in the chat's project folder (your Claude login)
```

**How it works, in short:**

1. The installer adds one line to `~/.codex/config.toml`, so Codex sends its model requests to a small local service instead of straight to OpenAI.
2. The service adds your Claude models to Codex's model list.
3. When you send a message, the service checks the chosen model. GPT requests go on to OpenAI unchanged. Claude requests start your `claude` CLI in the chat's project folder.
4. Claude Code's output is translated into the events Codex already shows: replies, thinking, tool steps and plans. Claude edits the real files, so its changes appear in Codex's diff view as usual.
5. Each Codex chat is tied to its own Claude Code session, so the next message carries on where the last one stopped.

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
2. Writes `~/.codex-claude-bridge/config.json`.
3. Starts a background service on `127.0.0.1:18787` that runs at login and restarts if it crashes. Logs go to `~/Library/Logs/codex-claude-bridge.log`.
4. Backs up `~/.codex/config.toml`, then adds one line at the top:
   ```toml
   openai_base_url = "http://127.0.0.1:18787/backend-api/codex" # codex-claude-bridge
   ```

**Uninstall:** `./scripts/uninstall.sh` stops the service and removes that line. Restart Codex afterwards.

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
| Each chat | its own Claude session (`--resume`) |
| Side chats and forked chats | their own fork of the parent's session (`--fork-session`) |
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

Claude uses Claude Code's own tools (shell, file edits, subagents, …), plus the CLAUDE.md, memory, skills and MCP servers from your Claude Code setup. From Codex it gets your AGENTS.md, your Codex skills list, the chat's folder, the permission mode and the chat so far. That's why your AGENTS.md rules and Codex skills still apply.

Codex's own plugins (Computer Use, for example) and MCP servers you've only set up in Codex aren't available to Claude. To give Claude an MCP server, add it to Claude Code too (`claude mcp add …`).

### Switching models mid-chat

Switch freely. Switching doesn't make Codex compact the chat.

| Switch | What the next model sees |
|---|---|
| GPT → Claude, first time in a chat | A new Claude session with the chat so far as text: your messages, GPT's replies, and GPT's commands with their output (each output cut to 2,000 characters). Only the latest 60,000 characters are passed. GPT's reasoning is encrypted by OpenAI, so Claude never sees it. |
| Back to Claude later | Claude resumes its own session and gets only what happened since its last reply. |
| Claude → GPT | Claude's replies, as normal assistant messages. Not Claude's thinking or tool steps. Claude's file changes are on disk, so GPT can read them. |
| You edit an earlier message | Claude starts a new session from the chat as it now looks. |
| Side chat or fork | Its own fork of the parent chat's Claude session. |

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
  "permissionModes": { "workspace-write": "auto" },
  "fallbackModel": "gpt-5.5",
  "extraSystemPrompt": "",
  "debugDumpDir": null
}
```

- `models`: what appears in the picker. `claudeModel` is anything `claude --model` accepts (an alias or a full model name). Put the version in `displayName` (e.g. "Sonnet 5") so the picker shows exactly which model you get.
- `permissionModes`: maps Codex's sandbox mode to a Claude Code permission mode.
- `fallbackModel`: the GPT model that answers housekeeping requests.

After changing the config, restart the service, then restart Codex so it reloads the model list:

```bash
launchctl kickstart -k gui/$(id -u)/com.codex-claude-bridge
```

Code changes in `src/` are picked up automatically: the service restarts itself once idle.

## Troubleshooting

- **Claude models don't show in the picker.** Quit Codex completely (Cmd+Q) and reopen it. Check `curl http://127.0.0.1:18787/health` and that `~/.codex/config.toml` starts with the `openai_base_url` line.
- **The installer says the port is in use.** Something else is on 18787; the installer names it. Run `CODEX_CLAUDE_BRIDGE_PORT=18888 ./scripts/install.sh`. The default isn't 8787 because that's `wrangler dev`'s default.
- **Claude is selected but GPT answers.** Update the bridge (`git pull`); Codex's request format changes between versions. Then check the log for `claude turn model=…` lines.
- **"Claude Code stopped: …" in a reply.** That's Claude Code's own error (auth, usage limit, unknown model name). Run the same model in a terminal with `claude -p --model <name> "hi"` to see it directly.
- **Logs:** `tail -f ~/Library/Logs/codex-claude-bridge.log`

## Limits

- Claude's tool calls don't go through Codex's approval prompts. Permissions come from the mapping above.
- GPT requests use Codex's HTTP streaming transport instead of its WebSocket transport. They behave the same, with slightly more overhead per turn.
- This depends on Codex's internal request format, which can change with Codex updates. The tests pin the shapes the bridge relies on.
- All of Codex's model requests go through the bridge, GPT included. If the service isn't running, GPT stops working in Codex too. `./scripts/uninstall.sh` sends Codex straight to OpenAI again.
- Codex's memories and its desktop-app instructions aren't passed to Claude. Claude Code's own memory still applies.

## Other platforms

The server is plain Node with no dependencies. On Linux or Windows:

1. Run it yourself: `node src/server.js`.
2. Add the `openai_base_url` line above to `~/.codex/config.toml`.
3. Restart Codex.

## How it works

The bridge is an OpenAI Responses API endpoint on localhost:

- **`GET /models`** fetches Codex's normal model catalog and adds the Claude models.
- **`POST /responses` with a GPT model** is forwarded to OpenAI untouched, apart from removing bridge-only items from the history.
- **`POST /responses` with a Claude model** runs `claude -p --input-format stream-json --output-format stream-json --resume <session>` and translates Claude Code's events into the Responses events Codex renders: text, reasoning summaries, web search calls and plan blocks. An invisible marker in each reply ties a Codex chat to its Claude session.

It only accepts requests from this Mac. It refuses requests from web pages (anything with a browser `Origin` header) and requests with an unexpected `Host`, so a website can't use it to run Claude.

## Development

```bash
npm test     # fake claude + fake OpenAI upstream; no network, no accounts
npm start    # run in the foreground
```

MIT licensed.
