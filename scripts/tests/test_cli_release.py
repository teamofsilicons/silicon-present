import importlib.util
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load("package-cli-release")
build = load("build-cli-release")


def native_bytes(target):
    data = bytearray(512)
    if target.startswith("linux-"):
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, 183 if target.endswith("aarch64") else 62)
    elif target.startswith("macos-"):
        data[:4] = b"\xcf\xfa\xed\xfe"
        struct.pack_into("<I", data, 4, 0x0100000C if target.endswith("aarch64") else 0x01000007)
    else:
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 60, 128)
        data[128:132] = b"PE\0\0"
        struct.pack_into("<H", data, 132, 0x8664)
    return bytes(data)


class CliReleaseTests(unittest.TestCase):
    def test_native_architecture_rejects_each_other_platform_and_scripts(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "present"
            for target in package.TARGETS:
                binary.write_bytes(native_bytes(target))
                package.verify_binary(binary, target)
                for wrong in package.TARGETS:
                    if target != wrong:
                        with self.assertRaises(ValueError):
                            package.verify_binary(binary, wrong)
            for invalid in (b"#!/bin/sh\n", b"MZ", b"\x7fELF", b"MZ" + b"\xff" * 70):
                binary.write_bytes(invalid)
                with self.assertRaises(ValueError):
                    package.verify_binary(binary, "windows-x86_64")

    def test_staged_receipts_reject_different_source_version_and_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            target = "windows-x86_64"
            binary = source / "present.exe"
            binary.write_bytes(native_bytes(target))
            receipt = {"target": target, "triple": package.TARGETS[target], "version": "0.1.1",
                       "sourceFingerprint": "frozen", "binarySha256": package.sha256(binary)}
            path = source / "build.json"
            path.write_text(json.dumps(receipt))
            package.check_build(source, target, "0.1.1", "frozen")
            for key, wrong in (("version", "0.1.0"), ("sourceFingerprint", "old"), ("binarySha256", "old")):
                path.write_text(json.dumps({**receipt, key: wrong}))
                with self.assertRaisesRegex(ValueError, key):
                    package.check_build(source, target, "0.1.1", "frozen")

    def test_fingerprint_includes_untracked_source_and_embedded_docs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("Cargo.toml", "Cargo.lock", "crates/present-cli/src/main.rs",
                         "crates/present-cli/docs/layers.md", "crates/silicon-present-client/src/lib.rs"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("initial")
            before = package.source_fingerprint(root)
            (root / "crates/present-cli/docs/layers.md").write_text("new docs")
            after = package.source_fingerprint(root)
            self.assertNotEqual(before, after)
            (root / "crates/silicon-present-client/src/new.rs").write_text("new source")
            self.assertNotEqual(after, package.source_fingerprint(root))

    def test_archive_is_exact_manifest_and_executable_with_no_extra_files_or_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / "present"
            binary.write_bytes(native_bytes("linux-x86_64"))
            manifest = "manifest\n"
            archive = root / "package.tar.gz"

            def write(extra=None, binary_data=None):
                with tarfile.open(archive, "w:gz") as tar:
                    for name, data in (("apps.yaml", manifest.encode()), ("bin/present", binary_data or binary.read_bytes())):
                        member = tarfile.TarInfo(name)
                        member.size = len(data)
                        tar.addfile(member, io.BytesIO(data))
                    if extra:
                        member = tarfile.TarInfo(extra)
                        member.type = tarfile.SYMTYPE if extra == "link" else tarfile.REGTYPE
                        member.linkname = "/etc/passwd" if extra == "link" else ""
                        tar.addfile(member, io.BytesIO(b""))
            write()
            package.verify_archive(archive, "linux-x86_64", package.sha256(binary), manifest)
            for extra in ("state.json", "link", "bin/present"):
                write(extra=extra)
                with self.assertRaises(ValueError):
                    package.verify_archive(archive, "linux-x86_64", package.sha256(binary), manifest)
            write(binary_data=b"changed executable")
            with self.assertRaisesRegex(ValueError, "executable differs"):
                package.verify_archive(archive, "linux-x86_64", package.sha256(binary), manifest)

    def test_builds_reuse_one_target_directory_and_select_real_cross_compilers(self):
        with patch.object(build.package, "native_target", return_value="macos-aarch64"):
            for target in package.REQUIRED:
                command, binary, directory = build.build_command(target)
                self.assertEqual(command[command.index("--target-dir") + 1], str(ROOT / "target"))
                self.assertIn("--locked", command)
                self.assertEqual(command[command.index("--jobs") + 1], "4")
                if target == "macos-aarch64":
                    self.assertNotIn("--target", command)
                    self.assertEqual(binary, ROOT / "target/release/present")
                elif target.startswith("linux"):
                    self.assertEqual(command[:2], ["cargo", "zigbuild"])
                    self.assertEqual(directory, ROOT / "target" / package.TARGETS[target])
                else:
                    self.assertEqual(command[:3], ["cargo", "xwin", "build"])
                    self.assertEqual(binary.suffix, ".exe")


if __name__ == "__main__":
    unittest.main()
