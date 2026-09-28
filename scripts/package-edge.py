"""Build and inspect a local Edge candidate. Never uploads or publishes.

Run after pnpm build and the Edge screenshot check. Standard library only.
Optional --compare-credentials FILE reads exact exclusion values in memory;
values and matching content are never included in reports.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def png_size(data):
    require(data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR', 'Invalid PNG')
    return struct.unpack('>II', data[16:24])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compare-credentials', type=Path)
    args = parser.parse_args()
    known = []
    if args.compare_credentials:
        content = args.compare_credentials.read_text(encoding='utf-8-sig')
        known = re.findall(r'''(?im)^\s*(?:KEY|api_key)\s*[:=：]\s*["']([^"'\r\n]+)["']''', content)
        if not known:
            known = re.findall(r'\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b', content)
        require(bool(known), 'Cannot read exact credential exclusion input')
        del content
    build = Path(os.environ.get('DANLINGO_TEST_EXTENSION', str(ROOT / '.output/chrome-mv3'))).resolve()
    package = read_json(ROOT / 'package.json')
    version = package['version']
    manifest = read_json(build / 'manifest.json')
    require(manifest['manifest_version'] == 3 and manifest['version'] == version, 'Manifest/version mismatch')
    require(manifest['default_locale'] == 'en', 'Missing English fallback')
    require(set(manifest['permissions']) == {'storage', 'offscreen'}, 'Permission scope changed; review required')
    require(set(manifest['optional_host_permissions']) == {'http://*/*', 'https://*/*'}, 'Optional permission scope changed')
    require(set(manifest['host_permissions']) == {'https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/watch/*',
            'https://www.youtube.com/*', 'https://www.bilibili.com/*', 'https://live.bilibili.com/*'}, 'Site permission scope changed')
    require(manifest.get('content_security_policy', {}).get('extension_pages') ==
            "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'", 'CSP changed; review required')
    for size in (16, 32, 48, 128):
        path = f'icon/{size}.png'
        require(manifest['icons'].get(str(size)) == path, 'Missing extension icon')
        require(manifest['action']['default_icon'].get(str(size)) == path, 'Missing toolbar icon')
        require(png_size((build / path).read_bytes()) == (size, size), 'Wrong icon dimensions')
    locales = sorted(p.parent.name for p in (build / '_locales').glob('*/messages.json'))
    listings = read_json(ROOT / 'docs/edge-listings.json')
    expected_locales = sorted(p.name for p in (ROOT / 'public/_locales').iterdir() if p.is_dir())
    require(len(locales) == 20 and locales == expected_locales == sorted(listings['locales']), 'Locale/listing mismatch')
    require(listings['version'] == version, 'Store listing version mismatch')
    for code, listing in listings['locales'].items():
        require(all(isinstance(listing.get(k), str) and listing[k].strip() for k in ('name', 'shortDescription', 'description')), f'Empty listing: {code}')
        require(len(listing['shortDescription']) <= 132, f'Long short description: {code}')
    for name, size in [('icon-300.png', (300, 300)), ('tile-440x280.png', (440, 280))]:
        require(png_size((ROOT / 'docs/store-assets' / name).read_bytes()) == size, 'Wrong store image dimensions')
    screenshots = sorted((ROOT / 'docs/store-assets/screenshots').glob('*.png'))
    require(len(screenshots) == 4, 'Expected four reviewed screenshots')
    for image in screenshots:
        require(png_size(image.read_bytes()) == (1280, 800), 'Wrong screenshot dimensions')
    files = sorted(p for p in build.rglob('*') if p.is_file())
    members = [p.relative_to(build).as_posix() for p in files]
    for name in ['manifest.json', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'local/wllama.wasm', 'local/wllama-worker.js']:
        require(name in members, 'Missing required package member: ' + name)
    for path in files:
        require(not path.is_symlink(), 'Symlink in package')
        require(path.suffix in {'.json', '.txt', '.html', '.js', '.wasm', '.css', '.png'}, 'Unexpected package file type')
        require(not re.search(r'fixture|\.map$|\.env|api[-_]?key|credential', path.name, re.I), 'Development/private file in package')
    # Detect literal remote executable imports; this does not replace source review.
    for path in files:
        if path.suffix == '.js':
            code = path.read_text(encoding='utf-8')
            require(not re.search(r'''(?:importScripts|import)\s*\(\s*["']https?://''', code), 'Remote executable import found')
        if path.suffix == '.html':
            require(not re.search(r'''<script[^>]+src=["']https?://''', path.read_text(encoding='utf-8'), re.I), 'Remote script found')
    patterns = {
        'private-key': rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
        'github-token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b',
        'provider-key': rb'\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|amux-[A-Za-z0-9_-]{24,})\b',
        'aws-access-key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
        'google-api-key': rb'\bAIza[A-Za-z0-9_-]{35}\b',
    }
    findings = []

    def scan(name, data):
        kinds = [kind for kind, pattern in patterns.items() if re.search(pattern, data)]
        if any(secret.encode(enc) in data for secret in known for enc in ('utf-8', 'utf-16le')):
            kinds.append('known-local-credential')
        if kinds:
            findings.append({'path': name, 'categories': kinds})

    sources = sorted(set(p for p in subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z'], cwd=ROOT).decode('utf-8').split('\0') if p))
    source_hash = hashlib.sha256()
    for name in sources:
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), 'Source file unavailable or symbolic')
        data = path.read_bytes()
        scan('source/' + name, data)
        source_hash.update(name.encode() + b'\0' + hashlib.sha256(data).digest())
    for path, name in zip(files, members):
        scan('build/' + name, path.read_bytes())
    require(not findings, 'Sensitive content requires review: ' + json.dumps(findings))
    output = ROOT / '.artifacts/edge-store' / version
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'DanLingo-{version}-edge-candidate.zip'
    with ZipFile(archive, 'w', compression=ZIP_DEFLATED, compresslevel=9) as z:
        for path, name in zip(files, members):
            entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            z.writestr(entry, path.read_bytes())
    with ZipFile(archive) as z:
        require(z.namelist() == members, 'Archive member mismatch')
        for name in members:
            data = z.read(name)
            require(data == (build / name).read_bytes(), 'Archive payload mismatch')
            scan('zip/' + name, data)
    require(not findings, 'ZIP scan failed')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / 'SHA256SUMS').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
    material = output / 'submission-materials'
    material.mkdir(exist_ok=True)
    for name in ['PRIVACY.md', 'EDGE_STORE.md', 'edge-listings.json']:
        shutil.copy2(ROOT / 'docs' / name, material / name)
    shutil.copytree(ROOT / 'docs/store-assets', material / 'store-assets', dirs_exist_ok=True)
    text_folder = material / 'listing-text'
    text_folder.mkdir(exist_ok=True)
    for code, listing in listings['locales'].items():
        (text_folder / f'{code}.txt').write_text('\n\n'.join([listing['name'], listing['shortDescription'], listing['description']]) + '\n', encoding='utf-8')
    report = {'status': 'PASS_LOCAL_PACKAGE_CHECKS_NOT_RELEASE_APPROVAL', 'version': version,
              'sourceFiles': len(sources), 'sourceContentSha256': source_hash.hexdigest(), 'packageFiles': len(members),
              'zipBytes': archive.stat().st_size, 'zipSha256': digest, 'locales': locales,
              'knownLocalCredentialsCompared': len(known), 'findings': findings,
              'limits': ['Not uploaded, reviewed, signed, or installed from Edge Add-ons.',
                         'Real platform/provider/native GPU acceptance and CI are tracked separately.',
                         'Pattern and exact matching do not rule out unknown or transformed secrets.',
                         'Images were visually inspected separately; no OCR or personal browser scan.']}
    (output / 'package-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
