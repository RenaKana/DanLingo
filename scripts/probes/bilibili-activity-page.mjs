import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// Read-only public activity-page probe for the native Bilibili live adapter.
// One temporary anonymous profile; no extension, socket, message payload, or account data.
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = 'https://live.bilibili.com/213';
const knownActivityUrl = 'https://live.bilibili.com/blanc/47867?liteVersion=true';
const outputDir = resolve('.artifacts/bilibili/activity-source');
const reportFile = resolve(outputDir, 'report.json');
const totalMs = 45_000;
const navigationMs = 18_000;
const pollIntervalMs = 500;
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const deadlineAt = startedMs + totalMs;

const report = {
  startedAt,
  target,
  evidenceLevel: 'real public Bilibili activity page; read-only compatibility metadata only',
  probeRevision: 'node-side-frame-poll-v2',
  changeUnderTest: 'Node-side bounded polling replaces page.waitForFunction closure that could not access the Node page object.',
  browser: { executablePath: null, profile: 'one-time temporary anonymous profile', headless: true },
  limits: { totalMs, navigationMs, pollIntervalMs },
  policy: {
    credentials: false,
    personalProfile: false,
    extensionLoaded: false,
    socketAdded: false,
    socketMessagesForwarded: false,
    chatPayloadsCaptured: false,
    accountDataRead: false,
    actionsSent: false,
  },
  diagnostics: {
    failedScriptResources: [],
    pageErrors: [],
    topPageState: null,
    frameState: null,
    inference: null,
  },
  stages: [],
  outcome: 'INCOMPLETE',
};

await mkdir(outputDir, { recursive: true });
const save = async () => writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
const stage = async name => { report.stages.push({ name, at: new Date().toISOString() }); await save(); };
const safeError = error => ({
  name: error?.name ?? 'Error',
  code: error?.message?.match(/net::ERR_[A-Z0-9_]+/)?.[0] ?? (error?.name === 'TimeoutError' ? 'TimeoutError' : 'ProbeError'),
});
const safeValue = value => {
  if (typeof value === 'string') return value.length <= 128 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};
const safeActivityUrl = raw => {
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://live.bilibili.com' || !/^\/blanc\/[1-9]\d{0,19}\/?$/.test(url.pathname)) return null;
    const query = new URLSearchParams();
    if (url.searchParams.get('liteVersion') === 'true') query.set('liteVersion', 'true');
    return `${url.origin}${url.pathname}${query.toString() ? `?${query}` : ''}`;
  } catch { return null; }
};
const safeResourcePath = raw => {
  try {
    const url = new URL(raw);
    return { domain: url.hostname, pathname: url.pathname || '/' };
  } catch { return null; }
};
const addBounded = (list, value, max = 40) => { if (list.length < max) list.push(value); };
const errorCode = request => request.failure()?.errorText?.match(/net::ERR_[A-Z0-9_]+/)?.[0] ?? 'request-failed';
const resourcePathFromError = value => {
  const match = String(value ?? '').match(/https?:\/\/[^\s)]+/i);
  return match ? safeResourcePath(match[0]) : null;
};
const sameActivityUrl = raw => safeActivityUrl(raw) === knownActivityUrl;


const { chromium } = await loadPlaywright();
const browserOptions = browserLaunchOptions('chromium');
const executablePath = browserOptions.executablePath ?? browserExecutablePath('chromium', { playwrightBrowser: chromium });
report.browser.executablePath = executablePath;

let context;
let page;
let activityFrame;
let lastFrame;
let deadlineReached = false;
const deadline = setTimeout(() => {
  deadlineReached = true;
  report.deadlineReached = true;
  void context?.close().catch(() => {});
}, totalMs);
deadline.unref();

async function frameLocatorUrl() {
  if (!page || page.isClosed()) return null;
  try {
    // Only read the child document URL fields; no DOM/body data is returned here.
    return await page.frameLocator('#player-ctnr iframe').locator('html').evaluate(node => ({
      documentURL: node.ownerDocument.URL,
      locationHref: node.ownerDocument.location.href,
    }));
  } catch { return null; }
}

async function currentIframe() {
  if (!page || page.isClosed()) return { count: 0, frame: null };
  try {
    const locator = page.locator('#player-ctnr iframe');
    const count = await locator.count();
    if (count !== 1) return { count, frame: null };
    const handle = await locator.first().elementHandle();
    return { count, frame: handle ? await handle.contentFrame() : null };
  } catch { return { count: -1, frame: null }; }
}

