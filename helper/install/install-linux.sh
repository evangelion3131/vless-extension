#!/bin/bash
# Установка vless-eevee helper на Linux.
# Использование: ./install-linux.sh
set -e

EXT_ID="pflnlemikfjdffpkadjjemologkalkcl"
HOST_NAME="com.vless.eevee.helper"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/vless-eevee"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
BROWSER_CONFIG_DIRS=(
  "$CONFIG_DIR/google-chrome"
  "$CONFIG_DIR/chromium"
  "$CONFIG_DIR/BraveSoftware/Brave-Browser"
)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$APP_DIR"

# Бинарники должны лежать рядом со скриптом: helper и xray
cp "$SCRIPT_DIR/helper" "$APP_DIR/helper"
cp "$SCRIPT_DIR/xray" "$APP_DIR/xray"
chmod +x "$APP_DIR/helper" "$APP_DIR/xray"

# Базы geoip/geosite нужны xray для routing-правил вида geosite:category-ru /
# geoip:ru — без них конфиг из подписки не загрузится. Кладём рядом с xray.
for dat in geoip.dat geosite.dat; do
  if [ -f "$SCRIPT_DIR/$dat" ]; then
    cp "$SCRIPT_DIR/$dat" "$APP_DIR/$dat"
  else
    echo "ВНИМАНИЕ: $dat не найден рядом со скриптом — конфиги с geosite/geoip правилами не заработают."
  fi
done

JSON_APP_DIR="$(printf '%s' "$APP_DIR" | sed 's/\\/\\\\/g; s/"/\\"/g')"

for browser_config_dir in "${BROWSER_CONFIG_DIRS[@]}"; do
  nm_dir="$browser_config_dir/NativeMessagingHosts"
  mkdir -p "$nm_dir"
  cat > "$nm_dir/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "vless-eevee helper",
  "path": "$JSON_APP_DIR/helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
done

echo "Готово. vless-eevee helper установлен в $APP_DIR"
echo "Native Messaging host зарегистрирован для Chrome, Chromium и Brave."
echo "Перезапустите браузер, если он был открыт."
