// P0-03: one bounded native-instance observation; no text replacement or P2.
// Uses only the existing browser/runtime and our own isolated persistent profile.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readBilibiliSourceEvidence, requireFileOption } from './recording-input.mjs';
import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from '../browser-runtime.mjs';

const evidencePath = requireFileOption(process.argv.slice(2), '--source-evidence');
const { evidence: sourceEvidence, fileName: sourceEvidenceFileName } = await readBilibiliSourceEvidence(evidencePath);
const bvid = sourceEvidence.bvid;
const pageSource = sourceEvidence.sources.find(source => source.label === 'page');
const targetUrl = pageSource.url;
const targetPath = new URL(targetUrl).pathname;
const evidenceCapturedAt = sourceEvidence.capturedAt ?? pageSource.fetchedAt;
const { chromium } = await loadPlaywright();
const browserOptions = browserLaunchOptions('chromium');
const executablePath = browserOptions.executablePath ?? browserExecutablePath('chromium', { playwrightBrowser: chromium });
const profile = fileURLToPath(new URL('../../.artifacts/profiles/p0-bilibili/', import.meta.url));
const outputDir = new URL('../../.artifacts/p0/bilibili/', import.meta.url);
mkdirSync(outputDir, { recursive: true });
const startedAt = new Date().toISOString();
const reportFile = new URL(`browser-${bvid}-${startedAt.replace(/[:.]/g, '-')}.json`, outputDir);
const reviewed = new Map(sourceEvidence.sources.filter(s => s.label !== 'page').map(s => [s.url, s.sha256]));
const observerCode = readFileSync(new URL('./bilibili-native-observer.mjs', import.meta.url), 'utf8')
  .replace('export function attachNativeObserver', 'function attachNativeObserver');
const report = { startedAt, target: targetUrl, bvid,
  sourceEvidence: { fileName: sourceEvidenceFileName, capturedAt: evidenceCapturedAt, resourceId: bvid },
  evidenceLevel: 'real Chromium runtime observation; no translation/replacement',
  browser: { executablePath, profile, headless: true },
  limits: { totalMs: 110_000, navigationMs: 35_000, instanceMs: 25_000, observationMs: 22_000, records: 64 },
  requests: [], resources: [], failedRequests: [], stages: [],
  rawCookiesRead: false, accountStoresRead: false, originalCommentsExported: false,
  nativeReplacementTested: false };
let context, page, observerHandle, found;
const resourcePromises = new Set();
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
const stage = name => { report.stages.push({ name, at: new Date().toISOString() }); save(); console.log(name); };
const errorCode = error => error?.message?.match(/net::ERR_[A-Z0-9_]+/)?.[0] ??
  (error?.name === 'TimeoutError' ? 'TimeoutError' : 'BrowserOrProbeError');
function safeRequestUrl(raw) {
  const u = new URL(raw), clean = new URL(u.origin + u.pathname);
  for (const key of ['bvid', 'aid', 'cid', 'oid', 'pid', 'type', 'segment_index', 'pull_mode', 'ps', 'pe']) {
    const value = u.searchParams.get(key);
    if (value && /^(?:BV[0-9a-zA-Z]{10}|\d+)$/.test(value)) clean.searchParams.set(key, value);
  }
  return clean.href;
}
function relevant(url) {
  const u = new URL(url);
  return (u.hostname === 'api.bilibili.com' && /^\/x\/v2\/dm\/(?:wbi\/)?web\/(?:view|seg\.so)$/.test(u.pathname)) ||
    (u.hostname === 'www.bilibili.com' && u.pathname === targetPath);
}

// Read observed player-related window property names, then only their public
// danmaku API (and one player/api-named own child). Never traverse stores/state.
function locateNative() {
  const names = Object.getOwnPropertyNames(window).filter(name => /player|bpx|nano/i.test(name)).slice(0, 40);
  const candidates = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    const value = descriptor && 'value' in descriptor ? descriptor.value : null;
    if (!value || !['object', 'function'].includes(typeof value) || value instanceof Element) continue;
    candidates.push({ path: `window[${JSON.stringify(name)}]`, value });
    for (const child of Object.getOwnPropertyNames(value).filter(key => /^(?:_?player|playerApi|api)$/i.test(key)).slice(0, 4)) {
      const d = Object.getOwnPropertyDescriptor(value, child);
      if (d && 'value' in d && d.value) candidates.push({ path: `window[${JSON.stringify(name)}][${JSON.stringify(child)}]`, value: d.value });
    }
  }
  for (const candidate of candidates) {
    try {
      const danmaku = candidate.value.danmaku;
      if (typeof danmaku?.getDanmakuX !== 'function') continue;
      const instance = danmaku.getDanmakuX();
      if (instance && typeof instance.getMetadata === 'function' && instance.hooks && instance.manager) {
        return { path: `${candidate.path}.danmaku.getDanmakuX()`, instance,
          discovery: 'observed window player-named data property and public danmaku API; no store traversal' };
      }
    } catch { /* A not-ready candidate is not a reason to inspect private state. */ }
  }
  return false;
}

