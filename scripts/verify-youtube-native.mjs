import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Run after a production build. Synthetic native YouTube site + actual extension + local mock.
import { settingsSection } from './settings-navigation.mjs';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';
import { ROOM, NEXT_ROOM, watchHtml, chatHtml, chatAdd } from '../test/fixtures/youtube-native-chat.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('node --experimental-strip-types scripts/verify-youtube-native.mjs [--browser chromium|edge] [--headed] [--build-dir PATH]\nUses an existing build copied into a unique isolated profile. Synthetic pages and local mock only; no real YouTube or provider traffic.'); process.exit(0); }
const option = (key, fallback) => { const i = args.indexOf(key); if (i < 0) return fallback; assert.ok(args[i + 1] && !args[i + 1].startsWith('--')); return args[i + 1]; };
for (let i = 0; i < args.length; i++) { assert.ok(['--headed', '--browser', '--build-dir'].includes(args[i]), 'Unsupported argument'); if (args[i] !== '--headed') i++; }
const browserName = option('--browser', 'chromium'); assert.ok(['chromium', 'edge'].includes(browserName));
const build = resolve(option('--build-dir', '.output/chrome-mv3'));
const base = resolve('.artifacts/live/native-chat'); await mkdir(base, { recursive: true });
const runDir = await mkdtemp(resolve(base, 'fixture-' + browserName + '-'));
const report = { capturedAt: new Date().toISOString(), runDir, evidence: 'SYNTHETIC_YOUTUBE_NATIVE_CHAT_PRODUCTION_EXTENSION_LOCAL_MOCK', status: 'running', checks: {}, requests: [], network: [], errors: [], screenshots: [], limitations: [
  'Synthetic native controller and DOM fixture; does not prove real YouTube Polymer compatibility, account behavior, or real provider translation quality.',
  'Actual copied production content scripts, native adapter, scheduler and background service worker; only copied manifest provider permission is changed.',
  'DOM insertion timestamps are observed, not physical display pixel timestamps. No YouTube requests, account login, chat posting, or real credentials.',
  'Background restart uses CDP stopped/running transitions and a lost worker-global nonce; does not simulate extension uninstall, profile loss, or physical browser restart.',
] };
const delay = ms => new Promise(done => setTimeout(done, ms));
const held = new Set(); let context, page, options, server, rpc, endpoint;
const prefix = '【模拟译文】';
const persist = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
async function waitFor(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(50); } throw new Error('Timed out: ' + label); }
async function check(name, fn) { report.phase = name; await persist(); try { report.checks[name] = { status: 'PASS', ...await fn() }; console.log('PASS ' + name); } catch (error) { report.checks[name] = { status: 'FAIL', reason: error.message }; throw error; } finally { await persist(); } }
const chat = () => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname === '/live_chat');
const state = () => page.evaluate(() => window.__YT_NATIVE_EVIDENCE__);
const frameState = () => chat().evaluate(() => ({ ...window.__YT_NATIVE_CHAT__.observed, hooks: window.__YT_NATIVE_CHAT__.hooks(), ids: [...document.querySelectorAll('yt-live-chat-text-message-renderer')].map(row => row.data.id) }));
const inject = action => chat().evaluate(action => window.__YT_NATIVE_CHAT__.add(action), action);
const action = value => chat().evaluate(value => window.__YT_NATIVE_CHAT__.action(value), value);
const insertion = id => waitFor(async () => (await frameState()).inserts.find(row => row.id === id), 'native insertion ' + id);
const submitted = id => waitFor(async () => (await state()).messages.find(row => row.from === 'adapter' && row.type === 'submitted' && row.sourceId === id), 'production submission ' + id);
const source = id => waitFor(async () => (await state()).messages.flatMap(row => row.events || []).find(row => row.sourceId === id), 'production intake ' + id);
async function connected(room = ROOM, previousSession) { await waitFor(async () => { const s = (await state())?.messages.filter(row => row.type === 'snapshot').at(-1); const frame = chat(); if (!frame) return false; const hooked = await frame.evaluate(() => window.__YT_NATIVE_CHAT__?.hooks().add).catch(() => false); return hooked && s?.resourceId === room && s.presentationActive === true && s.connection === 'connected' && (!previousSession || s.adapterSession !== previousSession); }, 'native active room ' + room); }
async function restored() { await waitFor(async () => { const h = (await frameState()).hooks; return !h.add && !h.action && h.batch; }, 'native methods restored'); }
async function save(patch) { const current = await rpc({ type: 'settings' }); const saved = await rpc({ type: 'save', settings: { ...current.settings, ...patch }, remember: false }); assert.equal(saved.ok, true); await page.bringToFront(); await connected(new URL(page.url()).searchParams.get('v')); }
async function screen(name) { const path = resolve(runDir, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path); }
function releaseHeld() { for (const done of held) done(); held.clear(); }

