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
    XRAY_ARCHIVE="Xray-linux-64.zip"
    ;;
  arm64)
    GOARCH="arm64"
    XRAY_ARCHIVE="Xray-linux-arm64-v8a.zip"
    ;;
  *)
    echo "Usage: $0 <amd64|arm64>" >&2
    exit 2
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PACKAGE_ROOT="$TMP_DIR/package"
APP_DIR="$PACKAGE_ROOT/opt/vless-eevee"
mkdir -p "$APP_DIR"

(
  cd "$REPO_ROOT/helper"
  CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -o "$APP_DIR/helper" .
)

curl --fail --location --retry 3 \
  "https://github.com/XTLS/Xray-core/releases/latest/download/$XRAY_ARCHIVE" \
  --output "$TMP_DIR/xray.zip"
unzip -j -o "$TMP_DIR/xray.zip" xray geoip.dat geosite.dat -d "$APP_DIR"
chmod 755 "$APP_DIR/helper" "$APP_DIR/xray"

CRX_OUTPUT="$TMP_DIR/vless-eevee.crx"
"$SCRIPT_DIR/build-extension-crx.sh" "$CRX_OUTPUT" "${VLESS_EEVEE_KEY_FILE:-}"
cp "$CRX_OUTPUT" "$APP_DIR/vless-eevee.crx"
cp "${CRX_OUTPUT}.version" "$APP_DIR/extension-version.txt"

mkdir -p "$PACKAGE_ROOT/var/lib/vless-eevee"
cp "$APP_DIR/vless-eevee.crx" "$PACKAGE_ROOT/var/lib/vless-eevee/vless-eevee.crx"
cp "$APP_DIR/extension-version.txt" "$PACKAGE_ROOT/var/lib/vless-eevee/extension-version.txt"

mkdir -p "$PACKAGE_ROOT/lib/systemd/system"
cat > "$PACKAGE_ROOT/lib/systemd/system/vless-eevee-worker.service" << 'EOF'
[Unit]
Description=vless-eevee background worker
After=network.target

[Service]
Type=simple
ExecStart=/opt/vless-eevee/helper -daemon -data-dir /var/lib/vless-eevee
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

for host_dir in \
  "$PACKAGE_ROOT/etc/opt/chrome/native-messaging-hosts" \
  "$PACKAGE_ROOT/etc/chromium/native-messaging-hosts"; do
  mkdir -p "$host_dir"
  cat > "$host_dir/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "vless-eevee helper",
  "path": "/opt/vless-eevee/helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
done

mkdir -p "$PACKAGE_ROOT/DEBIAN"
cp "$SCRIPT_DIR/linux/postinst" "$PACKAGE_ROOT/DEBIAN/postinst"
cp "$SCRIPT_DIR/linux/prerm" "$PACKAGE_ROOT/DEBIAN/prerm"
sed -i "s/external_version\": \"0\\.4\\.0\"/external_version\": \"$VERSION\"/" "$PACKAGE_ROOT/DEBIAN/postinst"
chmod 755 "$PACKAGE_ROOT/DEBIAN/postinst" "$PACKAGE_ROOT/DEBIAN/prerm"
cat > "$PACKAGE_ROOT/DEBIAN/control" << EOF
Package: vless-eevee
Version: $VERSION
Section: net
Priority: optional
Architecture: $ARCH
Maintainer: vless-eevee
Description: Native messaging helper for the vless-eevee browser extension
 Installs the vless-eevee helper and Xray core for Chrome, Chromium and Brave.
EOF
find "$PACKAGE_ROOT" -type d -exec chmod 755 {} +
find "$PACKAGE_ROOT" -type f -exec chmod 644 {} +
chmod 755 "$APP_DIR/helper" "$APP_DIR/xray" \
  "$PACKAGE_ROOT/DEBIAN/postinst" "$PACKAGE_ROOT/DEBIAN/prerm"

mkdir -p "$REPO_ROOT/dist"
OUTPUT="$REPO_ROOT/dist/vless-eevee_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PACKAGE_ROOT" "$OUTPUT"
echo "Created $OUTPUT"
