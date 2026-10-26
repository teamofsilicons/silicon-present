#!/bin/bash
# Run only inside a disposable Ubuntu 24.04 container. Source files are mounted
# at /opt/test, and renderer/test/fixtures/rich.pptx at /opt/fixture/rich.pptx.
set -euo pipefail
test -f /.dockerenv
test "$(id -u)" = 0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 sudo bubblewrap util-linux libreoffice-impress fonts-dejavu-core
id present-converter >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin present-converter
install -d -o root -g root -m 0755 /usr/local/libexec /var/lib/present-converter /etc/present
install -d -o present-converter -g present-converter -m 0700 /var/lib/present-converter/tmp
install -o root -g root -m 0755 /opt/test/soffice-sandbox.py /usr/local/libexec/present-soffice-sandbox
install -o root -g root -m 0755 /opt/test/soffice-sandbox /usr/local/bin/present-soffice
visudo -cf /opt/test/soffice-sandbox.sudoers
install -o root -g root -m 0440 /opt/test/soffice-sandbox.sudoers /etc/sudoers.d/present-soffice
printf 'sandbox-test-only\n' > /etc/present/secret.env
python3 -m http.server 4321 --bind 127.0.0.1 >/tmp/host-server.log 2>&1 &
host_server=$!
trap 'kill "$host_server" 2>/dev/null || true' EXIT
runuser -u present-converter -- env PRESENT_APP_SECRET=sandbox-test-only /usr/local/bin/present-soffice --self-check
base=/var/lib/present-converter/tmp/silicon-present-converter-123
install -d -o present-converter -g present-converter -m 0700 "$base" "$base/job-test-1"
install -o present-converter -g present-converter -m 0600 /opt/fixture/rich.pptx "$base/job-test-1/in.pptx"
runuser -u present-converter -- /usr/local/bin/present-soffice \
  "-env:UserInstallation=file://$base/lo-profile" \
  --headless --norestore --nologo --nodefault --nolockcheck \
  --convert-to odp --outdir "$base/job-test-1" "$base/job-test-1/in.pptx"
python3 - "$base/job-test-1/in.odp" <<'PY'
import pathlib, pwd, sys, zipfile
p = pathlib.Path(sys.argv[1])
assert p.stat().st_uid == pwd.getpwnam("present-converter").pw_uid
with zipfile.ZipFile(p) as z:
    assert z.read("mimetype") == b"application/vnd.oasis.opendocument.presentation"
    assert b"office:presentation" in z.read("content.xml")
print("PASS: real LibreOffice conversion produced a converter-owned, valid ODP")
PY
# A caller-controlled option and a path escape never reach LibreOffice.
if runuser -u present-converter -- /usr/local/bin/present-soffice --accept=socket; then
  echo 'FAIL: arbitrary argument accepted' >&2; exit 1
fi
if runuser -u present-converter -- /usr/local/bin/present-soffice \
  "-env:UserInstallation=file://$base/lo-profile" \
  --headless --norestore --nologo --nodefault --nolockcheck \
  --convert-to odp --outdir "$base/job-test-1" /etc/present/secret.env; then
  echo 'FAIL: path escape accepted' >&2; exit 1
fi
echo 'PASS: sandbox self-check, real conversion, and refused inputs'
