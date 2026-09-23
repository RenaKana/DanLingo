// Synthetic YouTube page/network surface only. It never posts a DanLingo bridge message
// or replaces extension code: production MAIN and ISOLATED scripts must do the work.
export const LIVE_FIXTURE_IDS = ['DlLiveRm001', 'DlLiveRm002'];
export const LIVE_FIXTURE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>DanLingo live fixture · LOCAL MOCK</title>
<style>body{margin:0;background:#12191e;color:#edf3f5;font:16px/1.5 system-ui}main{max-width:1180px;margin:24px auto;padding:0 20px}h1{font-size:20px;margin-bottom:4px}p{font-size:13px;color:#aebfc8}nav{display:flex;gap:10px;margin:18px 0}button{background:#253f4a;border:1px solid #668994;color:white;border-radius:6px;padding:8px 12px;cursor:pointer}.layout{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:18px}#player-container-outer{display:block}#movie_player{position:relative;width:100%;aspect-ratio:16/9;background:#173c4a;overflow:hidden}video{display:block;width:100%;height:100%;object-fit:contain}.scene{position:absolute;inset:32% 12% auto;pointer-events:none}.scene strong{font-size:34px;color:#c3e6da}.scene small{display:block;color:#9ebcc6}.controls{position:absolute;bottom:0;left:0;right:0;display:flex;gap:10px;align-items:center;padding:12px;background:#15262ce6}.controls button{padding:5px 10px}.controls span{font-size:12px}#chat{padding:16px;background:#1b272e;border:1px solid #3b525c}#movie_player:fullscreen{width:100vw;height:100vh;aspect-ratio:auto}#fixture-click-count{font-variant-numeric:tabular-nums}.ad-showing{outline:3px solid #ceae6a}[hidden]{display:none!important}</style></head><body><main>
<h1>DanLingo · Live acceptance fixture</h1><p>SYNTHETIC YOUTUBE PAGE + LOCAL MOCK TRANSLATION · no real account or provider</p>
<nav><button id="room-a" type="button">Room A</button><button id="room-b" type="button">Room B</button><button id="hide-chat" type="button">Hide native chat</button><button id="all-chat" type="button">All chat selection</button><button id="home" type="button">Homepage</button></nav>
<div class="layout"><div><div id="player-container-outer"><div id="movie_player"><video aria-label="Synthetic live video"></video><div class="scene"><strong>LIVE / FIXTURE</strong><small id="room-label"></small></div><div class="controls"><button id="play-pause" type="button">Pause</button><button id="fullscreen" type="button">Fullscreen</button><span>Player clicks: <b id="fixture-click-count">0</b></span></div></div></div><p>The in-flow translation status belongs below this player. Chat comments must not intercept player controls.</p></div><ytd-live-chat-frame id="chat"><strong>Native chat fixture</strong><p>This panel can be hidden. Production translation must continue from the structured live chat feed.</p></ytd-live-chat-frame></div></main></body></html>`;

/** Page-world fixture controls are ordinary site data; no private extension hooks. */
export function installLiveFixturePage() {
  const ids = ['DlLiveRm001', 'DlLiveRm002'];
  const state = { room: '', paused: false, seeking: false, ad: false, atLiveEdge: true, clicks: 0, currentTime: 9999, coverage: 'top' };
  const header = room => ({ liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
    { title: 'Top chat', selected: state.coverage === 'top', continuation: { reloadContinuationData: { continuation: `fixture:${room}:top:0` } } },
    { title: 'Live chat', selected: state.coverage === 'all', continuation: { reloadContinuationData: { continuation: `fixture:${room}:all:0` } } },
  ] } } } });
  function globals(room) {
    state.room = room; state.paused = false; state.seeking = false; state.ad = false; state.atLiveEdge = true;
    window.ytInitialPlayerResponse = {
      playabilityStatus: { status: 'OK' }, videoDetails: { videoId: room, title: `LOCAL MOCK ${room}`, isLive: true, isLiveContent: true },
      microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-09-01T00:00:00Z' } } },
    };
    const renderer = { isReplay: false, initialDisplayState: 'LIVE_CHAT_DISPLAY_STATE_EXPANDED', header: header(room),
      continuations: [{ reloadContinuationData: { continuation: `fixture:${room}:${state.coverage}:0` } }] };
    window.ytInitialData = { contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: renderer } } } };
    window.ytcfg = { data_: { INNERTUBE_API_KEY: 'fixture-only-not-a-real-key', INNERTUBE_CLIENT_NAME: 1, INNERTUBE_CLIENT_VERSION: '2.20260911.01.00',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20260911.01.00', hl: 'ja', gl: 'JP' } } }, get(key) { return this.data_[key]; } };
    const app = document.querySelector('ytd-watch-flexy'); if (app) app.data = window.ytInitialData;
    const label = document.getElementById('room-label'); if (label) label.textContent = room;
  }
  const initialId = new URL(location.href).searchParams.get('v') || /\/live\/([^/]+)/.exec(location.pathname)?.[1] || ids[0];
  globals(initialId);
  function mount() {
    const player = document.getElementById('movie_player'), video = player.querySelector('video');
    const emit = type => video.dispatchEvent(new Event(type));
    function update(patch) {
      Object.assign(state, patch); player.classList.toggle('ad-showing', state.ad);
      document.getElementById('play-pause').textContent = state.paused ? 'Play' : 'Pause';
      emit(state.seeking ? 'seeking' : state.paused ? 'pause' : 'playing'); emit('timeupdate');
    }
    Object.defineProperties(video, { paused: { get: () => state.paused }, seeking: { get: () => state.seeking },
      currentTime: { get: () => state.atLiveEdge ? state.currentTime : state.currentTime - 60 }, duration: { get: () => Infinity },
      readyState: { get: () => 4 }, playbackRate: { get: () => 1 }, ended: { get: () => false },
      seekable: { get: () => ({ length: 1, start: () => 0, end: () => state.currentTime }) },
      buffered: { get: () => ({ length: 1, start: () => 0, end: () => state.currentTime }) } });
    video.play = async () => update({ paused: false }); video.pause = () => update({ paused: true });
    Object.assign(player, { getPlayerResponse: () => window.ytInitialPlayerResponse,
      getVideoData: () => ({ video_id: state.room, isLive: true, isLiveContent: true }),
      getPlayerState: () => state.paused ? 2 : 1, getCurrentTime: () => video.currentTime, getDuration: () => state.currentTime,
      isAtLiveHead: () => state.atLiveEdge, getVideoLoadedFraction: () => 1, playVideo: () => video.play(), pauseVideo: () => video.pause() });
    player.addEventListener('click', () => { document.getElementById('fixture-click-count').textContent = String(++state.clicks); });
    document.getElementById('play-pause').addEventListener('click', () => update({ paused: !state.paused }));
    document.getElementById('fullscreen').addEventListener('click', () => { void player.requestFullscreen(); });
    document.getElementById('hide-chat').addEventListener('click', () => { document.getElementById('chat').hidden = !document.getElementById('chat').hidden; });
    function room(id) {
      window.dispatchEvent(new Event('yt-navigate-start')); history.pushState({}, '', '/watch?v=' + id); globals(id); update({});
      window.dispatchEvent(new Event('yt-navigate-finish')); document.dispatchEvent(new Event('yt-page-data-updated'));
    }
    document.getElementById('room-a').addEventListener('click', () => room(ids[0]));
    document.getElementById('room-b').addEventListener('click', () => room(ids[1]));
    document.getElementById('all-chat').addEventListener('click', () => { state.coverage = 'all'; globals(state.room); });
    document.getElementById('home').addEventListener('click', () => {
      window.dispatchEvent(new Event('yt-navigate-start')); history.pushState({}, '', '/');
      window.dispatchEvent(new Event('yt-navigate-finish'));
    });
    window.__DL_LIVE_FIXTURE__ = { state, update, room };
    update({});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
}

export function chatAdd(id, text, authorId = 'fixture-author') {
  return { addChatItemAction: { item: { liveChatTextMessageRenderer: { id, authorExternalChannelId: authorId,
    timestampUsec: String(Date.now() * 1000), message: { runs: [{ text }] } } } } };
}
export const chatDelete = id => ({ markChatItemAsDeletedAction: { targetItemId: id } });
export const chatDeleteAuthor = authorId => ({ markChatItemsByAuthorAsDeletedAction: { externalChannelId: authorId } });

/** Return realistic structured HTTP responses consumed by the production reader. */
export async function installLiveFixtureRoutes(page) {
  const queues = new Map(), requests = [];
  await page.addInitScript(installLiveFixturePage);
  await page.route('https://www.youtube.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname === '/watch' || url.pathname.startsWith('/live/')) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: LIVE_FIXTURE_HTML }); return;
    }
    if (url.pathname !== '/youtubei/v1/live_chat/get_live_chat') { await route.fulfill({ status: 204, body: '' }); return; }
    let body;
    try { body = route.request().postDataJSON(); } catch { body = null; }
    const match = /^fixture:([\w-]{11}):(top|all):(\d+)$/.exec(body?.continuation || '');
    if (!match || !body?.context?.client) { await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }); return; }
    const [, room, mode, indexText] = match, index = Number(indexText);
    const actions = queues.get(room)?.splice(0, 100) || [];
    if (index === 0) actions.unshift(chatAdd(`${room}-baseline`, `BASELINE ${room} 過去のメッセージ`));
    requests.push({ room, index, at: Date.now(), actions: actions.map(action => Object.keys(action)[0]), count: actions.length });
    const renderer = { actions, continuations: [{ timedContinuationData: { continuation: `fixture:${room}:${mode}:${index + 1}`, timeoutMs: 1000 } }],
      header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
        { title: 'Top chat', selected: mode === 'top', continuation: { reloadContinuationData: { continuation: `fixture:${room}:top:0` } } },
        { title: 'Live chat', selected: mode === 'all', continuation: { reloadContinuationData: { continuation: `fixture:${room}:all:0` } } },
      ] } } } } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ continuationContents: { liveChatContinuation: renderer } }) });
  });
  return { requests, enqueue(room, ...actions) { const queue = queues.get(room) || []; queue.push(...actions); queues.set(room, queue); } };
}

/** Read-only observer: actual bridge traffic plus actual rendered shadow-DOM nodes. */
export function installLiveObserver() {
  const state = window.__DL_LIVE_EVIDENCE__ = { documentId: crypto.randomUUID(), snapshots: [], events: [], controls: [], renders: [], removals: [], admissionRejections: [], errors: [], overflow: {}, counts: {} };
  const append = (kind, row, limit = 50000) => {
    state.counts[kind] = (state.counts[kind] || 0) + 1;
    state[kind].push(row);
    if (state[kind].length > limit) { state[kind].shift(); state.overflow[kind] = (state.overflow[kind] || 0) + 1; }
  };
  const sourceSessions = new Map();
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.bridge !== 'danlingo-live-v1') return;
    const at = performance.timeOrigin + performance.now();
    if (d.from === 'adapter' && d.type === 'snapshot') {
      append('snapshots', { at, resourceId: d.resourceId, adapterSession: d.adapterSession, connection: d.connection, coverage: d.coverage, playback: d.playback, reason: d.reason }, 10000);
    }
    if (d.from === 'adapter' && d.type === 'events') {
      append('events', { at, resourceId: d.resourceId, adapterSession: d.adapterSession, events: d.events, removes: d.removes, removeAuthors: d.removeAuthors });
      for (const e of d.events || []) sourceSessions.set(JSON.stringify(['youtube', 'live', d.resourceId, e.sourceId]), d.adapterSession);
      while (sourceSessions.size > 50000) { sourceSessions.delete(sourceSessions.keys().next().value); state.overflow.sourceSessions = (state.overflow.sourceSessions || 0) + 1; }
    }
    if (d.from === 'content' && d.type === 'control') append('controls', { at, enabled: d.enabled, bufferMs: d.bufferMs }, 10000);
  });
  const rows = new WeakMap();
  const rejectionNodes = new WeakSet(), rejectionEvents = new Set();
  let shadow;
  const record = element => {
    if (element.tagName !== 'SPAN' || rows.has(element) || !element.isConnected || getComputedStyle(element).visibility === 'hidden') return;
    const url = new URL(location.href), eventId = element.getAttribute('data-source-event-id');
    const row = { text: element.textContent, at: performance.timeOrigin + performance.now(), resourceId: url.searchParams.get('v') || /^\/live\/([^/]+)/.exec(url.pathname)?.[1] || null,
      eventId, adapterSession: state.snapshots.at(-1)?.adapterSession, sourceAdapterSession: sourceSessions.get(eventId) || null,
      translationStatus: element.getAttribute('data-translation-status'), displayAt: Number(element.getAttribute('data-display-at')) || null,
      preparedAt: Number(element.getAttribute('data-prepared-at')) || null, changes: [] };
    append('renders', row); rows.set(element, row);
  };
  const observer = new MutationObserver(records => {
    // release() appends a hidden temporary span directly to this shadow root, measures it,
    // and removes it synchronously when admission fails. Successful admission first changes
    // inline visibility to visible; normal animation/clear/resize removals retain that value.
    const added = new Set(), removed = new Set();
    for (const change of records) if (change.type === 'childList' && change.target === shadow) {
      for (const node of change.addedNodes) added.add(node);
      for (const node of change.removedNodes) removed.add(node);
    }
    for (const element of added) {
      if (!removed.has(element) || !(element instanceof HTMLElement) || element.tagName !== 'SPAN'
        || element.isConnected || element.parentNode || element.style.visibility !== 'hidden' || rows.has(element) || rejectionNodes.has(element)) continue;
      let animations;
      try { animations = element.getAnimations(); } catch { continue; }
      if (!Array.isArray(animations) || animations.length) continue;
      const eventId = element.getAttribute('data-source-event-id'), snapshot = state.snapshots.at(-1);
      const sourceAdapterSession = sourceSessions.get(eventId);
      let identity; try { identity = JSON.parse(eventId); } catch { continue; }
      if (!Array.isArray(identity) || identity.length !== 4 || identity[0] !== 'youtube' || identity[1] !== 'live'
        || typeof identity[2] !== 'string' || !identity[2] || typeof identity[3] !== 'string' || !identity[3]
        || !sourceAdapterSession || snapshot?.adapterSession !== sourceAdapterSession || snapshot.resourceId !== identity[2]) continue;
      const key = JSON.stringify([identity[2], sourceAdapterSession, eventId]);
      rejectionNodes.add(element);
      if (rejectionEvents.has(key)) continue;
      rejectionEvents.add(key);
      if (rejectionEvents.size > 50000) { rejectionEvents.delete(rejectionEvents.values().next().value); state.overflow.rejectionEvents = (state.overflow.rejectionEvents || 0) + 1; }
      append('admissionRejections', { at: performance.timeOrigin + performance.now(), eventId, resourceId: identity[2],
        adapterSession: snapshot.adapterSession, sourceAdapterSession, reason: 'native-overlay-admission',
        translationStatus: element.getAttribute('data-translation-status'),
        evidence: { sameMutationBatch: true, directObservedShadowChild: true, disconnected: true,
          inlineVisibility: 'hidden', previouslyRendered: false, animations: 0 } });
    }
    for (const change of records) {
      if (change.type === 'childList') {
        for (const node of change.addedNodes) if (node instanceof HTMLElement) record(node);
        for (const node of change.removedNodes) if (rows.has(node)) { const row = rows.get(node); row.removedAt = performance.timeOrigin + performance.now(); append('removals', { eventId: row.eventId, adapterSession: row.adapterSession, text: row.text, at: row.removedAt }); }
      }
      const element = change.target instanceof HTMLElement ? change.target : change.target.parentElement;
      const row = rows.get(element);
      if (row && element.textContent !== (row.changes.at(-1)?.text ?? row.text)) row.changes.push({ text: element.textContent, at: performance.timeOrigin + performance.now() });
    }
  });
  setInterval(() => {
    const next = document.getElementById('danlingo-live-overlay')?.shadowRoot;
    if (!next || next === shadow) return;
    shadow = next; observer.disconnect(); next.querySelectorAll('span').forEach(record); observer.observe(next, { childList: true, characterData: true, subtree: true });
  }, 50);
}

/** Turn only exact, source/session-correlated observed admission failures into cohort outcomes. */
export function observedAdmissionOutcomes(rejections, sources, { startAt, endAt, observedUntil }) {
  if (![startAt, endAt, observedUntil].every(Number.isFinite) || endAt <= startAt || observedUntil < endAt) return [];
  const byId = new Map(sources.map(source => [source.id, source])), seen = new Set(), outcomes = [];
  for (const row of rejections || []) {
    if (row.reason !== 'native-overlay-admission' || !Number.isFinite(row.at) || row.at < startAt || row.at > observedUntil
      || !row.sourceAdapterSession || row.adapterSession !== row.sourceAdapterSession) continue;
    const proof = row.evidence;
    if (proof?.sameMutationBatch !== true || proof.directObservedShadowChild !== true || proof.disconnected !== true
      || proof.inlineVisibility !== 'hidden' || proof.previouslyRendered !== false || proof.animations !== 0) continue;
    let identity; try { identity = JSON.parse(row.eventId); } catch { continue; }
    if (!Array.isArray(identity) || identity.length !== 4 || identity[0] !== 'youtube' || identity[1] !== 'live'
      || typeof identity[2] !== 'string' || !identity[2] || typeof identity[3] !== 'string' || !identity[3] || row.resourceId !== identity[2]) continue;
    const id = JSON.stringify([identity[2], row.sourceAdapterSession, identity[3]]), source = byId.get(id);
    if (!source || !Number.isFinite(source.receivedAt) || source.receivedAt < startAt || source.receivedAt >= endAt || row.at < source.receivedAt || seen.has(id)) continue;
    seen.add(id); outcomes.push({ id, kind: 'dropped', at: row.at, reason: 'native-overlay-admission' });
  }
  return outcomes;
}
