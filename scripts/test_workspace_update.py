"""Isolated regression tests for the fixed-folder workspace updater."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
import workspace_update as updater


REQUIRED_CHECKS = (
    'updater-regression', 'prepare', 'regression', 'typecheck', 'build',
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def directory_identity(path: Path) -> tuple[int, int]:
    info = path.stat()
    return info.st_dev, info.st_ino


class WorkspaceUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='danlingo-workspace-update-')
        self.temp_root = Path(self.temp.name)
        self.root = self.temp_root / 'workspace'
        self.root.mkdir()
        self.ws = updater.Workspace(self.root)

    def test_direct_builder_rejects_linked_staging_before_wxt_can_clean(self):
        if os.name != 'nt':
            self.skipTest('Windows junction guard')
        target = self.root / 'testing' / 'current' / 'extension'
        target.mkdir(parents=True)
        (target / 'keep.txt').write_text('keep', encoding='utf-8')
        output = target / 'output'
        output.mkdir()
        (self.root / '.staging').rmdir()
        self.create_junction(self.root / '.staging', target)
        try:
            result = subprocess.run(['node', str(Path(__file__).with_name('workspace-build.mjs')),
                                     str(self.root), str(self.root / '.staging' / 'output')],
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Build paths must not contain directory links', result.stderr)
            self.assertEqual((target / 'keep.txt').read_text(), 'keep')
            self.assertEqual(list(output.iterdir()), [])
        finally:
            (self.root / '.staging').rmdir()

    def test_promote_rejects_non_history_directory_name(self):
        snapshot = self.archive(checks=[{'name': name, 'result': 'passed'} for name in REQUIRED_CHECKS])
        manual = snapshot.with_name('manual')
        shutil.copytree(snapshot, manual)
        with self.ws.locked(), self.assertRaises(ValueError):
            self.ws.promote(manual)
        self.assertFalse((self.root / 'releases' / 'current').exists())

    def tearDown(self):
        self.temp.cleanup()

    def make_extension(self, version='0.4.0', service=b'service-worker-v1', extra=None):
        extension = self.root / 'fixtures' / updater.unique() / 'chrome-mv3'
        extension.mkdir(parents=True)
        manifest = {
            'manifest_version': 3,
            'version': version,
            'key': 'stable-extension-identity',
            'background': {'service_worker': 'svc.js'},
        }
        (extension / 'manifest.json').write_text(
            json.dumps(manifest), encoding='utf-8'
        )
        (extension / 'svc.js').write_bytes(service)
        for name, content in (extra or {}).items():
            target = extension.joinpath(*name.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        return extension

    def archive(self, version='0.4.0', service=b'service-worker-v1', channel='testing', extra=None, checks=None):
        extension = self.make_extension(version, service, extra)
        with self.ws.locked():
            return self.ws.archive(
                extension,
                channel,
                {'source': 'isolated-fixture', 'sourceCommit': 'fixture'},
                list(checks if checks is not None else ()),
            )

    def activate(self, channel, snapshot):
        with self.ws.locked():
            return self.ws.activate(channel, snapshot)

    def current_extension(self, channel='testing'):
        return self.root / channel / 'current' / 'extension'

    def seed_current(self, channel='testing', version='0.4.0', service=b'service-worker-v1', extra=None):
        snapshot = self.archive(version, service, channel, extra)
        self.activate(channel, snapshot)
        return snapshot

    def test_same_version_update_preserves_current_identity_and_unmanaged_files(self):
        first = self.archive(extra={'retired.js': b'retired'})
        self.activate('testing', first)
        current = self.root / 'testing' / 'current'
        identity = directory_identity(current)
        old_service_hash = sha256(self.current_extension() / 'svc.js')
        unmanaged = self.current_extension() / 'user-notes.json'
        unmanaged.write_bytes(b'{"keep":true}')

        second = self.archive(service=b'service-worker-v2')
        self.activate('testing', second)

        self.assertEqual(first.parent.name, second.parent.name)
        self.assertNotEqual(first, second)
        self.assertEqual(directory_identity(current), identity)
        self.assertEqual((self.current_extension() / 'svc.js').read_bytes(), b'service-worker-v2')
        self.assertNotEqual(sha256(self.current_extension() / 'svc.js'), old_service_hash)
        self.assertFalse((self.current_extension() / 'retired.js').exists())
        self.assertEqual(unmanaged.read_bytes(), b'{"keep":true}')
        self.assertEqual(updater.read_json(current / 'build-info.json')['snapshot'], str(second.relative_to(self.root)))

    def test_testing_updates_do_not_change_release_current(self):
        release_snapshot = self.archive(channel='releases', service=b'release-stable')
        self.activate('releases', release_snapshot)
        release_current = self.root / 'releases' / 'current'
        release_identity = directory_identity(release_current)
        release_hash = sha256(release_current / 'extension' / 'svc.js')

        testing_snapshot = self.archive(service=b'testing-update')
        self.activate('testing', testing_snapshot)

        self.assertEqual(directory_identity(release_current), release_identity)
        self.assertEqual(sha256(release_current / 'extension' / 'svc.js'), release_hash)

    def test_corrupt_package_checksum_does_not_change_current(self):
        self.seed_current(service=b'current')
        current = self.current_extension()
        before = {path.name: sha256(path) for path in current.iterdir() if path.is_file()}
        snapshot = self.archive(service=b'new')
        info = updater.read_json(snapshot / 'build-info.json')
        (snapshot / info['package']).write_bytes(b'corrupt archive')

        with self.assertRaises((ValueError, OSError)):
            self.activate('testing', snapshot)

        after = {path.name: sha256(path) for path in current.iterdir() if path.is_file()}
        self.assertEqual(after, before)
        self.assertFalse(self.ws.journal('testing').exists())

    def test_missing_manifest_resource_does_not_change_current(self):
        self.seed_current(service=b'current')
        current = self.current_extension()
        before = {path.name: sha256(path) for path in current.iterdir() if path.is_file()}
        extension = self.make_extension(service=b'new')
        manifest = updater.read_json(extension / 'manifest.json')
        manifest['background']['service_worker'] = 'missing.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')

        with self.assertRaises(ValueError):
            self.ws.archive(extension, 'testing', {'source': 'fixture'}, [])

        after = {path.name: sha256(path) for path in current.iterdir() if path.is_file()}
        self.assertEqual(after, before)
        self.assertFalse(self.ws.journal('testing').exists())

    def make_git_source(self):
        source = self.root / 'development' / 'current'
        (source / 'scripts').mkdir(parents=True)
        shutil.copyfile(Path(__file__), source / 'scripts' / 'test_workspace_update.py')
        (source / 'scripts' / 'test.mjs').write_text('// fixture test entry\n', encoding='utf-8')
        (source / 'scripts' / 'workspace-build.mjs').write_text('// fixture build entry\n', encoding='utf-8')
        (source / 'package.json').write_text('{"version":"0.4.0"}\n', encoding='utf-8')
        commands = (
            ['git', 'init', str(source)],
            ['git', '-C', str(source), 'config', 'user.name', 'Workspace Fixture'],
            ['git', '-C', str(source), 'config', 'user.email', 'fixture@example.invalid'],
            ['git', '-C', str(source), 'add', '.'],
            ['git', '-C', str(source), 'commit', '-m', 'fixture source'],
        )
        for command in commands:
            subprocess.run(command, check=True, capture_output=True, text=True)
        return source

    def test_update_test_build_failure_leaves_current_unchanged(self):
        self.seed_current(service=b'installed-before-build-failure')
        current = self.current_extension()
        before = {path.name: sha256(path) for path in current.iterdir() if path.is_file()}
        source = self.make_git_source()
        invocations = []

        def runner(command, **kwargs):
            invocations.append(command)
            failed = any(str(part).endswith('workspace-build.mjs') for part in command)
            return subprocess.CompletedProcess(command, 1 if failed else 0)

        with self.assertRaisesRegex(RuntimeError, 'build failed'):
            with self.ws.locked():
                self.ws.update_test(runner=runner)

        self.assertEqual(len(invocations), 5)
        self.assertEqual(Path(invocations[0][1]), source / 'scripts' / 'test_workspace_update.py')
        self.assertEqual({path.name: sha256(path) for path in current.iterdir() if path.is_file()}, before)
        self.assertFalse(self.ws.journal('testing').exists())
        self.assertTrue(any((path / 'build.log').exists() for path in (self.root / '.staging').iterdir()))

    def test_update_test_runs_checks_in_temp_workspace_and_keeps_release_isolated(self):
        release = self.archive(channel='releases', service=b'release-before-testing')
        self.activate('releases', release)
        release_current = self.root / 'releases' / 'current'
        release_identity = directory_identity(release_current)
        release_hash = sha256(release_current / 'extension' / 'svc.js')
        source = self.make_git_source()
        invoked = []

        def runner(command, cwd, stdout, stderr):
            invoked.append(command)
            if any(str(part).endswith('workspace-build.mjs') for part in command):
                output = Path(command[-1]) / 'chrome-mv3'
                output.mkdir(parents=True)
                (output / 'manifest.json').write_text(json.dumps({
                    'manifest_version': 3,
                    'version': '0.4.0',
                    'key': 'stable-extension-identity',
                    'background': {'service_worker': 'svc.js'},
                }), encoding='utf-8')
                (output / 'svc.js').write_bytes(b'built-from-isolated-source')
            stdout.write('fixture passed\n')
            return subprocess.CompletedProcess(command, 0)

        with self.ws.locked():
            result = self.ws.update_test(runner=runner)

        self.assertEqual(len(invoked), 5)
        self.assertEqual(Path(invoked[0][1]), source / 'scripts' / 'test_workspace_update.py')
        self.assertEqual([check['name'] for check in result['checks']], list(REQUIRED_CHECKS))
        self.assertEqual((self.current_extension() / 'svc.js').read_bytes(), b'built-from-isolated-source')
        self.assertEqual(directory_identity(release_current), release_identity)
        self.assertEqual(sha256(release_current / 'extension' / 'svc.js'), release_hash)
        self.assertTrue(all(self.root in Path(check['log']).parents for check in result['checks']))

    def test_promote_copies_testing_zip_byte_for_byte_and_installs_matching_files(self):
        snapshot = self.archive(
            service=b'promoted-service',
            extra={'nested/data.json': b'{"source":"testing"}'},
            checks=[{'name': name, 'result': 'passed'} for name in REQUIRED_CHECKS],
        )
        original_info = updater.read_json(snapshot / 'build-info.json')
        original_zip = (snapshot / original_info['package']).read_bytes()

        with self.ws.locked():
            release_info = self.ws.promote(snapshot)

        release_snapshot = self.root / release_info['snapshot']
        promoted_zip = release_snapshot / release_info['package']
        self.assertEqual(promoted_zip.read_bytes(), original_zip)
        self.assertEqual(updater.verify_snapshot(release_snapshot)['files'], original_info['files'])
        self.assertEqual((self.root / 'releases' / 'current' / 'extension' / 'svc.js').read_bytes(), b'promoted-service')
        self.assertEqual((self.root / 'releases' / 'current' / 'extension' / 'nested' / 'data.json').read_bytes(), b'{"source":"testing"}')

    def test_rollback_restores_selected_history_snapshot(self):
        original = self.archive('0.4.0', b'original-service')
        self.activate('testing', original)
        later = self.archive('0.5.0', b'later-service')
        self.activate('testing', later)

        with self.ws.locked():
            result = self.ws.rollback('testing', original)

        self.assertEqual(result['version'], '0.4.0')
        self.assertEqual((self.current_extension() / 'svc.js').read_bytes(), b'original-service')
        self.assertEqual(updater.read_json(self.root / 'testing' / 'current' / 'build-info.json')['snapshot'], str(original.relative_to(self.root)))

    def test_sync_hook_failure_restores_previous_files(self):
        self.seed_current(service=b'previous-service')
        previous = {path.name: sha256(path) for path in self.current_extension().iterdir() if path.is_file()}
        failed = {'once': False}

        def hook(event):
            if event == 'sync-file' and not failed['once']:
                failed['once'] = True
                raise OSError('injected sync interruption')

        self.ws = updater.Workspace(self.root, hook=hook)
        next_snapshot = self.archive('0.5.0', service=b'next-service')
        with self.assertRaisesRegex(RuntimeError, 'previous files restored'):
            self.activate('testing', next_snapshot)

        actual = {path.name: sha256(path) for path in self.current_extension().iterdir() if path.is_file()}
        self.assertEqual(actual, previous)
        self.assertFalse(self.ws.journal('testing').exists())

    def test_failed_recovery_keeps_journal_and_next_lock_recovers_first(self):
        self.seed_current(service=b'previous-service')
        previous = {path.name: sha256(path) for path in self.current_extension().iterdir() if path.is_file()}
        failed = {'sync': False, 'restore': False}

        def hook(event):
            if event == 'sync-file' and not failed['sync']:
                failed['sync'] = True
                raise OSError('injected update failure')
            if event == 'restore-file' and not failed['restore']:
                failed['restore'] = True
                raise OSError('injected recovery failure')

        self.ws = updater.Workspace(self.root, hook=hook)
        next_snapshot = self.archive(service=b'next-service')
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY FAILED'):
            self.activate('testing', next_snapshot)
        self.assertTrue(self.ws.journal('testing').is_file())

        entered = False
        with self.ws.locked():
            entered = True

        self.assertTrue(entered)
        actual = {path.name: sha256(path) for path in self.current_extension().iterdir() if path.is_file()}
        self.assertEqual(actual, previous)
        self.assertFalse(self.ws.journal('testing').exists())

    def test_process_exit_after_partial_sync_is_recovered_on_next_lock(self):
        self.seed_current(service=b'previous-service')
        next_snapshot = self.archive(service=b'crashing-update')
        child_code = r"""
