import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real original GGUF + built production extension; ONLY the YouTube surface is synthetic.
// Run: node --experimental-strip-types scripts/verify-local-live-multisequence.mjs [model.gguf]
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { LOCAL_DEFAULT_CONFIG } from '../src/local/config.ts';
import { ROOM, watchHtml, chatHtml, chatAdd } from '../test/fixtures/youtube-native-chat.mjs';
import { traceNativeActions } from './native-action-trace.mjs';
import { buildProviderPayload } from '../src/translation/provider.ts';

const modelPath = resolve(process.argv[2] ?? 'D:/Tool/Models/LmStudioModels/lmstudio-community/HY-MT1.5-1.8B-FP8/HY-MT1.5-1.8B-Q8_0.gguf');
const chineseSource = process.env.DANLINGO_VERIFY_ZH_JA === '1';
const placeholderProbe = process.env.DANLINGO_VERIFY_PLACEHOLDERS === '1';
const placeholderSource = '看了给你 🔒，包包，你解说很舒服';
if (placeholderProbe) assert.ok(chineseSource, 'placeholder screenshot probe requires Chinese to Japanese');
const traceNative = process.env.DANLINGO_VERIFY_NATIVE_TRACE === '1';
const settleMs = Number(process.env.DANLINGO_VERIFY_SETTLE_MS ?? 125000);
const artifacts = resolve(chineseSource ? '.artifacts/local-zh-ja' : '.artifacts/local-live-multisequence');
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(resolve(artifacts, 'run-'));
const extension = resolve(directory, 'extension');
const started = Date.now(), budgetMs = 300_000, deadlineMs = Number(process.env.DANLINGO_VERIFY_DEADLINE_MS ?? 2000), timerToleranceMs = 250;
assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60000);
const sources = chineseSource ? [
  '早上好，很高兴见到大家。', '今天天气真不错。', '我特别喜欢这首歌。', '这只猫真的好可爱。',
  '期待下一场比赛。', '声音有一点小。', '你解释得很清楚。', '这顶帽子很适合你。',
  '昨天的视频我也看了。', '在这里休息一下吧。', '新的地图好大啊。', '我会支持你到最后。',
  '我去喝点茶。', '那道菜看起来很好吃。', '刚才的动作好快啊。', '大家一起加油吧。',
] : [
  'おはようございます。', '今日はいい天気ですね。', 'この曲が大好きです。', '猫がかわいいですね。',
  '次の試合も楽しみです。', '音が少し小さいです。', '説明が分かりやすいです。', 'その帽子は似合いますね。',
  '昨日の動画も見ました。', 'ここで休憩しましょう。', '新しい地図が広いですね。', '最後まで応援します。',
  'お茶を飲んできます。', 'その料理はおいしそうです。', '今の動きは速かったです。', 'みんなで一緒に頑張ろう。',
];
const ordinary = sources.map((source, index) => ({ id: `normal-${index}`, source, kind: 'ordinary' }));
const paid = chineseSource ? [
  { id: 'sc-0', source: placeholderProbe ? placeholderSource : '谢谢你带来这么有趣的直播，不要太勉强自己，记得好好休息。', kind: 'paid' },
  { id: 'sc-1', source: '今天的挑战我会支持到最后，我们下次直播再见。', kind: 'paid' },
] : [
  { id: 'sc-0', source: 'いつも楽しい配信をありがとうございます。無理をせずに休んでください。', kind: 'paid' },
  { id: 'sc-1', source: '今日の挑戦を最後まで応援しています。また次の配信で会いましょう。', kind: 'paid' },
];
const report = {
  capturedAt: new Date().toISOString(), evidence: 'REAL_GGUF_WEBGPU_PRODUCTION_LIVE_ENGINE_SYNTHETIC_YOUTUBE_DOM',
  directory, modelPath, deadlineMs, timerToleranceMs, ordinary, paid, checks: {}, samples: [],
  errors: [], network: { syntheticFulfilled: [], blocked: [] }, screenshots: [],
  limitations: [
    'Synthetic YouTube native incoming ordinary actions and synthetic DOM paid rows; not real YouTube or real paid messages.',
    'One bounded burst establishes deadline/state behavior, not steady-state throughput or translation semantic quality.',
    'GPU evidence is native device verification/full layer offload and native slot telemetry, not physical GPU utilization.',
    'Two-second snapshot records its actual capture delay; deadline assertions allow 250 ms of timer scheduling tolerance.',
  ],
};
let context, page, options, rpc, profile, modelId, original, watchdogFired = false;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function bounded(promise, label, ms = 10_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, label, ms = 20_000) {
  const end = Math.min(started + budgetMs - 15_000, Date.now() + ms);
  while (Date.now() < end && !watchdogFired) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
}
function check(name, condition, detail) {
  report.checks[name] = { passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) };
  if (!condition) report.errors.push(`CHECK FAILED: ${name}`);
}
const frame = () => page?.frames().find(value => new URL(value.url() || 'about:blank').pathname === '/live_chat');
async function state() {
  const response = await rpc({ type: 'local-control', control: { action: 'state' } });
  assert.equal(response.ok, true, response.error);
  return response.state;
}
async function sample(label) {
  const value = await state();
  if (value.gpu?.nativeActionTrace) {
    report.nativeActionTrace = value.gpu.nativeActionTrace;
    delete value.gpu.nativeActionTrace;
  }
  report.samples.push({ label, at: Date.now(), state: value });
  if (value.phase === 'error') throw new Error(value.error ?? 'Local native inference error');
  return value;
}
async function capture(name) {
  if (process.env.DANLINGO_VERIFY_NO_CAPTURE === '1') return;
  if (!page || page.isClosed()) return;
  const file = resolve(directory, `${name}.png`);
  await bounded(page.screenshot({ path: file }), `screenshot ${name}`);
  report.screenshots.push(file);
}
async function evidence() {
  return { bridge: await page.evaluate(() => window.__DL_LIVE_BRIDGE__),
    dom: await frame().evaluate(() => ({ records: window.__DL_LIVE_DOM__.records,
      changes: window.__DL_LIVE_DOM__.changes, snapshot2s: window.__DL_LIVE_DOM__.snapshot2s,
      inserts: window.__YT_NATIVE_CHAT__.observed.inserts })) };
}
async function inject(rows, snapshot = false) {
  await frame().evaluate(({ rows, snapshot, deadlineMs }) => {
    const fixture = window.__YT_NATIVE_CHAT__, capture = window.__DL_LIVE_DOM__;
    const hooks = fixture.hooks();
    if (!hooks.add || !hooks.action || !hooks.batch) throw new Error('Native hook fingerprint changed before injection');
    for (const row of rows) {
      capture.records[row.id] = { ...row, receivedAt: Date.now() };
      if (row.kind === 'ordinary') fixture.add(row.action);
      else {
        // Paid rows are detected by the production automatic Super Chat repair observer.
        const element = document.createElement('yt-live-chat-paid-message-renderer');
        element.dataset.fixtureId = row.id;
        element.style.cssText = 'display:block;padding:8px;background:#145e7a;color:white';
        element.data = { id: row.id, message: { simpleText: row.source },
          authorName: { simpleText: 'Synthetic donor' }, purchaseAmountText: { simpleText: '$10.00' } };
        const author = document.createElement('span'); author.textContent = `${row.id} · $10.00 `;
        const message = document.createElement('span'); message.id = 'message'; message.textContent = row.source;
        element.append(author, message); document.querySelector('yt-live-chat-item-list-renderer').append(element);
      }
    }
    if (snapshot) setTimeout(() => {
      capture.scan();
      capture.snapshot2s = { capturedAt: Date.now(), rows: structuredClone(capture.records) };
    }, deadlineMs);
    capture.scan();
  }, { rows: rows.map(row => ({ ...row, ...(row.kind === 'ordinary' ? { action: chatAdd(row.id, row.source) } : {}) })), snapshot, deadlineMs });
}

