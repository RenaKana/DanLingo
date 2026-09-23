import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Manual native folder authorization, isolated profile, production direct-read GPU path.
// Never substitute copy-import, OPFS, or a personal browser profile for this check.
import assert from 'node:assert/strict';
import { mkdir, cp, mkdtemp, writeFile, stat, readdir } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv.includes('--manual-folder')) throw new Error('Run with --manual-folder and an existing GGUF path. Native authorization requires a user gesture. No copy-import is performed.');
const modelPath = resolve(process.argv.slice(2).find(value => !value.startsWith('--'))
  ?? 'D:/Tool/Models/LmStudioModels/lmstudio-community/Hy-MT2-30B-A3B/Hy-MT2-30B-A3B-APEX-I-Quality.gguf');
const before = await stat(modelPath); assert.ok(before.isFile() && before.size > 0);
const root = resolve('.artifacts/real-directory-model'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(directory, 'extension'), profile = resolve(directory, 'profile');
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
const report = { capturedAt: new Date().toISOString(), evidence: 'MANUALLY_GRANTED_EXTERNAL_DIRECTORY_PRODUCTION_EXTENSION',
  modelPath, bytes: before.size, network: [], checks: {}, errors: [], unverified: [] };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(fn, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(250); }
  throw new Error('Timeout: ' + label);
}
async function storageFootprint(path) {
  let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) rows.push(...await storageFootprint(child));
    else if (entry.isFile()) rows.push({ path: child, bytes: (await stat(child)).size });
  }
  return rows;
}
const { chromium } = await loadPlaywright();
const brandedChrome = process.argv.includes('--chrome');
const browserName = brandedChrome ? 'chrome' : process.argv.includes('--edge') ? 'edge' : 'chromium';
const browserOptions = browserLaunchOptions(browserName);
let context, page, origin;
const rpc = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: false, ...browserOptions, viewport: { width: 1360, height: 900 },
    ...(brandedChrome ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
    args: [...(brandedChrome ? [] : ['--disable-extensions-except=' + extension, '--load-extension=' + extension]),
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  if (brandedChrome) { const cdp = await context.browser().newBrowserCDPSession(); await cdp.send('Extensions.loadUnpacked', { path: extension }); await cdp.detach(); }
  context.on('request', request => { if (/^https?:/.test(request.url())) report.network.push(new URL(request.url()).origin); });
  await context.route('**/*', route => /^https?:/.test(route.request().url()) ? route.abort() : route.continue());
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  origin = 'chrome-extension://' + new URL(background.url()).host;
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/options.html'); await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  await page.locator('#backend').selectOption('local');
}
try {
  await launch(); report.browser = await page.evaluate(() => navigator.userAgent);
  report.storageBefore = await storageFootprint(join(profile, 'Default', 'IndexedDB'));
  const opened = context.waitForEvent('page'); await page.locator('#local-folder-add').click(); const authorization = await opened;
  await authorization.waitForURL(origin + '/model-folders.html');
  console.log('In the isolated browser, click 选择文件夹 and choose the directory containing:', modelPath);
  const model = await until(async () => (await rpc({ type: 'local-control', control: { action: 'list' } })).models
    ?.find(value => value.source?.kind === 'directory' && value.name === basename(modelPath) && value.bytes === before.size), 'manual directory grant and scan', 300_000);
  report.model = model;
  assert.equal((await rpc({ type: 'settings' })).settings.localModelId ?? '', '');
  report.checks.scanDoesNotSelectOrLoad = (await rpc({ type: 'local-control', control: { action: 'state' } })).state.phase === 'idle';
  assert.equal(report.checks.scanDoesNotSelectOrLoad, true);
  report.scan = (await rpc({ type: 'local-control', control: { action: 'directory-status' } })).scan;
  await authorization.close();
  report.rawRecord = await page.evaluate(async id => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('danlingo-local-models-v1', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise((resolve, reject) => { const request = db.transaction('models').objectStore('models').get(id);
      request.onsuccess = () => resolve({ keys: Object.keys(request.result), containsBlobs: 'blobs' in request.result, source: request.result.info.source }); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  }, model.id);
  assert.equal(report.rawRecord.containsBlobs, false); report.checks.metadataOnlyRecord = true;
  await context.close(); context = undefined;
  await launch();
  const restored = (await rpc({ type: 'local-control', control: { action: 'list' } })).models.find(value => value.id === model.id);
  assert.ok(restored); report.checks.restartRestoresReference = true;
  const refreshed = await rpc({ type: 'local-control', control: { action: 'directory-scan', directoryId: model.source.directoryId } });
  report.afterRestart = { directories: refreshed.directories, scan: refreshed.scan };
  if (refreshed.directories.find(value => value.id === model.source.directoryId)?.status !== 'ready') {
    report.unverified.push('Read grant after browser restart requires explicit reauthorization');
    throw new Error('External handle restored, but permission requires reauthorization. No background grant requested.');
  }
  report.checks.restartReadPermission = true;
  await page.locator('#local-model').selectOption(model.id);
  await until(async () => (await rpc({ type: 'settings' })).settings.localModelId === model.id, 'explicit model choice');
  const loadStart = performance.now(); const load = await rpc({ type: 'local-control', control: { action: 'load', modelId: model.id } });
  assert.equal(load.ok, true, load.error); report.gpuLoadMs = performance.now() - loadStart; report.loaded = load.state;
  assert.equal(load.state.gpu?.verified, true); report.checks.directGpuFullOffload = true;
  const saved = (await rpc({ type: 'settings' })).settings;
  report.translation = await rpc({ type: 'test-model', settings: { ...saved, backend: 'local', localModelId: model.id,
    sourceLanguage: 'zh', liveSourceLanguage: 'zh', targetLanguage: 'ja', thinkingEffort: 'default', requestTimeoutMs: 120000, thinkingRequestTimeoutMs: 120000 } });
  assert.equal(report.translation.ok, true, report.translation.error); report.checks.oneRealTranslation = true;
  report.storageAfter = await storageFootprint(join(profile, 'Default', 'IndexedDB'));
  assert.ok(report.storageAfter.every(value => value.bytes < before.size / 2), 'No corresponding large IndexedDB model copy');
  report.checks.noLargeDatabaseCopy = true;
  await rpc({ type: 'local-control', control: { action: 'unload' } });
  assert.deepEqual(report.network, []); report.status = 'PASS';
} catch (error) { report.errors.push(String(error.stack ?? error)); report.status = 'INCOMPLETE_OR_FAILED'; process.exitCode = 1; }
finally {
  await context?.close(); const after = await stat(modelPath);
  report.sourceUnchanged = before.size === after.size && before.mtimeMs === after.mtimeMs;
  if (!report.sourceUnchanged) { report.status = 'FAILED_SOURCE_CHANGED'; process.exitCode = 1; }
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'));
}