import os, sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import workspace_update
root = Path(sys.argv[1])
snapshot = root / sys.argv[3]
def hook(event):
    if event == 'sync-file':
        os._exit(73)
with workspace_update.Workspace(root, hook=hook).locked() as workspace:
    workspace.activate('testing', snapshot)
"""
        child = subprocess.run(
            [sys.executable, '-c', child_code, str(self.root), str(Path(__file__).resolve().parent),
             next_snapshot.relative_to(self.root).as_posix()],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(child.returncode, 73, child.stderr)
        self.assertTrue(self.ws.journal('testing').is_file())

        with self.ws.locked():
            pass

        self.assertEqual((self.current_extension() / 'svc.js').read_bytes(), b'previous-service')
        self.assertFalse(self.ws.journal('testing').exists())

    def test_os_lock_rejects_concurrent_process(self):
        child_code = r"""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import workspace_update
try:
    with workspace_update.Workspace(Path(sys.argv[1])).locked():
        pass
except RuntimeError as error:
    print(str(error))
    raise SystemExit(23)
raise SystemExit(0)
"""
        with self.ws.locked():
            child = subprocess.run(
                [sys.executable, '-c', child_code, str(self.root), str(Path(__file__).resolve().parent)],
                capture_output=True,
                text=True,
                timeout=20,
            )
        self.assertEqual(child.returncode, 23, child.stdout + child.stderr)
        self.assertIn('Another workspace update is running', child.stdout)

    @unittest.skipUnless(os.name == 'nt', 'Windows file-sharing semantics are required')
    def test_windows_exclusive_file_handle_blocks_sync_then_allows_recovery(self):
        self.seed_current(service=b'previous-service')
        current_manifest = self.current_extension() / 'manifest.json'
        before = sha256(current_manifest)
        next_snapshot = self.archive('0.5.0', service=b'next-service')

        from ctypes import wintypes
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        create_file = kernel32.CreateFileW
        create_file.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        create_file.restype = wintypes.HANDLE
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL
        handle = create_file(str(current_manifest), 0x80000000, 0x00000001, None, 3, 0x80, None)
        invalid = ctypes.c_void_p(-1).value
        if ctypes.cast(handle, ctypes.c_void_p).value == invalid:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            with self.assertRaisesRegex(RuntimeError, 'previous files restored') as raised:
                self.activate('testing', next_snapshot)
            self.assertIn('WinError 5', str(raised.exception))
            self.assertFalse(self.ws.journal('testing').exists())
            self.assertEqual(sha256(current_manifest), before)
        finally:
            close_handle(handle)

        with self.ws.locked():
            pass
        self.assertEqual(sha256(current_manifest), before)
        self.assertFalse(self.ws.journal('testing').exists())

    def create_junction(self, link: Path, target: Path):
        quote = lambda path: "'" + str(path).replace("'", "''") + "'"
        command = f'New-Item -ItemType Junction -Path {quote(link)} -Target {quote(target)} | Out-Null'
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode:
            self.skipTest(f'Could not create a temporary Windows junction: {result.stderr or result.stdout}')

    @unittest.skipUnless(os.name == 'nt', 'Windows junction semantics are required')
    def test_initial_junction_migration_removes_only_link_and_keeps_target(self):
        original = self.archive(service=b'legacy-target')
        current = self.root / 'testing' / 'current'
        self.create_junction(current, original)
        self.assertTrue(current.is_junction())
        target_identity = directory_identity(original)
        next_snapshot = self.archive(service=b'migrated-current')

        self.activate('testing', next_snapshot)

        self.assertFalse(current.is_junction())
        self.assertTrue(original.is_dir())
        self.assertEqual(directory_identity(original), target_identity)
        self.assertEqual((original / 'extension' / 'svc.js').read_bytes(), b'legacy-target')
        self.assertEqual((current / 'extension' / 'svc.js').read_bytes(), b'migrated-current')

    @unittest.skipUnless(os.name == 'nt', 'Windows junction semantics are required')
    def test_junction_removed_then_interrupted_recovers_old_files_and_keeps_target(self):
        original = self.archive(service=b'legacy-target')
        current = self.root / 'testing' / 'current'
        self.create_junction(current, original)
        target_hash = sha256(original / 'extension' / 'svc.js')
        failed = {'once': False}

        def hook(event):
            if event == 'junction-removed' and not failed['once']:
                failed['once'] = True
                raise OSError('interrupted after junction removal')

        self.ws = updater.Workspace(self.root, hook=hook)
        next_snapshot = self.archive(service=b'new-target')
        with self.assertRaisesRegex(RuntimeError, 'previous files restored'):
            self.activate('testing', next_snapshot)

        self.assertFalse(current.is_junction())
        self.assertEqual((current / 'extension' / 'svc.js').read_bytes(), b'legacy-target')
        self.assertTrue(original.is_dir())
        self.assertEqual(sha256(original / 'extension' / 'svc.js'), target_hash)
        self.assertFalse(self.ws.journal('testing').exists())

    def test_path_traversal_and_reparse_points_are_rejected(self):
        for name in ('../escape.txt', 'nested/../../escape.txt', 'C:/escape.txt'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                updater.safe_name(name)

        outside = self.temp_root / 'outside-snapshot'
        outside.mkdir()
        with self.assertRaises(ValueError):
            with self.ws.locked():
                self.ws.activate('testing', outside)

        extension = self.make_extension(extra={'subdir/data.json': b'fixture'})
        link = extension / 'linked-dir'
        if os.name == 'nt':
            self.create_junction(link, self.root)
        else:
            try:
                link.symlink_to(self.root, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f'This account cannot create a temporary symlink: {error}')
        with self.assertRaises(ValueError):
            updater.inventory(extension)


if __name__ == '__main__':
    unittest.main(verbosity=2)
