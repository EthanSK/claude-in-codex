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
**Date:** 2026-09-25T17:05:00Z
**Trigger:** User requested Codex task tools (pinning, renaming and task messaging) and Computer Use for bridged Claude
**Symptom:** Claude has permission bypass but lacks Codex app tools; Computer Use surfaces differ from Codex's own executor.
**Root cause:** The current bridge runs Claude Code's tool loop instead of emitting tool calls for Codex's executor. The bundled app-tools MCP server additionally uses a desktop native pipe with peer authentication. A standalone client could enumerate 47 app tools and read the current task, but two real Opus integration turns failed to connect, alongside `untrusted-code-signing-identity` rejections in the desktop log. The exact reason the standalone and Claude-launched paths differ is not established.
**Fix:** No app-tools integration shipped. Removed the experimental proxy and restored production source; documented the remaining limitation. A real Opus `cua.getState()` succeeded for desktop/Chrome inventory. A separate Opus in-app browser creation returned `Browser is not available: iab`; Codex's own Computer Use inventory included the same task's in-app browser. No test page was created or clicked, and no existing browser page was changed.
**Guard:** Tool discovery and fake-server tests do not prove a real Claude turn can call the tools. Verify the actual runner and each claimed browser surface before enabling an integration. Preserve native peer authentication; do not claim that permission bypass adds missing harness tools or that inventory proves input actions work.
---

---
**Date:** 2026-09-25T11:59:00Z
**Trigger:** Opus said it could not see a test word supplied in the immediately preceding side-chat message
**Symptom:** Successive turns in one side chat started new Claude sessions, lost the working directory and permission instructions, and received only the newest user message.
**Root cause:** Codex sent `previous_response_id: resp_ccb_…` with a one-message input delta; the bridge ignored the reference. A separate full-replay path also discarded earlier bridge-authored assistant messages along with control items.
**Fix:** `src/server.js` retains the latest Claude response input/output per WebSocket, reconstructs referenced input before parsing, and returns `previous_response_not_found` for an uncached reference. GPT switches replay sanitized context instead of forwarding a bridge-owned response ID. `src/codexInput.js` preserves prior Claude reply text when rebuilding a session.
**Guard:** Regression tests cover prewarm context, delta resume, per-connection isolation, unknown-reference errors, GPT switches, and earlier-reply retention. Real Opus tests on both an isolated and the installed bridge answered `apricot` from a delta-only follow-up, with the same Claude session ID on both turns. Already-lost context must be restated once; do not claim this reconstructs information absent from a damaged Claude session.
---

---
**Date:** 2026-09-25T11:51:00Z
**Trigger:** Claude side chats denied Bash because approval was required; user requested full bridge permissions
**Symptom:** Real turns logged `mode=acceptEdits`; Claude reported that a tool needed approval but the session could not ask.
**Root cause:** `-p` is non-interactive, not permission bypass. The default `acceptEdits` mode still denies some tools with `--permission-prompts none`. The existing runner already passes `--dangerously-skip-permissions` when the selected mode is `bypassPermissions`.
**Fix:** Document the existing opt-in configuration covering all sandbox mappings and `defaultPermissionMode`; apply it to the user's local bridge without changing other installations' defaults. Explicit Plan mode remains plan-only. Add prompt-free request-shape debug logs for the separate side-chat continuity investigation.
**Guard:** Regression test covers absent sandbox metadata, every mapped mode, new/resumed turns, and Plan mode. Real Claude Code 2.1.281 bridge calls performed Write/Edit/Bash outside the cwd on a new and resumed session without a terminal prompt; an installed-service call also wrote and read the test file successfully after restart.
---

---
**Date:** 2026-09-24T16:17:00Z
**Trigger:** Other running Codex tasks repeatedly logged WebSocket startup errors
**Symptom:** Codex's `agent-bridge-codex-channel` tried to prewarm GPT WebSockets without a model hint and received HTTP 426 every roughly 30 seconds. The bridge process stayed up, but the retries produced persistent errors and could delay connection setup.
**Root cause:** `proxyWebSocket` rejected all unhinted upgrades even though their later frames identify GPT or Claude. The first lazy GPT upstream connection also needed the frame's actual model in its routing hint, rather than a fixed fallback model.
**Fix:** `src/server.js` accepts unhinted WebSockets, routes each frame by its model, and uses the first GPT frame's model for the upstream handshake.
**Guard:** `test/bridge.test.js` prewarms GPT and Claude on an unhinted socket and checks the upstream GPT routing hint. Verify the installed service has restarted before judging live Codex behavior.
---

---
**Date:** 2026-09-24T16:16:00Z
**Trigger:** Reviewing long-running bridge state while investigating chats that appeared stuck
**Symptom:** Code inspection showed `sessionLocks` kept a completed entry for every Claude session; the map stored one promise but compared it to a different promise before deleting.
**Root cause:** `withSessionLock` stored `prev.then(() => next)` and later compared the map value with `next`, so the cleanup condition could never be true.
**Fix:** `src/claudeRunner.js` compares the map value with the exact queued promise it stored, releasing the key after the last turn for that session.
**Guard:** Keep the stored and compared promise identical when changing session serialization. This was a retention bug, not evidence that the active Claude chats were deadlocked.
---

---
**Date:** 2026-09-24T15:45:00Z
**Trigger:** A normal GPT side chat failed right after "Context automatically compacted"
**Symptom:** Codex desktop showed `The encrypted content for item cmp_ccb_… could not be verified. Reason: Encrypted content could not be decrypted or parsed.` in a GPT-6 Sol side chat of an Opus thread.
**Root cause:** `cmp_ccb_` items are the bridge's own Claude compaction markers (`ResponsesStream.compaction`). The HTTP GPT path strips bridge items with `sanitizeInputForOpenAI`, but `routeWebSocketMessage` forwarded GPT frames untouched, so a side chat that inherited the parent's Claude compaction sent the marker to OpenAI over WebSocket.
**Fix:** `src/server.js` `routeWebSocketMessage` now sanitizes GPT frames' `input` the same way; clean frames are still forwarded byte-for-byte.
**Guard:** `test/bridge.test.js` sends a GPT WebSocket frame containing `cmp_ccb_`/`msg_ccb_` items and asserts no bridge ids or markers reach the upstream, and that clean frames pass unchanged. Any new GPT-bound path must call `sanitizeInputForOpenAI`.
---

---
**Date:** 2026-09-24T15:30:00Z
**Trigger:** A fresh Opus side chat still did not start after the GPT-prewarmed WebSocket fix
**Symptom:** Codex's `queued_side_chat` turn selected `claude-opus-5-5`, but the bridge logged no Claude turn; the Codex trace reported `websocket reuse properties didn't match`.
**Root cause:** The bridge still rejected WebSocket upgrades whose handshake named Claude with HTTP 426. Codex can open a separate Claude-hinted connection for a fresh side chat instead of sending Opus over a GPT-prewarmed connection. The desktop handshake was not captured, so this route is a concrete uncovered cause consistent with the trace, not yet confirmed as that turn's only failure.
**Fix:** `src/server.js` accepts Claude-hinted WebSockets, routes their Claude frames locally, and opens an upstream GPT WebSocket only if a later frame needs GPT.
**Guard:** `test/bridge.test.js` covers fresh Claude-hinted WebSocket prewarm, Opus turn, and later GPT switch, alongside the existing GPT-prewarmed Opus test. Installed desktop acceptance remains a separate check.
---

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
