#!/usr/bin/env bash
set -euo pipefail

launchctl bootout system/com.vless.eevee.worker >/dev/null 2>&1 || true
rm -f /Library/LaunchDaemons/com.vless.eevee.worker.plist
rm -f \
  "/Library/Google/Chrome/NativeMessagingHosts/com.vless.eevee.helper.json" \
  "/Library/Application Support/Chromium/NativeMessagingHosts/com.vless.eevee.helper.json" \
  "/Library/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.vless.eevee.helper.json"
rm -rf -- "/Library/Application Support/vless-eevee"

echo "vless-eevee Worker и Native Messaging host удалены."
