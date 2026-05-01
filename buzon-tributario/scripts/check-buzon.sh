#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${SAT_CDP_PORT:-18800}"
CDP_URL="${SAT_CDP_URL:-http://127.0.0.1:${PORT}}"
PROFILE="${SAT_CHROME_PROFILE:-${TMPDIR:-/tmp}/sat-buzon-chrome-profile}"
LOG="${SAT_CHROME_LOG:-${TMPDIR:-/tmp}/sat-buzon-chrome.log}"

default_chrome_bin() {
  if [[ -n "${CHROME_BIN:-}" ]]; then
    echo "$CHROME_BIN"
    return
  fi
  case "$(uname -s)" in
    Darwin)
      echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ;;
    Linux)
      for candidate in \
        /usr/bin/google-chrome \
        /usr/bin/google-chrome-stable \
        /usr/bin/chromium \
        /usr/bin/chromium-browser \
        /snap/bin/chromium \
        /opt/google/chrome/google-chrome; do
        if [[ -x "$candidate" ]]; then
          echo "$candidate"
          return
        fi
      done
      for cmd in google-chrome google-chrome-stable chromium chromium-browser; do
        if found=$(command -v "$cmd" 2>/dev/null); then
          echo "$found"
          return
        fi
      done
      ;;
  esac
}

if [[ ! -d "$SKILL_ROOT/node_modules/playwright-core" ]]; then
  echo "playwright-core no está instalado. Ejecuta:" >&2
  echo "  cd \"$SKILL_ROOT\" && npm install" >&2
  exit 2
fi

if ! curl -sf "${CDP_URL}/json/version" >/dev/null 2>&1; then
  CHROME="$(default_chrome_bin || true)"
  if [[ -z "$CHROME" || ! -x "$CHROME" ]]; then
    echo "Chrome no encontrado. Define CHROME_BIN o instala Chrome/Chromium." >&2
    exit 2
  fi
  mkdir -p "$PROFILE"
  "$CHROME" \
    --headless=new \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    about:blank >"$LOG" 2>&1 &

  for _ in {1..40}; do
    if curl -sf "${CDP_URL}/json/version" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
fi

if ! curl -sf "${CDP_URL}/json/version" >/dev/null 2>&1; then
  echo "Chrome CDP no responde en ${CDP_URL}. Últimas líneas del log:" >&2
  tail -80 "$LOG" >&2 || true
  exit 2
fi

SAT_CDP_URL="$CDP_URL" node "$SCRIPT_DIR/check-buzon.js" "$@"
