import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Synthetic DOM acceptance for the keyed live-repair panel. This intentionally
// does not contact a provider or native adapter; it exercises the public UI
// contract and the bounded request/scan state machine in an isolated browser.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const moduleUri = async file => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(await readFile(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ ...browserLaunchOptions("chromium"), headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
const pageErrors = []; page.on('pageerror', error => pageErrors.push(error?.stack || String(error)));
await page.route('https://fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' }));
await page.goto('https://fixture.invalid/');
const output = resolve('.artifacts/live/live-repair-stability'); await mkdir(output, { recursive: true });
const repairs = await moduleUri('src/ui/live-repairs.ts');
const report = { status: 'INCOMPLETE', checks: {}, calls: 0, scans: 0, cancellations: 0, maxConcurrent: 0,
  evidence: 'SYNTHETIC_DOM_KEYED_LIVE_REPAIR_PANEL', limitation: 'No provider, native adapter, Electron compositor, or real platform page.' };

const waitFor = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 10000 });
const sourceIds = page => page.evaluate(() => [...window.__fixture.calls].map(row => row.sourceId));

try {
  await page.setContent(`<meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#eef4ef}main{padding:20px;width:650px}#mount{min-height:20px}</style><main><div id="mount"></div></main>`);
  const security = await page.evaluate(() => ({ href: location.href, secure: isSecureContext, randomUUID: typeof crypto.randomUUID }));
  assert.equal(security.secure, true, 'synthetic fixture must use a secure origin');
  assert.equal(security.randomUUID, 'function', 'crypto.randomUUID must be available for request IDs');
  await page.evaluate(async ({ repairs }) => {
    const { createLiveRepairs } = await import(repairs);
    const calls = [], scans = [], cancels = [], pending = new Map(); let active = 0, maxActive = 0, autoResolve = false, view;
    const request = value => {
      calls.push({ ...value }); active++; maxActive = Math.max(maxActive, active);
      return new Promise(resolve => {
        pending.set(value.requestId, output => { active--; pending.delete(value.requestId); resolve(output); });
        if (autoResolve) queueMicrotask(() => pending.get(value.requestId)?.({ id: value.requestId, status: 'translated', text: '自动译文-' + value.sourceId }));
      });
    };
    view = createLiveRepairs({
      request,
      timeoutMs: () => 10000,
      scan(scope, scanId) { scans.push({ scope, scanId }); },
      cancel(requestId) {
        cancels.push(requestId);
        pending.get(requestId)?.({ id: requestId, status: 'expired' });
      },
    });
    document.querySelector('#mount').append(view.host);
    window.__fixture = {
      view, calls, scans, cancels, pending,
      get active() { return active; }, get maxActive() { return maxActive; },
      setAutoResolve(value) { autoResolve = value; },
      reply(sourceId, text = '合成译文', status = 'translated') {
        const call = [...calls].reverse().find(row => row.sourceId === sourceId);
        if (call) pending.get(call.requestId)?.({ id: call.requestId, status, text });
      },
      replyRequest(requestId, text = '合成译文', status = 'translated') { pending.get(requestId)?.({ id: requestId, status, text }); },
      replyAll() { for (const call of [...calls]) pending.get(call.requestId)?.({ id: call.requestId, status: 'translated', text: '批量译文-' + call.sourceId }); },
      chunk(chunk) { return view.scanChunk(chunk); },
      state() { return { pending: pending.size, active, calls: calls.length, scans: scans.length, cancels: cancels.length }; },
    };
  }, { repairs });

  await page.evaluate(() => {
    const v = window.__fixture.view;
    for (let i = 0; i < 85; i++) v.capture('base-' + i, '原文-' + i, 'unprocessed');
  });
  await page.getByText('近期弹幕补翻', { exact: true }).click();
  await waitFor(page, () => document.querySelector('#danlingo-live-repairs')?.shadowRoot?.querySelectorAll('.entry').length === 85);

  // Hold the actual pointer down on a real button while inserting 35 newer
  // rows and long results above it. The target source must remain the one that
  // receives the eventual click, with its node, selection and button center
  // anchored in place.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const target = await page.evaluate(() => {
    const host = document.querySelector('#danlingo-live-repairs'), list = host.shadowRoot.querySelector('#items');
    list.scrollTop = 520; const row = list.querySelector('[data-source-id="base-40"]') || list.querySelector('.entry'); row.scrollIntoView({ block: 'center' });
    const button = row.querySelector('button'), source = row.querySelector('.source'), range = document.createRange();
    range.selectNodeContents(source); range.setStart(source.firstChild, 0); range.setEnd(source.firstChild, Math.min(4, source.textContent.length));
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); button.focus();
    const rect = button.getBoundingClientRect(); window.__fixture.pointerTarget = { row, button, sourceId: row.dataset.sourceId, center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, selected: selection.toString() };
    return window.__fixture.pointerTarget;
  });
  const beforePointer = await page.evaluate(() => {
    const host = document.querySelector('#danlingo-live-repairs'), target = window.__fixture.pointerTarget;
    const list = host.shadowRoot.querySelector('#items'), menu = host.shadowRoot.querySelector('.menu');
    const rect = target.button.getBoundingClientRect(), listRect = list.getBoundingClientRect(), menuRect = menu.getBoundingClientRect();
    return { center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, buttonTop: rect.top, listTop: listRect.top, menuTop: menuRect.top, scrollTop: list.scrollTop };
  });
  assert.ok(Math.abs(beforePointer.center.x - target.center.x) < 1.5, 'settled target x changed before pointer move');
  assert.ok(Math.abs(beforePointer.center.y - target.center.y) < 1.5, 'settled target y changed before pointer move');
  await page.mouse.move(target.center.x, target.center.y); await page.mouse.down();
  const atPointerDown = await page.evaluate(() => {
    const host = document.querySelector('#danlingo-live-repairs'), target = window.__fixture.pointerTarget;
    const list = host.shadowRoot.querySelector('#items'), menu = host.shadowRoot.querySelector('.menu');
    const rect = target.button.getBoundingClientRect(), listRect = list.getBoundingClientRect(), menuRect = menu.getBoundingClientRect();
    return { buttonTop: rect.top, listTop: listRect.top, menuTop: menuRect.top, scrollTop: list.scrollTop };
  });
  assert.ok(Math.abs(atPointerDown.buttonTop - beforePointer.buttonTop) < 1.5, 'button moved before pointer down');
  assert.ok(Math.abs(atPointerDown.listTop - beforePointer.listTop) < 1.5, 'list moved before pointer down');
  assert.ok(Math.abs(atPointerDown.menuTop - beforePointer.menuTop) < 1.5, 'menu moved before pointer down');
  const held = await page.evaluate(() => {
    const host = document.querySelector('#danlingo-live-repairs'), list = host.shadowRoot.querySelector('#items'), target = window.__fixture.pointerTarget;
    const selection = document.getSelection(); const source = target.row.querySelector('.source'), range = document.createRange(); range.selectNodeContents(source); range.setStart(source.firstChild, 0); range.setEnd(source.firstChild, Math.min(4, source.textContent.length)); selection.removeAllRanges(); selection.addRange(range);
    for (let i = 0; i < 35; i++) window.__fixture.view.capture('held-insert-' + i, '按下期间插入-' + i, 'unprocessed');
    for (let i = 0; i < 4; i++) {
      window.__fixture.view.capture('long-above-' + i, '长结果上方-' + i, 'unprocessed');
      window.__fixture.view.sync('long-above-' + i, { state: 'translated', text: '长'.repeat(1800), resultVersion: i + 1, application: 'generated' });
    }
    const after = host.shadowRoot.querySelector(`[data-source-id="${target.sourceId}"]`), button = after.querySelector('button'), rect = button.getBoundingClientRect();
    return { sameRow: after === target.row, sameButton: button === target.button, focused: host.shadowRoot.activeElement === target.button, selected: selection.toString(), center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, first: host.shadowRoot.querySelector('.entry')?.dataset.sourceId, scrollTop: list.scrollTop, targetTop: button.getBoundingClientRect().top };
  });
  assert.equal(held.sameRow, true); assert.equal(held.sameButton, true); assert.equal(held.focused, true); assert.equal(held.selected, target.selected); assert.equal(held.first, 'long-above-3');
  assert.ok(Math.abs(held.center.x - target.center.x) < 1.5, `held button x moved ${held.center.x - target.center.x}px`);
  assert.ok(Math.abs(held.center.y - target.center.y) < 1.5, `held button y moved ${held.center.y - target.center.y}px`);
  await page.mouse.up();
  await waitFor(page, ({ sourceId }) => window.__fixture.calls.some(row => row.sourceId === sourceId), { sourceId: target.sourceId });
  assert.equal((await sourceIds(page)).at(-1), target.sourceId, 'pointer down/up requests the exact target source');
  await page.evaluate(({ sourceId }) => window.__fixture.reply(sourceId, '按下目标译文'), target);
  await waitFor(page, ({ sourceId }) => document.querySelector('#danlingo-live-repairs')?.shadowRoot?.querySelector(`[data-source-id="${sourceId}"] .text`)?.textContent === '按下目标译文', target);

  // Keyboard activation retains the keyed row and uses its saved original.
  await page.evaluate(() => window.__fixture.view.capture('keyboard-row', '键盘原文', 'unprocessed'));
  const keyboard = page.locator('[data-source-id="keyboard-row"] button'); await keyboard.focus(); await keyboard.press('Enter');
  await waitFor(page, () => window.__fixture.calls.some(row => row.sourceId === 'keyboard-row'));
  const keyboardCall = await page.evaluate(() => [...window.__fixture.calls].reverse().find(row => row.sourceId === 'keyboard-row'));
  assert.equal(keyboardCall.originalText, '键盘原文'); await page.evaluate(() => window.__fixture.reply('keyboard-row', '键盘译文')); await waitFor(page, () => window.__fixture.pending.size === 0);

  // A pressed/active row is retained as a disabled tombstone when the five
  // minute retention boundary is crossed, and only the ending interaction can
  // remove it. It must never become a request for a newer row.
  await page.evaluate(() => { const v = window.__fixture.view; v.clear(); for (let i = 0; i < 300; i++) v.capture('press-' + i, '按压保留-' + i, 'unprocessed'); });
  await waitFor(page, () => document.querySelector('#danlingo-live-repairs')?.shadowRoot?.querySelectorAll('.entry').length === 300);
  const pressed = await page.evaluate(() => {
    const host = document.querySelector('#danlingo-live-repairs'), list = host.shadowRoot.querySelector('#items'); list.scrollTop = list.scrollHeight;
    const row = list.querySelector('[data-source-id="press-0"]'), button = row.querySelector('button'), rect = button.getBoundingClientRect();
    window.__fixture.pressRow = row;
    return { sourceId: row.dataset.sourceId, center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  });
  await page.mouse.move(pressed.center.x, pressed.center.y); await page.mouse.down();
  const tombstone = await page.evaluate(() => {
    const dateNow = Date.now, now = dateNow(); Date.now = () => now + 301000;
    try { window.__fixture.view.capture('ttl-trigger', '触发保留边界', 'unprocessed'); } finally { Date.now = dateNow; }
    const host = document.querySelector('#danlingo-live-repairs'), row = host.shadowRoot.querySelector('[data-source-id="press-0"]'), button = row?.querySelector('button');
    return { retained: !!row, disabled: !!button?.disabled, tombstone: row?.dataset.tombstone, sameRow: row === window.__fixture.pressRow };
  });
  assert.equal(tombstone.retained, true); assert.equal(tombstone.disabled, true); assert.equal(tombstone.tombstone, 'true'); assert.equal(tombstone.sameRow, true);
  const callsBeforeTombstoneUp = await page.evaluate(() => window.__fixture.calls.length); await page.mouse.up();
  await waitFor(page, () => !document.querySelector('#danlingo-live-repairs')?.shadowRoot?.querySelector('[data-source-id="press-0"]'));
  assert.equal(await page.evaluate(() => window.__fixture.calls.length), callsBeforeTombstoneUp, 'tombstone ending interaction does not request');

  await page.evaluate(() => { const v = window.__fixture.view; v.clear(); for (let i = 0; i < 340; i++) v.capture('retained-' + i, '保留记录-' + i, 'unprocessed'); });
  await waitFor(page, () => document.querySelector('#danlingo-live-repairs')?.shadowRoot?.querySelectorAll('.entry').length === 300);
  assert.equal(await page.locator('[data-source-id="retained-0"]').count(), 0); assert.equal(await page.locator('[data-source-id="retained-339"]').count(), 1);

  // Recent-only batch compatibility: unneeded remains explicitly retryable,
  // while translated/native-pending/unsupported rows are excluded.
  await page.evaluate(() => {
    const v = window.__fixture.view; v.clear();
    v.capture('batch-a', '批量可翻A', 'unprocessed'); v.capture('batch-unneeded', '批量可翻无需翻译', 'unneeded');
    v.capture('batch-translated', '批量已翻译', 'unprocessed'); v.sync('batch-translated', { state: 'translated', text: '已有译文', resultVersion: 1 });
    v.capture('batch-pending', '批量原生排队', 'queued'); v.sync('batch-pending', { state: 'translating', requestId: 'native-pending' });
    v.capture('batch-unsupported', '批量不支持', 'unprocessed', 'manual', false);
  });
  await page.getByRole('button', { name: '补翻近期未译', exact: true }).click(); await waitFor(page, () => window.__fixture.calls.length >= 2);
  const recentCalls = await sourceIds(page); assert.deepEqual(new Set(recentCalls.slice(-2)), new Set(['batch-a', 'batch-unneeded']));
  await page.evaluate(() => document.querySelector('#danlingo-live-repairs').shadowRoot.querySelector('#batch').dispatchEvent(new MouseEvent('click', { bubbles: true }))); assert.deepEqual(await sourceIds(page), recentCalls, 'repeated recent-only batch click coalesces');
  await page.evaluate(() => window.__fixture.replyAll()); await waitFor(page, () => window.__fixture.pending.size === 0 && window.__fixture.active === 0);

  // Full batch: fixed recent snapshot plus 350 loaded candidates arrives in
  // 100-item chunks. UI retention remains 300 rows, but the detached batch
  // snapshot dispatches every unique loaded candidate with concurrency <=4.
  await page.evaluate(() => {
    const v = window.__fixture.view; v.clear(); window.__fixture.setAutoResolve(false);
    for (let i = 0; i < 5; i++) v.capture('recent-' + i, '固定近期-' + i, 'unprocessed');
  });
  const scansBeforeFull = await page.evaluate(() => window.__fixture.scans.length); await page.locator('#danlingo-live-repairs').getByRole('button', { name: '一键补翻漏译', exact: true }).click();
  await waitFor(page, before => window.__fixture.scans.length > before, scansBeforeFull);
  const fullScan = await page.evaluate(() => window.__fixture.scans.at(-1)); assert.equal(fullScan.scope, 'loaded'); assert.match(fullScan.scanId, /^[0-9a-f-]{36}$/i);
  const fullCallsBeforeChunks = await page.evaluate(() => window.__fixture.calls.length);
  await page.evaluate(() => window.__fixture.view.capture('during-arrival', '批次开始后的新消息', 'unprocessed'));
  await page.locator('#danlingo-live-repairs').getByRole('button', { name: '一键补翻漏译', exact: true }).click();
  assert.equal(await page.evaluate(before => window.__fixture.scans.length === before, scansBeforeFull + 1), true, 'duplicate full-batch click coalesces');
  await page.evaluate(() => window.__fixture.setAutoResolve(true));
  const loaded = Array.from({ length: 350 }, (_, i) => ({ sourceId: 'loaded-' + i, originalText: '已加载-' + i, state: 'unprocessed' }));
  const chunks = [loaded.slice(0, 100), [loaded[0], ...loaded.slice(100, 200)], loaded.slice(200, 300), [loaded[100], ...loaded.slice(300)]];
  for (let index = 0; index < chunks.length; index++) await page.evaluate(({ scanId, chunk, done }) => window.__fixture.chunk({ scanId, candidates: chunk, status: 'supported', done }), { scanId: fullScan.scanId, chunk: chunks[index], done: index === chunks.length - 1 });
  await page.evaluate(() => window.__fixture.replyAll());
  await waitFor(page, () => window.__fixture.active === 0 && window.__fixture.pending.size === 0 && window.__fixture.calls.length >= 355, undefined);
  const fullSources = await sourceIds(page), fullBatchSources = fullSources.slice(fullCallsBeforeChunks);
  assert.equal(fullBatchSources.includes('during-arrival'), false, 'new arrivals are outside fixed batch');
  assert.equal(new Set(fullBatchSources).size, fullBatchSources.length, 'loaded identity dedupe');
  assert.ok(fullBatchSources.filter(sourceId => /^loaded-\d+$/.test(sourceId)).length >= 350, 'all 350 loaded candidates dispatched');
  assert.ok((await page.evaluate(() => window.__fixture.maxActive)) <= 4); assert.equal(await page.locator('.entry').count(), 300, 'UI retention stays at 300 while batch snapshot is larger');

  // Stop only the current batch: a separate single-row request survives and
  // completes, while the loaded scan and batch requests are cancelled.
  await page.evaluate(() => {
    const v = window.__fixture.view; v.clear(); window.__fixture.setAutoResolve(false);
    v.capture('single-request', '单条请求', 'unprocessed'); v.capture('stop-0', '停止批次0', 'unprocessed'); v.capture('stop-1', '停止批次1', 'unprocessed');
  });
  await page.locator('[data-source-id="single-request"] button').click(); await waitFor(page, () => window.__fixture.calls.some(row => row.sourceId === 'single-request'));
  const singleCall = await page.evaluate(() => [...window.__fixture.calls].reverse().find(row => row.sourceId === 'single-request').requestId);
  const scansBeforeStop = await page.evaluate(() => window.__fixture.scans.length); await page.locator('#danlingo-live-repairs').getByRole('button', { name: '一键补翻漏译', exact: true }).click();
  await waitFor(page, before => window.__fixture.scans.length > before, scansBeforeStop); const stopScan = await page.evaluate(() => window.__fixture.scans.at(-1));
  const callsBeforeStop = await page.evaluate(() => window.__fixture.calls.length); await page.getByRole('button', { name: '停止补翻', exact: true }).click();
  assert.equal(await page.evaluate(({ id }) => window.__fixture.cancels.includes(id), { id: singleCall }), false, 'single request is not cancelled with batch');
  assert.equal(await page.evaluate(({ id }) => window.__fixture.cancels.includes(id), { id: stopScan.scanId }), true, 'loaded scan is cancelled');
  await page.evaluate(({ scanId }) => window.__fixture.chunk({ scanId, candidates: [{ sourceId: 'after-stop', originalText: '停止后不应追加', state: 'unprocessed' }], status: 'supported', done: true }), stopScan);
  assert.equal(await page.evaluate(before => window.__fixture.calls.length === before, callsBeforeStop), true, 'stale scan does not dispatch after stop');
  await page.evaluate(({ id }) => window.__fixture.replyRequest(id, '单条完成译文'), { id: singleCall }); await waitFor(page, () => window.__fixture.pending.size === 0 && window.__fixture.active === 0);
  assert.equal((await page.locator('[data-source-id="single-request"] .text').textContent()), '单条完成译文');

  report.calls = await page.evaluate(() => window.__fixture.calls.length); report.scans = await page.evaluate(() => window.__fixture.scans.length); report.cancellations = await page.evaluate(() => window.__fixture.cancels.length); report.maxConcurrent = await page.evaluate(() => window.__fixture.maxActive);
  report.checks = { secureSyntheticOrigin: true, settledPointerGeometry: true, actualPointerDownUpTargetIdentity: true, highInsertionAnchorSelectionFocus: true, longResultsAboveAnchor: true, keyboardAndOriginalText: true, ttlPressedTombstoneAndCleanup: true, uiRetention300: true, recentBatchCompatibility: true, loaded350DetachedSnapshot: true, loadedIdentityDedupe: true, boundedConcurrency4: true, duplicateBatchCoalescing: true, stopScopedToBatch: true, newArrivalsExcluded: true };
  report.pageErrors = pageErrors; report.status = 'PASS'; await page.screenshot({ path: resolve(output, 'live-repair-stability.png') }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS live-repair keyed stability and batch lifecycle');
} catch (error) {
  report.pageErrors = pageErrors; report.error = error?.stack || String(error); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.error(report.error); process.exitCode = 1;
} finally { await browser.close(); }
