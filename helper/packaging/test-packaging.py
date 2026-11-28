#!/usr/bin/env python3
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXTENSION_ID = "pflnlemikfjdffpkadjjemologkalkcl"
HOST_NAME = "com.vless.eevee.helper"


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


manifest = json.loads((ROOT / "extension/manifest.json").read_text())
if manifest["name"] != "vless-eevee":
    fail("extension name is not vless-eevee")
if manifest["manifest_version"] != 3:
    fail("extension is not Manifest V3")
if "update_url" in manifest:
    fail("extension must not use CRX-based browser updates")

popup_html = (ROOT / "extension/popup.html").read_text()
popup_js = (ROOT / "extension/popup.js").read_text()
html_ids = set(re.findall(r'\bid="([^"]+)"', popup_html))
js_ids = set(re.findall(r'\$\("([^"]+)"\)', popup_js))
missing_ids = sorted(js_ids - html_ids)
if missing_ids:
    fail(f"popup.js references missing popup.html elements: {', '.join(missing_ids)}")

scripts = (
    ROOT / "helper/packaging/build-linux-deb.sh",
    ROOT / "helper/packaging/build-macos-pkg.sh",
    ROOT / "helper/packaging/build-windows-msi.ps1",
)
for path in scripts:
    if not path.is_file():
        fail(f"missing packaging script: {path}")

linux_text = scripts[0].read_text()
if EXTENSION_ID not in linux_text or HOST_NAME not in linux_text:
    fail("Linux package is missing stable native messaging identifiers")
if "/opt/vless-eevee/helper" not in linux_text:
    fail("Linux package has wrong helper path")
if 'cd "$REPO_ROOT/helper"\n  # Use libc/NSS DNS resolution' not in linux_text or \
        'CGO_ENABLED=1 GOOS=linux GOARCH="$GOARCH" go build' not in linux_text:
    fail("Linux helper must use the system DNS resolver")
if 'OUTPUT="$REPO_ROOT/dist/vless-eevee.v${VERSION}.linux.${ARCH}.deb"' not in linux_text:
    fail("Linux package output must include its version and architecture")
if ".crx" in linux_text.lower():
    fail("Linux package must not build or bundle a CRX")
if "trayapp" not in linux_text or "vless-eevee-tray.desktop" not in linux_text:
    fail("Linux package is missing the tray app")
if "/usr/share/applications/vless-eevee.desktop" not in linux_text:
    fail("Linux package is missing the application launcher")
if "Exec=/opt/vless-eevee/tray -data-dir /var/lib/vless-eevee" not in linux_text:
    fail("Linux application launcher is not configured to start the tray")
if "Depends: libayatana-appindicator3-1" not in linux_text:
    fail("Linux package is missing the tray runtime dependency")

postinst = (ROOT / "helper/packaging/linux/postinst").read_text()
prerm = (ROOT / "helper/packaging/linux/prerm").read_text()
if "vless-eevee-worker.service" not in postinst:
    fail("Linux post-install does not start Worker")
if "systemctl restart vless-eevee-worker.service" not in postinst:
    fail("Linux post-install does not restart an already running Worker")
if "external_crx" in postinst:
    fail("Linux post-install must not create CRX extension policies")
if "remove_legacy_extension_policy" not in postinst or "/var/lib/vless-eevee/vless-eevee.crx" not in postinst:
    fail("Linux post-install must remove policies and files from older CRX installs")
if "disable --now vless-eevee-worker.service" not in prerm:
    fail("Linux removal does not stop Worker")

wix = ROOT / "helper/packaging/windows/vless-eevee.wxs"
try:
    ET.parse(wix)
except Exception as exc:
    fail(f"WiX XML is invalid: {exc}")
wix_text = wix.read_text()
for required in ("tray.exe", "StartWorker", "StopWorker", "StartMenuShortcut", HOST_NAME):
    if required not in wix_text:
        fail(f"WiX package is missing {required}")
if ".crx" in wix_text.lower():
    fail("Windows package must not bundle a CRX")
if "LocalAppDataFolder" not in wix_text or "%LOCALAPPDATA%\\vless-eevee" not in wix_text:
    fail("Windows worker must keep writable configuration outside the install directory")

mac_text = scripts[1].read_text()
if "LaunchDaemons/com.vless.eevee.worker.plist" not in mac_text:
    fail("macOS package is missing LaunchDaemon")
if "NativeMessagingHosts" not in mac_text:
    fail("macOS package is missing Native Messaging registration")
if ".crx" in mac_text.lower():
    fail("macOS package must not build or bundle a CRX")
if "trayapp" not in mac_text or "LaunchAgents" not in mac_text or "com.vless.eevee.tray.plist" not in mac_text:
    fail("macOS package is missing the tray app")
if 'OUTPUT="$REPO_ROOT/dist/vless-eevee.v${VERSION}.macos.${PACKAGE_ARCH}.pkg"' not in mac_text:
    fail("macOS package output must include its version and architecture")

windows_text = scripts[2].read_text()
if '$OutputPath = Join-Path $OutputDir "vless-eevee.v$Version.windows.x64.msi"' not in windows_text:
    fail("Windows package output must include its version and architecture")
if ".crx" in windows_text.lower():
    fail("Windows package must not build or bundle a CRX")

workflow = (ROOT / ".github/workflows/build-installers.yml").read_text()
if ".crx" in workflow.lower() or "vless-eevee-updates.xml" in workflow:
    fail("release workflow must not build or publish CRX assets")
for expected in (
    'target="dist/vless-eevee.${TAG}.linux.${architecture}.deb"',
    'target="dist/vless-eevee.${TAG}.windows.x64.msi"',
    'if tag != f"v{version}":',
):
    if expected not in workflow:
        fail(f"release workflow is missing versioned asset behavior: {expected}")
if (ROOT / "helper/packaging/build-extension-crx.sh").exists():
    fail("obsolete CRX packaging script must be removed")

readme = (ROOT / "README.md").read_text()
if "На **Linux**, **Windows** и **macOS** расширение устанавливается из ZIP:" not in readme:
    fail("README must document unpacked extension installation for Linux")
if ".crx" in readme.lower():
    fail("README must no longer describe CRX installation or updates")

tray_main = ROOT / "helper/trayapp/main.go"
about_icon = ROOT / "helper/trayapp/assets/about.png"
if not about_icon.is_file() or "go:embed assets/about.png" not in tray_main.read_text():
    fail("tray app is missing its embedded About window icon")
if 'AddMenuItem("О программе"' not in tray_main.read_text():
    fail("tray menu is missing the About item")

print("Packaging integration checks passed")
