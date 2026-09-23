// Run after a production build. Synthetic Bilibili native site + actual
// production extension + loopback mock provider; optional anonymous public
// Bilibili observation is kept separate from fixture evidence.
//
// node --experimental-strip-types scripts/verify-bilibili-video.mjs
//   [--fixture-only | --real-only] [--browser chromium|edge] [--headed]
//   [--build-dir PATH]
//   [--real-url https://www.bilibili.com/video/BV.../]
//   [--reviewed-core PATH_TO_STATIC_EVIDENCE_JSON]
import assert from 'node:assert/strict';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { isReviewedDanmakuBuild, REVIEWED_DANMAKU_BUILDS } from '../src/platforms/bilibili/video.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';
import { AID, BVID, FIRST_CID, FIRST_URL, REBUILT_CID, SECOND_CID, SECOND_URL, videoHtml } from '../test/fixtures/bilibili-video-native.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node --experimental-strip-types scripts/verify-bilibili-video.mjs [--fixture-only | --real-only] [--browser chromium|edge] [--headed] [--build-dir PATH] [--real-url URL] [--reviewed-core STATIC_EVIDENCE_JSON]\nUses a copied production extension, a synthetic Bilibili native fixture, and a loopback-only translation mock. Real mode defaults to BV1SQbW6dELM in an isolated anonymous profile. Optional reviewed-core replays an exact SHA-checked official core, separately labeled in the report.');
  process.exit(0);
}
const accepted = new Set(['--fixture-only', '--real-only', '--headed', '--browser', '--build-dir', '--real-url', '--reviewed-core']);
for (let i = 0; i < args.length; i++) {
  assert.ok(accepted.has(args[i]), `Unsupported argument: ${args[i]}`);
  if (['--browser', '--build-dir', '--real-url', '--reviewed-core'].includes(args[i])) i++;
}
const fixtureOnly = args.includes('--fixture-only');
const realOnly = args.includes('--real-only');
assert.ok(!(fixtureOnly && realOnly), 'Choose at most one focused run flag');
const option = (key, fallback) => { const index = args.indexOf(key); if (index < 0) return fallback; assert.ok(args[index + 1] && !args[index + 1].startsWith('--')); return args[index + 1]; };
const browserName = option('--browser', process.env.DANLINGO_E2E_BROWSER || 'chromium');
assert.ok(['chromium', 'edge'].includes(browserName));
const build = resolve(option('--build-dir', '.output/chrome-mv3'));
const realUrl = option('--real-url', 'https://www.bilibili.com/video/BV1SQbW6dELM/');
assert.match(realUrl, /^https:\/\/www\.bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av[1-9]\d*)\/(?:\?p=[1-9]\d*)?$/);
const reviewedCorePath = option('--reviewed-core', null);
let reviewedCore = null;
if (reviewedCorePath) {
  const evidence = JSON.parse(await readFile(resolve(reviewedCorePath), 'utf8'));
  const core = evidence.resources.find(row => row.label === 'core');
  assert.ok(isReviewedDanmakuBuild(evidence.version), 'Core replay requires a reviewed version/build pair');
  assert.match(core.url, /^https:\/\/s1\.hdslb\.com\/bfs\/static\/player\/main\/core\.[a-f0-9]+\.js$/);
  const response = await fetch(core.url); assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(body).digest('hex'), core.sha256.toLowerCase());
  reviewedCore = { url: core.url, sha256: core.sha256, body, metadata: { version: evidence.version.version, lastCompiled: evidence.version.lastCompiled } };
}
const delay = ms => new Promise(done => setTimeout(done, ms));
const exists = path => access(path).then(() => true, () => false);
const safeText = value => typeof value === 'string' ? value.slice(0, 240) : value;
const sourceId = (resourceId, id) => JSON.stringify(['bilibili', resourceId, String(id)]);
const KEY = 'bilibili-video-local-test-only';
const prefix = '【模拟译文】';

const artifactRoot = resolve(process.env.DANLINGO_BILIBILI_ARTIFACTS || '.artifacts/bilibili-video', browserName);
await mkdir(artifactRoot, { recursive: true });
const runDir = await mkdtemp(resolve(artifactRoot, 'run-'));
const report = {
  capturedAt: new Date().toISOString(), runDir,
  evidence: 'PRODUCTION_EXTENSION_SYNTHETIC_BILIBILI_NATIVE_LOCAL_MOCK; real public page is separately gated',
  status: 'running', phase: 'setup', checks: {}, requests: [], network: [], errors: [], screenshots: [],
  fixture: { status: fixtureOnly || realOnly ? (realOnly ? 'not-requested' : 'pending') : 'pending', checks: {} },
  real: { status: fixtureOnly ? 'not-requested' : 'pending', checks: {} },
  ...(reviewedCore ? { officialCoreReplay: { url: reviewedCore.url, sha256: reviewedCore.sha256, metadata: reviewedCore.metadata,
    limitation: 'Replays the exact official build observed on the user page in an isolated real page; not proof of its anonymous default deployment.' } } : {}),
  limitations: [
    'Synthetic fixture verifies the public window.player.danmaku.getDanmakuX boundary and the production extension; it does not prove every Bilibili renderer revision.',
    'The native source contract intentionally emits collectionComplete=false because Bilibili segment discovery is incremental; this check does not claim a full remote pool.',
    'The provider is a loopback mock only. No provider key, account, cookies, comments, or posting API is used; real mode remains anonymous and isolated.',
    'Fixture pause/play/seek/rate controls are harness-owned media state changes; they are not physical user input or Electron-native proof.',
    'Real replacement, when observed, uses natural native playback of the already decoded pool with a loopback provider; no add/insert call or comment posting is made by the harness.',
  ],
};
const persist = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
const held = new Set();
let context, options, page, rpc, server, endpoint, synthetic = true;
let phase = 'setup';

