# LibreOffice isolation on Ubuntu 24.04

Set `SOFFICE_PATH=/usr/local/bin/present-soffice`. The launcher preserves the converter's existing argument interface;
no renderer changes are required. `CONVERTER_TMP` must be `/var/lib/present-converter/tmp`.

Install `python3`, `sudo`, `bubblewrap`, `util-linux`, LibreOffice Impress, Poppler, and the required fonts. Install
`soffice-sandbox` as `/usr/local/bin/present-soffice` and `soffice-sandbox.py` as
`/usr/local/libexec/present-soffice-sandbox`, both **root:root, mode 0755**. Validate `soffice-sandbox.sudoers` with
`visudo -cf` before installing it as `/etc/sudoers.d/present-soffice`, root:root, mode 0440. Never install the privileged
helper into a directory the converter can write.

`/var/lib/present-converter` and every ancestor must be root-owned and not writable by group or others; use mode 0755.
Its `tmp` child must be present-converter:present-converter, mode 0700. A converter-writable parent is refused because
it would allow the fixed bind source to be replaced during namespace setup.

The helper permits only the exact headless conversion arguments used by `renderer/src/office.ts`, the five existing
output/filter forms, and canonical converter profile/job paths. Existing path components must be converter-owned
and contain no symbolic links; the source must be a regular file with one link. It performs no privileged writes in
the converter's writable tree. The only writable host bind is that fixed temporary tree, so a later path replacement
cannot expose any host path outside the sandbox.

The root helper creates private network, PID, IPC, UTS and mount namespaces through bubblewrap. The sandbox contains
read-only system programs/libraries, font and LibreOffice configuration, a private `/proc`, minimal `/dev`, a new
temporary `/tmp`, and the converter temporary tree. It does not mount `/etc/present`, `/opt/present`, home directories,
host `/run`, or service data. It closes inherited descriptors above stderr and replaces the environment with a fixed
allowlist. `setpriv` then changes to the converter's **host UID/GID**, clears supplementary groups and every capability
set, and sets `no_new_privs` before invoking LibreOffice. There is no network route, including to localhost services,
private infrastructure, public internet or instance metadata. External media must already have been fetched by the
converter's checked transport before a native conversion.

The helper deliberately does **not** use a user namespace: mapping a different sandbox UID when launching bubblewrap
as root would still map it to host root. It uses privileged namespace setup followed by an actual UID/GID drop. This
also avoids changing Ubuntu's AppArmor or unprivileged-user-namespace policy. See the
[Ubuntu bubblewrap manual](https://manpages.ubuntu.com/manpages/noble/man1/bwrap.1.html) for namespace and mount flags.

The converter systemd unit must permit the narrow sudo elevation: `NoNewPrivileges=false`, and its capability bounding
set must retain `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_SETUID`, `CAP_SETGID`, `CAP_SETPCAP` and the normal root setup capabilities needed
by sudo/bubblewrap. Do not apply a syscall/namespace filter that denies the helper's namespace setup. The native
parser itself has zero capabilities and `NoNewPrivs=1`; verify this with the check below. Keep the converter under its
separate account with no service/web secrets in its environment. The wrapper imposes a 230-second deadline plus a
five-second kill grace; bubblewrap also binds the sandbox lifetime to its parent. There is no unsandboxed fallback.

## Checks

Local, cross-platform validation:

```sh
python3 deploy/soffice-sandbox.test.py
bash -n deploy/soffice-sandbox.integration.sh
sh -n deploy/soffice-sandbox
```

After installation on Linux, run this as the deployment operator:

```sh
sudo -u present-converter /usr/local/bin/present-soffice --self-check
```

It uses the same namespace, mount, environment and privilege settings as LibreOffice, then asserts nonroot host UID,
zero capabilities/groups, `no_new_privs`, inaccessible host secret locations, only allowlisted environment variables,
a different network namespace with no active non-loopback interface, no route, and failed connections to host localhost,
metadata and public internet. Inactive kernel-created tunnel devices are allowed; the parser has no capability to enable them.
The only successful result is JSON containing `"ok": true`; a failure must block converter activation.

`soffice-sandbox.integration.sh` is restricted to disposable Docker containers. It installs the helper and its runtime,
starts a localhost server outside the sandbox, creates a fake `/etc/present` secret, injects a fake secret environment
variable, runs the self-check, and performs a real PPTX-to-ODP conversion. It checks ZIP structure and output ownership,
and rejects arbitrary options and path escapes. It never requires a production credential:

```sh
docker run --rm --cap-add=SYS_ADMIN --cap-add=NET_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --mount type=bind,source="$PWD/deploy",target=/opt/test,readonly \
  --mount type=bind,source="$PWD/renderer/test/fixtures/rich.pptx",target=/opt/fixture/rich.pptx,readonly \
  ubuntu:24.04 bash /opt/test/soffice-sandbox.integration.sh
```

The Docker capability settings are for this disposable test container; they are not instructions to weaken the host's
global security policy. Follow the self-check with authenticated real-format import/export checks on the deployed
converter, because namespace success alone does not establish document fidelity.
