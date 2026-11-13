#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
APP_NAME="Dimina Desktop"
APP_BUNDLE="$ROOT_DIR/desktop/build/darwin-$(uname -m)/$APP_NAME.app"
if [[ "$(uname -m)" == "x86_64" ]]; then APP_BUNDLE="$ROOT_DIR/desktop/build/darwin-amd64/$APP_NAME.app"; fi

case "$MODE" in
  run|--build-only|--verify|--logs|--telemetry|--debug) ;;
  *) echo "usage: $0 [--build-only|--verify|--logs|--telemetry|--debug]" >&2; exit 2 ;;
esac

if [[ "$MODE" != "--build-only" ]]; then pkill -x "$APP_NAME" >/dev/null 2>&1 || true; fi
# Running from fe also makes Volta honor this repository's pinned Node version.
cd "$ROOT_DIR/fe"
node "$ROOT_DIR/desktop/scripts/build.mjs"
if [[ "$MODE" == "--build-only" ]]; then exit 0; fi
if [[ "$(uname -s)" != "Darwin" ]]; then echo "Run the executable in desktop/build for this platform."; exit 0; fi
if [[ "$MODE" == "--debug" ]]; then exec lldb -- "$APP_BUNDLE/Contents/MacOS/$APP_NAME"; fi
/usr/bin/open -n "$APP_BUNDLE"
case "$MODE" in
  --verify) sleep 1; pgrep -x "$APP_NAME" >/dev/null ;;
  --logs|--telemetry) exec /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\"" ;;
esac
