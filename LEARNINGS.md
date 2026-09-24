# Learnings

Per-repo institutional memory for fixes. Every entry below is a real bug we hit + how we solved it. Check this file BEFORE attempting a same-looking fix.

Maintained by the `learnings` skill — see `~/.claude/skills/learnings/skill.md`.

## Format

Each entry looks like:

```
---
**Date:** YYYY-MM-DDTHH:MM:SSZ
**Trigger:** <voice N / message snippet / null>
**Symptom:** <what was visible>
**Root cause:** <what we actually found>
**Fix:** <file:line + short prose + commit SHA>
**Guard:** <test / lint / watchdog / comment that prevents regression — or 'none'>
---
```

## Entries

(newest first)

---
**Date:** 2026-09-24T13:35:00Z
**Trigger:** An Opus side chat fails even after selecting Opus with `/model`
**Symptom:** Codex says the Claude model is unsupported with a ChatGPT account, while the bridge logs a GPT WebSocket upgrade but no Claude turn.
**Root cause:** Codex prewarms the side chat on a GPT WebSocket and can send the later Opus request on that same connection. The bridge chose the destination once from the handshake's GPT hint and blindly forwarded all later frames to OpenAI. The missing Claude-turn log did not mean the side chat bypassed the bridge.
**Fix:** `src/server.js` now inspects each message on a GPT WebSocket and runs Claude messages locally, while forwarding GPT messages to OpenAI. `scripts/install.sh` installs the WebSocket dependency (commit `efbcc03`).
**Guard:** `test/bridge.test.js` sends GPT prewarm and Opus turn over one WebSocket and asserts Claude receives the Opus turn; verify the installed service restarted before live acceptance.
---

---
**Date:** 2026-09-24T13:11:00Z
**Trigger:** Checking whether a source edit had reached the installed bridge
**Symptom:** The log said `server.js changed; restarting when idle`, but the same PID continued serving and the earlier temporary diagnostic message remained in its log output.
**Root cause:** Open connections, including long-lived GPT WebSockets, keep the service's active count above zero and delay the idle restart.
**Fix:** Clarify in `README.md` that a source edit is not live until the PID changes or a fresh startup log appears; wait for active turns before forcing a restart.
**Guard:** Verify the installed PID/startup log after code changes; do not treat a pending-reload line as deployment evidence.
---

---
**Date:** 2026-09-24T13:06:00Z
**Trigger:** Opus side chat stays on Thinking, then shows an unsupported-model error
**Symptom:** Codex desktop said `The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.`
**Root cause:** Superseded by the entry above. The attempt had no `claude turn` log because it went through a GPT-labeled WebSocket that the bridge forwarded without inspecting its messages. The CLI `--ignore-user-config` reproduction matched the error text but was not the desktop cause.
**Fix:** The initial README documented a provisional limitation; the later per-message WebSocket route replaces it.
**Guard:** Check WebSocket upgrade logs and the model in each message before concluding a request bypassed the bridge.
---

---
**Date:** 2026-09-24T12:50:48Z
**Trigger:** GPT takes the bridge's HTTP fallback; can it keep WebSocket transport?
**Symptom:** The bridge answered every WebSocket upgrade with 426, including GPT's, so GPT requests used HTTP streaming.
**Root cause:** Older Codex clients did not identify the selected model in the upgrade, but the tested Codex 0.155 sends `x-codex-routing-hint: model=<slug>` before the WebSocket handshake.
**Fix:** `src/server.js` proxies GPT upgrades and frames unchanged to ChatGPT, while Claude and clients without a model hint retain the 426-to-HTTP path (commit `34ad378`).
**Guard:** `test/bridge.test.js` covers GPT frame/auth forwarding, Claude and old-client fallback, and browser-origin rejection; a live Codex 0.155 GPT turn completed over an isolated WebSocket proxy.
---

---
**Date:** 2026-09-24T12:27:21Z
**Trigger:** share Codex Computer Use with Claude turns
**Symptom:** Claude could read native app state, but browser inventory reported `Missing required Codex turn metadata: session_id, turn_id`
**Root cause:** Claude Code's MCP calls do not include the Codex turn metadata that the app-backed browser service requires
**Fix:** `src/cuaMcpProxy.js` adds request-scoped metadata before forwarding calls to Codex's enabled Computer Use server; `src/claudeRunner.js` loads the proxy for Claude turns (commit `4166deb`)
**Guard:** `test/bridge.test.js` checks metadata and enabled-tool filtering; a live Claude Fable read-only `cua.getState()` check enumerated the browser successfully
---

---
**Date:** 2026-09-24T11:05:35Z
**Trigger:** chat: run scripts/install.sh and fix anything that fails
**Symptom:** Tool summaries ('Editing src/a.ts') show full absolute paths; bridge.test.js 'Claude turn streams...' fails on macOS
**Root cause:** Codex sends an unresolved cwd (/var/..., /tmp/...) but Claude reports file paths from its resolved process.cwd() (/private/var/...), so rel() in toolDisplay.js never strips the prefix
**Fix:** fs.realpathSync the cwd in claudeRunner.js before spawning and before describeToolUse
**Commit:** fdec844
**Guard:** test/bridge.test.js Edit summary assertion (workdir is under os.tmpdir(), a symlink on macOS)
---

---
**Date:** 2026-09-24T11:05:35Z
**Trigger:** chat: run scripts/install.sh and fix anything that fails
**Symptom:** scripts/install.sh re-install dies with 'Bootstrap failed: 5: Input/output error' at launchctl bootstrap
**Root cause:** launchctl bootout returns before launchd finishes tearing the job down; a bootstrap issued during the drain (fixed 1s sleep) hits EIO
**Fix:** Poll 'launchctl print gui/UID/LABEL' until the label is gone (max 10s), then bootstrap with one retry; also resolve node via process.execPath so the plist execs the real binary, not ~/bin/node shim
**Commit:** fdec844
**Guard:** install.sh comments at the bootout block; re-run install.sh while service is running
---
