#!/bin/bash
# First-boot dependencies only. Runtime secrets and releases belong to install.py.
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run the Present host bootstrap as root.' >&2
  exit 1
fi
. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 24.04 ] || [ "$(dpkg --print-architecture)" != arm64 ]; then
  echo 'This bootstrap requires Ubuntu 24.04 ARM64.' >&2
  exit 1
fi

apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
  ca-certificates curl software-properties-common snapd
add-apt-repository --yes universe
apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
  python3 python3-venv build-essential pkg-config libssl-dev \
  postgresql-16 postgresql-client-16 \
  libreoffice-impress-nogui libreoffice-draw-nogui poppler-utils ffmpeg \
  fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
  fontconfig unzip xz-utils tar gzip bubblewrap \
  libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libnss3 libnspr4 libdbus-1-3 libdrm2 libx11-6 libxcb1 libxcomposite1 \
  libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2

# Ubuntu cloud images ship the snap agent. Install it if the selected image does not.
systemctl enable --now snapd.socket
timeout 300 snap wait system seed.loaded
if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
  snap install amazon-ssm-agent --classic
fi
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
if ! snap list aws-cli >/dev/null 2>&1; then
  snap install aws-cli --classic
fi
# systemd/SSM commands may not include /snap/bin in PATH.
if [ ! -e /usr/local/bin/aws ]; then
  cat > /usr/local/bin/aws <<'AWS_WRAPPER'
#!/bin/sh
exec /snap/bin/aws "$@"
AWS_WRAPPER
  chmod 0755 /usr/local/bin/aws
fi
/usr/local/bin/aws --version
systemctl enable --now postgresql

install -d -m 0755 /opt/present /opt/present/releases /var/lib/present
install -d -m 0700 /etc/present /var/backups/present
fc-cache -f
date -u +%FT%TZ > /opt/present/bootstrap-complete
echo 'Present host dependencies are ready; install a verified release next.'
