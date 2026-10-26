#!/usr/bin/env python3
"""Install a checksum-verified Present release on its dedicated Ubuntu ARM64 host."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.request
from urllib.parse import urlparse, unquote


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def write(path, value, mode=0o644):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(value)
    p.chmod(mode)


def environment(path, values):
    def quote(value):
        value = str(value)
        if any(c in value for c in '\n\r\0'):
            raise ValueError('Invalid environment value')
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    write(path, ''.join(k + '=' + quote(v) + '\n' for k, v in values.items()), 0o600)


def healthy(url, needs_ok=False):
    for _ in range(60):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200 and (not needs_ok or json.load(response).get('ok') is True):
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError('Readiness failed: ' + url)


class DeploymentTransaction:
    """Restore runtime configuration and the previous release if installation fails.

    Database migrations must remain backward compatible: rollback never rewinds user data.
    """
    services = ['present-api', 'present-web', 'present-converter', 'present-caddy', 'present-backup.timer']

    def __init__(self, base):
        self.current = base / 'current'
        self.previous = self.current.readlink() if self.current.is_symlink() else None
        if self.current.exists() and not self.current.is_symlink():
            raise RuntimeError('/opt/present/current must be a release symlink')
        paths = [
            '/etc/present/api.env', '/etc/present/web.env', '/etc/present/converter.env',
            '/etc/present-caddy/Caddyfile', '/usr/local/libexec/present-soffice-sandbox',
            '/usr/local/bin/present-soffice', '/etc/sudoers.d/present-soffice',
            '/usr/local/sbin/present-backup', '/etc/systemd/system/present-backup.service',
            '/etc/systemd/system/present-backup.timer', str(base / 'previous-release'),
        ] + ['/etc/systemd/system/' + name + '.service' for name in self.services if not name.endswith('.timer')]
        self.files = {}
        for name in paths:
            path = Path(name)
            if path.is_symlink():
                self.files[path] = ('link', path.readlink(), None)
            elif path.exists():
                self.files[path] = ('file', path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
            else:
                self.files[path] = None
        self.active = {name for name in self.services if subprocess.run(
            ['systemctl', 'is-active', '--quiet', name], capture_output=True).returncode == 0}
        self.enabled = {name for name in self.services if subprocess.run(
            ['systemctl', 'is-enabled', '--quiet', name], capture_output=True).returncode == 0}

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        if kind is None:
            return False
        # Stop the new release before replacing its config; failure here must not skip restoration.
        subprocess.run(['systemctl', 'stop', *self.services], capture_output=True)
        for path, saved in self.files.items():
            path.unlink(missing_ok=True)
            if saved is not None:
                typ, data, mode = saved
                path.parent.mkdir(parents=True, exist_ok=True)
                if typ == 'link':
                    path.symlink_to(data)
                else:
                    path.write_bytes(data)
                    path.chmod(mode)
        self.current.unlink(missing_ok=True)
        self.current.with_name('current.next').unlink(missing_ok=True)
        if self.previous is not None:
            self.current.symlink_to(self.previous)
        subprocess.run(['systemctl', 'daemon-reload'], capture_output=True)
        for name in self.services:
            subprocess.run(['systemctl', 'enable' if name in self.enabled else 'disable', name], capture_output=True)
        failed = []
        for name in ['present-converter', 'present-api', 'present-web', 'present-caddy', 'present-backup.timer']:
            if name in self.active and subprocess.run(['systemctl', 'start', name], capture_output=True).returncode:
                failed.append(name)
        print('Deployment failed; previous release and runtime configuration restored.' if self.previous is not None
              else 'Deployment failed; incomplete first release stopped and runtime configuration removed.', flush=True)
        if failed:
            print('Rollback could not restart: ' + ', '.join(failed), flush=True)
        return False


def main():
    parser = argparse.ArgumentParser()
    for arg in ['archive', 'sha256', 'revision', 'secret', 'bucket']:
        parser.add_argument('--' + arg, required=True)
    parser.add_argument('--region', default='us-east-2')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run the release installer as root')
    if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', args.revision):
        raise ValueError('Invalid release revision')
    if not re.fullmatch('[a-z0-9][a-z0-9.-]+[a-z0-9]', args.bucket):
        raise ValueError('Invalid release bucket')
    os.umask(0o077)
    # The scheduled backup uses this lock too; no timer may restart the API during cutover.
    deployment_lock = open('/run/present-backup.lock', 'a')
    fcntl.flock(deployment_lock, fcntl.LOCK_EX)
    archive = Path(args.archive)
    with archive.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != args.sha256:
            raise ValueError('Release archive checksum mismatch')
    run('cloud-init', 'status', '--wait')
    base = Path('/opt/present')
    release = base / 'releases' / args.revision
    if release.exists():
        if (release / '.archive-sha256').read_text().strip() != args.sha256:
            raise ValueError('Release is immutable')
    else:
        release.mkdir(parents=True)
        with tarfile.open(archive) as bundle:
            bundle.extractall(release, filter='data')
        write(release / '.archive-sha256', args.sha256 + '\n', 0o600)
    run('chmod', '755', str(base), str(base / 'releases'))
    run('chmod', '-R', 'a+rX', str(release))
    for required in ['bin/present-service', 'bin/caddy', 'node/bin/node', 'web/web/server.js',
                     'web/web/.next-production/BUILD_ID', 'source/renderer/src/server.ts',
                     'deploy/soffice-sandbox.py', 'deploy/soffice-sandbox', 'deploy/soffice-sandbox.sudoers']:
        if not (release / required).is_file():
            raise RuntimeError('Release is missing required file: ' + required)
    if not (release / 'web/web/.next-production/static').is_dir():
        raise RuntimeError('Release is missing web/web/.next-production/static')
    if any(shutil.which(command) is None for command in ['sudo', 'flock', 'unshare', 'bwrap']):
        run('apt-get', '-o', 'DPkg::Lock::Timeout=300', 'install', '-y', 'sudo', 'util-linux', 'bubblewrap')
    for user in ['present', 'present-web', 'present-converter', 'present-caddy']:
        try:
            pwd.getpwnam(user)
        except KeyError:
            run('useradd', '--system', '--home-dir', '/var/lib/' + user, '--create-home', '--shell', '/usr/sbin/nologin', user)
    run('install', '-d', '-m', '700', '/etc/present')
    for directory, user in [('/var/lib/present/data', 'present'), ('/var/lib/present-converter/tmp', 'present-converter')]:
        run('install', '-d', '-m', '700', '-o', user, '-g', user, directory)
    run('chown', 'root:root', '/var/lib/present-converter')
    run('chmod', '755', '/var/lib/present-converter')
    run('install', '-d', '-m', '755', '/opt/present/browsers')

    with DeploymentTransaction(base):
        # AWS returns secrets only into this process; never into SSM command text or logs.
        secret = json.loads(json.loads(subprocess.check_output([
            'aws', 'secretsmanager', 'get-secret-value', '--region', args.region, '--secret-id', args.secret
        ]))['SecretString'])
        assert secret['APP_SECRET'].startswith('sa_app_')
        common = {'ACCOUNTS_URL': 'https://accounts.teamofsilicons.com'}
        api = dict(common, PRESENT_APP_ID='present', PRESENT_APP_SECRET=secret['APP_SECRET'],
                   PRESENT_DATABASE_URL=secret['PRESENT_DATABASE_URL'], PRESENT_BIND='127.0.0.1:4321',
                   PRESENT_PUBLIC_URL='https://backend.present.teamofsilicons.com', PRESENT_WEB_URL='https://present.teamofsilicons.com',
                   PRESENT_DATA_DIR='/var/lib/present/data', PRESENT_CONVERTER_URL='http://127.0.0.1:4322',
                   CONVERTER_SECRET=secret['CONVERTER_SECRET'], PRESENT_TING_URL='https://backend.ting.teamofsilicons.com')
        for key in ['PRESENT_ACCOUNTS_WEBHOOK_SECRET', 'PRESENT_POSTMARK_TOKEN', 'PRESENT_MAIL_FROM']:
            if secret.get(key):
                api[key] = secret[key]
        environment('/etc/present/api.env', api)
        environment('/etc/present/web.env', dict(common, APP_ID='present', APP_SECRET=secret['APP_SECRET'],
            APP_API_URL='http://127.0.0.1:4321', SESSION_SECRET=secret['SESSION_SECRET'],
            PUBLIC_URL='https://present.teamofsilicons.com', NODE_ENV='production', NEXT_TELEMETRY_DISABLED='1',
            HOSTNAME='127.0.0.1', PORT='4320'))
        environment('/etc/present/converter.env', dict(CONVERTER_SECRET=secret['CONVERTER_SECRET'], CONVERTER_PORT='4322',
            CONVERTER_TMP='/var/lib/present-converter/tmp', SOFFICE_PATH='/usr/local/bin/present-soffice',
            PDFTOPPM_PATH='/usr/bin/pdftoppm', PDFTOTEXT_PATH='/usr/bin/pdftotext', PDFTOCAIRO_PATH='/usr/bin/pdftocairo', PDFINFO_PATH='/usr/bin/pdfinfo',
            FFMPEG_PATH='/usr/bin/ffmpeg', PLAYWRIGHT_BROWSERS_PATH='/opt/present/browsers', NODE_ENV='production',
            PATH='/opt/present/current/node/bin:/usr/local/bin:/usr/bin:/bin'))

        run('systemctl', 'enable', '--now', 'postgresql')
        def sql(query):
            return run('runuser', '-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-At',
                       input=query, text=True, capture_output=True).stdout.strip()
        database = urlparse(secret['PRESENT_DATABASE_URL'])
        if database.scheme not in {'postgres', 'postgresql'} or database.hostname != '127.0.0.1' or \
                database.username != 'present' or database.path != '/present' or database.port not in {None, 5432}:
            raise ValueError('PRESENT_DATABASE_URL must name present@127.0.0.1:5432/present')
        password = unquote(database.password or '')
        assert re.fullmatch('[A-Za-z0-9_-]{32,}', password)
        if sql("SELECT 1 FROM pg_roles WHERE rolname='present'") != '1':
            sql("CREATE ROLE present LOGIN PASSWORD '" + password + "'")
        if sql("SELECT 1 FROM pg_database WHERE datname='present'") != '1':
            run('runuser', '-u', 'postgres', '--', 'createdb', '-O', 'present', 'present')
        # Reject a mismatched secret before stopping a working service. Do not rotate a live DB password implicitly.
        db_check = subprocess.run(['psql', '-h', '127.0.0.1', '-U', 'present', '-d', 'present', '-Atc', 'SELECT 1'],
                                  env=dict(os.environ, PGPASSWORD=password), capture_output=True)
        if db_check.returncode != 0:
            raise RuntimeError('Present database credentials do not authenticate; existing credentials were preserved')

        node = release / 'node/bin/node'
        build_env = dict(os.environ, PATH=str(release / 'node/bin') + ':' + os.environ['PATH'],
                         PLAYWRIGHT_BROWSERS_PATH='/opt/present/browsers', NEXT_TELEMETRY_DISABLED='1',
                         PNPM_HOME='/opt/present/pnpm', COREPACK_ENABLE_DOWNLOAD_PROMPT='0')
        # The converter is installed for the target architecture; the web is a traced standalone build.
        if not (release / '.converter-ready').exists():
            run(str(release / 'node/bin/npm'), 'install', '--global', '--prefix', str(release / 'tools'),
                'pnpm@10.33.0', env=build_env)
            run(str(node), str(release / 'tools/lib/node_modules/pnpm/bin/pnpm.cjs'),
                '--filter', '@silicon-present/renderer...', 'install', '--prod', '--frozen-lockfile',
                cwd=release / 'source', env=build_env)
            run(str(node), str(release / 'source/renderer/node_modules/playwright/cli.js'),
                'install', '--with-deps', 'chromium', env=build_env)
            run('chmod', '-R', 'a+rX', str(release), '/opt/present/browsers')
            write(release / '.converter-ready', 'ready\n')

        # The sandbox implementation and narrow sudo policy are versioned with the release.
        run('install', '-d', '-m', '755', '/usr/local/libexec')
        for source, destination, mode in [
            ('soffice-sandbox.py', '/usr/local/libexec/present-soffice-sandbox', 0o755),
            ('soffice-sandbox', '/usr/local/bin/present-soffice', 0o755),
            ('soffice-sandbox.sudoers', '/etc/sudoers.d/present-soffice', 0o440),
        ]:
            write(destination, (release / 'deploy' / source).read_text(), mode)
            run('chown', 'root:root', destination)
        run('visudo', '-cf', '/etc/sudoers.d/present-soffice')

        # Stop only this app while taking a consistent pre-migration database+asset backup.
        # A missing unit is expected on first install; an existing API must stop before a consistent backup.
        if Path('/etc/systemd/system/present-api.service').exists():
            run('systemctl', 'stop', 'present-api.service')
        backup = Path('/var/lib/present-backups')
        backup.mkdir(mode=0o700, exist_ok=True)
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        dump = backup / (stamp + '.dump')
        with dump.open('wb') as stream:
            run('runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', 'present', stdout=stream)
        assets = backup / (stamp + '-assets.tar.gz')
        run('tar', '-C', '/var/lib/present', '-czf', str(assets), 'data')
        for path in [dump, assets]:
            run('aws', 's3', 'cp', str(path), 's3://' + args.bucket + '/backups/predeploy-' + path.name, '--only-show-errors')
        current = base / 'current'
        if current.is_symlink():
            write(base / 'previous-release', str(current.resolve()) + '\n', 0o600)
        (base / 'current.next').unlink(missing_ok=True)
        (base / 'current.next').symlink_to(release)
        os.replace(base / 'current.next', current)
        for name, user, command, extra in [
            ('api', 'present', '/opt/present/current/bin/present-service', 'ReadWritePaths=/var/lib/present/data\n'),
            ('web', 'present-web', '/opt/present/current/node/bin/node /opt/present/current/web/web/server.js', ''),
            ('converter', 'present-converter', '/opt/present/current/node/bin/node --import tsx src/server.ts',
             'ReadWritePaths=/var/lib/present-converter/tmp\nNoNewPrivileges=false\n'),
        ]:
            workdir = '/opt/present/current/source/renderer' if name == 'converter' else '/opt/present/current'
            write('/etc/systemd/system/present-' + name + '.service', f'''[Unit]
    Description=Silicon Present {name}
    After=network-online.target postgresql.service
    Wants=network-online.target
    [Service]
    User={user}
    Group={user}
    WorkingDirectory={workdir}
    EnvironmentFile=/etc/present/{name}.env
    ExecStart={command}
    Restart=on-failure
    RestartSec=3
    TimeoutStopSec=45
    NoNewPrivileges=true
    PrivateTmp=true
    ProtectHome=true
    ProtectSystem=strict
    IPAddressDeny=169.254.169.254/32
    UMask=0077
    {extra}[Install]
    WantedBy=multi-user.target
    ''')
        write('/etc/present-caddy/Caddyfile', '''{
        email lords@teamofsilicons.com
    }
    present.teamofsilicons.com {
        reverse_proxy 127.0.0.1:4320 {
            flush_interval -1
        }
    }
    backend.present.teamofsilicons.com {
        reverse_proxy 127.0.0.1:4321 {
            flush_interval -1
        }
    }
    ''')
        Path('/etc/present-caddy').chmod(0o755)
        write('/etc/systemd/system/present-caddy.service', '''[Unit]
    Description=Silicon Present HTTPS
    After=network-online.target
    Wants=network-online.target
    [Service]
    User=present-caddy
    Group=present-caddy
    Environment=HOME=/var/lib/present-caddy
    ExecStart=/opt/present/current/bin/caddy run --config /etc/present-caddy/Caddyfile --adapter caddyfile
    ExecReload=/opt/present/current/bin/caddy reload --config /etc/present-caddy/Caddyfile --adapter caddyfile
    Restart=on-failure
    AmbientCapabilities=CAP_NET_BIND_SERVICE
    CapabilityBoundingSet=CAP_NET_BIND_SERVICE
    NoNewPrivileges=true
    PrivateTmp=true
    ProtectSystem=strict
    ReadWritePaths=/var/lib/present-caddy
    IPAddressDeny=169.254.169.254/32
    [Install]
    WantedBy=multi-user.target
    ''')
        write('/usr/local/sbin/present-backup', f'''#!/bin/bash
    set -euo pipefail
    umask 077
    exec 9>/run/present-backup.lock
    flock -n 9 || exit 0
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    root=/var/lib/present-backups
    systemctl stop present-api
    trap 'systemctl start present-api' EXIT
    runuser -u postgres -- pg_dump -Fc present > "$root/$stamp.dump"
    tar -C /var/lib/present -czf "$root/$stamp-assets.tar.gz" data
    systemctl start present-api
    trap - EXIT
    aws s3 cp "$root/$stamp.dump" s3://{args.bucket}/backups/$stamp.dump --only-show-errors
    aws s3 cp "$root/$stamp-assets.tar.gz" s3://{args.bucket}/backups/$stamp-assets.tar.gz --only-show-errors
    find "$root" -type f -mtime +3 -delete
    ''', 0o700)
        write('/etc/systemd/system/present-backup.service', '[Unit]\nDescription=Present consistent backup\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/present-backup\n')
        write('/etc/systemd/system/present-backup.timer', '[Unit]\nDescription=Daily Present backup\n[Timer]\nOnCalendar=*-*-* 03:15:00 UTC\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n')
        run('systemctl', 'daemon-reload')
        for name in ['converter', 'api', 'web']:
            run('systemctl', 'enable', 'present-' + name)
            run('systemctl', 'restart', 'present-' + name)
        healthy('http://127.0.0.1:4321/health', needs_ok=True)
        healthy('http://127.0.0.1:4322/health')
        healthy('http://127.0.0.1:4320/auth/session')
        run(str(release / 'bin/caddy'), 'validate', '--config', '/etc/present-caddy/Caddyfile', '--adapter', 'caddyfile')
        run('systemctl', 'enable', '--now', 'present-caddy', 'present-backup.timer')
        run('systemctl', 'restart', 'present-caddy')
        print('Present installed; database, service, converter and web readiness passed:', args.revision)


if __name__ == '__main__':
    main()
