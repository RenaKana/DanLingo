import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// Bounded native-list entry probe; no extension, provider, account or media diagnosis.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function installNativeChatProbe() {
  const room = new URL(location.href).searchParams.get('v');
  const find = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 20) return null;
    if (value.liveChatRenderer) return value.liveChatRenderer;
    for (const child of Object.values(value)) { const match = find(child, depth + 1); if (match) return match; }
    return null;
  };
  const watch = document.querySelector('ytd-watch-flexy');
  const renderer = find(watch?.data) || find(window.ytInitialData);
  const rootToken = renderer?.continuations?.find(row => row.reloadContinuationData)?.reloadContinuationData.continuation;
  const binding = [];
  const frame = [...document.querySelectorAll('ytd-live-chat-frame iframe')].find(frame => {
    try {
      const u = new URL(frame.contentWindow.location.href), parent = frame.closest('ytd-live-chat-frame'), host = parent?.polymerController || parent?.inst || parent;
      const b = new URL(host?.baseUrl || 'about:blank', location.href);
      const tokenMatches = !!rootToken && u.searchParams.get('continuation') === rootToken;
      binding.push({ frameQueryKeys: [...u.searchParams.keys()], basePath: b.pathname, baseQueryKeys: [...b.searchParams.keys()], rootTokenPresent: !!rootToken, tokenMatches,
        baseTokenMatches: !!u.searchParams.get('continuation') && b.searchParams.get('continuation') === u.searchParams.get('continuation') });
      return u.origin === location.origin && u.pathname === '/live_chat' && (u.searchParams.get('v') === room || tokenMatches);
    } catch { return false; }
  });
  const doc = frame?.contentDocument;
  const element = doc?.querySelector('yt-live-chat-item-list-renderer');
  const list = [element?.polymerController, element?.inst, element].find(value => typeof value?.handleAddChatItemAction_ === 'function' && typeof value?.handleLiveChatActions_ === 'function');
  if (!list) return { attached: false, frame: !!frame, element: !!element, binding };
  const original = list.handleAddChatItemAction_, batch = list.handleLiveChatActions_;
  const own = Object.getOwnPropertyDescriptor(list, 'handleAddChatItemAction_');
  const seen = new Set(), pending = new Map();
  let stopped = false, bypass = false, sequence = 0;
  const stats = { attached: true, received: 0, held: 0, submitted: 0, presented: 0, visibleBeforeRelease: 0, lateAfterRestore: 0,
    duplicateInput: 0, nativeError: 0, mutationsObserved: 0, scrollChangedByRelease: 0, markerPresented: 0, retainedMetadata: true, restored: false };
  const rows = () => [...doc.querySelectorAll('yt-live-chat-text-message-renderer')];
  const identity = row => row.data?.id || row.polymerController?.data?.id || row.id;
  const observer = new MutationObserver(() => { stats.mutationsObserved++; });
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  const submit = record => {
    if (!pending.delete(record.id)) return;
    clearTimeout(record.timer);
    if (!element.isConnected || frame.contentDocument !== doc) return;
    if (rows().some(row => identity(row) === record.id)) stats.visibleBeforeRelease++;
    const source = record.action.item.liveChatTextMessageRenderer;
    const copy = { ...source, message: { simpleText: '[DL entry probe] ' + record.ordinal } };
    stats.retainedMetadata &&= Object.keys(source).filter(key => key !== 'message').every(key => copy[key] === source[key]);
    const action = { ...record.action, item: { ...record.action.item, liveChatTextMessageRenderer: copy } };
    const scroller = list.$?.['item-scroller'];
    const wasAtBottom = typeof list.canScrollToBottom_ === 'function' ? list.canScrollToBottom_() : null;
    const top = scroller?.scrollTop;
    bypass = true;
    try { Reflect.apply(batch, list, [[{ addChatItemAction: action }]]); stats.submitted++; }
    catch { stats.nativeError++; }
    finally { bypass = false; }
    setTimeout(() => {
      const row = rows().find(row => identity(row) === record.id);
      if (row) { stats.presented++; if (row.textContent.includes('[DL entry probe]')) stats.markerPresented++; }
      if (wasAtBottom === false && scroller?.scrollTop !== top) stats.scrollChangedByRelease++;
    }, 300);
  };
  const wrapper = function(action) {
    const source = action?.item?.liveChatTextMessageRenderer;
    if (bypass || stopped || this !== list || !source?.id || stats.held >= 8) return Reflect.apply(original, this, arguments);
    stats.received++;
    if (seen.has(source.id)) { stats.duplicateInput++; return; }
    seen.add(source.id);
    const record = { id: source.id, action, ordinal: ++sequence, timer: null };
    pending.set(source.id, record); stats.held++;
    record.timer = setTimeout(() => submit(record), 500);
  };
  list.handleAddChatItemAction_ = wrapper;
  window.__DL_NATIVE_ENTRY_PROBE__ = {
    snapshot: () => ({ ...stats, pending: pending.size }),
    stop() {
      if (stopped) return { ...stats };
      stopped = true;
      for (const record of [...pending.values()]) {
        clearTimeout(record.timer); pending.delete(record.id); bypass = true;
        try { Reflect.apply(batch, list, [[{ addChatItemAction: record.action }]]); } catch { stats.nativeError++; }
        finally { bypass = false; }
      }
      if (list.handleAddChatItemAction_ === wrapper) {
        if (own) Object.defineProperty(list, 'handleAddChatItemAction_', own); else delete list.handleAddChatItemAction_;
      }
      stats.restored = list.handleAddChatItemAction_ === original;
      observer.disconnect(); return { ...stats, pending: pending.size };
    },
  };
  return { ...stats, binding };
}

