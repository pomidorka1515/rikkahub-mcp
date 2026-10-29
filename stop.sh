#!/data/data/com.termux/files/usr/bin/bash
# Stop the MCP server (works even if it was started without the pidfile).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
killed=0

if [ -f "$DIR/.pid" ]; then
  kill "$(cat "$DIR/.pid")" 2>/dev/null && killed=1
  rm -f "$DIR/.pid"
fi

# Fallback / cleanup: find this directory's compiled (or legacy) server.
for proc in /proc/[0-9]*; do
  pid="${proc#/proc/}"
  [ "$pid" = "$$" ] && continue
  cmdline="$(tr '\0' '\n' <"$proc/cmdline" 2>/dev/null)" || continue
  argv0="$(printf '%s\n' "$cmdline" | sed -n 1p)"
  argv1="$(printf '%s\n' "$cmdline" | sed -n 2p)"
  if [ "$argv1" = "--enable-source-maps" ]; then
    argv1="$(printf '%s\n' "$cmdline" | sed -n 3p)"
  fi
  case "$argv0" in *node*|*bun*) ;; *) continue ;; esac
  case "$argv1" in server.js|*/server.js) ;; *) continue ;; esac
  [ "$(readlink "$proc/cwd" 2>/dev/null)" = "$DIR" ] || continue
  kill "$pid" 2>/dev/null && killed=1
done

[ "$killed" = 1 ] && echo "stopped" || echo "not running"
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true
