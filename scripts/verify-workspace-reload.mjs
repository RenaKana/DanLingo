// Isolated browser evidence only. Never opens/edits the user's browser profile.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';

const [baselineArg, firstArg, secondArg, releaseArg, brand = 'chromium'] = process.argv.slice(2);
if (![baselineArg, firstArg, secondArg, releaseArg].every(Boolean) || !['chromium', 'chrome', 'edge'].includes(brand)) {
  throw new Error('Usage: verify-workspace-reload.mjs <baseline-snapshot> <first-snapshot> <second-snapshot> <release-snapshot> [chromium|chrome|edge]');
}
const source = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(source, '.artifacts'), { recursive: true });
const artifact = await mkdtemp(resolve(source, '.artifacts/workspace-reload-'));
const workspace = resolve(artifact, 'workspace');
const report = { evidence: 'isolated-browser-real-built-extension-synthetic-storage', brand, artifact,
  userProfileTouched: false, nativeModelFilePermissionVerified: false, manualLoadUnpackedVerified: false,
  checks: [], startedAt: new Date().toISOString() };
let context;
function activate(channel, snapshot) {
  execFileSync('python', [resolve(source, 'scripts/workspace_update.py'), '--workspace', workspace,
    'rollback', '--channel', channel, '--snapshot', snapshot], { windowsHide: true, stdio: 'pipe' });
}
async function snapshotCopy(input, channel) {
  const info = JSON.parse(await readFile(resolve(input, 'build-info.json'), 'utf8'));
  const dest = resolve(workspace, channel, info.version, basename(input));
  await cp(resolve(input), dest, { recursive: true, errorOnExist: true, force: false });
  return dest;
}
try {
  const baseline = await snapshotCopy(baselineArg, 'testing');
  const first = await snapshotCopy(firstArg, 'testing');
  const second = await snapshotCopy(secondArg, 'testing');
  const released = await snapshotCopy(releaseArg, 'releases');
  activate('testing', baseline);
  activate('releases', released);
  const loadPath = resolve(workspace, 'testing/current/extension');
  const releasePath = resolve(workspace, 'releases/current/extension');
  const directoryBefore = await stat(loadPath, { bigint: true });
  const { chromium } = await loadPlaywright();
  const channel = brand === 'edge' ? 'msedge' : brand;
  const launch = browserLaunchOptions(brand);
  if (!launch.executablePath) launch.channel = channel;
  report.executablePath = launch.executablePath ?? `installed channel: ${channel}`;
  context = await chromium.launchPersistentContext(resolve(artifact, 'isolated-profile'), {
    ...launch, headless: true, viewport: { width: 1400, height: 1000 },
    args: brand === 'chrome' ? ['--enable-unsafe-extension-debugging']
      : [`--disable-extensions-except=${loadPath},${releasePath}`, `--load-extension=${loadPath},${releasePath}`],
  });
  report.browserVersion = context.browser()?.version();
  report.loadingMethod = brand === 'chrome' ? 'CDP Extensions.loadUnpacked in disposable profile' : 'launch flags in disposable profile';
  if (brand === 'chrome') {
    const debuggerPage = await context.newPage();
    const session = await context.newCDPSession(debuggerPage);
    await session.send('Extensions.loadUnpacked', { path: loadPath });
    await session.send('Extensions.loadUnpacked', { path: releasePath });
    await session.detach();
    await debuggerPage.close();
  }
  const workerDeadline = Date.now() + 15000;
  while (context.serviceWorkers().length < 2 && Date.now() < workerDeadline) {
    await context.waitForEvent('serviceworker', { timeout: Math.max(1, workerDeadline - Date.now()) }).catch(() => {});
  }
  const workers = context.serviceWorkers();
  const identities = await Promise.all(workers.map(async worker => ({
    id: new URL(worker.url()).host,
    version: await worker.evaluate(() => chrome.runtime.getManifest().version),
  })));
  const testing = identities.find(item => item.version === '0.4.0');
  const release = identities.find(item => item.version === '0.3.0');
  report.loadedExtensions = identities;
  assert.ok(testing && release, 'Both isolated extensions must actually load');
  assert.notEqual(testing.id, release.id);
  report.extensionId = testing.id;
  report.releaseExtensionId = release.id;
  report.loadPath = loadPath;
  let page = await context.newPage();
  await page.goto(`chrome-extension://${testing.id}/options.html`);
  await page.locator('#endpoint').waitFor();
  // Existing storage schema; fake non-provider key and synthetic model record only.
  await page.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({ type: 'settings' });
    await chrome.storage.local.set({
      'settings.v1': { ...result.settings, enabled: false, targetLanguage: 'fr',
        endpoint: 'https://example.invalid/v1/chat/completions', model: 'fixture-model' },
      'providerKey.v1': { origin: 'https://example.invalid', value: 'fixture-not-a-real-credential' },
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('danlingo-local-models-v1', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('models')) request.result.createObjectStore('models', { keyPath: 'info.id' });
        if (!request.result.objectStoreNames.contains('directories')) request.result.createObjectStore('directories', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('models', 'readwrite');
        tx.objectStore('models').put({ info: { id: 'workspace-fixture', name: 'Workspace fixture',
          size: 0, fileNames: [], importedAt: 1 }, blobs: [] });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  const releasePage = await context.newPage();
  await releasePage.goto(`chrome-extension://${release.id}/options.html`);
  await releasePage.evaluate(() => chrome.storage.local.set({ 'workspace.channel.fixture': 'release-only' }));
  for (const snapshot of [first, second]) {
    const info = JSON.parse(await readFile(resolve(snapshot, 'build-info.json'), 'utf8'));
    const expectedBuild = JSON.parse(await readFile(resolve(snapshot, 'extension/danlingo-build.json'), 'utf8'));
    activate('testing', snapshot);
    // This is runtime.reload in an isolated browser, not a claim of clicking the user's Reload button.
    await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
    // MV3 workers can stay dormant after reload until a new extension page sends
    // a message. A new document is the meaningful readiness check, not a worker event.
    const retiredPage = page;
    page = await context.newPage();
    const reloadDeadline = Date.now() + 15000;
    for (;;) {
      try {
        await page.goto(`chrome-extension://${testing.id}/options.html`);
        await page.locator('#endpoint').waitFor({ timeout: 2000 });
        break;
      } catch (error) {
        if (Date.now() >= reloadDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await retiredPage.close().catch(() => {});
    const state = await page.evaluate(async () => {
      const local = await chrome.storage.local.get(['settings.v1', 'providerKey.v1', 'workspace.channel.fixture']);
      const modelPresent = await new Promise((resolve, reject) => {
        const request = indexedDB.open('danlingo-local-models-v1', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('models').objectStore('models').get('workspace-fixture');
          get.onsuccess = () => { db.close(); resolve(get.result?.info?.id === 'workspace-fixture'); };
          get.onerror = () => reject(get.error);
        };
      });
      return { id: chrome.runtime.id, version: chrome.runtime.getManifest().version,
        build: await (await fetch('danlingo-build.json', { cache: 'no-store' })).json(),
        settingsPreserved: local['settings.v1']?.targetLanguage === 'fr' && local['settings.v1']?.model === 'fixture-model',
        persistedCredentialPreserved: local['providerKey.v1']?.value === 'fixture-not-a-real-credential',
        modelRegistrationPreserved: modelPresent, isolatedFromRelease: !local['workspace.channel.fixture'] };
    });
    assert.equal(state.id, testing.id);
    assert.equal(state.version, info.version);
    assert.deepEqual(state.build, expectedBuild);
    for (const key of ['settingsPreserved', 'persistedCredentialPreserved', 'modelRegistrationPreserved', 'isolatedFromRelease']) assert.equal(state[key], true, key);
    const directoryAfter = await stat(loadPath, { bigint: true });
    assert.equal(directoryAfter.ino, directoryBefore.ino);
    const releaseState = await releasePage.evaluate(async () => ({ version: chrome.runtime.getManifest().version,
      marker: (await chrome.storage.local.get('workspace.channel.fixture'))['workspace.channel.fixture'] }));
    assert.deepEqual(releaseState, { version: '0.3.0', marker: 'release-only' });
    report.checks.push({ snapshot: info.createdAt, ...state, directoryIdentityPreserved: true, releaseUnchanged: true });
  }
  await page.screenshot({ path: resolve(artifact, 'options-after-two-reloads.png'), fullPage: true });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed-or-unavailable';
  report.error = String(error.stack ?? error).slice(0, 2400);
  process.exitCode = 1;
} finally {
  await context?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(artifact, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
