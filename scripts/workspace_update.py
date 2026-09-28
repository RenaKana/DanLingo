"""Fixed-folder extension updates. Python 3.12+, stdlib only; no browser data access.

All mutations run under one OS lock. A flushed journal precedes current-folder
writes; recovery always restores the prior files before another operation starts.
Snapshots and recovery copies are append-only. Fault hooks are dependency-injected
by the isolated tests, never enabled by command-line or environment switches.
Recovery covers process interruption; filesystem/power-loss durability is not claimed.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import uuid
import zipfile
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def unique():
    return datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '-' + uuid.uuid4().hex[:8]


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest().upper()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temp, 'x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def linked(path):
    return path.is_symlink() or path.is_junction()


def real_tree(path):
    """Reject reparse points before traversal, including ancestors."""
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        if linked(item):
            raise ValueError(f'Reparse point is forbidden here: {item}')
    return path


def safe_name(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('Invalid relative file path')
    parts = value.split('/')
    if any(p in ('', '.', '..') or p.endswith((' ', '.')) or
           re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I)
           for p in parts):
        raise ValueError(f'Unsafe relative file path: {value}')
    return value


def inside(root, path):
    root, path = Path(root).resolve(), Path(path).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError(f'Path must be strictly inside {root}: {path}')
    return path


def file_at(root, name):
    path = Path(root).joinpath(*safe_name(name).split('/'))
    real_tree(path)
    inside(root, path)
    return path


def inventory(root):
    root = real_tree(root)
    if not root.is_dir():
        raise ValueError(f'Missing extension folder: {root}')
    files = []
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            if linked(Path(base, name)):
                raise ValueError(f'Linked file or folder in build: {name}')
        for name in names:
            path = Path(base, name)
            rel = safe_name(path.relative_to(root).as_posix())
            if not path.is_file():
                raise ValueError(f'Not a regular file: {rel}')
            files.append(dict(path=rel, bytes=path.stat().st_size, sha256=digest(path)))
    return normalize(files)


def normalize(files):
    result, seen = [], set()
    if not isinstance(files, list):
        raise ValueError('Missing file inventory')
    for entry in files:
        name = safe_name(entry['path'])
        if name.lower() in seen or not re.fullmatch('[0-9a-fA-F]{64}', entry['sha256']):
            raise ValueError('Duplicate file or invalid checksum')
        if not isinstance(entry['bytes'], int) or entry['bytes'] < 0:
            raise ValueError('Invalid file size')
        seen.add(name.lower())
        result.append(dict(path=name, bytes=entry['bytes'], sha256=entry['sha256'].upper()))
    if 'manifest.json' not in seen:
        raise ValueError('manifest.json is missing')
    return sorted(result, key=lambda f: f['path'])


def verify_files(root, files, exact=True):
    expected = normalize(files)
    if exact:
        actual = inventory(root)
    else:
        actual = []
        for entry in expected:
            path = file_at(root, entry['path'])
            actual.append(dict(path=entry['path'], bytes=path.stat().st_size, sha256=digest(path)))
    if actual != expected:
        raise ValueError(f'File inventory/checksum mismatch: {root}')


def manifest_version(root):
    manifest = read_json(Path(root, 'manifest.json'))
    version = manifest.get('version', '')
    if manifest.get('manifest_version') != 3 or not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', version):
        raise ValueError('Invalid extension manifest/version')
    # WXT produces these static entry points; catch incomplete builds before sync.
    references = [manifest.get('background', {}).get('service_worker'),
                  manifest.get('options_ui', {}).get('page'), manifest.get('options_page'),
                  manifest.get('action', {}).get('default_popup')]
    references += list(manifest.get('icons', {}).values())
    for script in manifest.get('content_scripts', []):
        references += script.get('js', []) + script.get('css', [])
    for ref in filter(None, references):
        if not file_at(root, ref).is_file():
            raise ValueError(f'Manifest resource is missing: {ref}')
    return version


def zip_inventory(path, extract_to=None):
    files, seen = [], set()
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = safe_name(info.filename)
            if name.lower() in seen or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('Unsafe ZIP entry')
            seen.add(name.lower())
            with archive.open(info) as src:
                hasher = hashlib.sha256()
                size = 0
                target = file_at(extract_to, name) if extract_to else None
                if target:
                    target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, 'xb') if target else contextlib.nullcontext() as dest:
                    while data := src.read(1024 * 1024):
                        hasher.update(data)
                        size += len(data)
                        if dest:
                            dest.write(data)
                files.append(dict(path=name, bytes=size, sha256=hasher.hexdigest().upper()))
    return normalize(files)


def verify_snapshot(path):
    path = real_tree(path)
    info = read_json(path / 'build-info.json')
    verify_files(path / 'extension', info['files'])
    if manifest_version(path / 'extension') != info['version']:
        raise ValueError('Snapshot version mismatch')
    package = file_at(path, info['package'])
    if digest(package) != info['packageSha256'].upper():
        raise ValueError('ZIP checksum mismatch')
    if zip_inventory(package) != normalize(info['files']):
        raise ValueError('ZIP and extension files differ')
    if (path / 'SHA256SUMS').read_text().strip().split() != [info['packageSha256'].upper(), info['package']]:
        # Historical tools used either upper- or lowercase hex.
        sums = (path / 'SHA256SUMS').read_text().strip().split()
        if len(sums) != 2 or sums[0].upper() != info['packageSha256'].upper() or sums[1] != info['package']:
            raise ValueError('SHA256SUMS mismatch')
    return info


class Workspace:
    def __init__(self, root, hook=None):
        self.root = real_tree(root)
        self.hook = hook or (lambda event: None)
        for name in ('.transactions', '.staging', 'testing', 'releases'):
            path = real_tree(self.root / name)
            path.mkdir(parents=True, exist_ok=True)

    @contextlib.contextmanager
    def locked(self):
        """OS releases this lock even on forced process exit; the file stays."""
        path = real_tree(self.root / '.transactions' / 'update.lock')
        with open(path, 'a+b') as lock:
            lock.seek(0, os.SEEK_END)
            if not lock.tell():
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RuntimeError('Another workspace update is running; current files were not touched.') from error
            try:
                self.recover_all()
                yield self
            finally:
                lock.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def channel(self, channel):
        if channel not in ('testing', 'releases'):
            raise ValueError('Channel must be testing or releases')
        return real_tree(self.root / channel)

    def journal(self, channel):
        self.channel(channel)
        return self.root / '.transactions' / (channel + '.json')

    def stage(self):
        path = self.root / '.staging' / unique()
        path.mkdir()
        return path

    def archive(self, extension, channel, provenance, checks, package=None):
        version = manifest_version(extension)
        expected = inventory(extension)
        stage = self.stage()
        shutil.copytree(extension, stage / 'extension')
        verify_files(stage / 'extension', expected)
        package_name = f'DanLingo-{version}-{channel}.zip'
        if package:
            shutil.copyfile(package, stage / package_name)
        else:
            with zipfile.ZipFile(stage / package_name, 'x', zipfile.ZIP_DEFLATED) as archive:
                for file in expected:
                    archive.write(file_at(stage / 'extension', file['path']), file['path'])
        info = dict(schemaVersion=1, channel=channel, version=version, createdAt=now(),
                    **provenance, checks=checks, package=package_name,
                    packageSha256=digest(stage / package_name), files=expected)
        atomic_json(stage / 'build-info.json', info)
        (stage / 'SHA256SUMS').write_text(info['packageSha256'] + '  ' + package_name + '\n', encoding='utf-8')
        verify_snapshot(stage)
        final = self.channel(channel) / version / unique()
        real_tree(final).parent.mkdir(parents=True, exist_ok=True)
        # Unique destination; never replace or edit old archives.
        stage.rename(final)
        return final

    def legacy_current(self, channel):
        current = self.channel(channel) / 'current'
        if linked(current):
            target = current.resolve(strict=True)
            inside(self.channel(channel), target)
            if 'current' in target.relative_to(self.channel(channel)).parts:
                raise ValueError('Unexpected current link target')
            info = verify_snapshot(target)
            return current, target, info
        real_tree(current)
        info = read_json(current / 'build-info.json') if (current / 'build-info.json').exists() else None
        if not info and (current / 'extension').exists() and any((current / 'extension').iterdir()):
            raise ValueError('Unmanaged nonempty current extension; refusing to overwrite it')
        if info:
            verify_files(current / 'extension', info['files'], exact=False)
        return current, None, info

    def copy_file(self, source, target):
        real_tree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Temp files remain outside the browser load tree, even on interruption.
        temp = self.root / '.transactions' / (uuid.uuid4().hex + '.file')
        try:
            with open(source, 'rb') as src, open(temp, 'xb') as dest:
                shutil.copyfileobj(src, dest)
                dest.flush()
                os.fsync(dest.fileno())
            os.replace(temp, target)
        finally:
            if temp.exists():
                temp.unlink()

    def sync(self, source, target, desired, owned, recovering=False):
        real_tree(target).mkdir(parents=True, exist_ok=True)
        wanted = {entry['path'] for entry in desired}
        for name in sorted(set(owned) - wanted):
            path = file_at(target, name)
            if path.exists():
                path.unlink()
            parent = path.parent
            while parent != target and parent.exists() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
        for entry in desired:
            name = entry['path']
            target_file = file_at(target, name)
            if not target_file.exists() or digest(target_file) != entry['sha256'].upper():
                self.copy_file(file_at(source, name), target_file)
            self.hook('restore-file' if recovering else 'sync-file')
        if desired:
            verify_files(target, desired, exact=False)

    def activate(self, channel, snapshot):
        snapshot = real_tree(inside(self.root, snapshot))
        info = verify_snapshot(snapshot)
        current, legacy, previous = self.legacy_current(channel)
        old_files = normalize(previous['files']) if previous else []
        new_files = normalize(info['files'])
        old_names = {entry['path'] for entry in old_files}
        new_names = {entry['path'] for entry in new_files}
        if previous:
            old_key = read_json((legacy or current) / 'extension' / 'manifest.json').get('key')
            new_key = read_json(snapshot / 'extension' / 'manifest.json').get('key')
            if old_key != new_key:
                raise ValueError('Manifest key changed; extension identity would change')
        if not legacy:
            for name in new_names - old_names:
                if file_at(current / 'extension', name).exists():
                    raise ValueError(f'Unmanaged file collision; preserve it before updating: {name}')
        recovery = self.channel(channel) / 'recovery' / unique()
        real_tree(recovery).mkdir(parents=True)
        (recovery / 'extension').mkdir()
        if previous:
            for entry in old_files:
                target = file_at(recovery / 'extension', entry['path'])
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file_at((legacy or current) / 'extension', entry['path']), target)
            verify_files(recovery / 'extension', old_files)
        atomic_json(recovery / 'previous.json', previous)
        record = dict(channel=channel, startedAt=now(), snapshot=str(snapshot.relative_to(self.root)),
                      backup=str(recovery.relative_to(self.root)), previous=previous,
                      nextFiles=new_files, legacyTarget=str(legacy) if legacy else None)
        atomic_json(self.journal(channel), record)
        try:
            self.hook('journal-written')
            if legacy:
                # Remove the junction itself, never its target/snapshot contents.
                if not linked(current) or current.resolve() != legacy:
                    raise ValueError('Current junction changed during migration')
                if current.is_junction():
                    current.rmdir()
                else:
                    current.unlink()
                self.hook('junction-removed')
            real_tree(current).mkdir(exist_ok=True)
            self.sync(snapshot / 'extension', current / 'extension', new_files, old_names)
            active_info = dict(info, installedAt=now(), installedChannel=channel,
                               snapshot=str(snapshot.relative_to(self.root)))
            atomic_json(current / 'build-info.json', active_info)
            self.hook('metadata-written')
            atomic_json(recovery / 'outcome.json', dict(result='updated', finishedAt=now()))
            self.journal(channel).unlink()
        except Exception as error:
            try:
                self.recover(channel)
            except Exception as recovery_error:
                raise RuntimeError(f'UPDATE FAILED; RECOVERY FAILED. Do not reload. Recovery journal retained: {self.journal(channel)}. {recovery_error}') from error
            raise RuntimeError(f'UPDATE FAILED; previous files restored. {error}') from error
        return active_info

    def recover(self, channel):
        journal = self.journal(channel)
        if not journal.exists():
            return
        record = read_json(journal)
        if record['channel'] != channel:
            raise ValueError('Invalid recovery channel')
        backup = real_tree(inside(self.channel(channel) / 'recovery', self.root / record['backup']))
        previous = read_json(backup / 'previous.json')
        if previous != record['previous']:
            raise ValueError('Recovery metadata mismatch')
        files = normalize(previous['files']) if previous else []
        if files:
            verify_files(backup / 'extension', files)
        current = self.channel(channel) / 'current'
        if linked(current):
            if not record['legacyTarget'] or current.resolve() != Path(record['legacyTarget']).resolve():
                raise ValueError('Unrecognized current junction during recovery')
            verify_files(current.resolve() / 'extension', files)
            # No migration writes happened yet. Leave the original junction intact.
        else:
            real_tree(current).mkdir(exist_ok=True)
            owned = {entry['path'] for entry in normalize(record['nextFiles'])} | {f['path'] for f in files}
            self.sync(backup / 'extension', current / 'extension', files, owned, recovering=True)
            if previous:
                atomic_json(current / 'build-info.json', previous)
            else:
                (current / 'build-info.json').unlink(missing_ok=True)
        atomic_json(backup / 'outcome.json', dict(result='restored', finishedAt=now()))
        journal.unlink()
        print(f'Recovered previous {channel} files before continuing.', flush=True)

    def recover_all(self):
        for channel in ('testing', 'releases'):
            try:
                self.recover(channel)
            except Exception as error:
                raise RuntimeError(f'UNFINISHED UPDATE: recovery failed; no new operation started. Keep {self.journal(channel)} and its recovery folder. {error}') from error

    def source_state(self):
        source = (self.root / 'development' / 'current').resolve(strict=True)
        def git(*args):
            return subprocess.check_output(['git', '-C', str(source), *args])
        names = sorted(set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')) - {b''})
        hasher = hashlib.sha256()
        for raw in names:
            name = raw.decode('utf-8')
            path = source / name
            hasher.update(raw + b'\0')
            hasher.update(digest(path).encode() if path.is_file() else b'DELETED')
        return dict(source='development/current', sourcePhysicalPath=str(source),
                    sourceCommit=git('rev-parse', 'HEAD').decode().strip(),
                    sourceHasUncommittedChanges=bool(git('status', '--porcelain=v1', '-z')),
                    sourceTreeSha256=hasher.hexdigest().upper())

    def update_test(self, runner=None, regression_tests=None):
        runner = runner or subprocess.run
        source = (self.root / 'development' / 'current').resolve(strict=True)
        before = self.source_state()
        stage = self.stage()
        output = stage / 'output'
        output.mkdir()
        selected = []
        for name in regression_tests or []:
            name = safe_name(name.replace('\\', '/'))
            if not name.startswith(('test/', 'scripts/')) or not name.endswith('.test.mjs'):
                raise ValueError('Regression inputs must be existing test/*.test.mjs or scripts/*.test.mjs files')
            if not inside(source, source / name).is_file():
                raise ValueError(f'Regression file is missing: {name}')
            selected.append(name)
        regression = (['node', '--experimental-strip-types', '--test', *selected] if selected
                      else ['node', 'scripts/test.mjs'])
        commands = [
            ('updater-regression', [sys.executable, str(source / 'scripts' / 'test_workspace_update.py')]),
            ('prepare', ['node', 'node_modules/wxt/bin/wxt.mjs', 'prepare']),
            ('regression', regression),
            ('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit']),
            ('build', ['node', 'scripts/workspace-build.mjs', str(self.root), str(output)]),
        ]
        checks = []
        for name, command in commands:
            print(f'Running {name} (log: {stage / (name + ".log")})', flush=True)
            with open(stage / (name + '.log'), 'w', encoding='utf-8') as log:
                result = runner(command, cwd=source, stdout=log, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(f'{name} failed (exit {result.returncode}); current unchanged. See {stage / (name + ".log")}')
            checks.append(dict(name=name, result='passed', log=str(stage / (name + '.log'))))
            if name == 'regression':
                checks[-1]['scope'] = selected or ['all-offline-tests']
        if before != self.source_state():
            raise RuntimeError('Source changed during checks/build; current unchanged. Finish edits and retry.')
        extension = output / 'chrome-mv3'
        version = manifest_version(extension)
        if read_json(source / 'package.json')['version'] != version:
            raise ValueError('Source and build versions do not match; current unchanged')
        atomic_json(extension / 'danlingo-build.json', dict(version=version, builtAt=now()))
        snapshot = self.archive(extension, 'testing', before, checks)
        return self.activate('testing', snapshot)

    def promote(self, snapshot):
        snapshot = real_tree(inside(self.channel('testing'), snapshot))
        rel = snapshot.relative_to(self.channel('testing'))
        if len(rel.parts) != 2 or not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', rel.parts[0]) or not re.fullmatch(r'\d{8}-\d{6}-(?:\d{3}|\d{6}-[0-9a-f]{8})', rel.parts[1]):
            raise ValueError('Choose a testing version/timestamp history snapshot')
        info = verify_snapshot(snapshot)
        if info['version'] != rel.parts[0]:
            raise ValueError('Snapshot version does not match its history directory')
        required = {'updater-regression', 'prepare', 'regression', 'typecheck', 'build'}
        passed = {c['name'] for c in info.get('checks', []) if c.get('result') == 'passed'}
        if not required <= passed or info.get('channel') != 'testing':
            raise ValueError('Choose a verified testing snapshot with successful checks/build')
        provenance = {k: v for k, v in info.items() if k.startswith('source')}
        provenance.update(promotedFrom=str(snapshot.relative_to(self.root)), originalBuiltAt=info['createdAt'])
        release = self.archive(snapshot / 'extension', 'releases', provenance,
                               info['checks'], package=snapshot / info['package'])
        return self.activate('releases', release)

    def rollback(self, channel, snapshot):
        snapshot = real_tree(inside(self.channel(channel), snapshot))
        # Only complete history snapshots qualify; current and recovery do not.
        rel = snapshot.relative_to(self.channel(channel))
        if len(rel.parts) != 2 or not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', rel.parts[0]) or not re.fullmatch(r'\d{8}-\d{6}-(?:\d{3}|\d{6}-[0-9a-f]{8})', rel.parts[1]):
            raise ValueError('Select a version/timestamp history snapshot for the same channel')
        if verify_snapshot(snapshot)['version'] != rel.parts[0]:
            raise ValueError('Snapshot version does not match its history directory')
        return self.activate(channel, snapshot)

    def initialize_release(self):
        current = self.channel('releases') / 'current'
        if current.exists():
            raise ValueError('Release current already exists; initialization will not overwrite it')
        original = self.channel('releases') / '0.3.0'
        package = original / 'DanLingo-0.3.0-chromium.zip'
        sums = (original / 'SHA256SUMS').read_text().split()
        publication = read_json(original / 'evidence' / 'github-publication.json')
        asset = next(a for a in publication['assets'] if a['name'] == package.name)
        sha = digest(package)
        if sums != [sha.lower(), package.name] or asset['digest'].split(':')[-1].upper() != sha:
            raise ValueError('Published 0.3.0 ZIP checksum mismatch')
        stage = self.stage()
        extension = stage / 'extension'
        extension.mkdir()
        zip_inventory(package, extension)
        if manifest_version(extension) != '0.3.0':
            raise ValueError('Release ZIP is not 0.3.0')
        verify_files(original / 'extension', inventory(extension))
        provenance = dict(source='published-0.3.0-package', sourceCommit=publication['commit'],
                          sourceHasUncommittedChanges=False, releaseUrl=publication['releaseUrl'],
                          originalPackageSha256=sha)
        snapshot = self.archive(extension, 'releases', provenance,
                                [dict(name='published-package-integrity', result='passed')], package)
        return self.activate('releases', snapshot)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True)
    sub = parser.add_subparsers(dest='action', required=True)
    update = sub.add_parser('update-test')
    update.add_argument('--regression-test', action='append', help='Explicit related regression file; repeat for multiple files. Default: all offline tests.')
    sub.add_parser('initialize-release')
    sub.add_parser('recover')
    sub.add_parser('list')
    promote = sub.add_parser('promote')
    promote.add_argument('--snapshot', required=True)
    rollback = sub.add_parser('rollback')
    rollback.add_argument('--channel', choices=['testing', 'releases'], required=True)
    rollback.add_argument('--snapshot', required=True)
    args = parser.parse_args()
    try:
        workspace = Workspace(args.workspace)
        with workspace.locked():
            if args.action == 'update-test':
                result = workspace.update_test(regression_tests=args.regression_test)
            elif args.action == 'initialize-release':
                result = workspace.initialize_release()
            elif args.action == 'promote':
                result = workspace.promote(Path(args.snapshot).absolute())
            elif args.action == 'rollback':
                result = workspace.rollback(args.channel, Path(args.snapshot).absolute())
            elif args.action == 'list':
                for channel in ('testing', 'releases'):
                    for path in sorted(workspace.channel(channel).glob('*/*/build-info.json')):
                        if path.parent.parent.name == 'recovery':
                            continue
                        info = read_json(path)
                        print(json.dumps(dict(channel=channel, version=info['version'], time=info['createdAt'],
                                              snapshot=str(path.parent)), ensure_ascii=False))
                return 0
            else:
                print('Recovery complete; no pending update.')
                return 0
            print(json.dumps(dict(result='success', version=result['version'], builtAt=result['createdAt'],
                                  snapshot=result['snapshot'], checks=result.get('checks', []),
                                  browserLoadDirectory=str(workspace.root / result['installedChannel'] / 'current' / 'extension')),
                             indent=2, ensure_ascii=False))
            print('Reload the existing extension in the browser. Browser acceptance is recorded separately.')
        return 0
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
