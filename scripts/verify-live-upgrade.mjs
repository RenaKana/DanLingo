import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Build first. Uses only disposable profiles, synthetic settings/keys and offline extension pages.
// node scripts/verify-live-upgrade.mjs [--browser both|chromium|edge] [--headed]
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${name} requires a value`);
  return args[index + 1];
}
if (args.includes('--help')) {
  console.log('node scripts/verify-live-upgrade.mjs [--browser both|chromium|edge] [--headed]');
  process.exit(0);
}
const selection = option('--browser', 'both');
assert.ok(['both', 'chromium', 'edge'].includes(selection), 'Unknown browser');
assert.ok(!(selection === 'both' && process.env.DANLINGO_E2E_EXECUTABLE), 'Use a specific --browser with DANLINGO_E2E_EXECUTABLE');
const browsers = selection === 'both' ? ['chromium', 'edge'] : [selection];
const sourceOld = resolve('.output/danlingo-0.1.0-chrome');
const sourceNew = resolve('.output/chrome-mv3');
const artifactRoot = resolve('.artifacts/live/upgrade');
await mkdir(artifactRoot, { recursive: true });
const runDir = await mkdtemp(resolve(artifactRoot, 'run-'));
const report = {
  capturedAt: new Date().toISOString(), runDir, status: 'RUNNING', browsers: {}, errors: [],
  method: 'Offline unpacked extensions in disposable profiles; overwrite the owned extension directory at the same absolute path and restart the same profile for upgrade.',
  limitations: [
    'Native installation, optional-host consent and permission-increase prompts are not verified.',
    'Only copied test manifests pregrant https://upgrade.invalid/*; source packages remain unchanged.',
    'Keys and cache entries are synthetic; no personal browser profile, real Provider or external page is used.',
    'Cache checks establish IndexedDB record/accounting retention, not an actual translated Provider response or cache-hit replay.',
    'Unremembered Key retention is checked across an actual background worker stop/recreation in one browser session; browser restart is intentionally a different lifecycle.',
  ],
};
const persist = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
const pause = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
function owned(path) {
  const absolute = resolve(path), child = relative(runDir, absolute);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Operation must stay inside the disposable run directory');
  return absolute;
}
async function describeBuild(path) {
  const manifest = await readFile(resolve(path, 'manifest.json'), 'utf8');
  return { path, version: JSON.parse(manifest).version, manifestSha256: createHash('sha256').update(manifest).digest('hex') };
}
async function copyExtension(source, destination, replace = false) {
  const target = owned(destination);
  if (replace) await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  const manifestPath = resolve(target, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'https://upgrade.invalid/*'])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
function assertDefaults(settings) {
  assert.equal(settings.schemaVersion, 3);
  assert.equal(settings.liveBufferMs, 2000);
  assert.equal(settings.liveSourceLanguage, 'auto');
}
function assertPreserved(before, after) {
  for (const [key, value] of Object.entries(before)) {
    if (key !== 'schemaVersion') assert.deepEqual(after[key], value, `Upgrade must retain ${key}`);
  }
  assertDefaults(after);
}

let chromium;
async function launch(browserName, profile, extension, evidence) {
  const launchOptions = browserLaunchOptions(browserName);
  const context = await chromium.launchPersistentContext(owned(profile), {
    ...launchOptions, headless: !args.includes('--headed'), offline: true, viewport: { width: 1100, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
      '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  try {
    evidence.executablePath = launchOptions.executablePath ?? browserExecutablePath(browserName, { playwrightBrowser: chromium });
    evidence.network = { offline: true, blockedHttpRequests: 0 };
    await context.route(/^https?:\/\//, route => { evidence.network.blockedHttpRequests++; return route.abort('internetdisconnected'); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await waitFor(async () => !!(await options.locator('#key-state').textContent()) || !!(await options.locator('#result').textContent()), 'initial options overview');
    assert.equal(await options.locator('#result').innerText(), '', 'Initial options overview must succeed');
    const rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
    evidence.browserVersion = await options.evaluate(() => navigator.userAgent);
    evidence.extensionId = extensionId;
    evidence.loadedVersion = await options.evaluate(() => chrome.runtime.getManifest().version);
    return { context, options, worker, extensionId, rpc };
  } catch (error) { await context.close(); throw error; }
}

// Exact comparisons happen within the isolated extension page. Reports never contain key values.
async function keyState(options, expected, remembered) {
  return options.evaluate(async ({ expected, remembered }) => {
    const local = (await chrome.storage.local.get('providerKey.v1'))['providerKey.v1'];
    const session = (await chrome.storage.session.get('providerKey.v1'))['providerKey.v1'];
    const record = remembered ? local : session;
    return { exactValueAndOrigin: record?.value === expected && record?.origin === 'https://upgrade.invalid',
      onlyExpectedStorageArea: remembered ? !session : !local };
  }, { expected, remembered });
}
async function assertKey(options, expected, remembered) {
  const state = await keyState(options, expected, remembered);
  assert.equal(state.exactValueAndOrigin, true, 'Synthetic Key and origin must be retained exactly');
  assert.equal(state.onlyExpectedStorageArea, true, 'Key must exist only in the selected storage area');
  return state;
}
async function seedCache(options, settings) {
  const resourceId = 'sm9', original = 'upgrade synthetic original', translated = '升级缓存测试';
  const key = JSON.stringify(['danlingo-text-v2', resourceId, settings.endpoint, settings.model,
    settings.profile, settings.sourceLanguage, settings.targetLanguage, settings.thinkingEffort, original]);
  const createdAt = Date.now();
  const marker = { key, text: translated, resourceId, createdAt, expiresAt: createdAt + 86400000,
    accessed: 1, bytes: Buffer.byteLength(key) + Buffer.byteLength(translated) + Buffer.byteLength(resourceId) + 128 };
  await options.evaluate(marker => new Promise((done, fail) => {
    const request = indexedDB.open('danlingo-translations-v1', 1);
    request.onerror = () => fail(new Error('Cache open failed'));
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['entries', 'meta'], 'readwrite');
      tx.objectStore('entries').put(marker);
      tx.objectStore('meta').put({ key: 'totals', entries: 1, bytes: marker.bytes, sequence: 1 });
      tx.oncomplete = () => { db.close(); done(); };
      tx.onerror = tx.onabort = () => { db.close(); fail(new Error('Cache seed failed')); };
    };
  }), marker);
  return marker;
}
async function readCache(options, key) {
  return options.evaluate(key => new Promise((done, fail) => {
    const request = indexedDB.open('danlingo-translations-v1', 1);
    request.onerror = () => fail(new Error('Cache open failed'));
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['entries', 'meta'], 'readonly');
      const entryRequest = tx.objectStore('entries').get(key), totalsRequest = tx.objectStore('meta').get('totals');
      tx.oncomplete = () => { db.close(); done({ entry: entryRequest.result, totals: totalsRequest.result }); };
      tx.onerror = tx.onabort = () => { db.close(); fail(new Error('Cache read failed')); };
    };
  }), key);
}
async function reloadExtension(session, evidence) {
  const { worker } = session;
  let closed = false;
  worker.on('close', () => { closed = true; });
  // Browser restart alone can reuse the persisted worker script. This is the
  // unpacked extension's actual runtime reload, after replacing its files.
  await session.options.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
  await waitFor(() => closed, 'pre-upgrade worker closed during extension reload');
  evidence.explicitRuntimeReload = { oldWorkerClosed: closed };
}
async function restartWorker(session) {
  const { context, options, rpc } = session;
  const current = session.worker;
  assert.ok(current, 'Current extension worker must exist');
  const marker = randomUUID();
  await current.evaluate(marker => { globalThis.__DANLINGO_UPGRADE_WORKER_MARKER__ = marker; }, marker);
  const cdp = await context.newCDPSession(options), versions = new Map(), spawned = [];
  let closed = false;
  current.on('close', () => { closed = true; });
  const onWorker = worker => { if (worker.url() === current.url() && worker !== current) spawned.push(worker); };
  context.on('serviceworker', onWorker);
  try {
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      for (const version of event.versions) versions.set(version.versionId, version);
    });
    await cdp.send('ServiceWorker.enable');
    const version = await waitFor(() => [...versions.values()].find(value => value.scriptURL === current.url() && value.runningStatus === 'running' && value.status === 'activated'), 'running extension worker exposed by CDP', 5000);
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await waitFor(() => versions.get(version.versionId)?.runningStatus === 'stopped', 'worker stopped in CDP', 5000);
    const overview = await rpc({ type: 'overview' });
    assert.equal(overview.ok, true);
    const resumedVersion = await waitFor(() => [...versions.values()].find(value => value.scriptURL === current.url() && value.runningStatus === 'running' && value.status === 'activated'), 'worker running again in CDP', 10000);
    const recreated = spawned.at(-1) || context.serviceWorkers().find(worker => worker.url() === current.url());
    assert.ok(recreated, 'Reactivated worker must be available');
    assert.equal(await recreated.evaluate(() => globalThis.__DANLINGO_UPGRADE_WORKER_MARKER__ === undefined), true, 'Replacement must have new worker memory');
    return { stoppedByCdp: true, cdpStoppedThenRunning: true, oldTargetId: version.targetId, newTargetId: resumedVersion.targetId,
      playwrightWorkerCloseObserved: closed, freshWorkerMemory: true,
      sameBrowserContext: true, hasKey: overview.hasKey, remembered: overview.remembered, providerCalls: overview.engine.providerCalls };
  } finally { context.off('serviceworker', onWorker); await cdp.detach().catch(() => {}); }
}

async function verifyBrowser(browserName) {
  const base = await mkdtemp(resolve(runDir, browserName + '-'));
  const evidence = report.browsers[browserName] = { status: 'RUNNING', directory: base, fresh: {}, upgrade: {}, sessionKeyRestart: {} };
  let session;
  try {
    console.log(`CHECK: ${browserName} fresh install`);
    const freshExtension = resolve(base, 'fresh-extension');
    await copyExtension(sourceNew, freshExtension);
    session = await launch(browserName, resolve(base, 'fresh-profile'), freshExtension, evidence.fresh);
    assert.equal(evidence.fresh.loadedVersion, '0.2.0');
    const fresh = await session.rpc({ type: 'overview' });
    assert.equal(fresh.ok, true); assertDefaults(fresh.settings);
    assert.equal(fresh.hasKey, false); assert.equal(fresh.remembered, false); assert.equal(fresh.cache.entries, 0);
    assert.equal(await session.options.locator('#live-buffer').inputValue(), '2000');
    assert.equal(await session.options.locator('#live-source-language').inputValue(), 'auto');
    evidence.fresh.checks = { defaults: fresh.settings, hasKey: fresh.hasKey, cacheEntries: fresh.cache.entries, optionsDefaults: true };
    evidence.fresh.screenshot = resolve(base, 'fresh-options.png');
    await session.options.screenshot({ path: evidence.fresh.screenshot, fullPage: true });
    await session.context.close(); session = undefined;
    evidence.fresh.status = 'PASS'; await persist();

    console.log(`CHECK: ${browserName} same-path upgrade`);
    const extension = resolve(base, 'upgrade-extension'), profile = resolve(base, 'upgrade-profile');
    evidence.upgrade.extensionCopy = extension; evidence.upgrade.profile = profile; evidence.upgrade.old = {};
    await copyExtension(sourceOld, extension);
    session = await launch(browserName, profile, extension, evidence.upgrade.old);
    assert.equal(evidence.upgrade.old.loadedVersion, '0.1.0');
    const initial = await session.rpc({ type: 'settings' });
    assert.equal(initial.settings.schemaVersion, 2);
    const chosen = { ...initial.settings, schemaVersion: 2, enabled: false, endpoint: 'https://upgrade.invalid/v1/chat/completions',
      model: 'upgrade-user-chosen-model', profile: 'deepseek', thinkingEffort: 'max', displayMode: 'original', translationScope: 'window',
      requestTimeoutMs: 19000, thinkingRequestTimeoutMs: 97000, concurrency: 7, batchSize: 20, maxBatchChars: 6000,
      sourceLanguage: 'ja', targetLanguage: 'en', prefetchSeconds: 30, urgentSeconds: 8, cacheMaxEntries: 1234, cacheTtlDays: 41 };
    const rememberedKey = 'synthetic-upgrade-remembered-' + randomUUID();
    const saved = await session.rpc({ type: 'save', settings: chosen, apiKey: rememberedKey, remember: true });
    assert.equal(saved.ok, true, saved.error); assert.deepEqual(saved.settings, chosen);
    assert.equal(saved.hasKey, true); assert.equal(saved.remembered, true);
    evidence.upgrade.before = { settings: saved.settings, key: await assertKey(session.options, rememberedKey, true) };
    const oldOverview = await session.rpc({ type: 'overview' });
    assert.equal(oldOverview.cache.entries, 0);
    const marker = await seedCache(session.options, saved.settings);
    const seeded = await session.rpc({ type: 'overview' });
    assert.equal(seeded.cache.entries, 1); assert.equal(seeded.cache.bytes, marker.bytes);
    const originalId = session.extensionId;
    await session.context.close(); session = undefined;
    // The only recursive removal is this checked, owned extension copy. The profile remains untouched.
    await copyExtension(sourceNew, extension, true);
    evidence.upgrade.current = {};
    session = await launch(browserName, profile, extension, evidence.upgrade.current);
    assert.equal(evidence.upgrade.current.loadedVersion, '0.2.0');
    assert.equal(session.extensionId, originalId, 'Unpacked extension ID must stay stable across replacement');
    await reloadExtension(session, evidence.upgrade.current);
    // --load-extension on a subsequent launch enables the updated unpacked build
    // even when Chromium disabled it for added platform hosts. Consent is outside
    // this test; preserve the same profile and extension path for storage checks.
    await session.context.close(); session = undefined;
    evidence.upgrade.afterReloadRestart = {};
    session = await launch(browserName, profile, extension, evidence.upgrade.afterReloadRestart);
    assert.equal(session.extensionId, originalId);
    assert.equal(evidence.upgrade.afterReloadRestart.loadedVersion, '0.2.0');
    const upgraded = await session.rpc({ type: 'overview' });
    assert.equal(upgraded.ok, true); assertPreserved(saved.settings, upgraded.settings);
    assert.equal(upgraded.hasKey, true); assert.equal(upgraded.remembered, true);
    assert.equal(upgraded.cache.entries, 1); assert.equal(upgraded.cache.bytes, marker.bytes);
    const cache = await readCache(session.options, marker.key);
    assert.deepEqual(cache.entry, marker);
    assert.deepEqual(cache.totals, { key: 'totals', entries: 1, bytes: marker.bytes, sequence: 1 });
    evidence.upgrade.after = { settings: upgraded.settings, key: await assertKey(session.options, rememberedKey, true),
      cache: { exactMarkerRetained: true, entries: upgraded.cache.entries, bytes: upgraded.cache.bytes, exactAccountingRetained: true } };
    assert.equal(await session.options.locator('#live-buffer').inputValue(), '2000');
    assert.equal(await session.options.locator('#live-source-language').inputValue(), 'auto');
    evidence.upgrade.sameCopyPath = true; evidence.upgrade.sameExtensionId = true; evidence.upgrade.sameProfile = true;
    evidence.upgrade.status = 'PASS'; await persist();

    console.log(`CHECK: ${browserName} unremembered Key across worker recreation`);
    const sessionKey = 'synthetic-upgrade-session-' + randomUUID();
    const sessionSaved = await session.rpc({ type: 'save', settings: upgraded.settings, apiKey: sessionKey, remember: false });
    assert.equal(sessionSaved.ok, true); assert.equal(sessionSaved.hasKey, true); assert.equal(sessionSaved.remembered, false);
    await assertKey(session.options, sessionKey, false);
    evidence.sessionKeyRestart = await restartWorker(session);
    assert.equal(evidence.sessionKeyRestart.hasKey, true); assert.equal(evidence.sessionKeyRestart.remembered, false);
    assert.equal(evidence.sessionKeyRestart.providerCalls, 0);
    evidence.sessionKeyRestart.key = await assertKey(session.options, sessionKey, false);
    const restarted = await session.rpc({ type: 'overview' });
    assertPreserved(saved.settings, restarted.settings); assert.equal(restarted.cache.entries, 1);
    assert.deepEqual((await readCache(session.options, marker.key)).entry, marker);
    evidence.sessionKeyRestart.status = 'PASS'; evidence.status = 'PASS';
    console.log(`PASS: ${browserName} fresh install, upgrade and session Key worker restart`);
  } catch (error) {
    evidence.status = 'FAIL'; evidence.error = String(error.stack || error).slice(0, 2500);
    report.errors.push(`${browserName}: ${String(error.message || error).slice(0, 500)}`);
    process.exitCode = 1;
  } finally { await session?.context.close().catch(() => {}); await persist(); }
}

try {
  report.builds = { old: await describeBuild(sourceOld), current: await describeBuild(sourceNew) };
  assert.equal(report.builds.old.version, '0.1.0'); assert.equal(report.builds.current.version, '0.2.0');

  ({ chromium } = await loadPlaywright());
  for (const browserName of browsers) await verifyBrowser(browserName);
  report.status = browsers.every(name => report.browsers[name]?.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) { report.status = 'FAIL'; report.errors.push(String(error.stack || error).slice(0, 2500)); process.exitCode = 1; }
finally { await persist(); console.log('Report: ' + resolve(runDir, 'report.json')); }