const watchdog = setTimeout(() => {
  watchdogFired = true;
  report.errors.push('300 second hard runtime budget exceeded');
  void writeFile(resolve(directory, 'watchdog-report.json'), JSON.stringify(report, null, 2));
  void context?.close().catch(error => report.errors.push(`Watchdog browser close: ${error.message}`));
}, budgetMs);

try {
  await (async () => {
  original = await stat(modelPath);
  assert.ok(original.isFile() && original.size > 0, 'Expected an existing original GGUF file');
  assert.equal(new Set(sources).size, sources.length);
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  if (traceNative) {
    const nativePath = resolve(extension, 'local/wllama-worker.js');
    await writeFile(nativePath, traceNativeActions(await readFile(nativePath, 'utf8')));
    report.evidence += '_WITH_ISOLATED_NUMERIC_NATIVE_TRACE';
  }
  if (process.env.DANLINGO_VERIFY_FENCE === '1') {
    const nativePath = resolve(extension, 'local/wllama-worker.js');
    const probe = `
      const dlRequestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function(...args) {
        const device = await dlRequestDevice.apply(this, args), queue = device.queue;
        queue.onSubmittedWorkDone = async () => {
          const fence = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          try {
            const encoder = device.createCommandEncoder(); encoder.clearBuffer(fence); queue.submit([encoder.finish()]);
            await fence.mapAsync(GPUMapMode.READ); fence.unmap();
          } finally { fence.destroy(); }
        };
        return device;
      };
    `;
    await writeFile(nativePath, probe + await readFile(nativePath, 'utf8'));
    report.evidence += '_WITH_ISOLATED_READBACK_FENCE';
  }
  const { chromium } = await loadPlaywright();
  profile = await mkdtemp(resolve(directory, 'profile-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, ...browserLaunchOptions("chromium"),
    viewport: { width: 1360, height: 850 }, args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  const emptyChat = chatHtml.replace(/^owner\.handleAddChatItemAction_\(\{item:\{liveChatTextMessageRenderer:\{id:'baseline'.*$/m, '');
  assert.ok(!emptyChat.includes("id:'baseline'"));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://www.youtube.com' && ['/watch', '/live_chat'].includes(url.pathname)) {
      report.network.syntheticFulfilled.push(url.href);
      return route.fulfill({ status: 200, contentType: 'text/html', body: url.pathname === '/watch' ? watchHtml : emptyChat });
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      report.network.blocked.push(url.href); return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__DL_LIVE_BRIDGE__ = [];
    window.addEventListener('message', event => {
      const data = event.data;
      if (event.source === window && data?.bridge === 'danlingo-live-v1' && data.from === 'adapter') {
        if (window.__DL_LIVE_BRIDGE__.length < 20_000) window.__DL_LIVE_BRIDGE__.push({ at: Date.now(), data });
      }
    });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  rpc = message => bounded(options.evaluate(message => chrome.runtime.sendMessage(message), message), 'extension RPC', 130_000);
  await options.locator('#backend').selectOption('local');
  await options.locator('#local-file').setInputFiles(modelPath);
  await options.locator('#local-import').click();
  let importStatus = '';
  modelId = await until(async () => {
    const current = await options.locator('#local-result').textContent();
    if (current !== importStatus) { importStatus = current; console.log('IMPORT', current); }
    if (await options.locator('#local-result').evaluate(el => el.classList.contains('error'))) throw new Error(`Import failed: ${current}`);
    return options.locator('#local-model').inputValue();
  }, 'isolated original HY-MT import', 90_000);
  console.log('STAGE imported');
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, backend: 'local', localModelId: modelId,
    model: 'HY-MT1.5-1.8B-Q8_0', profile: 'chat-completions', thinkingEffort: 'default', superChatThinkingEffort: 'inherit',
    superChatTimeoutMs: 120_000, requestTimeoutMs: 120_000, thinkingRequestTimeoutMs: 120_000,
    sourceLanguage: chineseSource ? 'zh' : 'ja', liveSourceLanguage: chineseSource ? 'zh' : 'ja', targetLanguage: chineseSource ? 'ja' : 'zh-Hans', batchSize: 100, concurrency: 32,
    liveAdaptiveConcurrency: false, liveMaxBatchWaitMs: 0, liveBufferMs: deadlineMs, localPerformance: { ...LOCAL_DEFAULT_CONFIG },
  });
  assert.equal((await rpc({ type: 'save', settings, apiKey: '', remember: false })).ok, true);
  assert.equal((await rpc({ type: 'local-control', control: { action: 'load', modelId, config: settings.localPerformance } })).ok, true);
  report.loaded = await until(async () => { const value = await state(); if (value.phase === 'error') throw new Error(value.error); return value.phase === 'ready' && value; }, 'warm model ready');
  console.log('STAGE loaded', report.loaded.loadMs);
  check('actualNativeGpuFullOffload', report.loaded.gpu?.verified === true && report.loaded.gpu.offloadedLayers > 0 && report.loaded.gpu.offloadedLayers === report.loaded.gpu.totalLayers, report.loaded.gpu);
  check('runtimeAutoFour', report.loaded.runtime?.mode === 'auto' && report.loaded.runtime.parallel === 4, report.loaded.runtime);
  assert.ok(report.checks.actualNativeGpuFullOffload.passed && report.checks.runtimeAutoFour.passed, 'Expected real GPU and runtime auto=4');
  report.settings = settings;
  if (chineseSource) {
    report.modelTest = await rpc({ type: 'test-model', settings, text: sources[0], context: 'live' });
    console.log('MODEL_TEST', JSON.stringify(report.modelTest));
    check('singleTestChineseToJapaneseUsesHyPrompt', report.modelTest.ok && report.modelTest.promptMode === 'hy-mt' && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(report.modelTest.text), report.modelTest);
  }
  if (placeholderProbe) {
    report.placeholderTests=[];
    for(let index=0;index<10;index++){
      const result=await rpc({type:'test-model',settings,text:placeholderSource,context:'live'});
      report.placeholderTests.push(result);
      assert.equal(result.ok,true,result.error);assert.ok(result.text.includes('🔒'));
      assert.doesNotMatch(result.text,/プレースホルダ|占位符|placeholder/iu);
    }
    check('tenFreshScreenshotSourceTranslationsWithoutInstructionEcho',true,{count:10});
  }
  if (process.env.DANLINGO_VERIFY_VISIBLE_BURST === '1') {
    const visibleStarted = Date.now();
    const requests = sources.map((text, index) => ({ channel: 'danlingo-local-offscreen-v1', action: 'complete',
      id: `visible-${index}`, modelId, body: { ...buildProviderPayload({ ...settings, localModelName: report.loaded.model.name }, [{ id: 'a', text }], 'deadline'), strategy: 'normal' } }));
    const staggerMs = Number(process.env.DANLINGO_VERIFY_STAGGER_MS ?? 0);
    report.visibleBurst = await bounded(worker.evaluate(async ({ requests, staggerMs }) => Promise.all(requests.map(async (request, index) => {
      if (staggerMs) await new Promise(resolve => setTimeout(resolve, index * staggerMs));
      return chrome.runtime.sendMessage(request);
    })), { requests, staggerMs }), 'foreground native burst', 30000);
    report.visibleBurstMs = Date.now() - visibleStarted;
    console.log('VISIBLE_BURST', report.visibleBurstMs, report.visibleBurst.map(value => value.ok));
    assert.ok(report.visibleBurst.every(value => value.ok));
  }
  if (process.env.DANLINGO_VERIFY_VISIBILITY_ONLY === '1') {
    page = await context.newPage(); await page.goto(process.env.DANLINGO_VERIFY_PAGE === 'youtube' ? `https://www.youtube.com/watch?v=${ROOM}` : 'about:blank'); await page.bringToFront();
    if (process.env.DANLINGO_VERIFY_PAGE === 'youtube') await page.evaluate(() => { window.__YT_NATIVE_FIXTURE__.paused = false; document.querySelector('video').dispatchEvent(new Event('play')); });
    report.hiddenVisibility = await options.evaluate(() => document.visibilityState);
    const requests = sources.map((text, index) => ({ channel: 'danlingo-local-offscreen-v1', action: 'complete',
      id: `hidden-${index}`, modelId, body: { ...buildProviderPayload({ ...settings, localModelName: report.loaded.model.name }, [{ id: 'a', text }], 'deadline'), strategy: 'normal' } }));
    const hiddenStarted = Date.now(); let hiddenFinished = false;
    const pending = worker.evaluate(async requests => Promise.all(requests.map(request => chrome.runtime.sendMessage(request))), requests).then(result => { hiddenFinished = true; return result; });
    await sleep(5000);
    report.hiddenBurstAfter5s = { finished: hiddenFinished, elapsedMs: Date.now() - hiddenStarted, state: await sample('hidden-5s') };
    await options.bringToFront();
    const rescuedAt = Date.now(); report.foregroundVisibility = await options.evaluate(() => document.visibilityState);
    report.visibilityResults = await bounded(pending, 'foreground rescue', 30000);
    report.rescueMs = Date.now() - rescuedAt;
    report.finalState = await sample('visibility-final');
    check('visibilityProbeCompleted', report.visibilityResults.every(result => result.ok));
    console.log('VISIBILITY', JSON.stringify({ hidden: report.hiddenVisibility, visible: report.foregroundVisibility, visibleBurstMs: report.visibleBurstMs,
      hiddenFinishedAt5s: report.hiddenBurstAfter5s.finished, completedAt5s: report.hiddenBurstAfter5s.state.completed, rescueMs: report.rescueMs }));
    return;
  }
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`https://www.youtube.com/watch?v=${ROOM}`); await page.bringToFront();
  await page.evaluate(() => { window.__YT_NATIVE_FIXTURE__.paused = false; document.querySelector('video').dispatchEvent(new Event('play')); });
  report.hookReadiness = await until(async () => {
    if (!frame()) return false;
    const hooks = await frame().evaluate(() => window.__YT_NATIVE_CHAT__?.hooks());
    const snapshot = await page.evaluate(() => window.__DL_LIVE_BRIDGE__.findLast(item => item.data.type === 'snapshot')?.data);
    return hooks?.add && hooks.action && hooks.batch && snapshot?.presentationActive && !snapshot.playback?.paused && snapshot.playback?.atLiveEdge && { hooks, snapshot };
  }, 'exact native hooks and playing live-head snapshot');
  await frame().evaluate(() => {
    const capture = window.__DL_LIVE_DOM__ = { records: {}, changes: [], snapshot2s: null };
    capture.scan = () => {
      for (const row of document.querySelectorAll('[data-fixture-id]')) {
        const record = capture.records[row.dataset.fixtureId]; if (!record) continue;
        const at = Date.now(), text = row.querySelector('#message')?.textContent ?? '';
        const state = row.getAttribute('data-danlingo-state');
        record.insertedAt ??= at;
        if (!text.trim()) record.blankObserved = true;
        if (record.text !== text || record.state !== state) capture.changes.push({ id: row.dataset.fixtureId, at, text, state });
        record.text = text; record.state = state;
        if (state === 'translating') record.translatingAt ??= at;
        if (state === 'translated') record.translatedAt ??= at;
        if (text === record.source) record.originalVisibleAt ??= at;
      }
    };
    new MutationObserver(capture.scan).observe(document.querySelector('yt-live-chat-item-list-renderer'),
      { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-danlingo-state'] });
  });
  await capture('ready-before-burst');
  report.baseline = await sample('before-burst'); // Warmup may already have incremented inferenceCalls.
  report.beforeOverview = await rpc({ type: 'overview' });
  await inject([...ordinary, ...paid], true);
  await until(async () => {
    await sample('burst');
    return frame().evaluate(() => window.__DL_LIVE_DOM__.snapshot2s !== null);
  }, 'two-second snapshot', 8000);
  report.at2s = await evidence(); await capture('two-second-release');
  console.log('STAGE deadline', JSON.stringify((await state()), (key, value) => ['gpu', 'nativeEvidence', 'requested', 'runtime', 'model'].includes(key) ? undefined : value));
  const snapshot2s = report.at2s.dom.snapshot2s;
  report.snapshot2sCounts = {
    capturedAt: snapshot2s.capturedAt,
    captureDelayMs: snapshot2s.capturedAt - Math.min(...ordinary.map(row => snapshot2s.rows[row.id].receivedAt)),
    translated: ordinary.filter(row => snapshot2s.rows[row.id].state === 'translated').length,
    originalVisible: ordinary.filter(row => snapshot2s.rows[row.id].text === row.source).length,
    notYetInserted: ordinary.filter(row => !snapshot2s.rows[row.id].insertedAt).length,
  };
  await until(async () => {
    const value = await sample('drain');
    const rows = await frame().evaluate(() => window.__DL_LIVE_DOM__.records);
    return ordinary.every(row => rows[row.id]?.insertedAt) && paid.every(row => ['translated', 'failed', 'expired'].includes(rows[row.id]?.state)) && value.active === 0 && value.queued === 0;
  }, 'ordinary releases and concurrent Super Chats settled', settleMs);
  // Observe after native requests settle so a late result cannot silently rewrite a released original.
  await sleep(3000);
  report.afterBurst = await evidence(); report.afterBurstState = await sample('after-burst');
  console.log('STAGE burst-settled', report.afterBurstState.completed, report.afterBurstState.cancelled);
  const bridge = report.afterBurst.bridge;
  report.messages = [...ordinary, ...paid].map(row => {
    const dom = report.afterBurst.dom.records[row.id];
    const submitted = bridge.find(event => event.data.type === 'submitted' && event.data.sourceId === row.id);
    const displayed = bridge.find(event => event.data.type === 'displayed' && event.data.sourceId === row.id);
    const insertion = report.afterBurst.dom.inserts.find(event => event.id === row.id);
    return { ...row, ...dom, releasedAt: insertion?.at ?? dom?.insertedAt, submitted, displayed,
      releaseMs: (insertion?.at ?? dom?.insertedAt) - dom?.receivedAt,
      translated: row.kind === 'ordinary' ? submitted?.data.translated === true : dom?.state === 'translated' };
  });
  const normal = report.messages.filter(row => row.kind === 'ordinary');
  report.counts = {
    timelyTranslated: normal.filter(row => row.translated && row.releaseMs <= deadlineMs + timerToleranceMs).length,
    timelyOriginalFallback: normal.filter(row => !row.translated && row.text === row.source && row.releaseMs <= deadlineMs + timerToleranceMs).length,
    lateRelease: normal.filter(row => row.releaseMs > deadlineMs + timerToleranceMs).length,
    paidTranslated: report.messages.filter(row => row.kind === 'paid' && row.translated).length,
  };
  check('sixteenDistinctNormalNativeHookEvents', ordinary.every(row => bridge.some(event => event.data.type === 'events' && event.data.events?.some(source => source.sourceId === row.id))));
  check('allOrdinaryReleasedByDeadlineWithTolerance', report.counts.timelyTranslated + report.counts.timelyOriginalFallback === ordinary.length, report.counts);
  report.deadlineFallbackExercised = report.counts.timelyOriginalFallback > 0;
  check('noBlankOriginalOrTranslation', report.messages.every(row => row.insertedAt && row.text?.trim() && !row.blankObserved));
  check('noLateMutationAfterOriginalRelease', normal.filter(row => !row.translated).every(row => row.text === row.source &&
    !report.afterBurst.dom.changes.some(change => change.id === row.id && change.at >= row.releasedAt && change.text !== row.source)));
  check('twoConcurrentPaidMessagesTranslated', report.counts.paidTranslated === paid.length &&
    Math.max(...paid.map(row => report.afterBurst.dom.records[row.id].receivedAt)) -
    Math.min(...paid.map(row => report.afterBurst.dom.records[row.id].receivedAt)) <= 50);
  check('realInferenceAboveWarmupBaseline', report.afterBurstState.inferenceCalls > report.baseline.inferenceCalls);
  const successful = report.messages.find(row => row.kind === 'paid' && row.translated);
  if (successful) {
    // Same source and same paid generation policy: two new subscribers should both hit completed cache.
    const repeats = [0, 1].map(index => ({ id: `cache-${index}`, source: successful.source, kind: 'paid' }));
    const before = await sample('before-cache');
    await inject(repeats);
    await until(async () => {
      await sample('cache');
      return frame().evaluate(ids => ids.every(id => window.__DL_LIVE_DOM__.records[id]?.state === 'translated'), repeats.map(row => row.id));
    }, 'two same-policy successful-source cache subscribers', 10_000);
    report.cache = { sourceId: successful.id, before, after: await sample('after-cache'), evidence: await evidence() };
    check('samePolicyRepeatedSubscribersNoAdditionalInference', report.cache.after.inferenceCalls === before.inferenceCalls);
    check('repeatedSubscribersShareSuccessfulOutput', repeats.every(row => report.cache.evidence.dom.records[row.id].text === successful.text));
    if (chineseSource) {
      const beforeForce = await state();
      const row = frame().locator(`[data-fixture-id="${successful.id}"]`);
      await row.hover(); await row.locator('[data-danlingo-retry]').click();
      await until(async () => (await state()).inferenceCalls > beforeForce.inferenceCalls, 'explicit force starts fresh native inference');
      await until(async () => await row.getAttribute('data-danlingo-state') === 'translated', 'forced Japanese translation');
      report.force = { beforeCalls: beforeForce.inferenceCalls, after: await state(), text: await row.locator('#message').textContent() };
      check('forceBypassesCacheAndRetainsJapanese', report.force.after.inferenceCalls === beforeForce.inferenceCalls + 1 && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(report.force.text));
    }
  } else check('samePolicyRepeatedSubscribersNoAdditionalInference', false, 'No successful paid source available to test cache');
  report.finalState = await sample('final'); report.finalOverview = await rpc({ type: 'overview' });
  report.finalEvidence = await evidence();
  check('originalFallbackUnchangedThroughFinalCacheCheck', normal.filter(row => !row.translated).every(row =>
    report.finalEvidence.dom.records[row.id].text === row.source &&
    !report.finalEvidence.dom.changes.some(change => change.id === row.id && change.at >= row.releasedAt && change.text !== row.source)));
  const states = report.samples.map(sample => sample.state);
  report.peaks = { observedActive: Math.max(...states.map(value => value.active)),
    controllerPeak: Math.max(...states.map(value => value.peakActive)), nativePeak: Math.max(...states.map(value => value.nativePeakActive ?? 0)) };
  check('observedActiveMoreThanOneAndAtMostFour', report.peaks.observedActive > 1 && report.peaks.observedActive <= 4 && report.peaks.controllerPeak <= 4, report.peaks);
  check('nativeSlotCapacityRemainsFour', states.every(value => value.nativeSlots === 4));
  report.nativeGenerationObservation = { peak: report.peaks.nativePeak || null,
    note: 'Production inference collects native token events internally; nativePeak measures overlapping sequences that have begun generation. Only complete translations are exposed to the page.' };
  check('singleModelGenerationUnchanged', states.every(value => value.generation === report.loaded.generation));
  check('onlySyntheticWatchAndChatFulfilled', report.network.syntheticFulfilled.length === 2, report.network);
  await capture('final-native-chat');
  })();
} catch (error) {
  report.errors.push(error.stack ?? error.message);
  if (options && !options.isClosed()) {
    try { report.optionsFailure = { text: await options.locator('#local-result').textContent(), state: await state() }; }
    catch { /* Preserve the original failure even if diagnostics fail. */ }
  }
  try { report.failureEvidence = await bounded(evidence(), 'failure evidence', 3000); } catch { /* The failure itself remains in report. */ }
  try { await capture('failure'); } catch (captureError) { report.errors.push(`Failure screenshot: ${captureError.message}`); }
} finally {
  clearTimeout(watchdog);
  try {
    if (rpc && modelId && !options.isClosed()) {
      assert.equal((await bounded(rpc({ type: 'local-control', control: { action: 'unload' } }), 'unload', 15_000)).ok, true);
      assert.equal((await bounded(rpc({ type: 'local-control', control: { action: 'delete', modelId } }), 'delete imported copy', 15_000)).ok, true);
      const remaining = await bounded(rpc({ type: 'local-control', control: { action: 'list' } }), 'verify imported copy removal', 5000);
      check('isolatedImportedCopyDeleted', remaining.ok === true && Array.isArray(remaining.models) && !remaining.models.some(model => model.id === modelId));
    }
  } catch (error) { report.errors.push(`Imported copy cleanup: ${error.message}`); }
  let browserClosed = !context;
  try { await bounded(context?.close(), 'owned browser close', 15_000); browserClosed = true; }
  catch (error) { report.errors.push(`Browser cleanup: ${error.message}`); }
  try {
    if (profile && browserClosed) {
      const ownedRoot = await realpath(directory), target = await realpath(profile), child = relative(ownedRoot, target);
      assert.ok(child && !isAbsolute(child) && !child.startsWith(`..${sep}`) && child !== '..' && !child.includes(sep) && child.startsWith('profile-'), 'Profile cleanup must remain inside this owned run');
      await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 500 });
      check('ownedProfileRemoved', true);
    }
  } catch (error) { report.errors.push(`Profile cleanup: ${error.message}`); }
  try {
    const after = await stat(modelPath);
    check('originalModelFileSizeAndMtimeUnchanged', Boolean(original) && original.size === after.size && original.mtimeMs === after.mtimeMs);
  } catch (error) { report.errors.push(`Original model verification: ${error.message}`); }
  report.totalMs = Date.now() - started;
  report.status = report.errors.length ? 'FAIL' : 'PASS';
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'), report.status);
  if (report.status !== 'PASS') process.exitCode = 1;
}
