# codex-claude-bridge

Use Claude from the **Codex app**: Opus 5.5 and Fable appear in Codex's model picker next to your GPT models. Pick one and that thread runs on your local **Claude Code CLI**, covered by your Claude subscription. GPT keeps working exactly as before.

```
Codex app ──► 127.0.0.1:8787 ──┬─ GPT model    → chatgpt.com (unchanged, your ChatGPT login)
                               └─ Claude model → `claude -p` in the thread's folder (your Claude login)
```

Claude Code does the real work: its own agent loop, tools, CLAUDE.md, skills and MCP servers. Codex is only the window. The bridge never touches Claude credentials; it just runs the `claude` binary.

## Install (macOS)

```bash
./scripts/install.sh
```

Then quit and reopen Codex. The script:

- finds `node` (20+) and `claude`
- starts a LaunchAgent on `127.0.0.1:8787` (logs: `~/Library/Logs/codex-claude-bridge.log`)
- backs up `~/.codex/config.toml` and adds one line: `openai_base_url = "http://127.0.0.1:8787/backend-api/codex"`

To remove everything: `./scripts/uninstall.sh`.

## What maps to what

| In Codex | In Claude Code |
|---|---|
| Model picker: Opus 5.5 / Fable | `--model claude-opus-5-5` / `claude-fable-5` |
| Reasoning effort | `--effort` (low … max) |
| Full access / workspace-write / read-only | `bypassPermissions` / `acceptEdits` / `dontAsk` |
| Plan mode | `--permission-mode plan`; the plan comes back as Codex's plan card |
| Thread folder | working directory |
| AGENTS.md | appended to Claude's system prompt |
| Each thread | its own Claude session (`--resume`) |
| Compact (auto or `/compact`) | Claude Code's `/compact` |
| Stop button | interrupts Claude |
| Images you attach | passed to Claude |

In the Codex UI:

- Claude's text streams as normal replies.
- Thinking and each tool step (edits with +/− counts, commands, searches, todo lists, subagents) show in Codex's thinking/status area.
- Web searches and fetches show as Codex's native search cards.
- File changes show in Codex's diff view like any other change in your repo.

**Switching models mid-thread works both ways.** Claude receives what GPT said and did since its last turn, and GPT receives Claude's replies. If you edit an earlier message, Claude starts a fresh session seeded with the visible conversation.

Housekeeping requests Codex makes while a Claude model is selected (thread titles, summaries) go to your top GPT model.

## Config

`~/.codex-claude-bridge/config.json` (all optional):

```json
{
  "port": 8787,
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

After editing, restart the service with `launchctl kickstart -k gui/$(id -u)/com.codex-claude-bridge`, then restart Codex.

## Limits

- Claude's tool calls aren't Codex tool cards: Codex's own approval prompts don't appear for Claude. Permissions come from the mapping above.
- GPT traffic goes over HTTP streaming instead of Codex's WebSocket transport. It works the same, with slightly more overhead per turn.
- If a Codex update changes its request format, update the bridge (`/health` shows it's running; the log shows what it did).

## Development

```bash
npm test        # fake claude + fake upstream, no network
npm start       # run in the foreground
```
