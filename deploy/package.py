#!/usr/bin/env python3
"""Bundle tested Linux ARM64 binaries, Next standalone, and converter source."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node-archive', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--caddy-archive', required=True)
    parser.add_argument('--caddy-sha256', required=True)
    args = parser.parse_args()
    assert digest(args.node_archive) == args.node_sha256
    assert digest(args.caddy_archive) == args.caddy_sha256
    root = Path(__file__).resolve().parent.parent
    out = root / '.dev/production'
    bundle = out / 'bundle'
    if bundle.exists():
        shutil.rmtree(bundle)
    (bundle / 'bin').mkdir(parents=True)
    for binary in ['present-service', 'present']:
        shutil.copy2(root / 'target/aarch64-unknown-linux-gnu/release' / binary, bundle / 'bin' / binary)
    with tarfile.open(args.node_archive) as archive:
        names = archive.getnames()
        prefix = names[0].split('/')[0]
        archive.extractall(out / 'runtime', filter='data')
        shutil.copytree(out / 'runtime' / prefix, bundle / 'node', symlinks=True)
    with tarfile.open(args.caddy_archive) as archive:
        member = archive.getmember('caddy')
        archive.extract(member, bundle / 'bin', filter='data')
    dist = root / 'web/.next-production'
    shutil.copytree(dist / 'standalone', bundle / 'web', symlinks=True)
    # Next may trace local .env files. Credentials never belong in an artifact.
    for path in (bundle / 'web').rglob('.env*'):
        if path.is_file() or path.is_symlink():
            path.unlink()
    shutil.copytree(dist / 'static', bundle / 'web/web/.next-production/static')
    shutil.copytree(root / 'web/public', bundle / 'web/web/public')
    source = bundle / 'source'
    source.mkdir()
    for file in ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']:
        shutil.copy2(root / file, source / file)
    for name in ['packages/deck', 'packages/render', 'renderer']:
        dest = source / name
        dest.mkdir(parents=True)
        shutil.copy2(root / name / 'package.json', dest / 'package.json')
        shutil.copy2(root / name / 'tsconfig.json', dest / 'tsconfig.json')
        shutil.copytree(root / name / 'src', dest / 'src')
    shutil.copytree(root / 'deploy', bundle / 'deploy', ignore=shutil.ignore_patterns('__pycache__'))
    files = {}
    for path in sorted(bundle.rglob('*')):
        if path.is_file() and not path.is_symlink():
            files[str(path.relative_to(bundle))] = digest(path)
    content_hash = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    revision = base[:12] + '-' + content_hash[:12]
    manifest = {'revision': revision, 'source_base': base, 'content_sha256': content_hash,
                'architecture': 'aarch64-unknown-linux-gnu', 'files': files}
    (bundle / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
    artifact = out / (revision + '.tar.gz')
    with tarfile.open(artifact, 'w:gz', dereference=False) as archive:
        for path in sorted(bundle.iterdir()):
            archive.add(path, arcname=path.name)
    release = {'revision': revision, 'sha256': digest(artifact), 'archive': str(artifact)}
    (out / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
    print(json.dumps(dict(release, bytes=artifact.stat().st_size)))


if __name__ == '__main__':
    main()