async function engineReadiness(frame) {
  if (!frame) return null;
  try {
    return await frame.evaluate(() => {
      const prototype = globalThis.LiveDanmakuEngine?.default?.prototype;
      return {
        enginePresent: !!globalThis.LiveDanmakuEngine?.default,
        handleSocketMessagePresent: typeof prototype?.handleSocketMessage === 'function',
        roomInitResPresent: !!globalThis.__NEPTUNE_IS_MY_WAIFU__?.roomInitRes,
        bilibiliLiveRoomIdPresent: globalThis.BilibiliLive?.ROOMID != null,
      };
    });
  } catch { return null; }
}

async function installOneShotWrapper(frame) {
  return frame.evaluate(() => {
    const root = globalThis;
    const prototype = root.LiveDanmakuEngine?.default?.prototype;
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'handleSocketMessage') : undefined;
    const original = prototype?.handleSocketMessage;
    const state = {
      installed: false,
      receiverObserved: false,
      receiverConstructor: null,
      argumentCount: null,
      coreMetadata: null,
      restored: false,
      reason: null,
    };
    const metadataValue = value => {
      if (value == null) return null;
      if (typeof value === 'string' || typeof value === 'number') return { version: value };
      if (typeof value !== 'object') return null;
      const output = {};
      for (const key of ['version', 'coreVersion', 'build', 'revision', 'lastCompiled', 'name']) {
        const item = value[key];
        if (typeof item === 'string' && item.length <= 128 || typeof item === 'number' && Number.isFinite(item)) output[key] = item;
      }
      return Object.keys(output).length ? output : { available: true };
    };
    const readCoreMetadata = receiver => {
      for (const candidate of [receiver?.danmaku?.core, receiver?.core]) {
        try {
          if (candidate && typeof candidate.getMetadata === 'function') return metadataValue(candidate.getMetadata());
        } catch { /* A site-specific core can reject outside its lifecycle. */ }
      }
      return null;
    };
    if (!prototype || typeof original !== 'function' || !descriptor || !('value' in descriptor) || !descriptor.writable) {
      state.reason = !prototype ? 'engine-prototype-unavailable' : !descriptor?.writable ? 'receiver-not-writable' : 'handleSocketMessage-unavailable';
      root.__DL_ACTIVITY_PROBE__ = { snapshot: () => ({ ...state }), restore: () => ({ ...state }) };
      return { ...state };
    }
    const wrapper = function (...args) {
      try {
        return Reflect.apply(original, this, args);
      } finally {
        if (!state.receiverObserved) {
          state.receiverObserved = true;
          state.receiverConstructor = typeof this?.constructor?.name === 'string' ? this.constructor.name.slice(0, 80) : null;
          state.argumentCount = args.length;
          state.coreMetadata = readCoreMetadata(this);
        }
        if (prototype.handleSocketMessage === wrapper) {
          Object.defineProperty(prototype, 'handleSocketMessage', descriptor);
          state.restored = true;
        }
      }
    };
    Object.defineProperty(prototype, 'handleSocketMessage', { ...descriptor, value: wrapper });
    state.installed = true;
    root.__DL_ACTIVITY_PROBE__ = {
      snapshot: () => ({ ...state }),
      restore: () => {
        if (prototype.handleSocketMessage === wrapper) {
          Object.defineProperty(prototype, 'handleSocketMessage', descriptor);
          state.restored = true;
        }
        return { ...state };
      },
    };
    return { ...state };
  });
}

