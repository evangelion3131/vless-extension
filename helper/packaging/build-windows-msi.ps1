param(
    [string]$Wix = "wix"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Manifest = Get-Content (Join-Path $RepoRoot "extension\manifest.json") -Raw | ConvertFrom-Json
$Version = $Manifest.version
$ExtensionId = "pflnlemikfjdffpkadjjemologkalkcl"
$HostName = "com.vless.eevee.helper"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$PayloadDir = Join-Path $TempDir "payload"
$XrayArchive = Join-Path $TempDir "xray.zip"
$OutputDir = Join-Path $RepoRoot "dist"
$OutputPath = Join-Path $OutputDir "vless-eevee.v$Version.windows.x64.msi"

New-Item -ItemType Directory -Force -Path $PayloadDir, $OutputDir | Out-Null

try {
    Push-Location (Join-Path $RepoRoot "helper")
    try {
        $env:GOOS = "windows"
        $env:GOARCH = "amd64"
        go build -ldflags "-H=windowsgui -X main.appVersion=$Version" -o (Join-Path $PayloadDir "helper.exe") .
        if ($LASTEXITCODE -ne 0) { throw "Go helper build failed." }
    } finally {
        Pop-Location
        Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
    }

    Push-Location (Join-Path $RepoRoot "helper\trayapp")
    try {
        $env:GOOS = "windows"
        $env:GOARCH = "amd64"
        $env:CGO_ENABLED = "1"
        $env:CC = "gcc"
        go build -ldflags "-H=windowsgui -X main.appVersion=$Version" -o (Join-Path $PayloadDir "tray.exe") .
        if ($LASTEXITCODE -ne 0) { throw "Go tray build failed." }
    } finally {
        Pop-Location
        Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED, Env:CC -ErrorAction SilentlyContinue
    }

    Invoke-WebRequest `
        -Uri "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip" `
        -OutFile $XrayArchive
    Expand-Archive -Path $XrayArchive -DestinationPath $TempDir
    Copy-Item (Join-Path $TempDir "xray.exe"), (Join-Path $TempDir "geoip.dat"), (Join-Path $TempDir "geosite.dat") $PayloadDir

    $CrxBuilder = Join-Path $PSScriptRoot "build-extension-crx.sh"
    if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
        throw "A Bash-capable environment is required to package the CRX."
    }
    $Env:VLESS_EEVEE_KEY_FILE = $env:VLESS_EEVEE_KEY_FILE
    & bash $CrxBuilder (Join-Path $PayloadDir "vless-eevee.crx") $env:VLESS_EEVEE_KEY_FILE
    if ($LASTEXITCODE -ne 0) { throw "CRX packaging failed." }

    $NativeManifest = @{
        name            = $HostName
        description     = "vless-eevee helper"
        path            = "C:\Program Files\vless-eevee\helper.exe"
        type            = "stdio"
        allowed_origins = @("chrome-extension://$ExtensionId/")
    } | ConvertTo-Json
    Set-Content -Path (Join-Path $PayloadDir "$HostName.json") -Value $NativeManifest -Encoding ascii

    & $Wix build `
        -arch x64 `
        -d "AppVersion=$Version" `
        -d "PayloadDir=$PayloadDir" `
        -o $OutputPath `
        (Join-Path $PSScriptRoot "windows\vless-eevee.wxs")
    if ($LASTEXITCODE -ne 0) { throw "WiX MSI build failed." }

    Write-Host "Created $OutputPath"
} finally {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
}
