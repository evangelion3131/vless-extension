#!/usr/bin/env python3
import json
import pathlib
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
if "vless-eevee.crx" not in linux_text:
    fail("Linux package does not include extension CRX")

postinst = (ROOT / "helper/packaging/linux/postinst").read_text()
prerm = (ROOT / "helper/packaging/linux/prerm").read_text()
if "vless-eevee-worker.service" not in postinst:
    fail("Linux post-install does not start Worker")
if "disable --now vless-eevee-worker.service" not in prerm:
    fail("Linux removal does not stop Worker")

wix = ROOT / "helper/packaging/windows/vless-eevee.wxs"
try:
    ET.parse(wix)
except Exception as exc:
    fail(f"WiX XML is invalid: {exc}")
wix_text = wix.read_text()
for required in ("vless-eevee.crx", "StartWorker", "StopWorker", HOST_NAME):
    if required not in wix_text:
        fail(f"WiX package is missing {required}")

mac_text = scripts[1].read_text()
if "LaunchDaemons/com.vless.eevee.worker.plist" not in mac_text:
    fail("macOS package is missing LaunchDaemon")
if "NativeMessagingHosts" not in mac_text:
    fail("macOS package is missing Native Messaging registration")
if "vless-eevee.crx" not in mac_text:
    fail("macOS package is missing extension CRX")

print("Packaging integration checks passed")