async function readFinalSurface(frame, frameUrl) {
  return frame.evaluate(({ frameUrl: observedFrameUrl }) => {
    const root = globalThis;
    const roomInitRes = root.__NEPTUNE_IS_MY_WAIFU__?.roomInitRes;
    const room = roomInitRes?.data && typeof roomInitRes.data === 'object' ? roomInitRes.data : roomInitRes;
    const engine = root.LiveDanmakuEngine?.default;
    const prototype = engine?.prototype;
    const serial = value => {
      if (typeof value === 'string') return value.length <= 128 ? value : null;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      return null;
    };
    const metadataValue = value => {
      if (value == null) return null;
      if (typeof value === 'string' || typeof value === 'number') return { version: serial(value) };
      if (typeof value !== 'object') return null;
      const output = {};
      for (const key of ['version', 'coreVersion', 'build', 'revision', 'lastCompiled', 'name']) {
        const item = serial(value[key]);
        if (item !== null) output[key] = item;
      }
      return Object.keys(output).length ? output : { available: true };
    };
    const getMetadataFrom = value => {
      try { return value && typeof value.getMetadata === 'function' ? metadataValue(value.getMetadata()) : null; }
      catch { return null; }
    };
    let engineCoreMetadata = null;
    for (const candidate of [prototype?.danmaku?.core, prototype?.core]) {
      engineCoreMetadata = getMetadataFrom(candidate);
      if (engineCoreMetadata) break;
    }
    if (!engineCoreMetadata && typeof prototype?.getMetadata === 'function') engineCoreMetadata = getMetadataFrom(prototype);

    const identifiers = {
      roomInitRes: !!roomInitRes,
      bilibiliLiveRoomId: serial(root.BilibiliLive?.ROOMID) !== null,
      activityUrlRoomId: /^https:\/\/live\.bilibili\.com\/blanc\/[1-9]\d{0,19}(?:\/|\?|$)/.test(observedFrameUrl ?? ''),
    };
    const vueRoomLiveKeys = { data: new Set(), props: new Set() };
    if (!roomInitRes) {
      const nodes = [...document.querySelectorAll('#player-ctnr,#live-player,#chat-items,[id*="room"],[id*="live"],[class*="room"],[class*="live"]')].slice(0, 200);
      for (const node of nodes) {
        for (const key of ['data', 'props']) {
          const value = node[`$${key}`];
          if (!value || typeof value !== 'object') continue;
          for (const name of Object.keys(value)) {
            if (/(?:room|live|player|short|status|stream|activity)/i.test(name)) vueRoomLiveKeys[key].add(name.slice(0, 80));
          }
        }
      }
    }
    return {
      frameUrl: observedFrameUrl,
      roomInitRes: {
        room_id: serial(room?.room_id),
        short_id: serial(room?.short_id),
        live_status: serial(room?.live_status),
        source: roomInitRes?.data && typeof roomInitRes.data === 'object' ? 'roomInitRes.data' : roomInitRes ? 'roomInitRes' : null,
      },
      identifiers: {
        ...identifiers,
        values: { bilibiliLiveRoomId: serial(root.BilibiliLive?.ROOMID) },
      },
      liveDanmakuEnginePresent: !!engine,
      handleSocketMessagePresent: typeof prototype?.handleSocketMessage === 'function',
      engineCoreMetadata,
      counts: {
        livePlayer: document.querySelectorAll('#live-player').length,
        chatItems: document.querySelectorAll('#chat-items').length,
        video: document.querySelectorAll('video').length,
      },
      ...(roomInitRes ? {} : { vueRoomLiveKeys: { data: [...vueRoomLiveKeys.data].sort(), props: [...vueRoomLiveKeys.props].sort() } }),
    };
  }, { frameUrl });
}

async function readDocumentState(frame) {
  if (!frame) return null;
  return frame.evaluate(() => {
    const visible = node => {
      if (!(node instanceof Element)) return false;
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const countVisible = selectors => [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))].filter(visible).length;
    return {
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      livePlayerVisible: visible(document.querySelector('#live-player')),
      chatItemsVisible: visible(document.querySelector('#chat-items')),
      videoCount: document.querySelectorAll('video').length,
      videoVisibleCount: [...document.querySelectorAll('video')].filter(visible).length,
      loadingVisibleCount: countVisible(['[aria-busy="true"]', '[class*="loading" i]', '[id*="loading" i]']),
      verificationVisibleCount: countVisible(['[class*="captcha" i]', '[id*="captcha" i]', '[class*="verify" i]', '[id*="verify" i]', '[class*="security" i]', '[id*="security" i]']),
    };
  });
}