async function waitFor(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`);
}

async function check(name, fn, scope = 'fixture') {
  report.phase = phase = name;
  await persist();
  try {
    const result = await fn();
    report.checks[name] = { status: 'PASS', ...result };
    report[scope].checks[name] = report.checks[name];
    console.log(`PASS ${name}`);
    return result;
  } catch (error) {
    report.checks[name] = { status: 'FAIL', reason: String(error?.message ?? error) };
    report[scope].checks[name] = report.checks[name];
    throw error;
  } finally { await persist(); }
}

async function screenshot(name) {
  const path = resolve(runDir, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
  return path;
}

function fixtureEvidence() { return page.evaluate(() => window.__DL_BILI_EVIDENCE__ ?? { messages: [] }); }
function fixtureState() { return page.evaluate(() => window.__BILI_FIXTURE__?.snapshot?.()); }
function nativeEvidence() { return page.evaluate(() => window.__BILI_FIXTURE__?.nativeEvidence?.()); }
function messages(type) { return fixtureEvidence().then(value => value.messages.filter(row => !type || row.type === type)); }
function latestSnapshot() { return messages('snapshot').then(rows => rows.at(-1)); }
function sourceRows() { return messages('sources').then(rows => rows.flatMap(row => row.upserts || [])); }
function preparedRows() { return messages('prepared').then(rows => rows.flatMap(row => row.items || [])); }
function requestTexts() { return report.requests.flatMap(row => row.texts || []); }
function currentResource(pageNumber = 1, cid = FIRST_CID) { return `av${AID}:cid${cid}`; }

async function waitNative(resourceId, urlResourceId, timeout = 30000) {
  await waitFor(async () => {
    const native = await nativeEvidence(); const snapshot = await latestSnapshot();
    return native?.initWrapped && native?.insertWrapped && native?.identity?.cid &&
      snapshot?.resourceId === resourceId && snapshot?.urlResourceId === urlResourceId && snapshot?.session;
  }, `native attachment ${resourceId}` , timeout);
  await page.locator('[data-danlingo-player]').waitFor({ state: 'attached', timeout });
  return { native: await nativeEvidence(), snapshot: await latestSnapshot() };
}

async function waitSource(id, resourceId, timeout = 30000) {
  const dmid = await page.evaluate(value => window.__BILI_FIXTURE__?.sourceId?.(value) ?? value, id);
  return waitFor(async () => (await sourceRows()).find(row => row.resourceId === resourceId && row.sourceId === String(dmid)), `source ${id}` , timeout);
}

async function waitPrepared(id, resourceId, timeout = 60000) {
  const dmid = await page.evaluate(value => window.__BILI_FIXTURE__?.sourceId?.(value) ?? value, id);
  const expected = sourceId(resourceId, dmid);
  const session = (await latestSnapshot())?.session;
  return waitFor(async () => (await messages('prepared')).filter(row => row.session === session).flatMap(row => row.items || []).find(row => row.id === expected), `prepared ${id}`, timeout);
}

async function assertProgress(name) {
  const host = page.locator('#danlingo-progress');
  await host.waitFor({ state: 'visible', timeout: 20000 });
  const text = await host.evaluate(node => {
    const root = node.shadowRoot;
    return ['#progress-summary', '#coverage', '#near-progress', '#note'].map(selector => root?.querySelector(selector)?.textContent ?? '').join(' ');
  });
  assert.match(text, /已准备|读取评论池|读取中|分段预译中|暂无弹幕|无需翻译/);
  const playerBox = await page.locator('#playerWrap').boundingBox();
  const progressBox = await host.boundingBox();
  assert.ok(playerBox && progressBox && progressBox.y >= playerBox.y + playerBox.height - 1, 'progress must stay below the player, not overlay it');
  return { text: safeText(text), belowPlayer: true, screenshot: await screenshot(name) };
}

async function saveSettings(patch = {}) {
  const current = (await rpc({ type: 'settings' })).settings;
  const settings = normalizeSettings({ ...current, ...patch, enabled: patch.enabled ?? true, endpoint, allowLocalHttp: true, model: 'bilibili-video-fixture', profile: 'chat-completions', protocol: 'chat-completions', thinkingEffort: 'default', sourceLanguage: 'ja', targetLanguage: 'zh-Hans', translationScope: 'all', concurrency: 4, batchSize: 100, maxBatchChars: 12000, cacheMaxEntries: 20000 });
  const saved = await rpc({ type: 'save', settings, apiKey: KEY, remember: false });
  assert.equal(saved.ok, true, saved.error);
  return saved;
}

async function openFixture(empty = false) {
  synthetic = true;
  page = await context.newPage();
  await page.goto(FIRST_URL + (empty ? '&empty=1' : ''), { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  return waitNative(currentResource(1, FIRST_CID), `${BVID}:p1`);
}

async function renderFixture(id) {
  return page.evaluate(value => window.__BILI_FIXTURE__.render(value), id);
}

async function emptyPoolChecks() {
  const host = page.locator('#danlingo-progress');
  await check('empty-loaded-pool-finishes-reading-without-claiming-full-coverage', async () => {
    await host.waitFor({ state: 'visible' });
    await host.locator('summary').click();
    await waitFor(async () => (await host.locator('#progress-summary').textContent()) === '当前已加载范围暂无弹幕', 'empty pool status');
    assert.doesNotMatch(await host.locator('#coverage').textContent(), /读取中/);
    assert.match(await host.locator('#note').textContent(), /后续分段加载后/);
    assert.equal(report.requests.length, 0, 'empty pool sends no translations');
    const chunks = await messages('sources');
    assert.ok(chunks.some(row => row.complete && !row.upserts.length));
    assert.ok(chunks.every(row => row.collectionComplete === false));
    return assertProgress('fixture-empty-pool');
  });
  await check('empty-pool-accepts-later-danmaku-and-returns-to-empty', async () => {
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('after-empty', '後から届いたコメント', 3));
    await waitPrepared('after-empty', currentResource());
    await waitFor(async () => (await host.locator('#progress-summary').textContent()) === '已准备 1 / 1', 'late comment translated');
    await page.evaluate(() => window.player.danmaku.getDanmakuX().manager.dataBase.dmArray.splice(0));
    await waitFor(async () => (await host.locator('#progress-summary').textContent()) === '当前已加载范围暂无弹幕', 'pool empty again');
    assert.doesNotMatch(await host.locator('#coverage').textContent(), /读取中/);
    return { lateCommentPrepared: true, removalsApplied: true };
  });
  await check('loaded-but-excluded-danmaku-shows-no-translation-needed', async () => {
    const before = report.requests.length;
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('empty-special', '保留特殊样式', 3, 7));
    await waitFor(async () => (await host.locator('#progress-summary').textContent()) === '当前已加载范围无需翻译', 'excluded comment status');
    assert.match(await host.locator('#coverage').textContent(), /1 条 · 需翻译 0 条$/);
    assert.equal(report.requests.length, before);
    return { excludedCount: 1, noExtraRequests: true };
  });
  // Switch resources in the same document; the new pool must replace the empty state.
  await check('resource-switch-after-empty-state-loads-new-pool', async () => {
    await page.evaluate(() => {
      window.__BILI_FIXTURE__.addPool('swap-' + window.__BILI_FIXTURE__.state.cid, '切换前原文', 24);
      window.__BILI_FIXTURE__.switchPage(2, '62132');
    });
    await waitNative(currentResource(2, SECOND_CID), `${BVID}:p2`);
    await waitPrepared('mode-1', currentResource(2, SECOND_CID));
    await waitFor(async () => /^已准备 \d+ \/ [1-9]/.test(await host.locator('#progress-summary').textContent()), 'new resource preparation');
    return { emptyStateCleared: true };
  });
}

async function fixtureChecks() {
  phase = 'fixture-native';
  const first = await waitNative(currentResource(1, FIRST_CID), `${BVID}:p1`);
  await check('native-getDanmakuX-identity-config-video-hook-observed', async () => {
    const native = first.native;
    assert.deepEqual(native.metadata, { version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' });
    assert.deepEqual(native.identity, { bvid: BVID, aid: AID, cid: FIRST_CID, page: 1 });
    assert.equal(native.video.paused, true);
    assert.equal(native.video.currentTime, 0);
    assert.equal(native.video.playbackRate, 1);
    assert.equal(native.hook.own, true); assert.equal(native.hook.writable, true); assert.equal(native.hook.type, 'function');
    assert.equal(native.hook.wrapped, false); assert.equal(native.insertWrapped, true); assert.equal(native.initWrapped, true);
    assert.deepEqual(native.managerArrays, { dmArray: true, visualArray: true, allDm: true });
    return { metadata: native.metadata, identity: native.identity, getDanmakuCalls: native.getDanmakuCalls, hook: native.hook, managerArrays: native.managerArrays };
  });

  await check('incremental-native-pool-and-collectionComplete-false', async () => {
    const resourceId = currentResource(1, FIRST_CID);
    const initialSources = await waitSource('mode-1', resourceId);
    const initialRows = (await sourceRows()).filter(row => row.resourceId === resourceId);
    const nativeMessages = (await fixtureEvidence()).messages.filter(row => ['sources', 'snapshot'].includes(row.type));
    assert.ok(nativeMessages.length > 0 && nativeMessages.every(row => row.collectionComplete === false));
    const ids = await page.evaluate(() => Object.fromEntries(['mode-1', 'mode-4', 'mode-5', 'mode-6', 'special-7', 'special-8'].map(key => [key, window.__BILI_FIXTURE__.sourceId(key)])));
    assert.ok(initialRows.some(row => row.sourceId === ids['mode-1']));
    assert.equal(initialRows.some(row => row.sourceId === '999999999999999999'), false);
    const modes = new Map(initialRows.map(row => [row.sourceId, row.style?.position]));
    assert.deepEqual([modes.get(ids['mode-1']), modes.get(ids['mode-4']), modes.get(ids['mode-5']), modes.get(ids['mode-6'])], ['1', '4', '5', '6']);
    assert.equal(modes.get(ids['special-7']), '7');
    assert.equal(modes.get(ids['special-8']), '8');
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('incremental-late', '后续加载的分段弹幕', 44, 1));
    const appended = await waitSource('incremental-late', resourceId);
    assert.equal(appended.translatable, true);
    const incrementalDmid = await page.evaluate(() => window.__BILI_FIXTURE__.sourceId('incremental-late'));
    const laterMessages = (await fixtureEvidence()).messages.filter(row => row.type === 'sources' && row.upserts.some(item => item.sourceId === incrementalDmid));
    assert.ok(laterMessages.length > 0 && laterMessages.every(row => row.collectionComplete === false));
    return { initialRows: initialRows.length, incrementalSource: appended.sourceId, collectionComplete: false, historicalPoolIgnored: true };
  });

  await check('modes-1-4-5-6-translate-special-modes-stay-original', async () => {
    const resourceId = currentResource(1, FIRST_CID);
    const ordinary = [
      ['mode-1', '普通滚动弹幕'], ['mode-4', '顶部弹幕'], ['mode-5', '底部弹幕'], ['mode-6', '逆向弹幕'],
    ];
    for (const [id] of ordinary) await waitPrepared(id, resourceId);
    await waitPrepared('incremental-late', resourceId);
    const rendered = [];
    for (const [id, original] of ordinary) rendered.push({ id, ...(await renderFixture(id)), original });
    rendered.push({ id: 'incremental-late', ...(await renderFixture('incremental-late')), original: '后续加载的分段弹幕' });
    const special7 = await renderFixture('special-7');
    const special8 = await renderFixture('special-8');
    assert.ok(rendered.every(row => row.measured[0].startsWith(prefix)));
    assert.equal(special7.measured[0], '特殊样式保留原文');
    assert.equal(special8.measured[0], '命令样式保留原文');
    assert.equal(requestTexts().includes('特殊样式保留原文'), false);
    assert.equal(requestTexts().includes('命令样式保留原文'), false);
    return { translatedModes: ['1', '4', '5', '6'], incrementalTranslated: true, specialModesOriginal: ['7', '8'], rendered: rendered.map(row => ({ id: row.id, measured: safeText(row.measured[0]) })) };
  });

  await check('premeasure-long-text-clone-preserves-pool-and-active-models', async () => {
    const resourceId = currentResource(1, FIRST_CID);
    const setup = await page.evaluate(() => window.__BILI_FIXTURE__.addLongAndActive());
    await waitSource('long-check', resourceId); await waitPrepared('long-check', resourceId);
    const result = await page.evaluate(() => {
      const before = window.__BILI_FIXTURE__.snapshot();
      const insert = window.__BILI_FIXTURE__.render('long-check');
      const after = window.__BILI_FIXTURE__.snapshot();
      const pool = after.pool.find(row => row.id === 'long-check');
      const active = after.active.filter(row => ['active-a', 'active-b'].includes(row.id));
      return { measured: insert.measured[0], poolText: pool?.text, active, sourceLength: setupLength(before.pool, 'long-check') };
      function setupLength(rows, id) { return rows.find(row => row.id === id)?.text?.length ?? 0; }
    });
    assert.ok(result.measured.startsWith(prefix));
    assert.equal(result.poolText, '预译量'.repeat(120));
    assert.deepEqual(result.active.map(row => [row.id, row.text, row.modelText]), [['active-a', '活动模型原文-active-a', '活动模型原文-active-a'], ['active-b', '活动模型原文-active-b', '活动模型原文-active-b']]);
    assert.ok(result.sourceLength > 200);
    return { measuredTranslated: true, poolUnchanged: true, activeModelsUnchanged: true, sourceLength: result.sourceLength, measuredLength: result.measured.length };
  });

  await check('progress-reports-incremental-coverage-outside-player', async () => {
    const result = await assertProgress('fixture-progress-incremental');
    const text = result.text;
    assert.match(text, /读取中|分段预译中/);
    return result;
  });

  await check('pause-seek-rate-preserve-prepared-translation', async () => {
    const before = await latestSnapshot();
    const beforeRequests = report.requests.length;
    await page.evaluate(() => window.__BILI_FIXTURE__.setRate(1.5));
    await waitFor(async () => (await latestSnapshot())?.clock?.playbackRate === 1.5, 'rate snapshot');
    await page.evaluate(() => window.__BILI_FIXTURE__.play());
    await waitFor(async () => (await latestSnapshot())?.clock?.paused === false, 'playing snapshot');
    await page.evaluate(() => window.__BILI_FIXTURE__.pause());
    await waitFor(async () => (await latestSnapshot())?.clock?.paused === true, 'paused snapshot');
    const epoch = before?.epoch ?? 0;
    await page.evaluate(() => window.__BILI_FIXTURE__.setTime(42));
    const after = await waitFor(async () => { const snapshot = await latestSnapshot(); return snapshot?.clock?.mediaTimeMs === 42000 && snapshot.epoch > epoch ? snapshot : null; }, 'seek epoch');
    const rendered = await renderFixture('mode-1');
    assert.ok(rendered.measured[0].startsWith(prefix));
    await delay(1200);
    assert.equal(report.requests.length, beforeRequests, 'prepared seek should reuse the local prepared result');
    const state = await page.evaluate(() => window.__BILI_FIXTURE__.snapshot());
    assert.equal(state.native.history.playCalls, 1); assert.equal(state.native.history.pauseCalls, 1);
    return { initialEpoch: epoch, seekEpoch: after.epoch, mediaTimeMs: after.clock.mediaTimeMs, playbackRate: after.clock.playbackRate, paused: after.clock.paused, preparedReplay: true, extensionMediaCalls: { play: 0, pause: 0 } };
  });

  await check('same-url-cid-and-p-switch-fail-closed-before-old-insert', async () => {
    const oldResource = currentResource(1, FIRST_CID);
    await waitPrepared('swap-' + FIRST_CID, oldResource);
    const pageSwap = await page.evaluate(({ page, cid }) => window.__BILI_FIXTURE__.switchPage(page, cid), { page: 2, cid: SECOND_CID });
    assert.equal(pageSwap.measured[0], '资源切换前的长文本', 'old manager must not translate after URL/P changes before its next tick');
    const second = await waitNative(currentResource(2, SECOND_CID), `${BVID}:p2`);
    const oldRestored = await waitFor(async () => page.evaluate(() => window.__BILI_FIXTURE__.restorations().at(-1)), 'old page wrapper restoration');
    assert.deepEqual(oldRestored, { index: 0, hookRestored: true, insertRestored: true, initRestored: true });
    await waitSource('mode-1', currentResource(2, SECOND_CID));
    await waitPrepared('mode-1', currentResource(2, SECOND_CID));
    await waitPrepared('swap-' + SECOND_CID, currentResource(2, SECOND_CID));
    const cidSwap = await page.evaluate(cid => window.__BILI_FIXTURE__.rebuildCid(cid), REBUILT_CID);
    assert.equal(cidSwap.measured[0], '资源切换前的长文本', 'same URL with a rebuilt CID must fail closed before old insert');
    const rebuilt = await waitNative(currentResource(2, REBUILT_CID), `${BVID}:p2`);
    assert.notEqual(rebuilt.snapshot.session, second.snapshot.session);
    assert.equal(rebuilt.snapshot.resourceId, currentResource(2, REBUILT_CID));
    await waitSource('mode-1', currentResource(2, REBUILT_CID));
    await waitPrepared('mode-1', currentResource(2, REBUILT_CID));
    const currentRender = await renderFixture('mode-1');
    assert.ok(currentRender.measured[0].startsWith(prefix));
    return { pageSwitch: { oldResource, immediateOldMeasuredOriginal: true, newResource: currentResource(2, SECOND_CID) }, sameUrlCidRebuild: { oldMeasuredOriginal: true, newResource: currentResource(2, REBUILT_CID), sessionChanged: true }, oldWrappersRestored: true, currentResourceTranslated: true };
  });

  await check('disable-enable-and-pagehide-pageshow-lifecycle', async () => {
    const resourceId = currentResource(2, REBUILT_CID);
    const disabled = await rpc({ type: 'toggle', enabled: false });
    assert.equal(disabled.ok, true);
    await delay(800);
    const original = await renderFixture('mode-1');
    assert.equal(original.measured[0], '普通滚动弹幕');
    const enabled = await rpc({ type: 'toggle', enabled: true });
    assert.equal(enabled.ok, true);
    // Enabling affects future occurrences, not the native object still marked
    // active by the preceding unmodified insertion.
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('after-enable', '重新启用后的新弹幕', 46));
    await waitSource('after-enable', resourceId); await waitPrepared('after-enable', resourceId);
    const translated = await renderFixture('after-enable');
    assert.ok(translated.measured[0].startsWith(prefix));
    const beforeSession = (await latestSnapshot()).session;
    await page.evaluate(() => window.__BILI_FIXTURE__.spaDisableEnable());
    const rebound = await waitFor(async () => { const snapshot = await latestSnapshot(); return snapshot?.resourceId === resourceId && snapshot.session && snapshot.session !== beforeSession ? snapshot : null; }, 'pagehide/pageshow reattach');
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('after-pageshow', '页面恢复后的新弹幕', 47));
    await waitSource('after-pageshow', resourceId); await waitPrepared('after-pageshow', resourceId);
    const reboundRender = await renderFixture('after-pageshow');
    assert.ok(reboundRender.measured[0].startsWith(prefix));
    return { disabledOriginal: true, enabledTranslated: true, pagehidePageshowReattached: true, newSession: rebound.session };
  });

  await check('display-mode-and-fullscreen-preserve-native-output', async () => {
    const resourceId = currentResource(2, REBUILT_CID);
    assert.equal((await rpc({ type: 'toggle', displayMode: 'original' })).ok, true);
    await delay(600);
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('original-mode', '原文模式下的新弹幕', 48));
    const original = await renderFixture('original-mode');
    assert.equal(original.measured[0], '原文模式下的新弹幕');
    assert.equal((await rpc({ type: 'toggle', displayMode: 'translated' })).ok, true);
    await page.evaluate(() => window.__BILI_FIXTURE__.addPool('translated-mode', '译文模式下的新弹幕', 49));
    await waitSource('translated-mode', resourceId); await waitPrepared('translated-mode', resourceId);
    await page.locator('#fixture-fullscreen').click();
    await waitFor(() => page.evaluate(() => document.fullscreenElement?.id === 'playerWrap'), 'native fullscreen');
    await page.locator('#danlingo-progress').waitFor({ state: 'hidden', timeout: 5000 });
    assert.ok((await renderFixture('translated-mode')).measured[0].startsWith(prefix));
    await screenshot('fixture-fullscreen');
    await page.evaluate(() => document.exitFullscreen());
    await assertProgress('fixture-exit-fullscreen');
    return { originalMode: true, translatedMode: true, fullscreenNativeOutput: true, progressOutsidePlayer: true };
  });

  await check('reviewed-build-pairs-and-popup-diagnostic-recovery', async () => {
    const resourceId = currentResource(2, REBUILT_CID);
    const popup = await context.newPage();
    try {
      await popup.setViewportSize({ width: 390, height: 600 });
      await popup.goto(options.url().replace('/options.html', '/popup.html'));
      await page.bringToFront();
      const versions = [];
      for (const metadata of REVIEWED_DANMAKU_BUILDS) {
        await page.evaluate(value => Object.assign(window.__BILI_FIXTURE__.metadata, value), metadata);
        await waitFor(async () => (await rpc({ type: 'overview' })).status?.resourceId === resourceId, 'reviewed runtime status');
        const key = 'build-' + metadata.version;
        await page.evaluate(value => window.__BILI_FIXTURE__.addPool(value, '审核构建的新弹幕-' + value, 51), key);
        await waitSource(key, resourceId); await waitPrepared(key, resourceId);
        assert.ok((await renderFixture(key)).measured[0].startsWith(prefix));
        versions.push(metadata);
      }
      await page.evaluate(() => Object.assign(window.__BILI_FIXTURE__.metadata, { version: '9.9.9', lastCompiled: '2026-01-01T00:00:00+08:00' }));
      await waitFor(async () => { const value = await rpc({ type: 'overview' }); return !value.status && value.adapterDiagnostic?.code === 'unsupported-version'; }, 'unknown-build diagnosis');
      const requestsBefore = report.requests.length;
      await page.evaluate(() => window.__BILI_FIXTURE__.addPool('unknown-build', '未知构建不能送去翻译', 52));
      assert.equal((await renderFixture('unknown-build')).measured[0], '未知构建不能送去翻译');
      await waitFor(async () => /9\.9\.9.*尚未支持/.test(await popup.locator('#status').textContent()), 'popup specific failure');
      const screenshotPath = resolve(runDir, 'popup-unsupported-build.png');
      await popup.screenshot({ path: screenshotPath }); report.screenshots.push(screenshotPath);
      assert.equal(report.requests.length, requestsBefore, 'unsupported build admitted a provider request');

      // Restart the actual isolated extension background, retaining the same
      // page and its repeated native failure. No personal browser is attached.
      const worker = context.serviceWorkers().find(value => value.url().includes('/background.js'));
      assert.ok(worker); await worker.evaluate(() => { globalThis.__DL_DIAGNOSTIC_NONCE__ = 'before-restart'; });
      const cdp = await context.newCDPSession(options), workerVersions = new Map(), transitions = [];
      try {
        cdp.on('ServiceWorker.workerVersionUpdated', event => {
          for (const version of event.versions) { workerVersions.set(version.versionId, version);
            if (version.scriptURL === worker.url()) transitions.push(version.runningStatus); }
        });
        await cdp.send('ServiceWorker.enable');
        const version = await waitFor(() => [...workerVersions.values()].find(value => value.scriptURL === worker.url() && value.runningStatus === 'running'), 'active background version');
        transitions.length = 0;
        await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
        await waitFor(() => transitions.includes('stopped'), 'background stopped');
        await waitFor(async () => (await rpc({ type: 'overview' }).catch(() => null))?.adapterDiagnostic?.code === 'unsupported-version', 'diagnosis after background restart');
        const resumed = context.serviceWorkers().find(value => value.url() === worker.url());
        assert.ok(resumed); assert.equal(await resumed.evaluate(() => globalThis.__DL_DIAGNOSTIC_NONCE__ === undefined), true);
        assert.ok(transitions.includes('running'));
      } finally { await cdp.detach(); }
      await page.evaluate(() => window[Symbol.for('danlingo.bilibili.video.stop')]());
      await waitFor(async () => (await rpc({ type: 'overview' })).adapterDiagnostic?.code === 'native-unresponsive', 'expired native diagnosis', 12000);
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
      const unsupported = await rpc({ type: 'overview' }); assert.equal(unsupported.status, null); assert.equal(unsupported.adapterDiagnostic, null);
      await page.goto(FIRST_URL, { waitUntil: 'domcontentloaded' }); await page.bringToFront();
      await waitNative(currentResource(1, FIRST_CID), `${BVID}:p1`);
      await waitFor(async () => { const value = await rpc({ type: 'overview' }); return !!value.status && value.adapterDiagnostic === null; }, 'ready clears failure');
      await waitFor(async () => !/尚未支持|未收到|未响应|打开视频/.test(await popup.locator('#status').textContent()), 'popup recovery');
      return { versions, unknownOriginal: true, noUnknownProviderRequest: true, backgroundRestart: { transitions, freshMemory: true }, expiry: true, navigationCleared: true, recovered: true, screenshot: screenshotPath };
    } finally { await popup.close(); }
  });

  report.fixture.status = 'passed';
  report.fixture.final = { native: await nativeEvidence(), state: await fixtureState(), bridgeMessages: (await fixtureEvidence()).messages.length };
}

function publicNativeObservation() {
  return page.evaluate(() => {
    // These paths are the evidence-backed public boundary: window.player,
    // player.danmaku.getDanmakuX(), getManifest() and mediaElement(). If absent,
    // real acceptance is reported as unavailable rather than guessed.
    const player = window.player;
    const danmakuApi = player?.danmaku;
    if (!player || typeof danmakuApi?.getDanmakuX !== 'function') return null;
    const instance = danmakuApi.getDanmakuX();
    if (!instance || typeof instance.getMetadata !== 'function' || !instance.manager) return null;
    const config = player.getManifest?.();
    const video = typeof player.mediaElement === 'function' ? player.mediaElement() : null;
    const descriptor = instance?.hooks && Object.getOwnPropertyDescriptor(instance.hooks, 'beforeRender');
    const manager = instance?.manager;
    return { path: 'window.player.danmaku.getDanmakuX()', configPath: 'player.getManifest()', videoPath: 'player.mediaElement()', metadata: instance?.getMetadata?.(), identity: config && { bvid: config.bvid, aid: String(config.aid), cid: String(config.cid), page: Number(config.p) }, video: video && { currentTime: Number(video.currentTime), paused: !!video.paused, playbackRate: Number(video.playbackRate), duration: Number(video.duration), seeking: !!video.seeking }, hook: { own: !!descriptor, writable: descriptor?.writable === true, type: typeof instance?.hooks?.beforeRender }, manager: { dmArray: Array.isArray(manager?.dataBase?.dmArray), visualArray: Array.isArray(manager?.visualArray), insert: typeof manager?.insert === 'function' }, marker: [...document.querySelectorAll('[data-danlingo-player]')].map(node => node.getAttribute('data-danlingo-player')).filter(Boolean).slice(0, 3) };
  });
}

async function realChecks() {
  synthetic = false;
  report.phase = phase = 'real-public-page';
  assert.equal((await rpc({ type: 'toggle', enabled: true })).ok, true);
  page = await context.newPage();
  const target = realUrl;
  let navigation;
  try {
    navigation = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.bringToFront();
    const observed = await waitFor(async () => publicNativeObservation(), 'public Bilibili native player', 30000);
    report.real.checks.nativeBoundary = observed;
    assert.ok(isReviewedDanmakuBuild(observed.metadata), 'Unknown real native build remains unaccepted');
    if (reviewedCore) assert.deepEqual(observed.metadata, reviewedCore.metadata);
    assert.equal(observed.manager.dmArray, true); assert.equal(observed.manager.visualArray, true); assert.equal(observed.manager.insert, true);
    assert.equal(observed.hook.own, true); assert.equal(observed.hook.writable, true);
    const bridge = await waitFor(async () => { const value = await fixtureEvidence(); return value.messages.find(row => row.from === 'native' && row.type === 'snapshot' && row.resourceId?.startsWith('av') && row.session); }, 'production adapter real snapshot', 30000);
    const marked = await waitFor(async () => { const value = await publicNativeObservation(); return value?.marker?.length ? value : null; }, 'production player marker', 12000);
    report.real.checks.attach = { bridge: { resourceId: bridge.resourceId, urlResourceId: bridge.urlResourceId, session: bridge.session }, marker: marked.marker, configPath: observed.configPath, videoPath: observed.videoPath };
    const sources = await waitFor(async () => { const rows = (await messages('sources')).filter(row => row.resourceId === bridge.resourceId).flatMap(row => row.upserts || []); return rows.length ? rows : null; }, 'real native pool source', 30000);
    report.real.checks.incrementalPool = { observedSources: sources.length, collectionCompleteValues: [...new Set((await messages('sources')).map(row => row.collectionComplete))] };
    assert.ok(sources.length > 0);
    assert.ok((await messages('sources')).every(row => row.collectionComplete === false));

    const prepared = await waitFor(async () => { const rows = (await messages('prepared')).filter(row => row.session === bridge.session && row.items?.length).flatMap(row => row.items); return rows.length ? rows : null; }, 'real local-mock preparation', 45000);
    report.real.checks.localMockPrepared = { count: prepared.length, providerRequests: report.requests.length };
    // Replay within the already collected first segment using normal media
    // controls. Do not manually insert or re-emit a native danmaku model.
    await page.evaluate(async preparedIds => {
      const video = document.querySelector('#bilibili-player video') ?? (document.querySelectorAll('video').length === 1 ? document.querySelector('video') : null);
      if (!video) throw new Error('No unambiguous public native video element');
      const pool = window.player.danmaku.getDanmakuX().manager.dataBase.dmArray;
      const available = new Set(preparedIds);
      const first = pool.filter(item => available.has(String(item.dmid)) && item.stime >= 2).sort((a,b) => a.stime-b.stime)[0];
      video.muted = true; video.currentTime = first ? Math.max(0, first.stime - 1) : 2; await video.play();
    }, prepared.map(row => JSON.parse(row.id)[2]));
    const samples = [], translations = new Map();
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const sample = await page.evaluate(prefixValue => {
        const instance = window.player.danmaku.getDanmakuX(), manager = instance.manager;
        const pool = new Map(manager.dataBase.dmArray.map(value => [String(value.dmid), value]));
        const active = manager.visualArray.filter(model => [1,4,5,6].includes(model.textData?.mode));
        const ids = active.map(model => String(model.textData.dmid));
        const video = document.querySelector('#bilibili-player video') ?? document.querySelector('video');
        return { time: video?.currentTime, paused: video?.paused, active: active.length, duplicateIds: ids.length - new Set(ids).size,
          translated: active.filter(model => model.text?.startsWith(prefixValue)).slice(0, 60).map(model => ({ id: String(model.textData.dmid), width: model.width, height: model.height,
            textLength: model.text.length, originalLength: pool.get(String(model.textData.dmid))?.text?.length,
            poolOriginal: !!pool.get(String(model.textData.dmid)) && !pool.get(String(model.textData.dmid)).text.startsWith(prefixValue),
            nativeOn: pool.get(String(model.textData.dmid))?.on, shown: model.showed === true || !!model.element?.isConnected })) };
      }, prefix);
      samples.push(sample);
      for (const row of sample.translated) translations.set(row.id, row);
      await delay(100);
    }
    await page.evaluate(() => { for (const video of document.querySelectorAll('video')) video.pause(); });
    report.real.checks.naturalPlayback = { samples: samples.length, startTime: samples[0]?.time, endTime: samples.at(-1)?.time,
      distinctTranslated: translations.size, peakActive: Math.max(...samples.map(row => row.active)), maxDuplicateIds: Math.max(...samples.map(row => row.duplicateIds)),
      models: [...translations.values()].map(({ id, ...row }, index) => ({ label: index + 1, ...row })), screenshot: await screenshot('real-native-natural-playback-local-mock') };
    assert.ok(samples.at(-1)?.time > samples[0]?.time + 2, 'native media timeline did not advance');
    assert.ok(translations.size > 0, 'no natural native translated model was observed');
    assert.ok([...translations.values()].every(row => row.poolOriginal && row.width > 0 && row.height > 0), 'translated models must be natively measured while source text stays original');
    assert.ok(samples.every(row => row.duplicateIds === 0), 'consecutive native frames duplicated an occurrence');
    report.real.status = 'passed';
    report.real.final = { navigationStatus: navigation?.status() ?? null, observation: await publicNativeObservation(), bridgeMessages: (await fixtureEvidence()).messages.length };
  } catch (error) {
    const reason = String(error?.message ?? error);
    report.real.status = error?.code === 'ERR_ASSERTION' ? 'failed' : 'unavailable';
    report.real.reason = reason.slice(0, 800);
    report.real.navigationStatus = navigation?.status() ?? null;
    report.real.observation = await publicNativeObservation().catch(() => null);
    if (realOnly) throw error;
  }
}

try {
  server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    try {
      assert.equal(req.headers.authorization, `Bearer ${KEY}`);
      let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 1_000_000, 'mock request too large'); }
      const decoded = decodeTranslationFixtureRequest(JSON.parse(body));
      assert.ok(report.requests.length < 500, 'mock request budget exceeded');
      const row = { at: Date.now(), phase, protocol: decoded.protocol, ids: decoded.items.map(item => String(item.id)), texts: decoded.items.map(item => safeText(item.text)), count: decoded.items.length };
      report.requests.push(row);
      const reply = encodeTranslationFixtureResponse(decoded, decoded.items.map(item => ({ id: item.id, text: prefix + item.text })).reverse());
      res.setHeader('content-type', reply.contentType); res.end(reply.body);
      row.completedAt = Date.now();
    } catch (error) { report.errors.push(`mock: ${String(error?.message ?? error).slice(0, 300)}`); if (!res.headersSent) res.writeHead(500); res.end('{}'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;

  const manifestText = await readFile(resolve(build, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  report.build = { path: build, version: manifest.version, manifestSha256: createHash('sha256').update(manifestText).digest('hex') };
  const extension = resolve(runDir, 'test-extension');
  await cp(build, extension, { recursive: true });
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const { chromium } = await loadPlaywright();
  const launchOptions = { ...browserLaunchOptions(browserName), headless: !args.includes('--headed'), viewport: { width: 1360, height: 920 }, locale: 'zh-CN',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] };
  context = await chromium.launchPersistentContext(await mkdtemp(resolve(runDir, 'profile-')), launchOptions);
  report.browser = { name: browserName, version: context.browser()?.version() ?? null, headless: !args.includes('--headed') };
  await context.addInitScript(() => {
    if (window.top !== window) return;
    const evidence = { messages: [] };
    Object.defineProperty(window, '__DL_BILI_EVIDENCE__', { configurable: true, value: evidence });
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.bridge !== 'danlingo.native.v1') return;
      const value = event.data, row = { from: value.from, type: value.type, platform: value.platform, session: value.session, resourceId: value.resourceId, urlResourceId: value.urlResourceId, epoch: value.epoch, generation: value.generation, sourceGeneration: value.sourceGeneration, revision: value.revision, index: value.index, complete: value.complete, reset: value.reset, collectionComplete: value.collectionComplete, clock: value.clock ? { mediaTimeMs: value.clock.mediaTimeMs, durationMs: value.clock.durationMs, playbackRate: value.clock.playbackRate, paused: value.clock.paused, seeking: value.clock.seeking, contentActive: value.clock.contentActive } : undefined };
      if (value.type === 'sources') row.upserts = Array.isArray(value.upserts) ? value.upserts.slice(0, 500).map(item => ({ id: item.id, sourceId: item.sourceId, fixtureKey: item.fixtureKey, resourceId: item.resourceId, threadId: item.threadId, translatable: item.translatable, style: item.style && { position: item.style.position, size: item.style.size, color: item.style.color } })) : [];
      if (value.type === 'prepared') row.items = Array.isArray(value.items) ? value.items.slice(0, 200).map(item => ({ id: item.id, originalText: item.originalText, text: item.text })) : [];
      if (evidence.messages.length < 20000) evidence.messages.push(row);
    });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(endpoint).origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (synthetic && url.origin === 'https://www.bilibili.com' && (url.pathname.startsWith('/video/') || url.pathname === '/')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: url.pathname === '/' ? '<!doctype html><title>Unsupported homepage fixture</title>' : videoHtml });
    if (synthetic) { report.network.push({ blocked: true, origin: url.origin, path: url.pathname }); return route.abort(); }
    if (reviewedCore && url.origin === 'https://s1.hdslb.com' && /^\/bfs\/static\/player\/main\/core\.[a-f0-9]+\.js$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: reviewedCore.body });
    return route.continue();
  });
  context.on('request', request => { if (request.url() === endpoint && request.method() === 'POST') report.network.push({ mockProvider: true, serviceWorker: !!request.serviceWorker?.(), at: Date.now() }); });
  context.on('requestfailed', request => { if (!synthetic && report.network.length < 200) report.network.push({ failed: true, origin: new URL(request.url()).origin, path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? 'failed' }); });

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  rpc = payload => options.evaluate(value => chrome.runtime.sendMessage(value), payload);
  await waitFor(async () => Boolean(await options.locator('#key-state').textContent() || await options.locator('#result').textContent()), 'options ready');
  const saved = await saveSettings({ enabled: true });
  assert.equal(saved.hasKey, true);
  await rpc({ type: 'clear-cache' });

  if (!realOnly) {
    await openFixture(true);
    await emptyPoolChecks();
    await page.close(); page = null;
    await openFixture();
    await fixtureChecks();
    await rpc({ type: 'toggle', enabled: false }).catch(() => {});
    await page.close(); page = null;
  }
  if (!fixtureOnly) await realChecks();
  report.status = ['passed', 'not-requested'].includes(report.real.status) ? 'passed' : report.real.status === 'failed' ? 'failed' : 'partial';
  assert.ok(report.requests.length > 0, 'loopback provider was not exercised');
  assert.ok(report.network.some(value => value.mockProvider), 'mock provider request must come through the service worker');
  assert.equal(report.errors.length, 0, 'unexpected harness/mock errors');
} catch (error) {
  report.status = 'failed'; report.failure = String(error?.stack ?? error).slice(0, 4000); report.errors.push(String(error?.message ?? error).slice(0, 1000));
  if (synthetic && report.fixture.status === 'pending') report.fixture.status = 'failed';
  if (!synthetic && report.real.status === 'pending') report.real.status = 'failed';
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
} finally {
  await rpc?.({ type: 'toggle', enabled: false }).catch(() => {});
  await rpc?.({ type: 'delete-key' }).catch(() => {});
  if (page && !page.isClosed()) {
    report.finalEvidence = await fixtureEvidence().catch(() => null);
    report.finalNative = await nativeEvidence().catch(() => null);
    report.finalFixture = await fixtureState().catch(() => null);
  }
  await context?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ status: report.status, report: resolve(runDir, 'report.json'), fixture: report.fixture.status, real: report.real.status, requests: report.requests.length, errors: report.errors }, null, 2));
}
