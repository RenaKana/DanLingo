// Built extension with disposable OPFS files; no personal browser profile.
// This verifies the extension handoff, not native external-file grant persistence or real GPU loading.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { catalogs } from '../src/i18n/catalogs.ts';
const root = resolve('.artifacts/local-source-ui'); await mkdir(root, { recursive: true });
const run = await mkdtemp(resolve(root, 'run-'));
const extensionSource = resolve(process.argv[2] ?? '.output/chrome-mv3');
const report = { evidence: 'ISOLATED_BUILT_EXTENSION_OPFS_FIXTURE', extensionSource, browserBrand: 'edge', checks: [], screenshots: [], errors: [],
  offscreen: { pages: [], exceptions: [], apiSnapshots: [], captureErrors: [] },
  notVerified: ['Native external file permissions, browser restart and revocation', 'Real model GPU loading and end-to-end performance'] };
let context; let browserCdp; let extensionOrigin;
const discoveredTargets = new Map(); const offscreenSessions = new Map(); const offscreenTasks = new Map();
let nextOffscreenCommandId = 0;
const isOffscreenTarget = target => extensionOrigin && target.url === extensionOrigin + '/offscreen.html';
const observeOffscreenTarget = target => {
  if (!browserCdp || !isOffscreenTarget(target) || offscreenTasks.has(target.targetId) || offscreenSessions.has(target.targetId)) return;
  const task = (async () => {
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const diagnostic = { targetId: target.targetId, targetType: target.type, url: target.url, api: null };
    const state = { sessionId, diagnostic, pending: new Map() };
    offscreenSessions.set(target.targetId, state);
    report.offscreen.pages.push(diagnostic);
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextOffscreenCommandId;
      const timeout = setTimeout(() => { state.pending.delete(id); reject(new Error(`CDP target command timed out: ${method}`)); }, 5000);
      state.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); }
      });
      browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        const pending = state.pending.get(id);
        if (pending) { state.pending.delete(id); pending.reject(error); }
      });
    });
    await send('Runtime.enable');
    const result = await send('Runtime.evaluate', {
      expression: '({href:location.href,runtime:typeof chrome?.runtime,storage:typeof chrome?.storage,storageLocal:typeof chrome?.storage?.local,storageOnChanged:typeof chrome?.storage?.onChanged,storageLocalGet:typeof chrome?.storage?.local?.get})',
      returnByValue: true
    });
    diagnostic.api = result?.result?.value ?? null;
  })().catch(error => report.offscreen.captureErrors.push(`${target.url}: ${error.message}`));
  offscreenTasks.set(target.targetId, task);
  void task.finally(() => offscreenTasks.delete(target.targetId));
};
const rememberTarget = target => {
  discoveredTargets.set(target.targetId, target);
  observeOffscreenTarget(target);
};
try {
  const extension = resolve(run, 'extension'); await cp(extensionSource, extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  report.extensionVersion = manifest.version;
  assert.equal(typeof manifest.version, 'string'); assert.equal(manifest.default_locale, 'en');
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(run, 'profile'), { headless: true, ...browserLaunchOptions('edge'),
    viewport: { width: 1100, height: 850 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--no-first-run'] });
  await context.route(/^https?:/, route => route.abort());
  context.setDefaultTimeout(20000);
  browserCdp = await context.browser().newBrowserCDPSession();
  browserCdp.on('Target.targetCreated', ({ targetInfo }) => rememberTarget(targetInfo));
  browserCdp.on('Target.targetInfoChanged', ({ targetInfo }) => rememberTarget(targetInfo));
  browserCdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    let event; try { event = JSON.parse(message); } catch { return; }
    const state = [...offscreenSessions.values()].find(item => item.sessionId === sessionId);
    if (!state) return;
    if (event.id && state.pending.has(event.id)) {
      const pending = state.pending.get(event.id); state.pending.delete(event.id);
      event.error ? pending.reject(event.error) : pending.resolve(event.result);
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params?.exceptionDetails;
      report.offscreen.exceptions.push({ source: 'Runtime.exceptionThrown', text: details?.text ?? '',
        exception: details?.exception?.description ?? '', url: details?.url ?? state.diagnostic.url,
        lineNumber: details?.lineNumber, columnNumber: details?.columnNumber });
    } else if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      report.offscreen.exceptions.push({ source: 'Runtime.consoleAPICalled', url: state.diagnostic.url,
        args: event.params.args?.map(arg => arg.value ?? arg.description) ?? [] });
    }
  });
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });
  for (const target of (await browserCdp.send('Target.getTargets')).targetInfos) rememberTarget(target);
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    globalThis.__permissionRequests = []; globalThis.__pickerCalls = []; globalThis.__rpcTypes = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => { __rpcTypes.push(message.type); return send(message, ...rest); };
    const prototype = FileSystemFileHandle.prototype, request = prototype.requestPermission;
    prototype.requestPermission = function(options) { __permissionRequests.push(options); return request.call(this, options); };
    window.showOpenFilePicker = async options => { __pickerCalls.push({kind:'files',options,active:navigator.userActivation.isActive}); return [await (await navigator.storage.getDirectory()).getFileHandle('source-ui-fixture.gguf')]; };
    window.showDirectoryPicker = async options => { __pickerCalls.push({kind:'directory',options,active:navigator.userActivation.isActive}); return (await navigator.storage.getDirectory()).getDirectoryHandle('fixture-model-folder'); };
  });
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionOrigin = 'chrome-extension://' + new URL(background.url()).host;
  for (const target of discoveredTargets.values()) observeOffscreenTarget(target);
  for (const target of (await browserCdp.send('Target.getTargets')).targetInfos) rememberTarget(target);
  const origin = extensionOrigin;
  const source = await context.newPage(); source.on('pageerror', error => report.errors.push(error.message));
  // Populate only this disposable profile's OPFS. Header is deliberately weightless.
  await source.goto(origin + '/options.html');
  await source.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'en' }));
  await source.waitForFunction(() => document.querySelector('#result').textContent === 'Saved');
  assert.equal(await source.locator('#endpoint').inputValue(), '');
  assert.equal(await source.locator('#model').inputValue(), '');
  assert.equal(await source.locator('#profile').inputValue(), 'auto');
  await source.locator('#get-models').click();
  await source.waitForFunction(() => !document.querySelector('#get-models').disabled);
  await source.locator('#test-model').click();
  await source.waitForFunction(() => !document.querySelector('#test-model').disabled);
  assert.deepEqual(await source.evaluate(() => __rpcTypes.filter(type => ['models', 'test-model'].includes(type))), []);
  report.checks.push('fresh online fields remain empty, missing service prevents transport requests');
  await source.locator('#backend').selectOption('local');
  await source.evaluate(async () => {
    const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
    const u64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
    const str = s => { const b = new TextEncoder().encode(s); return [u64(b.length), b]; };
    const metadata = { 'general.architecture': 'llama', 'general.file_type': 15, 'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.tokens': ['hello'], 'tokenizer.chat_template': '{{ messages }}' };
    const parts = [u32(0x46554747), u32(3), u64(1), u64(Object.keys(metadata).length)];
    for (const [key, value] of Object.entries(metadata)) {
      parts.push(...str(key));
      if (typeof value === 'number') parts.push(u32(4), u32(value));
      else if (Array.isArray(value)) parts.push(u32(9), u32(8), u64(value.length), ...value.flatMap(str));
      else parts.push(u32(8), ...str(value));
    }
    const file = await (await navigator.storage.getDirectory()).getFileHandle('source-ui-fixture.gguf', { create: true });
    const writer = await file.createWritable(); await writer.write(new Blob(parts)); await writer.close();
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture-model-folder', {create:true});
    const nested = await folder.getFileHandle('folder-fixture.gguf', {create:true});
    const nestedWriter = await nested.createWritable(); await nestedWriter.write(new Blob(parts)); await nestedWriter.close();
    await chrome.storage.local.set({ 'ui.locale.v1': 'en' });
  });
  await source.waitForFunction(() => document.documentElement.lang === 'en');
  const initialPageCount = context.pages().length;
  await source.locator('#local-file-add').click();
  await source.waitForFunction(() => !document.querySelector('#local-file-add').disabled);
  const success = await source.locator('#local-result').innerText();
  assert.match(success, /1/); assert.equal(await source.locator('#local-result').evaluate(el => el.classList.contains('error')), false, success);
  assert.deepEqual(await source.evaluate(() => __permissionRequests), [{ mode: 'read' }]);
  const listed = await source.evaluate(() => chrome.runtime.sendMessage({ type: 'local-control', control: { action: 'list' } }));
  assert.equal(listed.models.length, 1); const model = listed.models[0];
  assert.equal(model.availability, 'ready'); assert.equal(model.metadataVersion, 1); assert.equal(model.fingerprint, undefined);
  assert.equal(listed.state.phase, 'idle');
  const rpc = async (page, control) => page.evaluate(control => chrome.runtime.sendMessage({ type: 'local-control', control }), control);
  for (const locale of ['en', 'zh-CN', 'ja', 'ar']) {
    await source.evaluate(code => chrome.storage.local.set({ 'ui.locale.v1': code }), locale);
    await source.waitForFunction(code => document.documentElement.lang === code, locale);
    assert.ok((await source.locator('#local-result').innerText()).startsWith(catalogs[locale]['modelManager.registered'].replace('{count}', new Intl.NumberFormat(locale).format(1))));
    assert.ok((await source.locator('#local-scan-status').innerText()).includes(catalogs[locale]['localSource.scanTimings'].split('{')[0]));
    const path = resolve(run, 'added-' + locale + '.png'); await source.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  }
  report.checks.push('file picker requests read permission, persists metadata and confirms offscreen access before localized success');
  assert.deepEqual(await source.evaluate(() => __pickerCalls.map(call => [call.kind, call.active, call.options.multiple])), [['files',true,true]]);
  assert.equal(context.pages().length, initialPageCount);
  assert.equal(await source.locator('#local-model').count(), 0);
  assert.equal(await source.locator('#local-model-manager').getAttribute('open'), '');
  const firstRow = source.locator('[data-model-id="' + model.id + '"]');
  assert.equal(await firstRow.locator('.local-source-kind').innerText(), catalogs.ar['modelManager.file']);
  assert.ok(!(await firstRow.locator('.local-directory-description > .subtle').innerText()).includes(model.source.directoryName + '/'));
  await source.locator('#local-folder-add').click();
  await source.waitForFunction(() => !document.querySelector('#local-folder-add').disabled);
  assert.equal((await rpc(source, {action:'list'})).models.length, 2);
  assert.equal((await source.evaluate(() => chrome.runtime.sendMessage({type:'overview'}))).settings.localModelId ?? '', '');
  assert.deepEqual(await source.evaluate(() => __pickerCalls.map(call => call.kind)), ['files','directory']);
  assert.equal((await source.evaluate(() => __pickerCalls.at(-1))).active, true);
  await source.evaluate(() => { window.showOpenFilePicker = async () => { throw new DOMException('cancelled','AbortError'); }; });
  await source.locator('#local-file-add').click();
  await source.waitForFunction(() => !document.querySelector('#local-file-add').disabled);
  assert.equal((await rpc(source, {action:'list'})).models.length, 2);
  assert.equal(await source.locator('#local-result').evaluate(el => el.classList.contains('error')), false);
  await source.evaluate(() => {
    globalThis.__readPermission = FileSystemFileHandle.prototype.requestPermission;
    FileSystemFileHandle.prototype.requestPermission = async () => 'denied';
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('source-ui-fixture.gguf')];
  });
  await source.locator('#local-file-add').click();
  await source.waitForFunction(() => !document.querySelector('#local-file-add').disabled);
  assert.equal(await source.locator('#local-result').evaluate(el => el.classList.contains('error')), true);
  assert.equal((await rpc(source, {action:'list'})).models.length, 2);
  await source.evaluate(() => { FileSystemFileHandle.prototype.requestPermission = __readPermission; });
  report.checks.push('separate direct pickers retain click activation, no intermediate page, source badges, folder registration and cancellation');
  report.checks.push('denied file authorization leaves the registered models unchanged');
  const settings = source;
  await settings.evaluate(() => chrome.storage.local.set({'ui.locale.v1':'en'}));
  await settings.locator('#model-test-options').evaluate(el => { el.open = true; });
  await settings.locator('#model-test-text').fill('unsaved test draft');
  // The fixture has a header but no weights: it reaches the real loader and fails without selecting another model.
  await firstRow.locator('[data-model-action="load"]').click();
  await settings.waitForFunction(() => !document.querySelector('[data-model-action="load"]').disabled);
  const load = await rpc(settings, { action: 'state' });
  assert.equal((await settings.evaluate(() => chrome.runtime.sendMessage({type:'overview'}))).settings.localModelId, model.id);
  assert.equal(await settings.locator('#model-test-text').inputValue(), 'unsaved test draft');
  assert.equal(await firstRow.locator('.local-model-state').innerText(), catalogs.en['modelManager.selected']);
  assert.equal(await settings.locator('#local-result').evaluate(el => el.classList.contains('error')), true);
  await settings.locator('#save').click();
  await settings.waitForFunction(() => document.querySelector('#result').textContent === 'Saved');
  const saved = await settings.evaluate(() => chrome.runtime.sendMessage({type:'overview'}));
  assert.equal(saved.settings.backend, 'local'); assert.equal(saved.settings.endpoint, ''); assert.equal(saved.settings.model, '');
  report.checks.push('row load persists selection on failure, retains drafts, local settings save with no online service');
  assert.equal(load.state.error, 'LOCAL_MODEL_LOAD_REJECTED');
  assert.equal(typeof load.state.loadTimings?.sourceMs, 'number'); assert.equal(load.state.loadTimings.metadataMs, 0);
  report.checks.push('direct first load reaches native weight rejection, with no permission error or header reparse');
  await rpc(settings, { action: 'unload' });
  const refreshed = await rpc(settings, { action: 'directory-scan' });
  assert.equal(refreshed.ok, true); assert.ok(refreshed.models.some(item => item.id === model.id));
  assert.equal(refreshed.scan.timings.headerMs, 0);
  report.checks.push('unchanged file refresh retains identity with zero header time');
  await settings.evaluate(() => { document.querySelector('#backend').value = 'local'; document.querySelector('#backend').dispatchEvent(new Event('change', { bubbles: true })); location.hash = 'service'; });
  for (const code of ['en', 'zh-CN', 'ja', 'ar']) {
    await settings.evaluate(code => chrome.storage.local.set({ 'ui.locale.v1': code }), code);
    await settings.waitForFunction(code => document.documentElement.lang === code, code);
    await settings.waitForFunction(() => document.querySelector('#local-scan-status').textContent.includes('0'));
    const text = await settings.locator('#local-scan-status').innerText();
    assert.ok(text.includes(catalogs[code]['localSource.scanTimings'].split('{')[0]), text);
    assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const path = resolve(run, 'refresh-' + code + '.png'); await settings.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  }
  await settings.setViewportSize({ width: 390, height: 800 });
  assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const narrow = resolve(run, 'refresh-ar-narrow.png'); await settings.screenshot({ path: narrow, fullPage: true }); report.screenshots.push(narrow);
  report.checks.push('source progress switches language including RTL and remains within desktop/narrow viewport');
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await Promise.allSettled([...offscreenTasks.values()]);
  await Promise.allSettled([...offscreenSessions.values()].map(({ sessionId }) => browserCdp?.send('Target.detachFromTarget', { sessionId })));
  await browserCdp?.detach().catch(() => {});
  await context?.close();
  await writeFile(resolve(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, version: report.extensionVersion, checks: report.checks, errors: report.errors,
    offscreen: report.offscreen, report: resolve(run, 'report.json') }));
}
