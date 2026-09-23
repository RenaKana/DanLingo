// Offline only: unique reviewable copies, no browser, network, credential or profile access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fingerprint(directory, prefix = '') {
  assert.equal((await lstat(directory)).isSymbolicLink(), false, 'Symlink source directory rejected');
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, path = resolve(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'Symlink payload rejected');
    if (entry.isDirectory()) Object.assign(files, await fingerprint(path, name + '/'));
    else {
      assert.ok(entry.isFile(), 'Non-file payload rejected');
      const bytes = await readFile(path);
      files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
  }
  return files;
}

async function sourceSnapshot(directory, version, zipPath) {
  const files = await fingerprint(directory);
  const manifestBytes = await readFile(resolve(directory, 'manifest.json'));
  assert.equal(sha256(manifestBytes), files['manifest.json'].sha256, 'Manifest changed during inspection');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, version, 'Unexpected source version');
  assert.equal((await lstat(zipPath)).isSymbolicLink(), false, 'Symlink ZIP rejected');
  const zipBytes = await readFile(zipPath);
  return { path: directory, version, files, fileCount: Object.keys(files).length,
    zip: { path: zipPath, bytes: zipBytes.length, sha256: sha256(zipBytes),
      relationToDirectory: 'NOT_VERIFIED: archive hash only; copies below come from the source directory' } };
}

const manualChecks = () => ({ manualLoaded: 'pending', permissions: 'pending', rememberedKey: 'pending', visual: 'pending',
  browserVersion: null, extensionId: null, settingsRetained: 'pending', sameExtensionIdAfterUpgrade: 'pending' });

export async function prepareManualPackage() {
  const current = await sourceSnapshot(resolve(project, '.output/chrome-mv3'), '0.2.0', resolve(project, '.output/danlingo-0.2.0-chrome.zip'));
  const previous = await sourceSnapshot(resolve(project, '.output/danlingo-0.1.0-chrome'), '0.1.0', resolve(project, '.output/danlingo-0.1.0-chrome.zip'));
  const base = resolve(project, '.artifacts/live/manual-acceptance');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'package-'));
  const reportPath = resolve(root, 'report.json');
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), status: 'PREPARING_OFFLINE', root,
    sources: { current, previous }, browsers: {},
    limitations: ['No browser was launched or extension loaded. All manual acceptance checks remain pending.',
      'Directory-copy hashes prove copied bytes only; ZIP correspondence and manual acceptance are separate evidence.',
      'Upgrade requires the coordinator to update the existing upgrade-extension directory in place after the operator is ready; do not uninstall.'],
  };
  // Preserve an explicit incomplete record if a subsequent copy or consistency check fails.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  try {
    for (const browser of ['chrome', 'edge']) {
      const browserRoot = resolve(root, browser);
      await mkdir(browserRoot);
      const copies = {};
      for (const [name, source] of [['fresh-extension', current], ['upgrade-extension', previous], ['current-candidate', current]]) {
        const path = resolve(browserRoot, name);
        await cp(source.path, path, { recursive: true, force: false, errorOnExist: true });
        const files = await fingerprint(path);
        assert.deepEqual(files, source.files, 'Copied file set or SHA256 differs: ' + browser + '/' + name);
        copies[name] = { path, sourcePath: source.path, version: source.version, createdAt: new Date().toISOString(),
          fileCount: Object.keys(files).length, files, copySha256Verified: true };
      }
      report.browsers[browser] = { managementPage: browser === 'chrome' ? 'chrome://extensions' : 'edge://extensions',
        copies, fresh: manualChecks(), upgrade: manualChecks(), upgradeFilesReplaced: 'pending' };
    }
    for (const source of [current, previous]) {
      assert.deepEqual(await fingerprint(source.path), source.files, 'Source changed during preparation');
      assert.equal(sha256(await readFile(source.zip.path)), source.zip.sha256, 'ZIP changed during preparation');
    }
    report.status = 'OFFLINE_COPIES_VERIFIED_MANUAL_PENDING';
    report.completedAt = new Date().toISOString();
  } catch {
    report.status = 'INCOMPLETE_OFFLINE_PREPARATION';
    report.error = 'copy-or-source-consistency-check-failed';
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    throw new Error('Offline preparation incomplete; inspect ' + reportPath);
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { root, reportPath, status: report.status };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/prepare-live-manual.mjs\nOffline: create a unique .artifacts/live/manual-acceptance/package-* directory with separate Chrome/Edge fresh-extension (0.2.0), upgrade-extension (0.1.0), and current-candidate (0.2.0) copies. Verify every copied file SHA256 and record source/ZIP hashes. No arguments, network, browser or credential access. Manual checks stay pending. Existing packages are preserved.');
    return;
  }
  assert.equal(args.length, 0, 'Only --help or no arguments are supported');
  console.log(JSON.stringify(await prepareManualPackage(), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('Offline manual package preparation failed; any created package retains its report.'); process.exitCode = 1; });
}
