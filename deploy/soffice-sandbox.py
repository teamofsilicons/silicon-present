#!/usr/bin/python3 -I
"""Fixed-purpose, root-owned LibreOffice sandbox; see soffice-sandbox.md."""

import os
from pathlib import Path
import pwd
import re
import stat
import sys

ACCOUNT = "present-converter"
TEMP = Path("/var/lib/present-converter/tmp")
FLAGS = ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck"]
PDF_ALL = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"},"ExportNotesPages":{"type":"boolean","value":"false"}}'
FORMATS = {"pptx", "ppt", "odp", "pdf", PDF_ALL}
ENV = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "HOME": "/tmp",
    "TMPDIR": "/tmp",
    "USER": ACCOUNT,
    "LOGNAME": ACCOUNT,
}


class Refused(ValueError):
    pass


def relative_path(value, root=TEMP):
    """Reject aliases, options, escapes and non-canonical path components."""
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise Refused("invalid temporary path")
    path = Path(value)
    if not path.is_absolute() or str(path) != value or ".." in path.parts:
        raise Refused("temporary paths must be canonical absolute paths")
    try:
        rel = path.relative_to(root)
    except ValueError as error:
        raise Refused("paths must stay inside the converter temporary directory") from error
    if not rel.parts or not re.fullmatch(r"silicon-present-converter-[1-9][0-9]*", rel.parts[0]):
        raise Refused("expected a converter process directory")
    return path, rel


def validate_arguments(arguments, root=TEMP):
    if arguments == ["--self-check"]:
        return None
    if len(arguments) != 11 or not arguments[0].startswith("-env:UserInstallation=file://"):
        raise Refused("expected the fixed headless conversion arguments")
    if arguments[1:6] != FLAGS or arguments[6] != "--convert-to" or arguments[8] != "--outdir":
        raise Refused("unsupported LibreOffice arguments")
    if arguments[7] not in FORMATS:
        raise Refused("unsupported output format or filter")
    profile, profile_rel = relative_path(arguments[0].removeprefix("-env:UserInstallation=file://"), root)
    output, output_rel = relative_path(arguments[9], root)
    source, source_rel = relative_path(arguments[10], root)
    if len(profile_rel.parts) != 2 or profile_rel.parts[1] != "lo-profile":
        raise Refused("unexpected LibreOffice profile path")
    if len(source_rel.parts) < 3 or not re.fullmatch(r"job-[a-z0-9]+-[1-9][0-9]*", source_rel.parts[1]):
        raise Refused("expected an input file in a converter job directory")
    if len(output_rel.parts) < 2 or source_rel.parts[:2] != output_rel.parts[:2]:
        raise Refused("input and output must belong to the same job")
    if profile_rel.parts[0] != source_rel.parts[0]:
        raise Refused("profile and input must belong to the same converter")
    return profile, output, source


def validate_directories(uid, paths, root=TEMP):
    # The fixed bind source cannot be replaced by the converter while root is
    # preparing mounts. Its parent and every ancestor are root-owned and immutable
    # to other accounts. No root operation writes within the writable bind.
    for path in [root.parent, *root.parent.parents]:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Refused("converter temporary directory has an unsafe parent")
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise Refused("converter temporary directory must be owned by the converter with mode 0700")
    if paths is None:
        return
    profile, output, source = paths
    for path in paths:
        current = root
        for part in path.relative_to(root).parts:
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                if current == profile:
                    break  # LibreOffice creates this directory on its first run.
                raise Refused("input or output directory does not exist") from None
            if stat.S_ISLNK(info.st_mode) or info.st_uid != uid:
                raise Refused("temporary paths must be converter-owned and contain no symlinks")
            if current != source and not stat.S_ISDIR(info.st_mode):
                raise Refused("expected a temporary directory")
    if not stat.S_ISREG(source.lstat().st_mode) or source.lstat().st_nlink != 1:
        raise Refused("input must be a regular file with one link")
    if not output.is_dir():
        raise Refused("output must be an existing directory")


