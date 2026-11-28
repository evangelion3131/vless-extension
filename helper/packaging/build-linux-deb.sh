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
  # Use libc/NSS DNS resolution so Linux follows the system resolver configuration.
  CGO_ENABLED=1 GOOS=linux GOARCH="$GOARCH" go build \
    -ldflags "-X main.appVersion=$VERSION" \
    -o "$APP_DIR/helper" .
)
(
  cd "$REPO_ROOT/helper/trayapp"
  CGO_ENABLED=1 GOOS=linux GOARCH="$GOARCH" go build \
    -ldflags "-X main.appVersion=$VERSION" \
    -o "$APP_DIR/tray" .
)

curl --fail --location --retry 3 \
  "https://github.com/XTLS/Xray-core/releases/latest/download/$XRAY_ARCHIVE" \
  --output "$TMP_DIR/xray.zip"
unzip -j -o "$TMP_DIR/xray.zip" xray geoip.dat geosite.dat -d "$APP_DIR"
chmod 755 "$APP_DIR/helper" "$APP_DIR/xray"

CRX_OUTPUT="$TMP_DIR/vless-eevee.crx"
if [ -n "${VLESS_EEVEE_CRX_FILE:-}" ]; then
  if [ ! -f "$VLESS_EEVEE_CRX_FILE" ]; then
    echo "VLESS_EEVEE_CRX_FILE does not exist: $VLESS_EEVEE_CRX_FILE" >&2
    exit 1
  fi
  cp "$VLESS_EEVEE_CRX_FILE" "$CRX_OUTPUT"
  printf '%s\n' "$VERSION" > "${CRX_OUTPUT}.version"
else
  "$SCRIPT_DIR/build-extension-crx.sh" "$CRX_OUTPUT" "${VLESS_EEVEE_KEY_FILE:-}"
fi
cp "$CRX_OUTPUT" "$APP_DIR/vless-eevee.crx"
cp "${CRX_OUTPUT}.version" "$APP_DIR/extension-version.txt"
if [ "$ARCH" = amd64 ] && [ -z "${VLESS_EEVEE_CRX_FILE:-}" ]; then
  mkdir -p "$REPO_ROOT/dist"
  cp "$CRX_OUTPUT" "$REPO_ROOT/dist/vless-eevee.extension.crx"
fi

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

mkdir -p "$PACKAGE_ROOT/etc/xdg/autostart"
mkdir -p "$PACKAGE_ROOT/usr/share/pixmaps"
cp "$REPO_ROOT/extension/icons/icon128.png" "$PACKAGE_ROOT/usr/share/pixmaps/vless-eevee.png"
cat > "$PACKAGE_ROOT/etc/xdg/autostart/vless-eevee-tray.desktop" << 'EOF'
[Desktop Entry]
Type=Application
Name=vless-eevee
Comment=vless-eevee update helper
Exec=/opt/vless-eevee/tray -data-dir /var/lib/vless-eevee
Icon=vless-eevee
Terminal=false
Categories=Network;
EOF
mkdir -p "$PACKAGE_ROOT/usr/share/applications"
cat > "$PACKAGE_ROOT/usr/share/applications/vless-eevee.desktop" << 'EOF'
[Desktop Entry]
Type=Application
Name=vless-eevee
Comment=VLESS helper and update tray
Exec=/opt/vless-eevee/tray -data-dir /var/lib/vless-eevee
Icon=vless-eevee
Terminal=false
Categories=Network;
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
chmod 755 "$PACKAGE_ROOT/DEBIAN/postinst" "$PACKAGE_ROOT/DEBIAN/prerm"
cat > "$PACKAGE_ROOT/DEBIAN/control" << EOF
Package: vless-eevee
Version: $VERSION
Section: net
Priority: optional
Architecture: $ARCH
Maintainer: vless-eevee
Depends: libayatana-appindicator3-1
Description: Native messaging helper for the vless-eevee browser extension
 Installs the vless-eevee helper and Xray core for Chrome, Chromium and Brave.
EOF
find "$PACKAGE_ROOT" -type d -exec chmod 755 {} +
find "$PACKAGE_ROOT" -type f -exec chmod 644 {} +
chmod 755 "$APP_DIR/helper" "$APP_DIR/xray" \
  "$PACKAGE_ROOT/DEBIAN/postinst" "$PACKAGE_ROOT/DEBIAN/prerm"
chmod 755 "$APP_DIR/tray"

mkdir -p "$REPO_ROOT/dist"
OUTPUT="$REPO_ROOT/dist/vless-eevee.v${VERSION}.linux.${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PACKAGE_ROOT" "$OUTPUT"
echo "Created $OUTPUT"
