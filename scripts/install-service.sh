#!/bin/bash
# Runs the server at login and keeps it running (macOS launchd). Re-run after moving the repo.
# It runs under `caffeinate -is`, so the Mac does not go to sleep while the server is up
# (a sleeping Mac would miss reminders and deadlines).
set -euo pipefail
. "$(dirname "$0")/env.sh"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.yomepay.server.plist"
LOG="$HOME/Library/Logs/yomepay.log"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.yomepay.server</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-is</string><string>$NODE</string><string>$ROOT/server/server.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.yomepay.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Running. Logs: $LOG"
echo "Local check: curl -s http://127.0.0.1:$PORT/api/state | head -c 200"
