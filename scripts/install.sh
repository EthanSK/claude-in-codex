#!/bin/bash
# Installs the Codex ↔ Claude bridge on macOS:
#  - background service (LaunchAgent) on 127.0.0.1:18787
#  - points Codex at it with one line in ~/.codex/config.toml (backed up first)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CODEX_CLAUDE_BRIDGE_PORT:-18787}"
LABEL="com.codex-claude-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BRIDGE_HOME="$HOME/.codex-claude-bridge"
CODEX_CONFIG="$HOME/.codex/config.toml"
LOG="$HOME/Library/Logs/codex-claude-bridge.log"
TAG="# codex-claude-bridge"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- find node and claude (login shell so nvm/homebrew PATHs are loaded) -------
NODE="$(command -v node || true)"
[ -z "$NODE" ] && NODE="$(zsh -lic 'command -v node' 2>/dev/null | tail -1 || true)"
[ -x "$NODE" ] || die "node not found. Install Node 22+ (brew install node)."
# `node` on PATH may be a shell shim (nvm/volta/fnm wrapper) rather than the real
# binary. launchd should exec the real binary: a shim that sources nvm.sh on every
# start is slow, depends on the shim's own environment, and is a needless failure
# point for a KeepAlive service. process.execPath is always the actual executable.
NODE="$("$NODE" -p 'process.execPath')"
[ -x "$NODE" ] || die "could not resolve the real node binary (got '$NODE')."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $("$NODE" -v) is too old; need 20+."
HAS_ZSTD="$("$NODE" -p 'typeof require("zlib").zstdDecompressSync === "function"')"

CLAUDE="$(command -v claude || true)"
[ -z "$CLAUDE" ] && CLAUDE="$(zsh -lic 'command -v claude' 2>/dev/null | tail -1 || true)"
[ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"
[ -x "$CLAUDE" ] || die "claude CLI not found. Install Claude Code and run: claude auth login"
say "node:   $NODE ($("$NODE" -v))"
say "claude: $CLAUDE ($("$CLAUDE" --version 2>/dev/null | head -1))"

# --- bridge config -------------------------------------------------------------
mkdir -p "$BRIDGE_HOME" "$(dirname "$PLIST")" "$(dirname "$LOG")"
if [ ! -f "$BRIDGE_HOME/config.json" ]; then
  cat > "$BRIDGE_HOME/config.json" <<JSON
{
  "port": $PORT,
  "claudePath": "$CLAUDE"
}
JSON
  say "wrote $BRIDGE_HOME/config.json"
else
  "$NODE" -e '
    const fs=require("fs"), f=process.argv[1], c=JSON.parse(fs.readFileSync(f,"utf8"));
    c.claudePath=process.argv[2]; c.port=Number(process.argv[3]); fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n");' "$BRIDGE_HOME/config.json" "$CLAUDE" "$PORT"
  say "updated claudePath and port in $BRIDGE_HOME/config.json"
fi

# --- LaunchAgent ----------------------------------------------------------------
SERVICE_PATH="$(dirname "$NODE"):$(dirname "$CLAUDE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/src/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
# Unload any previous copy of the service. `bootout` returns before launchd has
# actually finished tearing the job down, and a `bootstrap` issued while the old
# registration is still draining fails with "Bootstrap failed: 5: Input/output
# error" (seen on re-install). So poll until the label is really gone instead of
# relying on a fixed sleep.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for i in $(seq 1 40); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  die "could not unload the previous $LABEL service; run: launchctl bootout gui/$(id -u)/$LABEL"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already used by: $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR==2{print $1" (pid "$2")"}'). Re-run with CODEX_CLAUDE_BRIDGE_PORT=<free port>."
fi
# One retry: even after the label disappears from `launchctl print`, a bootstrap
# that lands in the same instant can still hit the transient EIO above.
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "launchctl bootstrap failed; see $LOG"
fi
say "service started (logs: $LOG)"

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || die "bridge didn't start; see $LOG"
say "bridge healthy on http://127.0.0.1:$PORT"

# --- Codex config ------------------------------------------------------------------
mkdir -p "$(dirname "$CODEX_CONFIG")"
touch "$CODEX_CONFIG"
if grep -q "$TAG" "$CODEX_CONFIG"; then
  say "Codex already points at the bridge"
else
  if grep -Eq '^[[:space:]]*openai_base_url[[:space:]]*=' "$CODEX_CONFIG"; then
    die "~/.codex/config.toml already sets openai_base_url; remove it or point it at http://127.0.0.1:$PORT/backend-api/codex yourself."
  fi
  BACKUP="$CODEX_CONFIG.bak-ccb-$(date +%Y%m%d-%H%M%S)"
  cp "$CODEX_CONFIG" "$BACKUP"
  say "backed up Codex config to $BACKUP"
  {
    echo "openai_base_url = \"http://127.0.0.1:$PORT/backend-api/codex\" $TAG"
    cat "$BACKUP"
  } > "$CODEX_CONFIG"
  say "added openai_base_url to ~/.codex/config.toml"
fi

if [ "$HAS_ZSTD" != "true" ] && ! grep -q "enable_request_compression" "$CODEX_CONFIG"; then
  # This Node can't decode Codex's zstd request bodies, so ask Codex not to compress.
  if grep -q '^\[features\]' "$CODEX_CONFIG"; then
    /usr/bin/sed -i '' "/^\[features\]/a\\
enable_request_compression = false $TAG
" "$CODEX_CONFIG"
  else
    printf '\n[features] %s\nenable_request_compression = false %s\n' "$TAG" "$TAG" >> "$CODEX_CONFIG"
  fi
  say "disabled Codex request compression (Node $("$NODE" -v) has no zstd)"
fi

say "Done. Quit and reopen the Codex app, then pick Opus 5.5 or Fable 5 in the model picker."