export async function main(args) {
  if (args.includes('--help')) { console.log('node scripts/probes/youtube-native-chat.mjs --url https://www.youtube.com/watch?v=ID [--seconds 20] [--browser chromium|edge]\nIndependent native chat entry probe. Up to eight genuine ordinary events receive a local marker after 500ms, then original methods are restored. No provider, posting or moderation. No media acceptance claim.'); return; }
  const values = {};
  for (let i = 0; i < args.length; i += 2) { assert.ok(['--url', '--seconds', '--browser'].includes(args[i]) && args[i + 1] && !values[args[i]]); values[args[i]] = args[i + 1]; }
  const url = new URL(values['--url']);
  assert.ok(url.origin === 'https://www.youtube.com' && url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v')));
  const seconds = Number(values['--seconds'] || 20), browserName = values['--browser'] || 'chromium';
  assert.ok(seconds >= 12 && seconds <= 30 && ['chromium','edge'].includes(browserName));
  const { chromium } = await loadPlaywright();
  const base = resolve('.artifacts/live/native-chat-entry'); await mkdir(base, { recursive: true });
  const runDir = await mkdtemp(resolve(base, 'probe-'));
  const report = { capturedAt: new Date().toISOString(), status: 'INCOMPLETE', room: url.searchParams.get('v'), browser: browserName,
    windowSeconds: seconds, providerRequests: 0, nativeChatResponses: 0, checks: {}, error: null,
    limitation: 'Real native entry and local marker only. Not real translation, personal Chrome, full lifecycle, media health or long-term stability acceptance.' };
  let browser, page;
  try {
    browser = await chromium.launch({ ...browserLaunchOptions(browserName), headless: true }); report.browserVersion = browser.version();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); report.phase = 'navigate';
    page.on('response', response => { const u = new URL(response.url()); if (u.origin === url.origin && u.pathname === '/youtubei/v1/live_chat/get_live_chat' && response.status() === 200) report.nativeChatResponses++; });
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    report.phase = 'find-native-list';
    await page.waitForFunction(() => {
      try { return !!document.querySelector('ytd-live-chat-frame iframe')?.contentDocument?.querySelector('yt-live-chat-item-list-renderer'); } catch { return false; }
    }, undefined, { timeout: 25000 });
    report.initial = await page.evaluate(installNativeChatProbe);
    report.phase = 'observe-entry';
    assert.ok(report.initial.attached, 'native-entry-unavailable');
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    report.observation = await page.evaluate(() => window.__DL_NATIVE_ENTRY_PROBE__.snapshot());
    report.restoration = await page.evaluate(() => window.__DL_NATIVE_ENTRY_PROBE__.stop());
    const s = report.observation;
    report.checks = { realMessages: s.held > 0, withheldBeforeNativeRender: s.held > 0 && s.visibleBeforeRelease === 0,
      nativeMarkerPresented: s.presented > 0 && s.markerPresented === s.presented, metadataPreserved: s.retainedMetadata,
      exactSubmissions: s.submitted === s.held && s.nativeError === 0 && s.pending === 0, restored: report.restoration.restored };
    if (Object.values(report.checks).every(Boolean)) report.status = 'PASS_REAL_NATIVE_ENTRY_PROBE_ONLY';
  } catch (error) { report.error = error?.name === 'TimeoutError' ? 'timeout-at-recorded-phase' : /net::ERR_/.test(error?.message || '') ? 'browser-network-error' : 'native-entry-probe-incomplete'; }
  finally {
    report.surface = await page?.evaluate(() => ({ chatCollapsed: document.querySelector('ytd-watch-flexy')?.hasAttribute('is-chat-collapsed'),
      live: window.ytInitialPlayerResponse?.videoDetails?.isLive === true,
      frames: [...document.querySelectorAll('iframe')].slice(0,10).map(frame => {
        try { const url = new URL(frame.src, location.href), e = frame.contentDocument?.querySelector('yt-live-chat-item-list-renderer');
          const docUrl = new URL(frame.contentDocument?.URL || 'about:blank'), locationUrl = new URL(frame.contentWindow?.location.href || 'about:blank');
          const parent = frame.closest('ytd-live-chat-frame'), controller = parent?.polymerController || parent?.inst || parent;
          return { path: url.origin === location.origin ? url.pathname : 'other-origin', srcEmpty: !frame.getAttribute('src'), listPresent: !!e,
            documentPath: docUrl.origin === location.origin ? docUrl.pathname : docUrl.protocol,
            documentRoomMatches: docUrl.searchParams.get('v') === new URL(location.href).searchParams.get('v'),
            locationPath: locationUrl.origin === location.origin ? locationUrl.pathname : locationUrl.protocol,
            parentAttributes: parent?.getAttributeNames(), parentProperties: Object.keys(controller || {}).filter(k => /video|resource|frame|data|url/i.test(k)).slice(0,40),
            controllerMethods: [e?.polymerController,e?.inst,e].map(c => ['handleAddChatItemAction_','handleLiveChatActions_','handleLiveChatAction_','flushActiveItems_'].filter(k => typeof c?.[k] === 'function')) }; } catch { return { inaccessible: true }; }
      }) })).catch(() => null);
    await page?.screenshot({path:resolve(runDir,'surface.png')}).catch(() => {});
    await page?.evaluate(() => window.__DL_NATIVE_ENTRY_PROBE__?.stop()).catch(() => {}); await browser?.close().catch(() => {});
    await writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), ...report }));
  if (report.status !== 'PASS_REAL_NATIVE_ENTRY_PROBE_ONLY') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv.slice(2));