SELF_CHECK = r'''
import fcntl, json, os, pathlib, socket, struct
expected = int(__import__("sys").argv[1])
host_network = int(__import__("sys").argv[2])
assert os.getuid() == expected and os.geteuid() == expected and expected != 0
assert os.getgroups() == []
status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines())
for name in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]:
    assert int(status[name].strip(), 16) == 0, name
assert status["NoNewPrivs"].strip() == "1"
for path in ["/etc/present", "/opt/present", "/root", "/home", "/run", "/var/lib/present", "/etc/shadow"]:
    assert not pathlib.Path(path).exists(), path
allowed = {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "USER", "LOGNAME", "PWD"}
assert set(os.environ).issubset(allowed), "unexpected environment variable"
assert os.stat("/proc/self/ns/net").st_ino != host_network, "host network namespace retained"
# Some kernels create inactive GRE/IP tunnel devices in every new namespace.
# They have no addresses/routes and cannot be enabled with zero capabilities.
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
    for _, name in socket.if_nameindex():
        flags = struct.unpack_from("H", fcntl.ioctl(probe.fileno(), 0x8913, struct.pack("256s", name.encode())), 16)[0]
        assert name == "lo" or not (flags & 1), "active non-loopback interface"
for address in [("127.0.0.1", 4321), ("169.254.169.254", 80), ("1.1.1.1", 80)]:
    try:
        connection = socket.create_connection(address, timeout=0.3)
    except OSError:
        pass
    else:
        connection.close()
        raise AssertionError("network unexpectedly reachable")
assert len(pathlib.Path("/proc/net/route").read_text().splitlines()) == 1
print(json.dumps({"ok": True, "uid": os.getuid(), "capabilities": "none", "network": "isolated", "host_secrets": "not_mounted", "environment": "allowlist"}))
'''


def command(uid, gid, arguments):
    # Do not use --uid under a root-created user namespace: that would map the
    # sandbox uid to host root. Keep host UID identities and drop them with
    # setpriv inside the mount/network/PID namespaces before parsing any document.
    cmd = [
        "/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "230s",
        "/usr/bin/bwrap", "--die-with-parent", "--new-session",
        "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        "--cap-drop", "ALL", "--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID",
        "--cap-add", "CAP_SETPCAP", "--clearenv",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib",
    ]
    # Ubuntu's hardened bubblewrap creates implicit parents with mode 0700.
    # These explicit mountpoints contain only the allowlisted public runtime
    # files and must remain traversable after setpriv drops the host root UID.
    for path in ["/etc", "/var", "/var/cache", "/var/lib", "/var/lib/present-converter"]:
        cmd += ["--perms", "0755", "--dir", path]
    if Path("/lib64").exists():
        cmd += ["--symlink", "usr/lib64", "/lib64"]
    for path in ["/etc/ld.so.cache", "/etc/fonts", "/etc/libreoffice", "/etc/alternatives", "/var/cache/fontconfig"]:
        if Path(path).exists():
            cmd += ["--ro-bind", path, path]
    cmd += [
        "--proc", "/proc", "--dev", "/dev", "--perms", "1777", "--tmpfs", "/tmp",
        "--bind", str(TEMP), str(TEMP), "--chdir", "/tmp",
    ]
    for key, value in ENV.items():
        cmd += ["--setenv", key, value]
    cmd += [
        "--", "/usr/bin/setpriv", f"--reuid={uid}", f"--regid={gid}", "--clear-groups",
        "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", "--",
    ]
    if arguments == ["--self-check"]:
        cmd += ["/usr/bin/python3", "-I", "-c", SELF_CHECK, str(uid), str(os.stat("/proc/self/ns/net").st_ino)]
    else:
        cmd += ["/usr/bin/soffice", *arguments]
    return cmd


def main():
    if sys.platform != "linux":
        raise Refused("this launcher requires Linux")
    arguments = sys.argv[1:]
    paths = validate_arguments(arguments)
    account = pwd.getpwnam(ACCOUNT)
    if os.geteuid() != 0:
        raise Refused("use the installed present-soffice launcher")
    if account.pw_uid == 0 or (os.environ.get("SUDO_USER") not in (None, ACCOUNT)):
        raise Refused("unexpected invoking account")
    validate_directories(account.pw_uid, paths)
    # Bubblewrap creates parent mountpoints before dropping privileges. They
    # must be traversable by the parser; writable job data remains under the
    # converter-owned 0700 bind root.
    os.umask(0o022)
    os.chdir("/")
    # Do not let an inherited descriptor expose a service socket, directory or
    # secret to either namespace setup or the document parser.
    for entry in Path("/proc/self/fd").iterdir():
        fd = int(entry.name)
        if fd > 2:
            try:
                os.close(fd)
            except OSError:
                pass
    cmd = command(account.pw_uid, account.pw_gid, arguments)
    os.execve(cmd[0], cmd, ENV)


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, KeyError) as error:
        print(f"LibreOffice sandbox refused to start: {error}", file=sys.stderr)
        sys.exit(126)
