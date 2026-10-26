#!/usr/bin/env python3
"""Plan or sequentially cross-build Present CLI releases from macOS.

Defaults to a read-only plan. Pass --build after source/tests are frozen. Reuses
the repository's single target directory; never uploads or publishes anything.
Package the resulting binaries separately with package-cli-release.py.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_cli_release", ROOT / "scripts/package-cli-release.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
TARGET = ROOT / "target"


def build_command(target):
    triple = package.TARGETS[target]
    if target.startswith("linux-"):
        command = ["cargo", "zigbuild"]
        cargo_target = triple + ".2.28" if triple.endswith("gnu") else triple
    elif target.startswith("windows-"):
        command = ["cargo", "xwin", "build"]
        cargo_target = triple
    else:
        command = ["cargo", "build"]
        cargo_target = None if target == package.native_target() else triple
    command += ["--locked", "--release", "-p", "present-cli", "--bin", "present", "--jobs", "4", "--target-dir", str(TARGET)]
    if cargo_target:
        command += ["--target", cargo_target]
    directory = TARGET / triple if cargo_target else TARGET
    return command, directory / "release" / package.binary_name(target), directory


def tool(name, fallback=None):
    found = shutil.which(name)
    if not found and fallback and Path(fallback).is_file():
        found = str(fallback)
    if not found:
        raise ValueError(f"Required compiler tool unavailable: {name}")
    return found


def native_smoke(binary, target, version):
    if target != package.native_target():
        return {"status": "not-run", "reason": "Requires exact-package target validator"}
    with tempfile.TemporaryDirectory(prefix="present-cli-smoke-") as home:
        env = os.environ.copy()
        env["SILICON_HOME"] = home
        for key in ("PRESENT_API_URL", "PRESENT_ACCOUNTS_URL", "ACCOUNTS_URL"):
            env.pop(key, None)
        result = package.run([str(binary), "--version"], env=env, capture_output=True, text=True)
        if result.stdout.strip() != f"present {version}":
            raise ValueError(f"Unexpected native CLI version: {result.stdout.strip()}")
        package.run([str(binary), "--help"], env=env, stdout=subprocess.DEVNULL)
        package.run([str(binary), "docs", "layers"], env=env, stdout=subprocess.DEVNULL)
        package.run([str(binary), "accounts", "--json"], env=env, stdout=subprocess.DEVNULL)
        if list(Path(home).iterdir()):
            raise ValueError("Read-only CLI smoke unexpectedly wrote into the fresh home")
    return {"status": "passed", "commands": ["--version", "--help", "docs layers", "accounts --json"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--target", action="append", choices=package.TARGETS)
    parser.add_argument("--binaries-dir", type=Path)
    parser.add_argument("--prune-new-target-cache", action="store_true", help="After staging, remove only cross-target caches absent at the start of this invocation")
    parser.add_argument("--min-free-mib", type=int, default=768)
    args = parser.parse_args()
    targets = args.target or list(package.REQUIRED)
    if len(targets) != len(set(targets)):
        parser.error("Duplicate targets are not allowed")
    if args.min_free_mib < 512:
        parser.error("--min-free-mib must be at least 512")
    version, fingerprint = package.cli_version(), package.source_fingerprint()
    output = (args.binaries_dir or ROOT / ".dev/production" / f"cli-builds-{version}").resolve()
    installed = set(subprocess.check_output(["rustup", "target", "list", "--installed"], text=True).splitlines())
    for target in targets:
        if package.TARGETS[target] not in installed:
            raise ValueError(f"Install Rust target first: {package.TARGETS[target]}")
    if platform.system() != "Darwin":
        raise ValueError("This local cross-build workflow requires macOS/Xcode")
    tools = []
    zig = None
    if any(t.startswith("linux-") for t in targets):
        tool("cargo-zigbuild")
        zig = shutil.which("zig") or tool("python-zig")
    if any(t.startswith("windows-") for t in targets):
        tool("cargo-xwin")
        tools += [str(Path(tool(name, f"/opt/homebrew/opt/{family}/bin/{name}")).parent)
                  for name, family in (("clang-cl", "llvm"), ("llvm-lib", "llvm"), ("llvm-ar", "llvm"), ("lld-link", "lld"))]
    stripper = tool("llvm-strip", "/opt/homebrew/opt/llvm/bin/llvm-strip")
    plan = {"version": version, "sourceFingerprint": fingerprint, "freeBytes": shutil.disk_usage(ROOT).free,
            "binariesDirectory": str(output), "targetDirectory": str(TARGET), "targets": []}
    for target in targets:
        command, binary, cache = build_command(target)
        plan["targets"].append({"target": target, "command": command, "binary": str(binary), "cacheAlreadyExists": cache.exists()})
    print(json.dumps(plan, indent=2), flush=True)
    if not args.build:
        return
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="present-cli-tools-") as temporary:
        if zig:
            (Path(temporary) / "zig").symlink_to(Path(zig).resolve())
        env = os.environ.copy()
        env.update(CARGO_TARGET_DIR=str(TARGET), CARGO_BUILD_JOBS="4", CARGO_INCREMENTAL="0", CARGO_PROFILE_RELEASE_DEBUG="0")
        env["PATH"] = os.pathsep.join([temporary, *dict.fromkeys(tools), env.get("PATH", "")])
        for target, item in zip(targets, plan["targets"]):
            if package.source_fingerprint() != fingerprint:
                raise ValueError("CLI source changed; freeze it and restart the build")
            if shutil.disk_usage(ROOT).free < args.min_free_mib * 1024 * 1024:
                raise ValueError("Insufficient free disk; coordinate cleanup before continuing")
            destination = output / target
            if destination.exists():
                raise ValueError(f"Refusing to overwrite a staged build: {destination}")
            target_env = env.copy()
            if target.startswith("windows-"):
                if target_env.get("CARGO_ENCODED_RUSTFLAGS"):
                    raise ValueError("Unset CARGO_ENCODED_RUSTFLAGS before the Windows static-CRT build")
                target_env["RUSTFLAGS"] = (target_env.get("RUSTFLAGS", "") + " -C target-feature=+crt-static").strip()
            package.run(item["command"], cwd=ROOT, env=target_env)
            if package.source_fingerprint() != fingerprint:
                raise ValueError("CLI source changed during compilation; refusing to stage the result")
            source = Path(item["binary"])
            package.verify_binary(source, target)
            destination.mkdir()
            binary = destination / source.name
            shutil.copyfile(source, binary)
            binary.chmod(0o755)
            # Strip only the staged copy, retaining reusable Cargo build outputs.
            package.run([stripper, "--strip-debug", str(binary)])
            if target.startswith("macos-"):
                # Changing Mach-O bytes invalidates the linker ad-hoc signature.
                package.run(["codesign", "--force", "--sign", "-", str(binary)])
            package.verify_binary(binary, target)
            smoke = native_smoke(binary, target, version)
            receipt = {"version": version, "target": target, "triple": package.TARGETS[target],
                       "sourceFingerprint": fingerprint, "binarySha256": package.sha256(binary),
                       "binaryBytes": binary.stat().st_size, "buildCommand": item["command"],
                       "builtAt": datetime.now(timezone.utc).isoformat(), "nativeSmoke": smoke,
                       "windowsStaticCrt": target.startswith("windows-"),
                       "awsLcPrebuiltNasm": target.startswith("windows-") and not shutil.which("nasm", path=target_env["PATH"]),
                       "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip()}
            receipt["buildEnvironment"] = {key: target_env[key] for key in
                ("CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "CARGO_INCREMENTAL", "CARGO_PROFILE_RELEASE_DEBUG", "RUSTFLAGS", "AWS_LC_SYS_PREBUILT_NASM")
                if key in target_env}
            if receipt["awsLcPrebuiltNasm"]:
                dependency = next(p for p in tomllib.loads((ROOT / "Cargo.lock").read_text())["package"] if p["name"] == "aws-lc-sys")
                receipt["prebuiltNasmProvenance"] = {"crate": dependency["name"], "version": dependency["version"],
                    "crateChecksum": dependency["checksum"], "source": dependency["source"],
                    "activation": "AWS_LC_SYS_PREBUILT_NASM=1" if target_env.get("AWS_LC_SYS_PREBUILT_NASM") == "1" else "aws-lc-sys/prebuilt-nasm Cargo feature (enabled by rustls)",
                    "documentation": "Packaged crate README.md: Use of prebuilt NASM objects",
                    "objects": "builder/prebuilt-nasm (distributed in the checksummed crate)"}
            (destination / "build.json").write_text(json.dumps(receipt, indent=2) + "\n")
            if args.prune_new_target_cache and not item["cacheAlreadyExists"]:
                cache = TARGET / package.TARGETS[target]
                if cache.is_symlink() or cache.parent != TARGET or cache.resolve().parent != TARGET.resolve():
                    raise ValueError(f"Unsafe cache path: {cache}")
                print(f"Removing newly created, staged target cache: {cache}", flush=True)
                shutil.rmtree(cache)
    print(f"Verified staged binaries: {output}")


if __name__ == "__main__":
    main()