try {
  server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    try {
      let body = ''; for await (const part of req) { body += part; assert.ok(body.length < 1000000); }
      const decoded = decodeTranslationFixtureRequest(JSON.parse(body)); assert.ok(report.requests.length < 100, 'mock request budget');
      const row = { at: Date.now(), phase: report.phase, protocol: decoded.protocol, texts: decoded.items.map(item => item.text), held: decoded.items.some(item => item.text.includes('HELD_')) }; report.requests.push(row);
      if (row.held) await new Promise(done => held.add(done));
      else if (decoded.items.some(item => item.text.includes('ORDER_HEAD'))) await delay(550);
      row.respondedAt = Date.now(); row.connectionClosed = res.destroyed;
      const reply = encodeTranslationFixtureResponse(decoded, decoded.items.map(item => ({ id: item.id, text: prefix + item.text })).reverse());
      res.setHeader('content-type', reply.contentType); res.end(reply.body);
    } catch { report.errors.push('local-mock-invalid-request'); if (!res.headersSent) res.writeHead(500); res.end('{}'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const config = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, endpoint, allowLocalHttp: true, model: 'native-chat-fixture', profile: 'chat-completions', thinkingEffort: 'default',
    concurrency: 4, batchSize: 1, liveBufferMs: 2000, liveMaxBatchWaitMs: 0, liveSourceLanguage: 'ja', liveAdaptiveConcurrency: false });
  const manifestText = await readFile(resolve(build, 'manifest.json'), 'utf8');
  report.build = { path: build, manifestSha256: createHash('sha256').update(manifestText).digest('hex'), version: JSON.parse(manifestText).version };
  const extension = resolve(runDir, 'test-extension'); await cp(build, extension, { recursive: true });
  const manifest = JSON.parse(manifestText); manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(await mkdtemp(resolve(runDir, 'profile-')), { ...browserLaunchOptions(browserName), headless: !args.includes('--headed'), viewport: { width: 1320, height: 850 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  // All HTTP destinations are denied except the loopback mock and fulfilled fixture.
  await context.route('**/*', async route => { const url = new URL(route.request().url());
    if (url.origin === 'https://www.youtube.com' && ['/watch', '/live_chat'].includes(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: url.pathname === '/watch' ? watchHtml : chatHtml });
    if (url.origin === new URL(endpoint).origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
    report.network.push({ blocked: true, origin: url.origin, path: url.pathname }); return route.abort();
  });
  context.on('request', request => { if (request.url() === endpoint && request.method() === 'POST') report.network.push({ mockProvider: true, serviceWorker: !!request.serviceWorker(), at: Date.now() }); });
  await context.addInitScript(() => { if (window.top !== window) return; const evidence = { messages: [] }; window.__YT_NATIVE_EVIDENCE__ = evidence;
    window.addEventListener('message', event => { if (event.source === window && event.origin === location.origin && event.data?.bridge === 'danlingo-live-v1' && evidence.messages.length < 10000) evidence.messages.push({ ...event.data, observedAt: Date.now() }); });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  await waitFor(async () => !!await options.locator('#key-state').textContent() || !!await options.locator('#result').textContent(), 'options initial load');
  assert.equal((await rpc({ type: 'save', settings: config, apiKey: 'synthetic-native-fixture-only', remember: false })).ok, true);
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message.slice(0, 300)));
  await page.goto('https://www.youtube.com/watch?v=' + ROOM); await page.bringToFront(); await connected();

  await check('native-entry-baseline-paused-video', async () => {
    assert.deepEqual((await frameState()).hooks, { add: true, action: true, batch: true });
    assert.equal((await frameState()).inserts.find(row => row.id === 'baseline').text, '既存の履歴です');
    assert.equal((await state()).messages.flatMap(row => row.events || []).some(row => row.sourceId === 'baseline'), false);
    const snapshot = (await state()).messages.filter(row => row.type === 'snapshot').at(-1); assert.equal(snapshot.playback.paused, true); assert.equal(snapshot.presentationActive, true);
    assert.equal(await page.locator('#danlingo-live-overlay').count(), 0);
    return { actualNativeHooks: true, existingHistoryUntouched: true, chatActiveWithPausedVideo: true };
  });
  await check('early-ready-release-native-metadata', async () => {
    const input = chatAdd('early', 'これは早く届くテストです'); await inject(input); const intake = await source('early'), row = await insertion('early');
    assert.equal(row.text, prefix + input.item.liveChatTextMessageRenderer.message.simpleText);
    const { message: ignored, ...metadata } = row.data, { message: ignored2, ...expected } = input.item.liveChatTextMessageRenderer; assert.deepEqual(metadata, expected);
    assert.ok(row.at - intake.receivedAt < 1800, 'ready chat must not wait the full 2000ms buffer');
    assert.equal((await submitted('early')).translated, true);
    await waitFor(async () => (await state()).messages.some(row => row.type === 'displayed' && row.sourceId === 'early' && row.translated), 'native DOM presentation acknowledgement');
    return { releaseDelayMs: row.at - intake.receivedAt, metadataPreserved: true };
  });
  await check('ready-results-release-in-arrival-order', async () => {
    await inject(chatAdd('order-head', 'ORDER_HEAD 先頭の日本語です')); await source('order-head');
    await waitFor(() => report.requests.some(row => row.texts.some(text => text.includes('ORDER_HEAD'))), 'first provider request');
    await inject(chatAdd('order-tail', '後続の日本語が先に準備されます')); await source('order-tail');
    await insertion('order-head'); await insertion('order-tail');
    const rows = (await frameState()).inserts.filter(row => ['order-head', 'order-tail'].includes(row.id)); assert.deepEqual(rows.map(row => row.id), ['order-head', 'order-tail']); assert.ok(rows.every(row => row.text.startsWith(prefix)));
    const prepared = (await state()).messages.filter(row => row.type === 'prepared' && ['order-head', 'order-tail'].includes(row.sourceId)); assert.deepEqual(prepared.map(row => row.sourceId), ['order-tail', 'order-head'], 'fixture must actually receive tail result first');
    return { preparationOrder: prepared.map(row => row.sourceId), order: rows.map(row => row.id) };
  });
  await check('slow-head-original-timeout-no-late-rewrite', async () => {
    await inject(chatAdd('slow-head', 'HELD_TIMEOUT 遅い先頭の日本語です')); const intake = await source('slow-head');
    await waitFor(() => report.requests.some(row => row.texts.some(text => text.includes('HELD_TIMEOUT'))), 'held request started');
    await inject(chatAdd('slow-tail', '速い後続の日本語です')); await source('slow-tail');
    const head = await insertion('slow-head'), tail = await insertion('slow-tail');
    assert.equal(head.text, 'HELD_TIMEOUT 遅い先頭の日本語です'); assert.ok(head.at - intake.receivedAt >= 1700 && head.at - intake.receivedAt < 3000); assert.ok(tail.text.startsWith(prefix)); assert.ok(tail.at >= head.at);
    releaseHeld(); await delay(350);
    assert.equal((await frameState()).inserts.filter(row => row.id === 'slow-head').length, 1); assert.equal((await frameState()).mutations.filter(row => row.id === 'slow-head').length, 0);
    assert.equal(await chat().locator('[data-fixture-id="slow-head"] #message').textContent(), head.text);
    return { originalDeadlineMs: head.at - intake.receivedAt, immutableAfterLateProvider: true };
  });
  await check('rich-fragments-emoji-lines-native-scroll', async () => {
    const emoji = { emoji: { emojiId: 'fixture-custom', shortcuts: [':fixture_star:'], accessibility: { accessibilityData: { label: 'Synthetic star' } } } };
    const decorated = { text: '@fixture', bold: true, navigationEndpoint: { browseEndpoint: { browseId: 'fixture-channel' } } };
    await inject(chatAdd('rich', { runs: [{ text: '日本語の本文です\n次の行です ' }, emoji, decorated, { text: ' 最後の日本語です' }], accessibility: { accessibilityData: { label: 'Fixture rich message' } } }));
    const row = await insertion('rich'); assert.ok(row.text.startsWith(prefix)); assert.ok(row.text.includes('\n')); assert.ok(row.data.message.runs.some(run => JSON.stringify(run) === JSON.stringify(emoji))); assert.ok(row.data.message.runs.some(run => JSON.stringify(run) === JSON.stringify(decorated)));
    assert.equal(await chat().locator('[data-fixture-id="rich"] img.emoji').count(), 1); assert.equal(await chat().locator('[data-fixture-id="rich"] a').textContent(), '@fixture');
    await screen('native-chat-rich-fragments');
    for (let i = 0; i < 15; i++) await inject(chatAdd('scroll-' + i, '你好')); await insertion('scroll-14');
    assert.equal(await chat().evaluate(() => { const list = document.querySelector('yt-live-chat-item-list-renderer'); return list.scrollTop > 0 && Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 3; }), true);
    await screen('native-chat-rich-and-scroll'); return { richRunsPreserved: true, originalListScroll: true };
  });
  await check('hidden-original-handoff-reopen-future-only', async () => {
    await inject(chatAdd('hide-pending', 'HELD_HIDE 隠す前に届いた日本語です')); await source('hide-pending');
    await page.locator('#hide-chat').click(); await restored(); assert.equal((await insertion('hide-pending')).text, 'HELD_HIDE 隠す前に届いた日本語です');
    await inject(chatAdd('hidden-native', '隠れている間の日本語です')); await insertion('hidden-native');
    await page.locator('#hide-chat').click(); await connected(); releaseHeld();
    await inject(chatAdd('reopen-fresh', '再開後の新しい日本語です')); assert.ok((await insertion('reopen-fresh')).text.startsWith(prefix));
    assert.equal((await state()).messages.flatMap(row => row.events || []).some(row => row.sourceId === 'hidden-native'), false);
    assert.equal(await chat().locator('[data-fixture-id="hidden-native"] #message').textContent(), '隠れている間の日本語です');
    return { hiddenNativeOnly: true, reopenFutureOnly: true };
  });
  await check('top-all-native-selection', async () => {
    for (const coverage of ['top', 'all']) { await chat().getByRole('combobox', { name: 'Chat filter' }).selectOption(coverage); await waitFor(async () => (await state()).messages.filter(row => row.type === 'snapshot').at(-1)?.coverage === coverage, 'native coverage ' + coverage); await inject(chatAdd('filter-' + coverage, '選択したチャットの日本語です ' + coverage)); assert.ok((await insertion('filter-' + coverage)).text.startsWith(prefix)); }
    return { topAndAllTranslate: true };
  });
  await check('disable-restores-native-methods-and-pending-original', async () => {
    await inject(chatAdd('disable-pending', 'HELD_DISABLE 停止前の日本語です')); await source('disable-pending'); assert.equal((await rpc({ type: 'toggle', enabled: false })).ok, true); await restored();
    assert.equal((await insertion('disable-pending')).text, 'HELD_DISABLE 停止前の日本語です'); await inject(chatAdd('disabled', '無効中の日本語です')); assert.equal((await insertion('disabled')).text, '無効中の日本語です');
    assert.equal((await rpc({ type: 'toggle', enabled: true })).ok, true); await connected(); releaseHeld();
    await inject(chatAdd('enabled-fresh', '有効に戻った日本語です')); assert.ok((await insertion('enabled-fresh')).text.startsWith(prefix)); return { originalMethodsRestored: true };
  });
  await check('pending-removal-clear-and-native-replacement', async () => {
    for (const mode of ['remove', 'clear', 'replace']) {
      const id = 'cancel-' + mode; await inject(chatAdd(id, 'HELD_CANCEL_' + mode + ' 保留中の日本語です')); await source(id);
      const replacement = chatAdd('replacement-native', '公式の置換テキストです');
      await action(mode === 'remove' ? { removeChatItemAction: { targetItemId: id } } : mode === 'clear' ? { clearChatAction: {} } : { replaceChatItemAction: { targetItemId: id, replacementItem: replacement.item } });
      if (mode === 'replace') assert.equal((await insertion('replacement-native')).text, '公式の置換テキストです');
      releaseHeld(); await delay(150); assert.equal((await frameState()).inserts.some(row => row.id === id), false);
    }
    await inject(chatAdd('after-cancel', '削除後の新しい日本語です')); assert.ok((await insertion('after-cancel')).text.startsWith(prefix)); return { removedPendingNeverInserted: true, replacementMaterializedByNative: true };
  });
  await check('frame-replacement-abandons-old-work', async () => {
    await inject(chatAdd('old-frame', 'HELD_FRAME 古いフレームの日本語です')); await source('old-frame');
    const oldFrame = chat(), previousSession = (await state()).messages.filter(row => row.type === 'snapshot').at(-1).adapterSession; await page.evaluate(() => window.__YT_NATIVE_FIXTURE__.replaceFrame());
    await waitFor(() => chat() && chat() !== oldFrame, 'new chat frame'); await connected(ROOM, previousSession); releaseHeld();
    await inject(chatAdd('new-frame', '新しいフレームの日本語です')); assert.ok((await insertion('new-frame')).text.startsWith(prefix)); assert.equal((await frameState()).inserts.some(row => row.id === 'old-frame'), false); return { staleWorkNotInserted: true };
  });
  await check('spa-room-navigation-abandons-old-room', async () => {
    await inject(chatAdd('old-room', 'HELD_ROOM 古い部屋の日本語です')); await source('old-room');
    await page.evaluate(room => window.__YT_NATIVE_FIXTURE__.navigate(room), NEXT_ROOM); await connected(NEXT_ROOM); releaseHeld();
    await inject(chatAdd('new-room', '新しい部屋の日本語です')); assert.ok((await insertion('new-room')).text.startsWith(prefix)); assert.equal((await frameState()).inserts.some(row => row.id === 'old-room'), false);
    await screen('native-chat-after-room-navigation'); return { syntheticSpaLifecycle: true };
  });
  await check('background-restart-pending-original-and-fresh-recovery', async () => {
    await inject(chatAdd('restart-pending', 'HELD_RESTART 再起動前の保留メッセージです')); const intake = await source('restart-pending');
    await waitFor(() => report.requests.some(row => row.texts.some(text => text.includes('HELD_RESTART'))), 'pending HTTP before worker restart');
    await worker.evaluate(() => { globalThis.__DL_NATIVE_RESTART_NONCE__ = 'synthetic-worker-memory-marker'; });
    const cdp = await context.newCDPSession(options), versions = new Map(), transitions = []; report.workerRestart = { transitions };
    try {
      cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) { versions.set(version.versionId, version); if (version.scriptURL === worker.url()) transitions.push({ at: Date.now(), versionId: version.versionId, runningStatus: version.runningStatus }); } });
      await cdp.send('ServiceWorker.enable');
      const version = await waitFor(() => [...versions.values()].find(value => value.scriptURL === worker.url() && value.status === 'activated' && value.runningStatus === 'running'), 'active worker CDP version');
      const stoppedAt = Date.now(); report.workerRestart.stoppedAt = stoppedAt; await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      await waitFor(() => transitions.some(value => value.at >= stoppedAt && value.runningStatus === 'stopped'), 'CDP stopped worker');
      const original = await insertion('restart-pending'); assert.equal(original.text, 'HELD_RESTART 再起動前の保留メッセージです');
      report.workerRestart.pendingOriginalDelayMs = original.at - intake.receivedAt;
      const overview = await rpc({ type: 'overview' }); assert.equal(overview.ok, true); assert.equal(overview.hasKey, true); assert.equal(overview.remembered, false);
      await waitFor(() => transitions.some(value => value.at >= stoppedAt && value.runningStatus === 'running'), 'CDP restarted worker');
      const resumed = context.serviceWorkers().find(value => value.url() === worker.url()); assert.ok(resumed); assert.equal(await resumed.evaluate(() => globalThis.__DL_NATIVE_RESTART_NONCE__ === undefined), true);
      report.workerRestart.freshWorkerMemory = true; report.workerRestart.sessionCredentialRetained = true;
      await connected(NEXT_ROOM); releaseHeld(); await inject(chatAdd('restart-fresh', '再起動後の新しい日本語です')); assert.ok((await insertion('restart-fresh')).text.startsWith(prefix));
      assert.ok(report.requests.some(row => row.texts.some(text => text.includes('再起動後の新しい日本語です'))));
      assert.equal((await frameState()).inserts.filter(row => row.id === 'restart-pending').length, 1); assert.equal(await chat().locator('[data-fixture-id="restart-pending"] #message').textContent(), original.text);
      return { transitions, freshWorkerMemory: true, sessionCredentialRetained: true, pendingOriginalDelayMs: original.at - intake.receivedAt, freshMessageViaMock: true };
    } finally { await cdp.detach().catch(() => {}); }
  });
  await check('background-diagnostics-native-metrics-and-safe-export', async () => {
    const diagnostics = await waitFor(async () => { const result = await rpc({ type: 'live-diagnostics' }); return result.ok && result.status?.resourceId === NEXT_ROOM && result.status.liveMetrics?.translated >= 2 && result.status.liveMetrics?.original >= 1 ? result : null; }, 'trusted background diagnostics native counters');
    assert.ok(diagnostics.status.liveMetrics.presented >= 3); assert.ok(diagnostics.status.liveMetrics.readinessMs.samples >= 2); assert.ok(diagnostics.status.liveMetrics.translatedChars > 0);
    await settingsSection(options,'data'); await options.locator('details').filter({ has: options.locator('#export-diagnostics') }).locator('summary').click();
    const downloadPromise = options.waitForEvent('download'); await options.locator('#export-diagnostics').click(); const download = await downloadPromise;
    const artifact = resolve(runDir, 'safe-runtime-diagnostics.json'); await download.saveAs(artifact); const exportedText = await readFile(artifact, 'utf8'), exported = JSON.parse(exportedText);
    assert.equal(exported.schema, 'danlingo-runtime-diagnostics'); assert.equal(exported.page.platform, 'youtube'); assert.ok(exported.page.liveMetrics.translated >= 2); assert.ok(exported.page.liveMetrics.original >= 1); assert.ok(exported.page.liveMetrics.translatedChars > 0);
    assert.ok(exported.globalEngine.counts.providerCalls >= 1);
    for (const forbidden of ['synthetic-native-fixture-only', endpoint, NEXT_ROOM, '再起動後の新しい日本語です']) assert.equal(exportedText.includes(forbidden), false, 'export must omit credentials, endpoint, room identity and comment body');
    return { rpcNativeMetrics: diagnostics.status.liveMetrics, exportedNativeMetrics: exported.page.liveMetrics, artifact, privacySafeExport: true };
  });
  assert.ok(report.requests.length > 0); assert.ok(report.network.some(row => row.mockProvider && row.serviceWorker));
  assert.equal(report.network.some(row => row.blocked && row.path.includes('youtubei')), false, 'production adapter must not independently fetch YouTube');
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.failure = error.message; console.error(error.stack); process.exitCode = 1; if (page) await screen('failure').catch(() => {}); }
finally {
  releaseHeld(); if (page) { report.finalEvidence = await state().catch(() => null); report.finalNative = await frameState().catch(() => null); }
  await context?.close().catch(() => {}); if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  report.finishedAt = new Date().toISOString(); await persist(); console.log(JSON.stringify({ status: report.status, report: resolve(runDir, 'report.json'), screenshots: report.screenshots }));
}
