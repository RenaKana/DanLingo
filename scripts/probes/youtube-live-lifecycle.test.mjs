import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as chat from '../../src/platforms/youtube/chat.ts';
import { resourceFromUrl } from '../../src/core/resource.ts';
import { validLiveBufferMs } from '../../src/core/live-budget.ts';

const code = ts.transpileModule(readFileSync(new URL('../../src/platforms/youtube/live.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(frames = []) {
  let now = 0, tick, nextId = 0;
  const events = [], requests = [], listeners = new Map(), timers = new Map();
  const video = { isConnected: true, paused: false, seeking: false, ended: false, readyState: 4, error: null,
    currentTime: 100, seekable: { length: 1, end: () => 100 } };
  const renderer = { continuations: [{ reloadContinuationData: { continuation: 'root', timeoutMs: 1000 } }],
    header: { sortFilterSubMenuRenderer: { subMenuItems: [0, 1].map(i => ({ selected: i === 0,
      continuation: { reloadContinuationData: { continuation: 'menu-' + i } } })) } } };
  const response = { videoDetails: { videoId: 'abcdefghijk', isLive: true } };
  const player = { getVideoData: () => ({ video_id: 'abcdefghijk' }), getPlayerResponse: () => response,
    getPlayerState: () => 1, classList: { contains: () => false }, querySelector: s => s === 'video' ? video : null };
  const window = { ytInitialPlayerResponse: response, ytInitialData: { liveChatRenderer: renderer }, ytcfg: { get: () => ({ client: {} }) },
    postMessage: d => events.push(d), addEventListener: (n, fn) => listeners.set(n, fn), removeEventListener: n => listeners.delete(n) };
  window.top = window;
  const location = { href: 'https://www.youtube.com/watch?v=abcdefghijk', origin: 'https://www.youtube.com' };
  const document = { hidden: false, querySelector: s => s === '#movie_player' ? player : null, querySelectorAll: () => frames,
    addEventListener() {}, removeEventListener() {} };
  const exports = {};
  const context = { exports, window, location, document, AbortController, URL, TextDecoder, crypto,
    performance: { now: () => now }, getComputedStyle: () => ({ visibility: 'visible' }),
    setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; },
    setTimeout: (fn, ms) => { timers.set(++nextId, { fn, due: now + ms }); return nextId; }, clearTimeout: id => timers.delete(id),
    require: id => id.includes('resource') ? { resourceFromUrl, clockStamp: () => 1e12 + now } : id.includes('live-budget') ? { validLiveBufferMs } : chat,
    fetch: (url, options) => new Promise((resolve, reject) => {
      const row = { url, options, at: now, resolve, aborted: false }; requests.push(row);
      options.signal.addEventListener('abort', () => { row.aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
    }) };
  vm.runInNewContext(code, context);
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const control = enabled => listeners.get('message')?.({ source: window, origin: location.origin,
    data: { bridge: 'danlingo-live-v1', from: 'content', type: 'control', enabled, bufferMs: 2000 } });
  const advance = async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); } tick?.(); await flush(); };
  const reply = async (index, id, status = 200, retry = null) => {
    const actions = id ? [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id, message: { simpleText: id } } } } }] : [];
    requests[index].resolve(new Response(JSON.stringify({ continuationContents: { liveChatContinuation: {
      actions, continuations: [{ timedContinuationData: { continuation: 'next-' + index, timeoutMs: 2000 } }] } } }),
    { status, headers: retry ? { 'retry-after': retry } : {} })); await flush();
  };
  const stop = exports.startYoutubeLiveBridge();
  return { events, requests, video, player, window, control, advance, reply, stop, restart: exports.startYoutubeLiveBridge, flush };
}

