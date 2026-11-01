# Shared by the scripts: load .env (variables already set win, like in server/config.js) and resolve settings.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; v="${v%"${v##*[![:space:]]}"}"
    [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]] && v="${BASH_REMATCH[1]}"
    [ -z "${!k+x}" ] && export "$k=$v"
  done < "$ROOT/.env"
fi
DATA="${YOMEPAY_DATA_DIR:-$HOME/.yomepay/data}"; DATA="${DATA/#\~/$HOME}"
PORT="${PORT:-4749}"
HTTPS_PORT="${YOMEPAY_HTTPS_PORT:-443}"