try {
  await stage('launch-temporary-anonymous-profile');
  const profile = await mkdtemp(join(tmpdir(), 'danlingo-bilibili-activity-'));
  context = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    headless: true,
    viewport: { width: 1365, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-extensions', '--disable-sync', '--disable-component-update', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
  });
  report.browser.version = context.browser()?.version() ?? null;
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(2_000);
  page.on('requestfailed', request => {
    if (request.resourceType() !== 'script') return;
    const path = safeResourcePath(request.url());
    if (path) addBounded(report.diagnostics.failedScriptResources, { ...path, code: errorCode(request) });
  });
  page.on('response', response => {
    if (response.request().resourceType() !== 'script' || response.status() < 400) return;
    const path = safeResourcePath(response.url());
    if (path) addBounded(report.diagnostics.failedScriptResources, { ...path, code: `HTTP_${response.status()}` });
  });
  page.on('pageerror', error => addBounded(report.diagnostics.pageErrors, {
    type: error?.name ?? 'Error',
    resourcePath: resourcePathFromError(error?.stack ?? error?.message),
  }));

  await stage('navigate-public-activity-page');
  try {
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navigationMs });
    report.navigation = { status: response?.status() ?? null, url: page.url().split('#')[0] };
  } catch (error) {
    report.navigation = { error: safeError(error), url: page.url().split('#')[0] };
  }

  await stage('scroll-player-into-view-for-lazy-initialization');
  try {
    const playerContainer = page.locator('#player-ctnr');
    await playerContainer.waitFor({ state: 'attached', timeout: 10_000 });
    await playerContainer.scrollIntoViewIfNeeded({ timeout: 5_000 });
    report.scroll = { playerContainerFound: true, scrolledIntoView: true };
  } catch (error) {
    report.scroll = { playerContainerFound: false, scrolledIntoView: false, error: safeError(error) };
  }

  await stage('poll-iframe-url-and-native-constructor');
  const readiness = {
    attempts: 0,
    iframeCount: null,
    frameLocatorUrl: null,
    observedSameOriginUrl: false,
    enginePresent: false,
    handleSocketMessagePresent: false,
    roomInitResSeen: false,
    bilibiliLiveRoomIdSeen: false,
    ready: false,
    readyAt: null,
  };
  let lastReadiness;
  while (!deadlineReached && Date.now() < deadlineAt - 700) {
    readiness.attempts++;
    const located = await currentIframe();
    readiness.iframeCount = located.count;
    const urlInfo = await frameLocatorUrl();
    if (urlInfo) {
      readiness.frameLocatorUrl = {
        documentURL: safeActivityUrl(urlInfo.documentURL) ?? urlInfo.documentURL.split('#')[0],
        locationHref: safeActivityUrl(urlInfo.locationHref) ?? urlInfo.locationHref.split('#')[0],
      };
    }
    const observedUrl = urlInfo && (sameActivityUrl(urlInfo.documentURL) || sameActivityUrl(urlInfo.locationHref))
      ? (safeActivityUrl(urlInfo.documentURL) ?? safeActivityUrl(urlInfo.locationHref)) : null;
    if (observedUrl) readiness.observedSameOriginUrl = true;
    const engine = await engineReadiness(located.frame);
    if (engine) {
      readiness.enginePresent = engine.enginePresent;
      readiness.handleSocketMessagePresent = engine.handleSocketMessagePresent;
      readiness.roomInitResSeen ||= engine.roomInitResPresent;
      readiness.bilibiliLiveRoomIdSeen ||= engine.bilibiliLiveRoomIdPresent;
    }
    lastFrame = located.frame ?? lastFrame;
    lastReadiness = { frame: located.frame, observedUrl, engine };
    if (located.frame && observedUrl && engine?.enginePresent && engine.handleSocketMessagePresent) {
      activityFrame = located.frame;
      readiness.ready = true;
      readiness.readyAt = new Date().toISOString();
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs));
  }
  report.readiness = readiness;
  report.topPage = await page.evaluate(() => {
    const container = document.querySelector('#player-ctnr');
    const iframe = container?.querySelector('iframe');
    return {
      playerContainerPresent: !!container,
      iframeCount: container?.querySelectorAll('iframe').length ?? 0,
      iframeSrcProperty: iframe instanceof HTMLIFrameElement ? iframe.src : null,
    };
  }).catch(error => ({ error: safeError(error) }));
  report.iframe = {
    src: safeActivityUrl(report.topPage.iframeSrcProperty ?? '') ?? knownActivityUrl,
    frameLocatorUrl: readiness.frameLocatorUrl,
  };

  if (readiness.ready) {
    await stage('install-one-shot-natural-receiver-wrapper-after-ready');
    report.wrapperInstall = await installOneShotWrapper(activityFrame).catch(error => ({ error: safeError(error) }));
  }

  const finalFrame = activityFrame ?? lastFrame;
  report.diagnostics.topPageState = await readDocumentState(page.mainFrame()).catch(error => ({ error: safeError(error) }));
  report.diagnostics.frameState = await readDocumentState(finalFrame).catch(error => ({ error: safeError(error) }));
  const frameState = report.diagnostics.frameState;
  const topState = report.diagnostics.topPageState;
  const verificationVisible = (frameState?.verificationVisibleCount ?? 0) > 0 || (topState?.verificationVisibleCount ?? 0) > 0;
  const loadingVisible = (frameState?.loadingVisibleCount ?? 0) > 0 || (topState?.loadingVisibleCount ?? 0) > 0;
  const failedScripts = report.diagnostics.failedScriptResources.length;
  report.diagnostics.inference = verificationVisible
    ? { hypothesis: 'verification-or-access-gate-visible', basis: ['verification-like-visible-selector'] }
    : failedScripts > 0
      ? { hypothesis: 'script-resource-load-failure', basis: [`failed-script-resources:${failedScripts}`] }
      : frameState?.videoCount === 0 && loadingVisible
        ? { hypothesis: 'player-shell-still-loading', basis: ['live-player-present', 'no-video', 'loading-like-visible-selector'] }
        : frameState?.videoCount === 0 && frameState?.livePlayerVisible
          ? { hypothesis: 'player-shell-without-video-after-scroll', basis: ['live-player-visible', 'no-video', 'no-verification-selector'] }
          : { hypothesis: 'not-determined-by-selector-only-diagnostics', basis: ['no-chat-or-account-content-collected'] };
  if (finalFrame && !page.isClosed()) {
    await stage('read-final-native-compatibility-metadata');
    const finalUrl = readiness.frameLocatorUrl?.documentURL && sameActivityUrl(readiness.frameLocatorUrl.documentURL)
      ? readiness.frameLocatorUrl.documentURL
      : readiness.frameLocatorUrl?.locationHref && sameActivityUrl(readiness.frameLocatorUrl.locationHref)
        ? readiness.frameLocatorUrl.locationHref : knownActivityUrl;
    report.surface = await readFinalSurface(finalFrame, finalUrl).catch(error => ({ error: safeError(error) }));
  }

  if (readiness.ready && report.wrapperInstall?.installed) {
    await stage('poll-natural-receiver-once');
    while (!deadlineReached && Date.now() < deadlineAt - 500) {
      report.receiverObservation = await activityFrame.evaluate(() => globalThis.__DL_ACTIVITY_PROBE__?.snapshot?.() ?? null).catch(error => ({ error: safeError(error) }));
      if (report.receiverObservation?.receiverObserved) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs));
    }
    report.receiverObservation = await activityFrame.evaluate(() => globalThis.__DL_ACTIVITY_PROBE__?.snapshot?.() ?? null).catch(error => ({ error: safeError(error) }));
  }

  if (readiness.ready) {
    report.outcome = report.receiverObservation?.receiverObserved ? 'NATIVE_RECEIVER_OBSERVED' : 'NATIVE_ENGINE_READY_RECEIVER_NOT_OBSERVED';
  } else if (report.topPage?.playerContainerPresent && report.iframe?.src) {
    report.outcome = 'ACTIVITY_FRAME_NATIVE_ENGINE_NOT_READY_WITHIN_45S';
  } else {
    report.outcome = 'PAGE_OR_ACTIVITY_IFRAME_UNAVAILABLE';
  }
} catch (error) {
  report.error = { stage: report.stages.at(-1)?.name ?? null, ...safeError(error) };
  report.outcome = deadlineReached ? 'DEADLINE_REACHED' : 'PROBE_ERROR';
} finally {
  if (activityFrame && page && !page.isClosed()) {
    report.wrapperRestoration = await activityFrame.evaluate(() => globalThis.__DL_ACTIVITY_PROBE__?.restore?.() ?? null).catch(() => null);
  }
  if (context) await context.close().catch(() => {});
  clearTimeout(deadline);
  report.finishedAt = new Date().toISOString();
  report.deadlineReached = report.deadlineReached === true || deadlineReached;
  await save();
  console.log(JSON.stringify({ report: reportFile, outcome: report.outcome, readiness: report.readiness,
    iframe: report.iframe, surface: report.surface, receiverObservation: report.receiverObservation,
    wrapperRestoration: report.wrapperRestoration, error: report.error }, null, 2));
}
