#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARCH="${1:-}"
EXTENSION_ID="pflnlemikfjdffpkadjjemologkalkcl"
HOST_NAME="com.vless.eevee.helper"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO_ROOT/extension/manifest.json")"

case "$ARCH" in
  amd64)
    GOARCH="amd64"
    CLANG_ARCH="x86_64"
    XRAY_ARCHIVE="Xray-macos-64.zip"
    PACKAGE_ARCH="x64"
    ;;
  arm64)
    GOARCH="arm64"
    CLANG_ARCH="arm64"
    XRAY_ARCHIVE="Xray-macos-arm64-v8a.zip"
    PACKAGE_ARCH="arm64"
    ;;
  *)
    echo "Usage: $0 <amd64|arm64>" >&2
    exit 2
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PAYLOAD="$TMP_DIR/payload"
APP_DIR="$PAYLOAD/Library/Application Support/vless-eevee"
HOST_DIR="$PAYLOAD/Library/Google/Chrome/NativeMessagingHosts"
TRAY_APP="$PAYLOAD/Applications/vless-eevee.app"
LAUNCH_AGENT_DIR="$PAYLOAD/Library/LaunchAgents"
mkdir -p "$APP_DIR" "$HOST_DIR" "$TRAY_APP/Contents/MacOS" "$LAUNCH_AGENT_DIR"
mkdir -p "$TMP_DIR/scripts"

cat > "$TMP_DIR/scripts/postinstall" << 'EOF'
#!/bin/sh
set -eu
APP_DIR="/Library/Application Support/vless-eevee"
DATA_DIR="$APP_DIR"

install -d -m 755 "$APP_DIR"
install -d -m 755 /Library/Google/Chrome/NativeMessagingHosts \
  "/Library/Application Support/Chromium/NativeMessagingHosts" \
  "/Library/BraveSoftware/Brave-Browser/NativeMessagingHosts"

cat > "$APP_DIR/com.vless.eevee.helper.json.template" <<'MANIFEST'
{
  "name": "com.vless.eevee.helper",
  "description": "vless-eevee helper",
  "path": "/Library/Application Support/vless-eevee/helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://pflnlemikfjdffpkadjjemologkalkcl/"]
}
MANIFEST
if [ -d "/Applications/Google Chrome.app" ]; then
  cp "$APP_DIR/com.vless.eevee.helper.json.template" \
    "/Library/Google/Chrome/NativeMessagingHosts/com.vless.eevee.helper.json"
fi
if [ -d "/Applications/Chromium.app" ]; then
  cp "$APP_DIR/com.vless.eevee.helper.json.template" \
    "/Library/Application Support/Chromium/NativeMessagingHosts/com.vless.eevee.helper.json"
fi
if [ -d "/Applications/Brave Browser.app" ]; then
  cp "$APP_DIR/com.vless.eevee.helper.json.template" \
    "/Library/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.vless.eevee.helper.json"
fi

cat > /Library/LaunchDaemons/com.vless.eevee.worker.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.vless.eevee.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Library/Application Support/vless-eevee/helper</string>
    <string>-daemon</string>
    <string>-data-dir</string>
    <string>/Library/Application Support/vless-eevee</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
</dict>
</plist>
PLIST
chmod 644 /Library/LaunchDaemons/com.vless.eevee.worker.plist
launchctl bootout system/com.vless.eevee.worker >/dev/null 2>&1 || true
launchctl bootstrap system /Library/LaunchDaemons/com.vless.eevee.worker.plist
GUI_UID="$(/usr/bin/stat -f '%u' /dev/console)"
if [ "$GUI_UID" -gt 0 ]; then
  launchctl bootstrap "gui/$GUI_UID" /Library/LaunchAgents/com.vless.eevee.tray.plist >/dev/null 2>&1 || true
fi
EOF
chmod 755 "$TMP_DIR/scripts/postinstall"

(
  cd "$REPO_ROOT/helper"
  GOOS=darwin GOARCH="$GOARCH" go build \
    -ldflags "-X main.appVersion=$VERSION" \
    -o "$APP_DIR/helper" .
)
(
  cd "$REPO_ROOT/helper/trayapp"
  CGO_ENABLED=1 GOOS=darwin GOARCH="$GOARCH" CC="clang -arch $CLANG_ARCH" go build \
    -ldflags "-X main.appVersion=$VERSION" \
    -o "$TRAY_APP/Contents/MacOS/tray" .
)
cat > "$TRAY_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>tray</string>
  <key>CFBundleIdentifier</key><string>com.vless.eevee.tray</string>
  <key>CFBundleName</key><string>vless-eevee</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
cat > "$LAUNCH_AGENT_DIR/com.vless.eevee.tray.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.vless.eevee.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/vless-eevee.app/Contents/MacOS/tray</string>
    <string>-data-dir</string>
    <string>/Library/Application Support/vless-eevee</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST

curl --fail --location --retry 3 \
  "https://github.com/XTLS/Xray-core/releases/latest/download/$XRAY_ARCHIVE" \
  --output "$TMP_DIR/xray.zip"
unzip -j -o "$TMP_DIR/xray.zip" xray geoip.dat geosite.dat -d "$APP_DIR"
chmod 755 "$APP_DIR/helper" "$APP_DIR/xray"
codesign --force --sign - "$APP_DIR/helper"
codesign --force --sign - "$APP_DIR/xray"
codesign --force --sign - "$TRAY_APP/Contents/MacOS/tray"

cat > "$HOST_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "vless-eevee helper",
  "path": "/Library/Application Support/vless-eevee/helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

mkdir -p "$REPO_ROOT/dist"
OUTPUT="$REPO_ROOT/dist/vless-eevee.v${VERSION}.macos.${PACKAGE_ARCH}.pkg"
pkgbuild \
  --root "$PAYLOAD" \
  --scripts "$TMP_DIR/scripts" \
  --identifier "com.vless.eevee.helper" \
  --version "$VERSION" \
  --install-location / \
  "$OUTPUT"
echo "Created $OUTPUT"
