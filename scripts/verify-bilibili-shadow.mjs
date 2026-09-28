import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_SOURCE = resolve(ROOT, 'src/platforms/bilibili/shadow-session.ts');
const VIDEO_SOURCE = resolve(ROOT, 'src/platforms/bilibili/video.ts');
export const DEFAULT_URL = 'https://www.bilibili.com/video/BV1yvhW6sEzi/';
export const DEFAULT_DURATION_SECONDS = 45;
export const TAIL_OBSERVATION_MS = 7_000;
export const SAMPLE_INTERVAL_MS = 250;
export const MINIMUM_FORECAST_LEAD_MS = 3_000;
const READY_TIMEOUT_MS = 120_000;
const MAX_PLAYBACK_OVERRUN_MS = 30_000;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const result = { help: false, browser: 'chromium', durationSeconds: DEFAULT_DURATION_SECONDS,
    output: null, url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { ...result, help: true };
    if (!['--browser', '--duration', '--output', '--url'].includes(key)) throw new Error(`Unknown option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--browser') {
      if (!['chromium', 'chrome', 'edge'].includes(value)) throw new Error('--browser must be chromium, chrome, or edge');
      result.browser = value;
    } else if (key === '--duration') {
      if (!/^\d+$/u.test(value)) throw new Error('--duration must be a whole number of seconds');
      result.durationSeconds = Number(value);
      if (!Number.isSafeInteger(result.durationSeconds) || result.durationSeconds < 11 || result.durationSeconds > 3600)
        throw new Error('--duration must be between 11 and 3600 seconds');
    } else if (key === '--output') result.output = value;
    else {
      let url;
      try { url = new URL(value); } catch { throw new Error('--url must be a valid Bilibili video URL'); }
      if (url.protocol !== 'https:' || url.hostname !== 'www.bilibili.com' ||
          !/^\/video\/(?:BV[0-9A-Za-z]+|av\d+)\/?$/u.test(url.pathname) || url.search || url.hash)
        throw new Error('--url must be an unsegmented https://www.bilibili.com/video/... URL without query or hash');
      result.url = url.href;
    }
  }
  if (result.output && extname(result.output).toLowerCase() !== '.json') throw new Error('--output must name a .json file');
  return result;
}

function phaseSummary(rows, { requestedDurationMs, sampleIntervalMs, startVideoTimeMs, startMonotonicMs, boundaryState }) {
  const intervals = [];
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].monotonicMs - rows[i - 1].monotonicMs;
    if (Number.isFinite(gap) && gap >= 0) intervals.push(gap);
  }
  const first = rows[0] ?? null, last = rows.at(-1) ?? null;
  const mediaStart = Number.isFinite(startVideoTimeMs) ? startVideoTimeMs : first?.videoTimeMs;
  const wallStart = Number.isFinite(startMonotonicMs) ? startMonotonicMs : first?.monotonicMs;
  const initialGap = first && Number.isFinite(wallStart) ? first.monotonicMs - wallStart : null;
  if (initialGap !== null && initialGap >= 0) intervals.push(initialGap);
  const mediaAdvanceMs = last && Number.isFinite(mediaStart) ? last.videoTimeMs - mediaStart : 0;
  const wallAdvanceMs = last && Number.isFinite(wallStart) ? last.monotonicMs - wallStart : 0;
  const pausedSamples = rows.filter(row => row.paused === true).length;
  const seekingSamples = rows.filter(row => row.seeking === true).length;
  const hiddenSamples = rows.filter(row => row.hidden === true || row.visibilityState === 'hidden').length;
  const rateMismatchSamples = rows.filter(row => !Number.isFinite(row.playbackRate) || Math.abs(row.playbackRate - 1) > 0.001).length;
  const maxGapMs = intervals.length ? Math.max(...intervals) : null;
  const adequateCadence = rows.length >= Math.floor(requestedDurationMs / sampleIntervalMs * 0.75) &&
    maxGapMs !== null && maxGapMs <= sampleIntervalMs * 4;
  const boundaryInterrupted = boundaryState && (boundaryState.paused === true || boundaryState.seeking === true ||
    boundaryState.hidden === true || boundaryState.visibilityState === 'hidden' ||
    !Number.isFinite(boundaryState.playbackRate) || Math.abs(boundaryState.playbackRate - 1) > 0.001);
  const uninterrupted = !boundaryInterrupted && pausedSamples === 0 && seekingSamples === 0 && hiddenSamples === 0 && rateMismatchSamples === 0;
  return {
    sampleCount: rows.length,
    firstVideoTimeMs: first?.videoTimeMs ?? null,
    lastVideoTimeMs: last?.videoTimeMs ?? null,
    mediaAdvanceMs,
    wallAdvanceMs,
    maxSampleGapMs: maxGapMs,
    pausedSamples,
    seekingSamples,
    hiddenSamples,
    rateMismatchSamples,
    adequateCadence,
    mediaDurationReached: mediaAdvanceMs >= requestedDurationMs,
    uninterrupted,
    qualifiesAsContinuousPlayback: adequateCadence && mediaAdvanceMs >= requestedDurationMs && uninterrupted,
  };
}

export function summarizePlaybackSamples(samples, { requestedDurationMs, sampleIntervalMs = SAMPLE_INTERVAL_MS,
  predictionStartVideoTimeMs, predictionStartMonotonicMs, tailStartVideoTimeMs, tailStartMonotonicMs,
  tailBoundaryState } = {}) {
  assert.ok(Array.isArray(samples), 'Playback samples must be an array');
  assert.ok(Number.isFinite(requestedDurationMs) && requestedDurationMs > 0, 'Requested duration must be positive');
  assert.ok(Number.isFinite(sampleIntervalMs) && sampleIntervalMs > 0, 'Sample interval must be positive');
  const prediction = samples.filter(sample => sample.phase === 'prediction');
  const tail = samples.filter(sample => sample.phase === 'tail');
  return {
    sampleIntervalMs,
    requestedDurationMs,
    totalSamples: samples.length,
    prediction: phaseSummary(prediction, { requestedDurationMs, sampleIntervalMs,
      startVideoTimeMs: predictionStartVideoTimeMs, startMonotonicMs: predictionStartMonotonicMs }),
    tail: phaseSummary(tail, { requestedDurationMs: TAIL_OBSERVATION_MS, sampleIntervalMs,
      startVideoTimeMs: tailStartVideoTimeMs, startMonotonicMs: tailStartMonotonicMs,
      boundaryState: tailBoundaryState }),
  };
}

function usage() {
  return [
    'Usage: node scripts/verify-bilibili-shadow.mjs [options]',
    '',
    'Options:',
    `  --duration <seconds>   Continuous playback target (11-3600 seconds; default ${DEFAULT_DURATION_SECONDS})`,
    `  --url <video-url>      Unsegmented Bilibili video URL (default ${DEFAULT_URL})`,
    '  --browser <name>       chromium, chrome, or edge (default chromium)',
    '  --output <file.json>   Report path (default: .artifacts/bilibili-shadow/<timestamp>.json)',
    '  --help                 Show this help without opening a browser',
    '',
    'Uses one anonymous isolated headless browser context. It does not load an extension, log in, select a clip,',
    'filter recorded outcomes, call a model, or add/replace native danmaku. The video is paused and',
    'positioned at 0 only before measurement; capture then runs for the requested duration plus a 7s tail.',
  ].join('\n');
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return resolve(ROOT, '.artifacts/bilibili-shadow', `shadow-${stamp}.json`);
}

function outputFiles(output) {
  const stem = basename(output, extname(output));
  const dir = dirname(output);
  return {
    report: output,
    preflight: resolve(dir, `${stem}.preflight.png`),
    predictionEnd: resolve(dir, `${stem}.prediction-end.png`),
    tailEnd: resolve(dir, `${stem}.tail-end.png`),
  };
}

async function assertOutputsAvailable(files) {
  await mkdir(dirname(files.report), { recursive: true });
  for (const path of Object.values(files)) {
    try { await access(path); throw new Error(`Output already exists; refusing to overwrite: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function loadViteBuild() {
  const projectRequire = createRequire(import.meta.url);
  const wxtEntry = projectRequire.resolve('wxt');
  const viteEntry = createRequire(wxtEntry).resolve('vite');
  const vite = await import(pathToFileURL(viteEntry).href);
  if (typeof vite.build !== 'function') throw new Error('Project Vite build API is unavailable');
  return vite.build;
}

export async function buildShadowModuleBundle() {
  const source = await readFile(SESSION_SOURCE, 'utf8');
  const virtualId = 'virtual:danlingo-bilibili-shadow-entry';
  const resolvedVirtualId = `\0${virtualId}`;
  const importPath = path => resolve(path).replaceAll('\\', '/');
  const build = await loadViteBuild();
  const result = await build({
    configFile: false,
    root: ROOT,
    publicDir: false,
    logLevel: 'error',
    plugins: [{
      name: 'danlingo-bilibili-shadow-entry',
      resolveId(id) { if (id === virtualId) return resolvedVirtualId; return null; },
      load(id) {
        if (id !== resolvedVirtualId) return null;
        return `import { BilibiliShadowSession } from ${JSON.stringify(importPath(SESSION_SOURCE))};\n` +
          `import { resolveBilibiliBinding } from ${JSON.stringify(importPath(VIDEO_SOURCE))};\n` +
          'window.__DLShadowModule = Object.freeze({ BilibiliShadowSession, resolveBilibiliBinding });';
      },
    }],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      target: 'es2022',
      rollupOptions: {
        input: virtualId,
        output: { format: 'iife', name: 'DLShadowExports' },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap(item => item.output ?? []) : result?.output ?? [];
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  if (!entry?.code) throw new Error('Vite did not produce the shadow observer IIFE');
  const code = entry.code;
  return { code, sourceHash: sha256(source), bundleHash: sha256(code) };
}

async function captureScreenshot(page, target, screenshots, label) {
  if (!page || page.isClosed()) return;
  const buffer = await page.screenshot({ type: 'png', fullPage: false });
  await writeFile(target, buffer, { flag: 'wx' });
  screenshots.push({ label, path: target, sha256: sha256(buffer) });
}

async function waitForMeasurement(page, durationMs) {
  const started = Date.now();
  const deadline = started + durationMs + MAX_PLAYBACK_OVERRUN_MS;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => {
      const run = window.__DLShadowRun;
      const sample = run?.samples.at(-1);
      return run && sample ? { startedVideoTimeMs: run.startedVideoTimeMs, sample,
        ended: run.video.ended, phase: run.phase } : null;
    });
    if (!latest) throw new Error('The in-page shadow observation stopped unexpectedly');
    if (latest.sample.videoTimeMs - latest.startedVideoTimeMs >= durationMs || latest.ended) return latest;
    await delay(1000);
  }
  return latest;
}

async function waitForTailObservation(page, durationMs) {
  const deadline = Date.now() + durationMs + MAX_PLAYBACK_OVERRUN_MS;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => {
      const run = window.__DLShadowRun;
      const sample = run?.samples.at(-1);
      return run && sample ? { cutoffVideoTimeMs: run.predictionStoppedVideoTimeMs,
        cutoffMonotonicMs: run.predictionStoppedMonotonicMs, sample, ended: run.video.ended } : null;
    });
    if (!latest) throw new Error('The in-page shadow observation stopped unexpectedly during tail observation');
    if (latest.sample.videoTimeMs - latest.cutoffVideoTimeMs >= durationMs || latest.ended) return latest;
    await delay(500);
  }
  return latest;
}

export function eventCountsFrom(report) {
  const ledger = report?.ledger ?? report;
  const events = Array.isArray(ledger?.events) ? ledger.events : null;
  const counts = {};
  for (const key of ['shadowSelected', 'nativeValidate', 'nativeInitRender', 'nativeFirstShow']) {
    counts[key] = events
      ? events.filter(event => event?.type === key).length
      : Number.isSafeInteger(ledger?.classification?.eventTypes?.[key])
        ? ledger.classification.eventTypes[key] : null;
  }
  return counts;
}

async function startPageCapture(page, { durationMs, sessionId }) {
  return page.evaluate(async ({ durationMs: targetDurationMs, sessionId, sampleIntervalMs }) => {
    const prepared = window.__DLShadowPrepared;
    const Module = window.__DLShadowModule;
    if (!prepared?.binding || !Module?.BilibiliShadowSession) throw new Error('Shadow observer module or prepared player is missing');
    const { binding, video } = prepared;
    const updates = { total: 0, byType: {} };
    const session = new Module.BilibiliShadowSession({ binding, session: sessionId, now: () => performance.now(),
      onUpdate(update) {
        updates.total++;
        const type = typeof update?.type === 'string' ? update.type.slice(0, 80) : 'untyped';
        updates.byType[type] = (updates.byType[type] ?? 0) + 1;
      } });
    if (typeof session.tick !== 'function' || typeof session.report !== 'function' ||
        typeof session.stop !== 'function' || typeof session.setPredicting !== 'function') {
      session.stop?.();
      throw new Error('BilibiliShadowSession API is incomplete; refusing to start playback');
    }
    session.tick(0);
    const preflight = session.report();
    if (!preflight.known) {
      session.stop();
      throw new Error(`Shadow native inputs unavailable before playback: ${preflight.reason}`);
    }
    const run = { session, binding, video, phase: 'prediction', samples: [], updates,
      startedVideoTimeMs: null, startedMonotonicMs: null, tickErrors: 0, timer: null };
    const sample = () => {
      try { session.tick(0); } catch { run.tickErrors++; }
      run.samples.push({ phase: run.phase, monotonicMs: performance.now(), videoTimeMs: video.currentTime * 1000,
        paused: video.paused, seeking: video.seeking, playbackRate: video.playbackRate,
        hidden: document.hidden, visibilityState: document.visibilityState, readyState: video.readyState, ended: video.ended });
    };
    window.__DLShadowRun = run;
    prepared.phase = 'prediction';
    video.muted = true;
    await video.play();
    if (video.paused || video.seeking || video.playbackRate !== 1) {
      session.stop();
      delete window.__DLShadowRun;
      throw new Error('Video did not enter continuous 1x playback');
    }
    run.startedVideoTimeMs = video.currentTime * 1000;
    run.startedMonotonicMs = performance.now();
    sample();
    run.timer = setInterval(sample, sampleIntervalMs);
    return { startedVideoTimeMs: run.startedVideoTimeMs, startedMonotonicMs: run.startedMonotonicMs,
      initialPaused: video.paused, initialSeeking: video.seeking, initialPlaybackRate: video.playbackRate,
      muted: video.muted, durationMs: targetDurationMs, eventCounts: prepared.eventCounts,
      player: { identity: binding.identity, metadata: prepared.metadata, durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : null } };
  }, { durationMs, sessionId, sampleIntervalMs: SAMPLE_INTERVAL_MS });
}

async function stopPrediction(page) {
  return page.evaluate(() => {
    const run = window.__DLShadowRun;
    if (!run) throw new Error('Shadow observation is unavailable at prediction cutoff');
    run.session.setPredicting(false);
    run.phase = 'tail';
    if (window.__DLShadowPrepared) window.__DLShadowPrepared.phase = 'tail';
    run.predictionStoppedMonotonicMs = performance.now();
    run.predictionStoppedVideoTimeMs = run.video.currentTime * 1000;
    return { monotonicMs: run.predictionStoppedMonotonicMs, videoTimeMs: run.predictionStoppedVideoTimeMs,
      paused: run.video.paused, seeking: run.video.seeking, playbackRate: run.video.playbackRate,
      hidden: document.hidden, sampleCount: run.samples.length };
  });
}

async function finishPageCapture(page, { fromStimeMs, toStimeMs }) {
  const captured = await page.evaluate(({ fromStimeMs, toStimeMs }) => {
    const run = window.__DLShadowRun;
    if (!run) throw new Error('Shadow observation is unavailable at report time');
    try { run.session.tick(0); } catch { run.tickErrors++; }
    run.samples.push({ phase: run.phase, monotonicMs: performance.now(), videoTimeMs: run.video.currentTime * 1000,
      paused: run.video.paused, seeking: run.video.seeking, playbackRate: run.video.playbackRate,
      hidden: document.hidden, visibilityState: document.visibilityState, readyState: run.video.readyState, ended: run.video.ended });
    const sessionReport = run.session.report({ fromStimeMs, toStimeMs });
    const stopResult = run.session.stop();
    clearInterval(run.timer);
    return {
      sessionReport,
      eventCountsByPhase: window.__DLShadowPrepared?.eventCounts?.byPhase ?? null,
      evaluationWindow: { fromStimeMs, toStimeMs, wasFixedBeforePlayback: true },
      samples: run.samples,
      updates: run.updates,
      tickErrors: run.tickErrors,
      predictionStoppedMonotonicMs: run.predictionStoppedMonotonicMs ?? null,
      predictionStoppedVideoTimeMs: run.predictionStoppedVideoTimeMs ?? null,
      finalVideoState: { videoTimeMs: run.video.currentTime * 1000, paused: run.video.paused,
        seeking: run.video.seeking, playbackRate: run.video.playbackRate, hidden: document.hidden,
        visibilityState: document.visibilityState },
      stopResult,
      metadata: run.binding.danmaku.getMetadata(),
      identity: run.binding.identity,
    };
  }, { fromStimeMs, toStimeMs });
  captured.eventCounts = eventCountsFrom(captured.sessionReport);
  return captured;
}

async function preparePage(page) {
  await page.waitForFunction(() => Boolean(window.player && document.querySelector('#bilibili-player video') &&
    document.querySelector('#bilibili-player video').readyState >= 2 &&
    Number.isFinite(document.querySelector('#bilibili-player video').duration) &&
    window.__DLShadowModule?.resolveBilibiliBinding(window.player, location.href)), null, { timeout: READY_TIMEOUT_MS });
  return page.evaluate(async () => {
    const Module = window.__DLShadowModule;
    if (!Module?.resolveBilibiliBinding) throw new Error('Bundled binding resolver is missing');
    const binding = Module.resolveBilibiliBinding(window.player, location.href);
    if (!binding?.video || !binding?.manager || !binding?.danmaku || !binding?.identity?.resourceId)
      throw new Error('The target page did not expose a supported native player binding');
    const video = binding.video;
    if (video.readyState < 2 || !Number.isFinite(video.duration) || video.duration <= 0)
      throw new Error('Native video is not ready for measurement');
    const eventCounts = { byPhase: { preparation: { pause: 0, seeking: 0, seeked: 0, play: 0, ratechange: 0, visibilitychange: 0 },
      prediction: { pause: 0, seeking: 0, seeked: 0, play: 0, ratechange: 0, visibilitychange: 0 },
      tail: { pause: 0, seeking: 0, seeked: 0, play: 0, ratechange: 0, visibilitychange: 0 } } };
    const prepared = { binding, video, phase: 'preparation', eventCounts, listeners: [], metadata: null,
      initial: { videoTimeMs: video.currentTime * 1000, paused: video.paused, seeking: video.seeking,
        playbackRate: video.playbackRate, muted: video.muted } };
    const listen = (target, name, key) => {
      const fn = () => { eventCounts.byPhase[prepared.phase][key]++; };
      target.addEventListener(name, fn);
      prepared.listeners.push(() => target.removeEventListener(name, fn));
    };
    listen(video, 'pause', 'pause'); listen(video, 'seeking', 'seeking'); listen(video, 'seeked', 'seeked');
    listen(video, 'play', 'play'); listen(video, 'ratechange', 'ratechange');
    listen(document, 'visibilitychange', 'visibilitychange');
    video.pause();
    video.currentTime = 0;
    if (video.seeking || Math.abs(video.currentTime) > .25) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Initial seek to 0 did not finish')); }, 10_000);
        const check = () => {
          if (!video.seeking && Math.abs(video.currentTime) <= .25) { cleanup(); resolve(); }
        };
        const cleanup = () => { clearTimeout(timeout); video.removeEventListener('seeked', check); };
        video.addEventListener('seeked', check);
        check();
      });
    }
    if (Math.abs(video.currentTime) > .25 || video.seeking || !video.paused)
      throw new Error('The player did not remain paused at time 0 after preparation');
    try { prepared.metadata = typeof binding.danmaku.getMetadata === 'function' ? binding.danmaku.getMetadata() : null; }
    catch { prepared.metadata = null; }
    prepared.afterSeek = { videoTimeMs: video.currentTime * 1000, paused: video.paused,
      seeking: video.seeking, playbackRate: video.playbackRate, durationMs: video.duration * 1000,
      readyState: video.readyState, visibilityState: document.visibilityState };
    window.__DLShadowPrepared = prepared;
    return { identity: binding.identity, metadata: prepared.metadata, before: prepared.initial, afterSeek: prepared.afterSeek,
      eventCounts, poolCount: Array.isArray(binding.manager.dataBase?.dmArray)
        ? binding.manager.dataBase.dmArray.length : null };
  });
}

