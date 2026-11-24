# Установка vless-eevee helper на Windows.
# Запуск: powershell -ExecutionPolicy Bypass -File install-windows.ps1

$ErrorActionPreference = "Stop"
$ExtensionId = "pflnlemikfjdffpkadjjemologkalkcl"
$HostName = "com.vless.eevee.helper"

$AppDir = "$env:LOCALAPPDATA\vless-eevee"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

# Бинарники должны лежать рядом со скриптом: helper.exe и xray.exe
Copy-Item "$ScriptDir\helper.exe" "$AppDir\helper.exe" -Force
Copy-Item "$ScriptDir\xray.exe"   "$AppDir\xray.exe"   -Force

# Базы geoip/geosite нужны xray для routing-правил вида geosite:category-ru /
# geoip:ru — без них конфиг из подписки не загрузится. Кладём рядом с xray.
foreach ($dat in @("geoip.dat", "geosite.dat")) {
    if (Test-Path "$ScriptDir\$dat") {
        Copy-Item "$ScriptDir\$dat" "$AppDir\$dat" -Force
    } else {
        Write-Host "ВНИМАНИЕ: $dat не найден рядом со скриптом — конфиги с geosite/geoip правилами не заработают."
    }
}

$Manifest = @{
    name            = $HostName
    description     = "vless-eevee helper"
    path            = "$AppDir\helper.exe"
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json

$ManifestPath = "$AppDir\$HostName.json"
Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8

# Регистрируем host в реестре (только для текущего пользователя, без прав администратора)
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath

Write-Host "Готово. vless-eevee helper установлен в $AppDir"
Write-Host "Перезапустите Chrome, если он был открыт."