async function pageSummary() {
  return page.evaluate(() => {
    const player = document.getElementById('bilibili-player');
    const videoData = window.__INITIAL_STATE__?.videoData;
    const publicMedia = videoData && { bvid: videoData.bvid, aid: videoData.aid, cid: videoData.cid, duration: videoData.duration };
    // Select code anchors only in small executable bootstrap scripts. Never
    // serialize INITIAL_STATE, page HTML, account state, console bodies or headers.
    const bootstrapAnchors = [...document.scripts]
      .filter(s => !s.src && !s.type.includes('json') && s.textContent.length < 15_000 &&
        !/__INITIAL_STATE__|__playinfo__/.test(s.textContent))
      .flatMap(s => [...s.textContent.matchAll(/(?:window\.)?[A-Za-z_$][\w$.]{0,70}\s*=\s*(?:new\s+)?(?:window\.)?(?:NanoPlayer|BilibiliPlayer|bilibiliPlayer|Player)[\w$]*/g)].map(m => m[0]))
      .slice(0, 12);
    return { url: location.origin + location.pathname, playerElementPresent: !!player,
      playerElementClasses: player ? [...player.classList] : [], publicMedia,
      playerNamedWindowKeys: Object.getOwnPropertyNames(window).filter(k => /player|bpx|nano/i.test(k)).slice(0, 40),
      playerElementExpandoNames: player ? Object.getOwnPropertyNames(player).filter(k => /player|vue|react/i.test(k)).slice(0, 12) : [],
      bootstrapAnchors,
      videos: [...document.querySelectorAll('#bilibili-player video')].slice(0, 3).map(v => ({
        readyState: v.readyState, paused: v.paused, currentTime: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : null, width: v.videoWidth, height: v.videoHeight,
        mediaErrorCode: v.error?.code ?? null })),
      nativeDmDomCount: document.querySelectorAll('.bili-danmaku-x-dm').length,
      visibleGate: /(?:访问受限|请求被拦截|安全验证|网络异常)/.test(document.body.innerText.slice(0, 6000)) };
  });
}

const deadline = setTimeout(() => {
  report.deadlineReached = true;
  context?.close().catch(() => {});
}, report.limits.totalMs);
deadline.unref();

