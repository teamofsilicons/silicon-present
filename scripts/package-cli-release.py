#!/usr/bin/env python3
"""Package staged Present CLI builds; never upload, publish, or run a compiler.

Input: <binaries-dir>/<target>/present[.exe] plus build.json from
build-cli-release.py. All four required targets are mandatory by default.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    "macos-aarch64": "aarch64-apple-darwin",
    "linux-aarch64": "aarch64-unknown-linux-gnu",
    "linux-x86_64": "x86_64-unknown-linux-musl",
    "windows-x86_64": "x86_64-pc-windows-msvc",
    "macos-x86_64": "x86_64-apple-darwin",
}
REQUIRED = tuple(target for target in TARGETS if target != "macos-x86_64")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def cli_version(root=ROOT):
    manifest = tomllib.loads((root / "crates/present-cli/Cargo.toml").read_text())
    version = manifest["package"]["version"]
    if isinstance(version, dict):
        version = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]["package"]["version"]
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("CLI release version must be x.y.z")
    return version


def source_fingerprint(root=ROOT):
    """Include embedded docs and untracked source, not only the Git revision."""
    paths = [root / "Cargo.toml", root / "Cargo.lock"]
    for crate in ("present-cli", "silicon-present-client"):
        paths.extend(p for p in (root / "crates" / crate).rglob("*") if p.is_file())
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()


def binary_name(target):
    return "present.exe" if target.startswith("windows-") else "present"


def verify_binary(path, target):
    """Reject scripts and binaries for a different OS or CPU before packaging."""
    if target not in TARGETS:
        raise ValueError(f"Unsupported target: {target}")
    with path.open("rb") as stream:
        data = stream.read(4096)
        arm = target.endswith("aarch64")
        valid = False
        if target.startswith("linux-"):
            valid = (len(data) >= 20 and data[:6] == b"\x7fELF\x02\x01"
                     and struct.unpack_from("<H", data, 18)[0] == (183 if arm else 62))
        elif target.startswith("macos-"):
            valid = (len(data) >= 8 and data[:4] == b"\xcf\xfa\xed\xfe"
                     and struct.unpack_from("<I", data, 4)[0] == (0x0100000C if arm else 0x01000007))
        elif len(data) >= 64 and data[:2] == b"MZ":
            offset = struct.unpack_from("<I", data, 60)[0]
            stream.seek(offset)
            header = stream.read(6)
            valid = len(header) == 6 and header[:4] == b"PE\0\0" and struct.unpack_from("<H", header, 4)[0] == 0x8664
    if not valid:
        raise ValueError(f"Wrong native binary format or architecture for {target}: {path}")


def native_target():
    machine = {"arm64": "aarch64", "AMD64": "x86_64"}.get(platform.machine(), platform.machine())
    family = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(platform.system())
    return f"{family}-{machine}"


def run(command, **kwargs):
    print("+", " ".join(map(str, command)), flush=True)
    return subprocess.run(command, check=True, **kwargs)


def verify_archive(archive, target, binary_hash, manifest):
    expected = {"apps.yaml", f"bin/{binary_name(target)}"}
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        files = [m for m in members if m.isfile()]
        if (len(files) != 2 or {m.name.removeprefix("./") for m in files} != expected
                or any(not (m.isfile() or m.isdir()) for m in members)):
            raise ValueError("Archive must contain only apps.yaml and its native executable")
        for member in files:
            stream = package.extractfile(member)
            if member.name.removeprefix("./") == "apps.yaml":
                if stream.read() != manifest.encode():
                    raise ValueError("Archive manifest differs from staged manifest")
            elif hashlib.file_digest(stream, "sha256").hexdigest() != binary_hash:
                raise ValueError("Archive executable differs from the verified build")


def check_build(source, target, version, fingerprint):
    binary = source / binary_name(target)
    verify_binary(binary, target)
    receipt = json.loads((source / "build.json").read_text())
    expected = {"target": target, "triple": TARGETS[target], "version": version,
                "sourceFingerprint": fingerprint, "binarySha256": sha256(binary)}
    for key, value in expected.items():
        if receipt.get(key) != value:
            raise ValueError(f"Stale or mismatched {target} build receipt: {key}")
    return binary, receipt


def package_target(source, target, output, version, fingerprint, apps):
    binary, build = check_build(source, target, version, fingerprint)
    manifest = (f"schema_version: 1\napp_id: present\nversion: {version}\ncommand: present\n"
                f"targets:\n  {target}:\n    binary: bin/{binary.name}\n")
    archive = output / f"present-{version}-{target}.tar.gz"
    # An early target may already be under validation while other targets build.
    # Reuse its exact immutable bytes only after matching manifest and binary.
    if not archive.exists():
        with tempfile.TemporaryDirectory(prefix="present-cli-package-", dir=output) as temp:
            stage = Path(temp)
            (stage / "bin").mkdir()
            shutil.copyfile(binary, stage / "bin" / binary.name)
            (stage / "bin" / binary.name).chmod(0o755)
            (stage / "apps.yaml").write_text(manifest)
            run([apps, "validate", str(stage)])
            run([apps, "pack", str(stage), "--output", str(archive)])
    verify_archive(archive, target, build["binarySha256"], manifest)
    run([apps, "validate", str(archive)])
    receipt = {**build, "archive": str(archive), "archiveSha256": sha256(archive),
               "archiveBytes": archive.stat().st_size, "validation": "local-package-only"}
    (output / f"{archive.name}.sha256").write_text(f"{receipt['archiveSha256']}  {archive.name}\n")
    if target.startswith("windows-"):
        download = archive.with_name(f"present-{version}-{target}.zip")
        if download.exists():
            with zipfile.ZipFile(download) as package:
                if package.namelist() != [binary.name] or hashlib.sha256(package.read(binary.name)).hexdigest() != build["binarySha256"]:
                    raise ValueError(f"Existing download differs from verified build: {download}")
        else:
            with zipfile.ZipFile(download, "x", compression=zipfile.ZIP_DEFLATED) as package:
                package.write(binary, binary.name)
        receipt.update(downloadArchive=str(download), downloadSha256=sha256(download), downloadBytes=download.stat().st_size)
        download.with_name(download.name + ".sha256").write_text(f"{receipt['downloadSha256']}  {download.name}\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binaries-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target", action="append", choices=TARGETS, help="Explicit partial package set; default requires all four targets")
    parser.add_argument("--apps", default="silicon-apps")
    args = parser.parse_args()
    targets = args.target or list(REQUIRED)
    if len(targets) != len(set(targets)):
        parser.error("Duplicate targets are not allowed")
    version, fingerprint = cli_version(), source_fingerprint()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Validate the entire set before writing the first archive.
    for target in targets:
        check_build(args.binaries_dir / target, target, version, fingerprint)
    if (output / "release-manifest.json").exists():
        raise ValueError("Refusing to overwrite release-manifest.json")
    receipts = [package_target(args.binaries_dir / target, target, output, version, fingerprint, args.apps) for target in targets]
    if source_fingerprint() != fingerprint:
        raise ValueError("CLI source changed while packaging; release is not frozen")
    manifest = {"appId": "present", "version": version, "sourceFingerprint": fingerprint,
                "requiredTargets": list(REQUIRED), "complete": set(REQUIRED).issubset(targets), "targets": receipts}
    (output / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
