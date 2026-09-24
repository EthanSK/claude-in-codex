# codex-claude-bridge

**Use Claude models inside the OpenAI Codex app.** Claude models appear in Codex's model picker next to GPT. Pick one, and that chat runs on your own **Claude Code CLI**, covered by your Claude subscription. GPT keeps working exactly as before.

```
Codex app ──► 127.0.0.1:18787 ──┬─ GPT model    → chatgpt.com, unchanged (your ChatGPT login)
                                └─ Claude model → `claude -p` in the chat's project folder (your Claude login)
```

Claude Code does all the work: its own agent loop, tools, CLAUDE.md, skills and MCP servers. Codex is the window. The bridge never reads or stores any credentials. For GPT it relays Codex's own requests to OpenAI; for Claude it runs the official `claude` binary.

> Unofficial side project. Not affiliated with or endorsed by OpenAI or Anthropic. You're responsible for using each service within its terms.

## Requirements

- macOS (the installer uses a LaunchAgent; see [Other platforms](#other-platforms))
- The **Codex** app (or Codex CLI), signed in with ChatGPT
- **Claude Code** installed and signed in: `claude auth login`
- **Node.js 22.15+** (Node 20+ works too; the installer then turns off Codex's request compression, which older Node can't decode)

## Setup

```bash
git clone https://github.com/<you>/codex-claude-bridge.git
cd codex-claude-bridge
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
| Model picker entry (default: Opus 5.5, Fable) | `claude --model …` |
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

**Switch models mid-chat freely.** Claude gets whatever GPT said and did since its last turn. GPT sees Claude's replies. If you edit an earlier message, Claude starts a fresh session seeded with the conversation as it now looks.

Codex housekeeping requests made while a Claude model is selected, such as thread titles, are answered by your top GPT model.

## Configuration

`~/.codex-claude-bridge/config.json` (every key is optional):

```json
{
  "port": 18787,
  "claudePath": "/Users/you/.local/bin/claude",
  "models": [
    { "slug": "claude-opus-5-5", "displayName": "Opus 5.5", "claudeModel": "claude-opus-5-5" },
    { "slug": "claude-fable-5", "displayName": "Fable", "claudeModel": "claude-fable-5" },
    { "slug": "claude-sonnet", "displayName": "Sonnet", "claudeModel": "sonnet" }
  ],
  "permissionModes": { "workspace-write": "auto" },
  "fallbackModel": "gpt-5.5",
  "extraSystemPrompt": "",
  "debugDumpDir": null
}
```

- `models`: what appears in the picker. `claudeModel` is anything `claude --model` accepts (an alias or a full model name).
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

## Development

```bash
npm test     # fake claude + fake OpenAI upstream; no network, no accounts
npm start    # run in the foreground
```

MIT licensed.
