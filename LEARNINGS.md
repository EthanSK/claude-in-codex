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
