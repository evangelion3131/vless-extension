#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT="${1:-$REPO_ROOT/dist/vless-eevee.crx}"
KEY_FILE="${2:-${VLESS_EEVEE_KEY_FILE:-}}"

mkdir -p "$(dirname "$OUTPUT")"

if [ -z "$KEY_FILE" ]; then
  if [ -n "${VLESS_EEVEE_KEY_B64:-}" ]; then
    KEY_FILE="$(mktemp)"
    trap 'rm -f "$KEY_FILE"' EXIT
    printf '%s' "$VLESS_EEVEE_KEY_B64" | openssl base64 -d -A > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
  fi
fi

if [ -z "$KEY_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "VLESS_EEVEE_KEY_FILE or VLESS_EEVEE_KEY_B64 is required to build a stable CRX." >&2
  exit 2
fi

BROWSER=""
for candidate in google-chrome chromium brave-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER="$(command -v "$candidate")"
    break
  fi
done
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  if [ -x "$candidate" ]; then
    BROWSER="$candidate"
    break
  fi
done
for candidate in \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" \
  "/c/Program Files/Chromium/Application/chrome.exe"; do
  if [ -x "$candidate" ]; then
    BROWSER="$candidate"
    break
  fi
done
if [ -z "$BROWSER" ]; then
  echo "A Chromium-compatible browser is required to package the extension." >&2
  exit 2
fi

rm -f "$REPO_ROOT/extension.crx" "$REPO_ROOT/extension.pem"
"$BROWSER" --headless --disable-gpu --no-sandbox \
  --pack-extension="$REPO_ROOT/extension" \
  --pack-extension-key="$KEY_FILE" \
  >/dev/null 2>&1 || true

if [ ! -f "$REPO_ROOT/extension.crx" ]; then
  echo "CRX packaging failed." >&2
  exit 1
fi

mv "$REPO_ROOT/extension.crx" "$OUTPUT"
VERSION_FILE="$(mktemp)"
python3 - "$REPO_ROOT/extension/manifest.json" "$VERSION_FILE" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(manifest["version"] + "\n")
PY
mv "$VERSION_FILE" "${OUTPUT}.version"
rm -f "$REPO_ROOT/extension.pem"
echo "Created $OUTPUT (version $(cat "${OUTPUT}.version"))"