test('reader enforces one request, server interval and initial baseline', async () => {
  const h = harness(); h.control(true); h.control(true); assert.equal(h.requests.length, 1);
  await h.reply(0, 'history'); assert.equal(h.events.filter(e => e.type === 'events').length, 0);
  await h.advance(1999); assert.equal(h.requests.length, 1);
  h.control(true); await h.advance(1); assert.equal(h.requests.length, 2);
  await h.reply(1, 'new'); assert.equal(h.events.find(e => e.type === 'events').events[0].sourceId, 'new'); h.stop();
});
test('lost isolated controller aborts its active request and no longer polls', async () => {
  const h = harness(); h.control(true); await h.advance(6001);
  assert.equal(h.requests[0].aborted, true); assert.equal(h.events.at(-1).connection, 'disconnected');
  await h.advance(30000); assert.equal(h.requests.length, 1);
  h.control(true); assert.equal(h.requests.length, 2); await h.reply(1, 'new-baseline');
  assert.equal(h.events.filter(e => e.type === 'events').length, 0); h.stop();
});
test('explicit disable and repeated injection retire the old reader', async () => {
  const h = harness(); h.control(true); h.control(false); assert.equal(h.requests[0].aborted, true);
  h.control(true); const stop = h.restart(); await h.flush(); assert.equal(h.requests[1].aborted, true);
  h.control(true); assert.equal(h.requests.length, 3); stop();
});
test('429 obeys Retry-After and reconnect starts from a fresh baseline', async () => {
  const h = harness(); h.control(true); await h.reply(0, null, 429, '5');
  h.control(true); await h.advance(4999); assert.equal(h.requests.length, 1);
  await h.advance(1); assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].options.body).continuation, 'root');
  await h.reply(1, 'during-gap'); assert.equal(h.events.filter(e => e.type === 'events').length, 0); h.stop();
});
test('pause aborts and resume never catches up old messages', async () => {
  const h = harness(); h.control(true); h.video.paused = true; await h.advance(1);
  assert.equal(h.requests[0].aborted, true); h.video.paused = false; h.control(true);
  await h.reply(1, 'paused-history'); assert.equal(h.events.filter(e => e.type === 'events').length, 0); h.stop();
});
test('native live-head resolves future seekable end; native DVR false still blocks', async () => {
  const h = harness(); h.video.seekable.end = () => 3700; h.player.isAtLiveHead = () => true;
  h.control(true); assert.equal(h.events.at(-1).playback.atLiveEdge, true); assert.equal(h.requests.length, 1);
  h.player.isAtLiveHead = () => false; h.video.seekable.end = () => 100; await h.advance(1);
  assert.equal(h.events.at(-1).playback.atLiveEdge, false); assert.equal(h.requests[0].aborted, true); h.stop();
});

const filterFrame = (srcRoom, documentRoom = srcRoom) => {
  const data = { header: { sortFilterSubMenuRenderer: { subMenuItems: [0, 1].map(i => ({ selected: i === 1,
    continuation: { reloadContinuationData: { continuation: 'filter-' + i } } })) } } };
  return { src: `https://www.youtube.com/live_chat?v=${srcRoom}`, contentWindow: {
    location: { href: `https://www.youtube.com/live_chat?v=${documentRoom}` },
    document: { querySelector: () => ({ data }) },
  }, data };
};

test('old-room or not-yet-navigated chat frames cannot change the current room filter', () => {
  for (const frame of [filterFrame('oldroom1234'), filterFrame('abcdefghijk', 'oldroom1234')]) {
    const h = harness([frame]);
    try { h.control(true); assert.equal(h.requests.length, 1); assert.equal(h.events.at(-1).coverage, 'top'); }
    finally { h.stop(); }
  }
});

test('current-room All chat stops intake and explicit Top chat re-establishes a baseline', async () => {
  const frame = filterFrame('abcdefghijk');
  const h = harness([frame]);
  try {
    h.control(true); assert.equal(h.requests.length, 0); assert.equal(h.events.at(-1).reason, 'unsupported-all-chat');
    frame.data.header.sortFilterSubMenuRenderer.subMenuItems.forEach((item, i) => { item.selected = i === 0; });
    await h.advance(1); assert.equal(h.requests.length, 1);
    await h.reply(0, 'filter-gap-history'); assert.equal(h.events.filter(event => event.type === 'events').length, 0);
    await h.advance(2000); await h.reply(1, 'fresh-top');
    assert.equal(h.events.find(event => event.type === 'events').events[0].sourceId, 'fresh-top');
  } finally { h.stop(); }
});
