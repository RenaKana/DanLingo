// Offline build with immutable source/build/archive provenance. Never reads credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const project = resolve('.');
const digest = value => createHash('sha256').update(value).digest('hex');
async function fingerprint(path, files = {}) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'No symbolic links in candidate sources');
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await fingerprint(file, files);
    else if (entry.isFile()) files[relative(project, file).replaceAll('\\', '/')] = digest(await readFile(file));
  }
  return files;
}
async function sourceFingerprint() {
  const files = {};
  for (const directory of ['src', 'entrypoints', 'public']) await fingerprint(resolve(directory), files);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'wxt.config.ts', 'tsconfig.json']) files[file] = digest(await readFile(file));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
const base = resolve('.artifacts/live/native-chat-migration');
await mkdir(base, { recursive: true });
const runDir = await mkdtemp(resolve(base, 'candidate-'));
const before = await sourceFingerprint();
await writeFile(resolve(runDir, 'source-before.json'), JSON.stringify(before, null, 2));
for (const file of Object.keys(before)) {
  const destination = resolve(runDir, 'source', file);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await cp(resolve(file), destination);
}
let log = '';
const code = await new Promise((done, reject) => {
  const child = spawn(process.execPath, ['node_modules/wxt/bin/wxt.mjs', 'zip'], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  child.on('error', reject); child.on('close', done);
});
await writeFile(resolve(runDir, 'build.log'), log);
assert.equal(code, 0, 'Build failed; see build.log');
const after = await sourceFingerprint();
await writeFile(resolve(runDir, 'source-after.json'), JSON.stringify(after, null, 2));
assert.deepEqual(after, before, 'Sources changed while building; candidate is not frozen');
const build = resolve('.output/chrome-mv3'), zip = resolve('.output/danlingo-0.2.0-chrome.zip');
await cp(build, resolve(runDir, 'extension'), { recursive: true, force: false, errorOnExist: true });
await cp(zip, resolve(runDir, 'danlingo-0.2.0-youtube-native.zip'), { force: false, errorOnExist: true });
const report = { capturedAt: new Date().toISOString(), status: 'BUILT_NOT_ACCEPTED', runDir,
  sourcesUnchangedDuringBuild: true, sourceFingerprint: digest(JSON.stringify(before)), sourceFiles: before,
  build, buildFiles: await fingerprint(build), archive: zip, archiveSha256: digest(await readFile(zip)),
  limitation: 'This records an offline build only. Browser, Provider, installation and archive payload equality require separate checks.' };
await writeFile(resolve(runDir, 'provenance.json'), JSON.stringify(report, null, 2));
await writeFile(resolve(base, 'latest-build.json'), JSON.stringify({ runDir, archiveSha256: report.archiveSha256 }, null, 2));
console.log(JSON.stringify({ runDir, status: report.status, archiveSha256: report.archiveSha256 }));