export function metricAcceptance(sessionReport) {
  const ledger = sessionReport?.ledger ?? null;
  const evaluation = ledger?.evaluation ?? null;
  return { metrics: evaluation?.metrics ?? null, acceptance: evaluation?.acceptance ?? null,
    overall: ledger?.overall ?? null, steadyState: ledger?.steadyState ?? null };
}

export async function runShadowVerification(options) {
  const output = resolve(options.output || defaultOutputPath());
  const files = outputFiles(output);
  await assertOutputsAvailable(files);
  const report = {
    schema: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    target: options.url,
    browser: { requested: options.browser, context: 'ephemeral-anonymous', headless: true },
    source: { entry: 'src/platforms/bilibili/shadow-session.ts', sha256: null, bundleSha256: null },
    measurement: { durationSeconds: options.durationSeconds, sampleIntervalMs: SAMPLE_INTERVAL_MS,
      tailObservationMs: TAIL_OBSERVATION_MS, fromStimeMs: 10_000, toStimeMs: options.durationSeconds * 1000,
      minimumMatchedLeadMs: MINIMUM_FORECAST_LEAD_MS, windowFixedBeforePlayback: true,
      outcomeSampleFiltering: false, clipSelection: false, translationOrModelCalls: false },
    preparation: null,
    player: null,
    playback: null,
    shadow: null,
    screenshots: [],
    outputFiles: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, path])),
    limitations: [
      'This is an isolated anonymous Chromium-family browser run; it does not establish behavior in the user personal browser.',
      'It records prediction and native rendering lifecycle only; it does not prove translation quality or provider/model translation.',
      'firstShow is a native player lifecycle event, not proof that a glyph pixel entered the video viewport.',
    ],
  };
  let browser, context, page, sessionStarted = false;
  try {
    const bundle = await buildShadowModuleBundle();
    report.source.sha256 = bundle.sourceHash;
    report.source.bundleSha256 = bundle.bundleHash;
    const { chromium } = await loadPlaywright();
    const browserOptions = browserLaunchOptions(options.browser, { playwrightBrowser: chromium });
    const executablePath = browserOptions.executablePath ?? browserExecutablePath(options.browser, { playwrightBrowser: chromium });
    browser = await chromium.launch({ ...browserOptions, headless: true, timeout: 30_000 });
    report.browser.version = browser.version();
    report.browser.executablePath = executablePath;
    context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN' });
    page = await context.newPage();
    page.setDefaultTimeout(READY_TIMEOUT_MS);
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });
    const actualUrl = new URL(page.url());
    const expectedUrl = new URL(options.url);
    if (actualUrl.hostname !== 'www.bilibili.com' || actualUrl.pathname !== expectedUrl.pathname || actualUrl.search || actualUrl.hash)
      throw new Error(`The page redirected outside the requested unsegmented video: ${actualUrl.origin}${actualUrl.pathname}`);
    await page.bringToFront();
    await page.addScriptTag({ content: bundle.code });
    const prep = await preparePage(page);
    report.preparation = prep;
    report.player = { identity: prep.identity, metadata: prep.metadata, durationMs: prep.afterSeek.durationMs,
      poolCountAtStart: prep.poolCount };
    await captureScreenshot(page, files.preflight, report.screenshots, 'paused-at-zero-preflight');

    const sessionId = randomUUID();
    const boot = await startPageCapture(page, { durationMs: options.durationSeconds * 1000, sessionId });
    sessionStarted = true;
    report.player = { ...report.player, ...boot.player, videoMutedForAutoplay: boot.muted };
    report.playbackStartedAt = { videoTimeMs: boot.startedVideoTimeMs, monotonicMs: boot.startedMonotonicMs };
    console.log(`Observing ${options.url} in isolated ${options.browser} for ${options.durationSeconds}s plus 7s tail.`);
    const progress = await waitForMeasurement(page, options.durationSeconds * 1000);
    report.measurementCutoff = await stopPrediction(page);
    report.measurementReachedVideoDuration = !!progress &&
      progress.sample.videoTimeMs - progress.startedVideoTimeMs >= options.durationSeconds * 1000;
    await captureScreenshot(page, files.predictionEnd, report.screenshots, 'prediction-cutoff');
    const tailProgress = await waitForTailObservation(page, TAIL_OBSERVATION_MS);
    report.tailObservationReachedVideoDuration = !!tailProgress &&
      tailProgress.sample.videoTimeMs - tailProgress.cutoffVideoTimeMs >= TAIL_OBSERVATION_MS;
    await captureScreenshot(page, files.tailEnd, report.screenshots, 'tail-end');
    const captured = await finishPageCapture(page, {
      fromStimeMs: report.measurement.fromStimeMs,
      toStimeMs: report.measurement.toStimeMs,
    });
    sessionStarted = false;
    report.shadow = {
      events: captured.sessionReport?.ledger?.events ?? null,
      eventCounts: eventCountsFrom(captured.sessionReport),
      evaluationWindow: captured.evaluationWindow,
      metrics: metricAcceptance(captured.sessionReport).metrics,
      acceptance: metricAcceptance(captured.sessionReport).acceptance,
      overall: metricAcceptance(captured.sessionReport).overall,
      steadyState: metricAcceptance(captured.sessionReport).steadyState,
      sessionReport: captured.sessionReport,
      updates: captured.updates,
      tickErrors: captured.tickErrors,
      stopResult: captured.stopResult,
      finalVideoState: captured.finalVideoState,
      eventCountsByPhase: captured.eventCountsByPhase,
    };
    report.playback = summarizePlaybackSamples(captured.samples, {
      requestedDurationMs: options.durationSeconds * 1000,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      predictionStartVideoTimeMs: boot.startedVideoTimeMs,
      predictionStartMonotonicMs: boot.startedMonotonicMs,
      tailStartVideoTimeMs: report.measurementCutoff.videoTimeMs,
      tailStartMonotonicMs: report.measurementCutoff.monotonicMs,
      tailBoundaryState: report.measurementCutoff,
    });
    report.playback.eventCounts = captured.eventCountsByPhase;
    const interruptedByEvent = ['prediction', 'tail'].some(phase =>
      ['pause', 'seeking', 'ratechange', 'visibilitychange'].some(key => (captured.eventCountsByPhase?.[phase]?.[key] ?? 0) > 0));
    report.status = report.measurementReachedVideoDuration && report.playback.prediction.qualifiesAsContinuousPlayback &&
      report.tailObservationReachedVideoDuration && report.playback.tail.qualifiesAsContinuousPlayback && !interruptedByEvent
      ? (report.shadow.acceptance?.passed === true || report.shadow.acceptance?.accepted === true ? 'passed' : 'measurement-complete')
      : 'incomplete-playback';
    if (!captured.sessionReport.known || captured.sessionReport.capacityExceeded ||
      captured.sessionReport.observed?.instrumentationErrors > 0) report.status = 'observer-unavailable';
    if (captured.tickErrors > 0) report.status = 'observer-errors';
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error?.stack ?? error).slice(0, 5000);
    console.error(String(error?.message ?? error));
    if (page && !page.isClosed()) {
      try { await captureScreenshot(page, files.tailEnd, report.screenshots, 'failure-state'); } catch { /* Keep the primary failure. */ }
      if (sessionStarted) {
        try {
          const captured = await finishPageCapture(page, { fromStimeMs: report.measurement.fromStimeMs,
            toStimeMs: report.measurement.toStimeMs });
          report.shadow = { events: captured.sessionReport?.ledger?.events ?? null,
            eventCounts: eventCountsFrom(captured.sessionReport), metrics: metricAcceptance(captured.sessionReport).metrics,
            acceptance: metricAcceptance(captured.sessionReport).acceptance, sessionReport: captured.sessionReport,
            updates: captured.updates, tickErrors: captured.tickErrors, stopResult: captured.stopResult };
          report.playback = summarizePlaybackSamples(captured.samples, { requestedDurationMs: options.durationSeconds * 1000,
            sampleIntervalMs: SAMPLE_INTERVAL_MS });
          sessionStarted = false;
        } catch { /* The original failure is more useful than a failed recovery report. */ }
      }
    }
  } finally {
    if (page && !page.isClosed() && sessionStarted) {
      try { await page.evaluate(() => { const run = window.__DLShadowRun; if (run) { clearInterval(run.timer); run.session.stop(); } }); }
      catch { /* Closing the anonymous page also releases its in-memory wrappers. */ }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(files.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return; }
  const report = await runShadowVerification(options);
  console.log(JSON.stringify({ status: report.status, output: report.outputFiles.report,
    playback: report.playback?.prediction ?? null, eventCounts: report.shadow?.eventCounts ?? null,
    evaluation: report.shadow?.acceptance ?? null }, null, 2));
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(fileURLToPath(import.meta.url))) {
  try { await main(); }
  catch (error) { console.error(String(error?.stack ?? error)); process.exitCode = 1; }
}
