#!/bin/bash
# Makes the app reachable over HTTPS, but only from devices signed in to your tailnet.
# The port is YOMEPAY_HTTPS_PORT (default 443; pick another if 443 is taken on this Mac).
# Never use `tailscale funnel` for this app: that would put it on the public internet.
set -euo pipefail
. "$(dirname "$0")/env.sh"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
"$TS" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"
"$TS" serve status