try {
  stage('launch-isolated-existing-chromium');
  context = await chromium.launchPersistentContext(profile, { ...browserOptions, headless: true,
    viewport: { width: 1365, height: 900 }, locale: 'zh-CN',
    args: ['--autoplay-policy=no-user-gesture-required'], timeout: 25_000 });
  report.browser.version = context.browser()?.version() ?? null;
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('response', response => {
    const url = response.url();
    if (relevant(url) && report.requests.length < 20) report.requests.push({
      url: safeRequestUrl(url), status: response.status(), at: new Date().toISOString() });
    const path = new URL(url).origin + new URL(url).pathname;
    if (reviewed.has(path)) {
      const pending = (async () => {
        const evidence = { url: path, status: response.status(), reviewedSha256: reviewed.get(path) };
        try {
          const body = await response.body();
          evidence.bytes = body.length;
          evidence.sha256 = createHash('sha256').update(body).digest('hex');
          evidence.matchesReviewedSource = evidence.sha256 === evidence.reviewedSha256;
        } catch { evidence.bodyAvailable = false; }
        report.resources.push(evidence);
      })();
      resourcePromises.add(pending);
      pending.finally(() => resourcePromises.delete(pending));
    }
  });
  page.on('requestfailed', request => {
    if (relevant(request.url()) && report.failedRequests.length < 12) report.failedRequests.push({
      url: safeRequestUrl(request.url()), error: request.failure()?.errorText?.match(/net::ERR_[A-Z0-9_]+/)?.[0] ?? 'failed' });
  });
  stage('navigate-real-public-video');
  const navigation = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: report.limits.navigationMs });
  report.navigationStatus = navigation?.status() ?? null;
  report.initialPage = await pageSummary();
  const media = report.initialPage.publicMedia;
  if (media?.bvid !== bvid || !Number.isSafeInteger(Number(media?.cid)) || Number(media.cid) <= 0) {
    throw new Error('Public page media identity does not match source evidence');
  }
  const pageNumber = Number(new URL(targetUrl).searchParams.get('p') ?? 1);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error('Invalid target page number');
  const resourceKey = `${bvid}:${media.cid}:p${pageNumber}`;
  report.resourceKey = resourceKey;
  stage('locate-public-native-api');
  found = await page.waitForFunction(locateNative, undefined, { timeout: report.limits.instanceMs, polling: 500 });
  report.instance = await found.evaluate(({ path, instance, discovery }) => ({ path, discovery,
    metadata: instance.getMetadata(), beforeRenderType: typeof instance.hooks.beforeRender,
    managerBeforeCollisionCheckType: typeof instance.manager.beforeCollisionCheck,
    activeModelCount: instance.manager.visualArray.length, nativeCurrentTime: instance.currentTime,
    nativeContainerClass: instance.container?.className ?? null }));
  stage('attach-existing-observer-to-one-instance');
  observerHandle = await found.evaluateHandle(({ instance }, code, resourceKey) => {
    const attach = new Function(`${code}\nreturn attachNativeObserver;`)();
    const previous = instance.hooks.beforeRender;
    const observer = attach(instance, { resourceKey, maxRecords: 64 });
    return { instance, previous, observer };
  }, observerCode, resourceKey);
  report.attached = await observerHandle.evaluate(({ instance, previous, observer }) => ({
    changedOnlyInstanceHook: instance.hooks.beforeRender !== previous, snapshot: observer.snapshot() }));
  // Play only the observed native video element in this isolated profile.
  // No seek, danmaku-switch setting, posting, source mutation, or extra add.
  report.play = await page.evaluate(async () => {
    const video = document.querySelector('#bilibili-player video');
    if (!video) return { outcome: 'no-native-video' };
    video.muted = true;
    try { await video.play(); return { outcome: 'play-resolved', paused: video.paused, currentTime: video.currentTime }; }
    catch (error) { return { outcome: 'play-rejected', errorName: error.name }; }
  });
  stage('observe-pending-to-measured-native-models');
  const until = Date.now() + report.limits.observationMs;
  report.observations = [];
  while (Date.now() < until) {
    const snapshot = await observerHandle.evaluate(({ observer }) => observer.snapshot());
    report.observations.push({ at: new Date().toISOString(), ...snapshot });
    if (snapshot.calls > 1 && snapshot.active.some(model => model.label != null && model.width > 0 && model.height > 0 && model.shown)) break;
    await page.waitForTimeout(500); // Bounded sampling interval, not navigation readiness.
  }
  report.finalPage = await pageSummary();
  const observations = report.observations;
  report.outcome = observations.some(s => s.active.some(m => m.label != null && m.width > 0 && m.height > 0 && m.shown)) ?
    'native-beforeRender-and-later-measured-model-observed' :
    observations.some(s => s.calls > 0) ? 'native-hook-triggered-no-matched-measured-model' : 'instance-found-hook-not-observed';
} catch (error) {
  report.error = { stage: report.stages.at(-1)?.name, code: errorCode(error) };
  report.outcome = 'bounded-observation-blocked';
  if (page && !page.isClosed()) {
    try { report.finalPage = await pageSummary(); } catch { /* Context already closed. */ }
  }
  process.exitCode = 1;
} finally {
  if (observerHandle && page && !page.isClosed()) {
    try {
      report.restoration = await observerHandle.evaluate(({ instance, previous, observer }) => {
        const before = observer.snapshot(), stopped = observer.stop(), after = observer.snapshot();
        return { ...stopped, originalHookIdentityRestored: instance.hooks.beforeRender === previous,
          enabledAfterStop: after.enabled, beforeCalls: before.calls, afterCalls: after.calls };
      });
      stage('observer-stopped-and-original-hook-checked');
    } catch { report.restoration = { verified: false, reason: 'browser-context-unavailable' }; }
  } else report.restoration = { applicable: false, reason: 'observer-not-installed' };
  await Promise.race([Promise.allSettled([...resourcePromises]), new Promise(resolve => setTimeout(resolve, 1500))]);
  if (context) {
    try { await context.close(); report.browserContextClosed = true; }
    catch { report.browserContextClosed = false; report.closeError = 'context-close-failed'; }
  } else report.browserContextClosed = false;
  clearTimeout(deadline);
  report.endedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ report: fileURLToPath(reportFile), outcome: report.outcome,
    instance: report.instance, restoration: report.restoration, resources: report.resources,
    finalPage: report.finalPage, error: report.error }, null, 2));
}
