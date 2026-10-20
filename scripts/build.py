"""构建普通用户权限的 Windows 安装包，只打包本项目自己的代码和资源。"""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent.parent
from bundle import bundle, MODULES

VERSION = json.loads((ROOT / "package.json").read_text("utf-8"))["version"]
ICON = ROOT / "assets/codex-token.ico"
FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def digest(file):
    """流式计算文件摘要，用于安装载荷校验和构建来源追踪。"""
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def compile_cs(source, output, extra=()):
    """使用 Windows 自带的 .NET Framework 编译器；不安装额外工具链。"""
    compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    command = [
        str(compiler),
        "/nologo",
        "/codepage:65001",
        "/optimize+",
        "/target:winexe",
        "/out:" + str(output),
        "/win32manifest:" + str(ROOT / "packaging/windows/app.manifest"),
        "/win32icon:" + str(ICON),
        "/r:System.Web.Extensions.dll",
        "/r:System.Windows.Forms.dll",
        "/r:System.IO.Compression.dll",
        "/r:System.IO.Compression.FileSystem.dll",
    ]
    command += list(extra) + [str(source)]
    subprocess.run(command, check=True, creationflags=FLAGS)


def main():
    """按依赖顺序生成 JS、辅助程序、载荷清单、安装器和 SHA-256 文件。"""
    if os.name != "nt":
        raise RuntimeError("Windows is required to build the installer.")
    if len(sys.argv) != 1:
        raise ValueError("The universal installer has no version-specific build options.")
    work = ROOT / ".artifacts/build" / uuid.uuid4().hex
    payload = work / "payload"
    payload.mkdir(parents=True)
    script = payload / "runtime.js"
    script.write_text(
        bundle({"compatibilityMode": "auto", "origin": "app://-", "releaseVersion": VERSION}),
        "utf-8",
    )
    subprocess.run(["node", "--check", str(script)], check=True, creationflags=FLAGS)
    (payload / "Manage.ps1").write_text(
        (ROOT / "packaging/windows/Manage.ps1").read_text("utf-8-sig"), "utf-8-sig"
    )
    (payload / "README.txt").write_text(
        (ROOT / "packaging/windows/README.txt").read_text("utf-8"), "utf-8-sig"
    )
    shutil.copyfile(ROOT / "LICENSE", payload / "LICENSE.txt")
    shutil.copyfile(ICON, payload / "CodexToken.ico")
    compile_cs(
        ROOT / "packaging/windows/Runtime.cs",
        payload / "CodexToken.Runtime.exe",
        [str(ROOT / "packaging/windows/UsageLogReader.cs")],
    )
    manifest = {
        "applicationId": "org.codextoken.cdp",
        "schemaVersion": 6,
        "mode": "cdp-runtime",
        "releaseVersion": VERSION,
        "compatibilityMode": "auto",
        "payloadFiles": {p.name: digest(p) for p in payload.iterdir() if p.is_file()},
    }
    (payload / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=True, separators=(",", ":")), "utf-8"
    )
    package = work / "payload.zip"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for file in sorted(payload.iterdir()):
            output.write(file, file.name)
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    installer = dist / "CodexToken-Setup-win-x64.exe"
    compile_cs(
        ROOT / "packaging/windows/Setup.cs", installer, ["/resource:" + str(package) + ",Payload"]
    )
    installer.with_suffix(installer.suffix + ".sha256").write_text(
        digest(installer) + "  " + installer.name + "\n", "ascii"
    )
    source_files = MODULES + [
        "package.json",
        "LICENSE",
        "scripts/build.py",
        "scripts/bundle.py",
        "packaging/windows/Runtime.cs",
        "packaging/windows/UsageLogReader.cs",
        "packaging/windows/Setup.cs",
        "packaging/windows/Manage.ps1",
        "packaging/windows/app.manifest",
        "packaging/windows/README.txt",
        "assets/codex-token.svg",
        "assets/codex-token.ico",
        "scripts/build-icon.cjs",
    ]
    icon_bytes = ICON.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", icon_bytes)
    if reserved != 0 or kind != 1 or count != 10:
        raise ValueError("Invalid application icon directory")
    icon_sizes = [icon_bytes[6 + index * 16] or 256 for index in range(count)]
    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "releaseVersion": VERSION,
        "installer": str(installer),
        "installerBytes": installer.stat().st_size,
        "installerSha256": digest(installer),
        "payloadRoot": str(payload),
        "payloadZip": str(package),
        "codexBinariesBundled": False,
        "officialFilesChanged": False,
        "runtimeCopied": False,
        "compatibilityMode": "auto",
        "versionGateEnabled": False,
        "officialFingerprintGateEnabled": False,
        "icon": {
            "source": "assets/codex-token.ico",
            "sha256": digest(ICON),
            "sizes": icon_sizes,
            "installedFile": "CodexToken.ico",
        },
        "sourceSha256": {name: digest(ROOT / name) for name in source_files},
        "fullOfficialHostAcceptance": False,
        "realModelRequests": 0,
    }
    (ROOT / "dist/build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8"
    )
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
