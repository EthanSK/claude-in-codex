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
**Date:** 2026-10-08T18:20:00Z
**Trigger:** A GPT side chat failed to send an authorized follow-up to its main chat with `sendRequest.bind is not a function`.
**Symptom:** Reading chats worked, but sending failed before delivery. The Claude bridge was healthy, and a separate upstream report records the same failure (openai/codex #51790).
**Root cause:** Codex desktop 26.1002.52244's renderer parent lookup receives an AppServerManager RPC stub, then passes `t.sendRequest.bind(t)` to its opening-item reader. Cap'n Web treats this as a remote `sendRequest.bind` call; JavaScript function prototype methods are not exposed there. The exact function extracted from the installed app reproduces the reported error with a real Cap'n Web 0.11.1 `RpcStub`.
**Fix:** A local candidate replaces only that binding with `(...e)=>t.sendRequest(...e)`. The bridge's source and service do not own this callback and cannot repair it through a reload. The candidate is not an installed or signed desktop repair; do not ship it as a bridge fix or claim native delivery passed.
**Guard:** The original installed lookup fails with the exact error, while the corrected lookup resolves its parent and preserves arguments/options. Additional cases cover paginated compaction, tool-output opening items, empty/no-parent history, repeated-cursor rejection and cached history. Electron's ASAR reader verifies all 20,899 packed files are unchanged except this callback; renderer syntax and archive/manifest hashes pass. This establishes a bounded candidate, not desktop startup, signing, Computer Use or message delivery. Check actual installation and delivery separately, and do not resend a request already manually pasted into its main chat.
---

---
**Date:** 2026-10-06T23:04:00Z
**Trigger:** The historical audit received an additional report that an Opus turn never saw a design clarification relayed from a side chat.
**Symptom:** Codex recorded a `codex_app.send_message_to_thread` delivery immediately after a question-card result; the corresponding native tool result contained only the question acceptance. The delivery reached the transcript much later through an explicit rollout-file read. A bounded sweep found 132 desktop deliveries with this same shape.
**Root cause:** These unsolicited `function_call_output` items have an item ID, no `call_id`, and a `<codex_delegation>` wrapper. The normalizer handled only collaboration `agent_message` items, while the continuation collector ignored unrelated tool outputs. Scanning only after a pending marker could also miss a delivery recorded before native work emitted a later marker.
**Fix:** Normalize the actual app delivery shape with its sender and full wrapper retained; preserve ordinary tool results and quoted wrappers. Deliver unread agent messages through the next Codex tool continuation or resumed prompt, retaining delivered IDs in the existing session state to prevent replay after native/service restarts and forked compaction. No transcript polling, automatic cross-chat messaging, permission transfer, native-work interruption or extra model turn is introduced.
**Guard:** Five new positive regressions fail against `0ee85bf`, while the negative tool-output guard already passes there. All 69 current tests pass. HTTP integration verifies same-process delivery, a resumed prompt without duplication and reloaded ID state; unit cases cover new/resumed turns, long deliveries, messages before/after results and later markers, another-thread rejection and lone collaboration waits. A real isolated Claude Code 2.1.292 / Fable 5.1 session received the synthetic delegation once as an MCP result, returned its word and recalled it after resuming; its native transcript confirms the canonical model, one delivery and no repeated wrapper in the resumed prompt. Installed verification remains separate. The bridge can only deliver inputs Codex actually sends, and cannot guarantee model obedience.
**Installed verification:** Commit `b2d0ea0` was loaded at 2026-10-06T23:05:55Z (PID 40828), after other chats and bridge-native jobs were idle. Health passed, both unhinted and Claude-hinted WebSocket upgrades returned 101, and GPT reconnected. A real Fable 5.1 check through the installed endpoint received the synthetic delivery before the pending marker, returned its word and recalled it after resuming. Its native transcript contains exactly one delegation in the MCP result; saved session state retains that delivery ID and the test thread owner. This verifies installed delivery and continuity, not arbitrary model obedience or every desktop UI path.
---

---
**Date:** 2026-10-06T22:00:00Z
**Trigger:** Ethan requested a historical sweep of previous bridge sessions, Codex logs and native Claude transcripts, with fixes for missed failures.
**Symptom:** The October 2 bridge log contains an unhandled `write EPIPE` crash in WebSocket rejection. An October 4 native Codex tool call was aborted after 1,803 silent seconds despite the intended 24-hour timeout. Isolated probes additionally reproduced a malformed-frame crash, a stopped queued request starting later, an idle source reload during a waiting Claude turn or disconnected compaction, a stale route after changing the installation port, and a failed uninstall of a one-line config.
**Root cause:** Client TCP/WebSocket errors had no listeners. Claude Code's separate stdio idle timeout was not overridden by `MCP_TOOL_TIMEOUT`. Queued requests checked disconnection only after spawning. The watcher counted HTTP/WebSocket lifetimes but not native work between responses. Installation treated an already-managed route as immutable; uninstall used `grep -v`, whose empty-result exit status skipped the replacement.
**Fix:** Contain client connection errors, set the Codex MCP server's existing 24-hour timeout explicitly, skip closed queued responses before spawning, wait for session locks and native compaction before reloading, update only the bridge-managed route on port changes, and remove tagged config lines with an empty-result-safe filter. A pending watcher checks again after native work finishes. Persistent GPT sockets still delay reload; no forced restart, paid-turn retry or prompt/history rewrite was added.
**Guard:** Nine focused regression cases fail against the previous production source, and all 63 current tests pass. They exercise raw client frames on GPT and unhinted routes, queued cancellation, tool handoff configuration, actual isolated source watching during native waits and disconnected compaction, and installer scripts with fake service commands. A real isolated Claude Code 2.1.292 / Fable 5.1 session received the expected delayed MCP result after a 36-second hold with a deliberately shortened 1-second idle setting; the native transcript confirms the selected model, successful tool result and same-session continuation. This verifies the override, not a 24-hour wait or a desktop app tool that never replies. Installed verification remains separate.
**Installed verification:** The same safe reload at 2026-10-06T23:05:55Z loaded this batch through commit `b2d0ea0`. Health and bounded local WebSocket upgrade checks passed; the current GPT chat reconnected, and a real Fable tool handoff and resumed turn completed through the installed service. Crash, queued cancellation, watcher, watchdog and installer failure paths were reproduced with isolated fixtures; they were not destructively rerun on the live service.
---

---
**Date:** 2026-10-06T21:30:00Z
**Trigger:** Ethan asked whether recent bridge use was efficient and preserved model quality, and what a native SendMessage summary meant.
**Symptom:** Reproduction found that a user screenshot arriving during a Codex tool continuation lost its pixels, and a message before the tool result lost its text too. A model-switch replay also reduced historical user/tool-result images to text placeholders.
**Root cause:** `findCodexResults` scanned only after the last output and extracted text only. `parseCodexRequest` rendered historical attachments as text without adding their image blocks to Claude's input. A separate bridge instruction incorrectly recommended relative file links.
**Fix:** Collect new messages from the owning pending marker/call, preserve base64 image attachments in the same waiting process, and retain historical user/tool-result images with explicit history labels. Resume only images after the last valid Claude marker to avoid resending its existing image history. Tell Claude to use absolute local-file links. URL attachments in MCP continuations remain text URLs; no image downloads or context-storage system were added.
**Guard:** The new continuation and history-image regressions fail against the previous source. All 55 tests pass, including HTTP/WebSocket handoffs, current/history image separation, another-thread rejection and cancellation without results. A real isolated Fable 5.1 turn read the test image's exact characters after its pixels arrived before the tool result; its native transcript contained the exact base64 data and both response markers named the same session. A separate fresh Fable session also read the earlier GPT-side image correctly without tools, with its pixels present in the native user input. Installed verification remains separate.
---

---
**Date:** 2026-10-06T21:13:00Z
**Trigger:** Local notification helpers lacked a Codex chat ID, a parent lost its native Claude context after a side chat, and native background Agent tasks disappeared between turns.
**Symptom:** Claude children inherited no chat ID (or the bridge launcher's ID). The side-chat incident ended with `/compact` in the parent's Claude transcript, the state index assigning that session to the side chat, and the parent subsequently starting fresh.
**Root cause:** Only the ordinary runner handled `--fork-session`; compaction ignored ownership and recorded its returned parent session under the requesting side chat. The runner also copied its process environment without setting the request's `CODEX_THREAD_ID`. Native background agents belong to the per-turn Claude process, which exits when the turn ends.
**Fix:** Fork compaction for another owner, even with a stale inherited marker; accept only successful compaction with a distinct fork ID, and emit no replacement marker on failure. Give ordinary and compaction processes the request's validated chat UUID, clearing inherited IDs when it is absent or invalid. Explain the native-agent lifetime and direct cross-turn work to the existing offered Codex collaboration tools, without adding a persistent-process architecture or overriding delegation instructions.
**Guard:** The new identity, fork-compaction and compaction-failure regressions failed against the previous source. All 53 tests pass, including malformed compaction output, a returned parent ID, current/stale side-chat markers, parent continuity and new/resumed/forked environments. A real isolated Fable 5.1 test printed the correct parent chat ID through Bash, compacted a side chat into a distinct Claude session without changing the parent state, then proved both chats resumed their own sessions and remembered the original word; the side printed its own chat ID. Guidance for native background agents is not a guarantee of model compliance. Installed verification is separate.
**Installed verification:** Commit `080c386` was loaded at 2026-10-06T21:13:01Z (PID 57063). Health passed and GPT WebSockets reconnected. The same real parent/side-chat checks then passed through the installed service. The first disk-state assertion ran before the debounced save appeared; re-reading the saved state confirmed distinct ownership and the unchanged parent marker before both existing sessions completed their recall checks. Wait for the expected saved marker when testing persistence, rather than assuming a fixed delay proves a write completed.
---

---
**Date:** 2026-10-06T20:59:30Z
**Trigger:** The first installed sub-agent check still stopped before its GPT follow-up despite an earlier isolated pass.
**Symptom:** Both children replied, but Claude said the user had rejected its wait. A captured isolated request showed the bridge session marker immediately followed by the child mailbox item, with the pending `wait_agent` call entirely absent.
**Root cause:** The first mailbox fix expected Codex to retain the preempted call. Codex can remove both that call and its result before delivering the ready message; a successful run with ordinary tool results did not exercise this path.
**Fix:** Store the existing response marker with each pending tool, match mailbox arrivals using that marker when the wait call is absent, and require the owning thread to match. Resume only a lone pending collaboration wait, never invent results for other simultaneous tools, and preserve explicit human interruption.
**Guard:** The marker-only replay regression fails against the first fix. The WebSocket integration test reconnects without the wait call and proves one Claude process receives the actual child reply. Unit checks cover human Stop/new text/images, historical mailbox items, inherited markers in another thread and unrelated/parallel tools. All 50 current tests pass (49-test suite plus the added WebSocket regression and targeted rerun). An isolated real Opus 5.5 parent again completed GPT-6.1 Sol and Fable 5.1 spawns and a GPT follow-up with the three expected tokens. Installed verification remains separate.
**Installed verification:** Commit `474a476` was loaded by the service restarted at 2026-10-06T21:00:43Z (PID 98847). Health passed and GPT WebSockets reconnected. A fresh Opus 5.5 parent through that installed service spawned GPT-6.1 Sol and Fable 5.1 children, received both expected replies, then completed the GPT follow-up with its remembered token. One parent Claude session handled the whole sequence; no false cancellation occurred. Existing malformed failed-child histories are not rewritten.
---

---
**Date:** 2026-10-06T20:49:50Z
**Trigger:** A GPT sub-agent spawned by bridged Claude failed immediately with `invalid_encrypted_content` for an `amsg_` item.
**Symptom:** The child transcript stored the parent's ordinary task text inside an `encrypted_content` part. The failure also occurred with `fork_turns: none`, so it was not inherited Claude compaction.
**Root cause:** `ResponsesStream.codexToolCall` omitted `encrypted_function_args`. Codex's collaboration router treats spawn/send/follow-up message arguments as encrypted unless this field is explicitly `[]`. Independently, the bridge did not parse `agent_message` inputs, dropping Claude-child tasks and parent mailbox replies. The first real test exposed a third gap: Codex preempted `wait_agent` for a mailbox delivery without returning a tool result, causing the bridge to kill Claude; Claude Code then recorded a user cancellation and refused the authorized follow-up.
**Fix:** Declare plaintext only on bridge-generated collaboration message calls; retain agent message content and sender in Claude input and tool continuations; wake a pending `wait_agent` when its actual mailbox delivery arrives without a tool result, preserving human interruption handling and other tool cancellation behavior. Do not strip or reinterpret arbitrary OpenAI ciphertext, and do not convert existing failed child histories based on whether encrypted data looks readable.
**Guard:** Parser/stream regressions fail against the prior source; tests preserve real GPT ciphertext and exercise explicit Stop, human prompts/images, and unrelated pending tools. All 49 tests pass. A real isolated Opus 5.5 parent spawned GPT-6.1 Sol and Fable 5.1, received `GPT_CHILD_OK` and `CLAUDE_CHILD_OK`, and completed a GPT follow-up returning its remembered `GPT_CHILD_OK`, without a false cancellation. Installation is tracked separately from isolated acceptance.
---

---
**Date:** 2026-10-06T19:22:57Z
**Trigger:** Fable said pasted Agent Flow prompts contained no new request and continued implementation despite a request to answer first.
**Symptom:** The reported paste reached Claude verbatim, and its file-read results contained both complete canonical prompts, including the instruction not to implement yet. A separate parser reproduction exposed XML-authored requests becoming historical context plus `(continue)`.
**Root cause:** The reported incident was an instruction-following failure after successful delivery and reading. Independently, `classifyUserText` treated complete XML-root text as context, including speech and typed-text wrappers or selections followed by a current request.
**Fix:** Commit `631b83d` keeps authored wrappers and requests following context blocks as current prompts, preserving their original quotation boundaries. Pasted-file references with an empty `My request` heading already worked; compare actual Claude input and file-read results before attributing a model's claim to lost transport.
**Guard:** All 44 tests passed using a fake Claude runner, including Fable new/resumed-turn input equality; three new parser regressions fail against the previous source. Tests cover a long selection, attachment-reference messages and unchanged injected-metadata handling. These checks establish transport behavior, not model obedience; installation requires a separate verified service reload.
**Installed verification:** The service restarted at 2026-10-06T19:31:57Z after the user authorized making the fix live. Health passed and GPT WebSockets reconnected. Two real Fable 5.1 requests, one speech-wrapped and one selection-led follow-up, returned the expected token in the same Claude session; its transcript contained both prompts verbatim as current user messages, with no tool calls. This verifies those live message shapes, not arbitrary future instruction-following.
---

---
**Date:** 2026-09-27T11:58:00Z
**Trigger:** User's Codex picker showed only GPT-5.5, Opus and Fable; the current model said Custom and the companion bar could not switch.
**Symptom:** The bridge logged upstream catalogue timeouts/network failures, while logs also showed older 0.145.0 and desktop 0.158.0 clients sharing it. The persisted catalogue later recovered, but the affected UI had retained the smaller list.
**Root cause:** `handleModels` used one `state.upstreamModels` fallback for every client. Direct authenticated read-only queries proved the older version's list omits GPT-6. With configured GPT-5.6 hiding, that older list produces the screenshot's three visible models. An isolated regression proves that another client or account overwrites the fallback. The screenshot itself does not record the exact upstream request that populated that UI.
**Fix:** Persist successful lists by a hash of endpoint, query and account context. Do not reuse the legacy unscoped list on an outage. Return 503 when no scoped cache exists, rather than a successful partial catalogue. Reject malformed upstream lists without overwriting good cached data. The companion bar separately recognises Custom model controls without inventing a selected model; its typing route is unchanged.
**Guard:** Integration coverage includes two client versions, two accounts, upstream outages, persistence across service restart, malformed responses and an uncached version. The old implementation fails this regression. Installed service restarted at 11:59:46 UTC; read-only authenticated requests to the live bridge returned the expected three visible models for 0.145.0 and all six visible models (including Astra and Sol) for 0.158.0. Both scoped lists persisted separately, and GPT WebSocket reconnections were observed. The affected desktop picker and a Custom-to-named toolbar switch still require a user check.
---

---
**Date:** 2026-09-26T17:12:00Z
**Trigger:** User's Agent Flow chat reported "Couldn't start Claude Code" and suggested logging in.
**Symptom:** Claude's current CLI and account status worked, but every bridge turn stopped before the runner started.
**Root cause:** The service started at 14:58:40 UTC and logged its CLI failure exactly 15 seconds later, matching the startup help-probe timeout. `claudeCapabilities` cached that negative result permanently, so later requests could not recover. The generic error also suggested auth even though this check only runs `--help`.
**Fix:** Cache only successful probes, keyed by executable path. A subsequent request retries a failed probe without restarting or reauthenticating.
**Guard:** Regression tests reproduce a real 15-second startup timeout and then successful recovery in the same module instance, plus missing/failed executables, nonzero output and a different executable path. All 37 bridge tests pass. Installed service restarted at 17:13:28 UTC, confirmed the real CLI within 0.4 seconds, and resumed the affected Agent Flow desktop chat with Opus; an actual assistant reply followed. GPT WebSocket reconnections also appeared after restart. No login was required.
---

---
**Date:** 2026-09-26T11:50:00Z
**Trigger:** Claude recommended switching to GPT for a browser screenshot despite the tool-handoff implementation being present.
**Symptom:** The live service had no `codex tools for claude` messages; its process started before the tool-handoff commit and still had a pending idle reload.
**Root cause:** Persistent connections prevented the source watcher from restarting the old runtime. The tool-handoff and subsequent question/side-chat changes were also committed locally but absent from the public main branch.
**Fix:** Ran all 35 regression tests, restarted the service under the user's existing authorization, verified a new PID and GPT WebSocket reconnections, and pushed the missing commits. Added the runtime/tool-catalog checks to README troubleshooting.
**Guard:** Real Opus turns through the installed bridge emitted `handed js to codex` and received actual native-app inventory. Standalone CLI browser inventory failed to load its request-header policy even after one retry; direct desktop Codex inventory succeeded with Chrome and the in-app browser. Dictionary screenshot testing was refused by Codex's app approval, so no screenshot or click acceptance is claimed. Preserve those approval boundaries; inventory alone is not proof of screenshot or input success.
---

---
**Date:** 2026-09-25T20:40:00Z
**Trigger:** User: a new side chat just shows "Thinking 0s" and never answers
**Symptom:** An Opus side chat opened from a task whose Opus turn was running a long typecheck stayed at "Thinking 0s" for 2.5 minutes until stopped. Codex logs showed the request sent at 21:22:51 local time; the bridge log showed no `claude turn` line for it.
**Root cause:** Turns are serialized per Claude session. A side chat forks its parent's session (`--resume <parent> --fork-session`), and the lock key was the parent's session ID, so the fork queued behind the parent's running turn. The `claude turn` log line is written inside the lock, so the wait was silent.
**Fix:** `src/claudeRunner.js` gives a fork its own lock key, and logs when a turn waits for a busy session. A real Claude Code fork taken while the parent ran a 40-second foreground command answered in 9 seconds, and the parent then finished normally.
**Guard:** Test "a new side chat does not wait for its parent's running Claude turn" (fails on the old lock key).
---

---
**Date:** 2026-09-25T20:10:00Z
**Trigger:** User asked for bridged Claude's questions to use Codex's question UI, because Claude Code's question tool has a different format
**Symptom:** Claude was told to ask only in plain text. With the Codex tool handoff, an answer arriving during a tool run would also have been dropped, and one starting a new turn reached Claude only as background context with a "(continue)" prompt.
**Root cause:** The desktop app's `request_user_input_async` returns `{"accepted":true}` at once and later sends the answer as a user message starting with `<send_user_message_question_reply>`. The bridge treated any tag-led user text as injected context, and only plain prompts were attached to tool results. A real Opus run also showed that the CLI's sync `request_user_input` is refused outside Plan mode.
**Fix:** `src/codexInput.js` classifies the reply tag as the user's prompt; `src/codexTools.js` attaches context-led messages to tool results as well; `src/claudeRunner.js` prefers `request_user_input_async`, tells Claude to ask through it (falling back to plain text when Codex refuses) and passes `--disallowedTools AskUserQuestion`.
**Guard:** Tests for the desktop question flow, the reply classification and the plain-text case without a question tool. The desktop card itself still needs a live check after the service reloads.
---

---
**Date:** 2026-09-25T17:30:00Z
**Trigger:** User asked for the bridge to stop relaying Codex tools through Claude-launched connections so bridged Claude gets Codex's task tools and in-app browser
**Symptom:** Claude-launched MCP clients were rejected by the desktop app-tools pipe (code-signing peer check). The in-app browser was also unavailable to the direct Computer Use proxy.
**Root cause:** The bridge ran every tool inside Claude Code. Only Codex's own executor holds the trusted pipe connection, the per-turn metadata and the in-app browser.
**Fix:** `src/codexTools.js` turns the request's `tools` into a per-turn MCP server (`mcp__codex__*`). A call ends the current response with a real `function_call`/`custom_tool_call` item (`end_turn: false`) and holds the Claude process. The next Codex request carrying that `call_id`'s output resumes the same process (`findCodexResults` in `src/server.js`). A new message without the results cancels the waiting turn before resuming normally. `sanitizeInputForOpenAI` keeps these calls for GPT without bridge ids. A real Codex capture showed code mode: one freeform `exec` tool whose description (about 17 KB) lists nested tools, plus `wait`, `request_user_input`, `clock`, `collaboration`, `mcp__cua_repl` and hosted `web_search`.
**Guard:** Four regression tests: HTTP and WebSocket continuation, cancellation and GPT sanitising. Real Opus turns through `codex exec --ephemeral` against an isolated bridge copy completed `exec` → Codex-run shell, Computer Use `getState`, and serial parallel calls plus native Bash in one process. Claude Code serialises the parallel MCP calls (each was handed off separately about 0.2 s apart). Claude Code caps MCP descriptions at 2,048 characters unless `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` is raised. Desktop-only tools (codex_app task tools, in-app browser) still need a live desktop check after the installed service reloads.
---

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
