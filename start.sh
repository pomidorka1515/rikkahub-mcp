#!/data/data/com.termux/files/usr/bin/bash
# Start the loopback MCP server (idempotent) and print client URLs.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${MCP_PORT:-8765}"
PIDFILE="$DIR/.pid"

running() { curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

if ! running; then
  # keep Android from freezing Termux while the server is up
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
  cd "$DIR"
  npm run build
  nohup node --enable-source-maps dist/server.js >>"$DIR/server.log" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 40); do running && break; sleep 0.25; done
fi

if running; then
  TOKEN="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/rikkahub-mcp/token" 2>/dev/null || true)"
  echo "running on port $PORT"
  echo "  streamable http : http://127.0.0.1:$PORT/mcp?token=$TOKEN"
  echo "  legacy sse      : http://127.0.0.1:$PORT/sse?token=$TOKEN"
else
  echo "failed to start; see $DIR/server.log" >&2
  tail -20 "$DIR/server.log" >&2 || true
  exit 1
fi
