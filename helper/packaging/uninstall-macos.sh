#!/usr/bin/env bash
set -euo pipefail

launchctl bootout system/com.vless.eevee.worker >/dev/null 2>&1 || true
CONSOLE_UID="$(/usr/bin/stat -f '%u' /dev/console)"
if [ "$CONSOLE_UID" -gt 0 ]; then
  launchctl bootout "gui/$CONSOLE_UID" /Library/LaunchAgents/com.vless.eevee.tray.plist >/dev/null 2>&1 || true
fi
rm -f /Library/LaunchAgents/com.vless.eevee.tray.plist
rm -rf -- /Applications/vless-eevee.app
rm -f /Library/LaunchDaemons/com.vless.eevee.worker.plist
rm -f \
  "/Library/Google/Chrome/NativeMessagingHosts/com.vless.eevee.helper.json" \
  "/Library/Application Support/Chromium/NativeMessagingHosts/com.vless.eevee.helper.json" \
  "/Library/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.vless.eevee.helper.json"
rm -rf -- "/Library/Application Support/vless-eevee"

echo "vless-eevee Worker и Native Messaging host удалены."
