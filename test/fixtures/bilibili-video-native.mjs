// Synthetic Bilibili VOD surface. It exposes only the public player/danmakuX
// boundary used by the production adapter; no network or private store walk is
// required for this fixture.

export const BVID = 'BV1xx411c7mD';
export const AID = '2';
export const FIRST_CID = '62131';
export const SECOND_CID = '62132';
export const REBUILT_CID = '72132';
export const FIRST_URL = `https://www.bilibili.com/video/${BVID}/?p=1`;
export const SECOND_URL = `https://www.bilibili.com/video/${BVID}/?p=2`;

export const videoHtml = `<!doctype html>
<meta charset="utf-8">
<title>Synthetic Bilibili VOD native danmaku</title>
<style>
  :root { color-scheme: light; font: 14px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif; }
  body { margin: 24px; color: #203229; background: #eef5f0; }
  main { max-width: 1120px; display: grid; grid-template-columns: minmax(0, 760px) 300px; gap: 20px; align-items: start; }
  #player-column { display: block; min-width: 0; }
  #playerWrap { position: relative; display: block; min-height: 430px; padding: 20px; border: 1px solid #b9cdbd; border-radius: 12px; background: #14211a; color: #f3fff5; }
  #playerWrap video { display: block; width: 100%; height: 360px; background: #24342a; border-radius: 8px; }
  #playerWrap .caption { margin-top: 12px; color: #c8e4cf; }
  #danmaku-stage { position: absolute; inset: 22px; pointer-events: none; overflow: hidden; }
  #danmaku-stage [data-dmid] { margin: 4px 0; color: #fff; text-shadow: 1px 1px 2px #000; white-space: pre-wrap; }
  #fixture-controls, #native-evidence, #rendered { margin-top: 14px; padding: 12px; border: 1px solid #b9cdbd; border-radius: 8px; background: #fff; }
  #native-evidence, #rendered { max-height: 250px; overflow: auto; }
  code { font-family: Consolas, monospace; font-size: 12px; }
  button { margin: 4px 6px 4px 0; }
  @media (max-width: 900px) { main { display: block; } #player-column { margin-bottom: 20px; } }
</style>
<main>
  <section id="player-column">
    <div id="playerWrap"><video id="fixture-video" muted></video><div id="danmaku-stage"></div><div class="caption">Synthetic Bilibili native player (paused by default)</div></div>
    <div id="fixture-controls"><strong>Fixture controls</strong><div>
      <button id="fixture-play" type="button">play</button>
      <button id="fixture-pause" type="button">pause</button>
      <button id="fixture-seek" type="button">seek 42s</button>
      <button id="fixture-rate" type="button">rate 1.5×</button>
      <button id="fixture-fullscreen" type="button">fullscreen</button>
    </div></div>
  </section>
  <aside><h2>Native evidence</h2><pre id="native-evidence"></pre><h2>Rendered</h2><div id="rendered"></div></aside>
</main>
<script>
(() => {
  const metadata = { version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' };
  const stage = document.querySelector('#danmaku-stage');
  const rendered = document.querySelector('#rendered');
  const evidenceNode = document.querySelector('#native-evidence');
  const video = document.querySelector('#fixture-video');
  const state = { page: 1, bvid: ${JSON.stringify(BVID)}, aid: ${JSON.stringify(AID)}, cid: ${JSON.stringify(FIRST_CID)}, time: 0, paused: true, rate: 1, duration: 600, played: 0 };
  const history = { players: [], getDanmakuCalls: 0, hookCalls: 0, insertCalls: 0, measurements: [], renders: [], events: [], playCalls: 0, pauseCalls: 0 };
  const prefix = '【模拟译文】';
  const pool = [];
  const idAliases = new Map();
  const dmidFor = raw => {
    const value = String(raw);
    if (/^\d+$/.test(value)) return value;
    if (!idAliases.has(value)) idAliases.set(value, String(1000 + idAliases.size));
    return idAliases.get(value);
  };
  const poison = { dmid: '999999999999999999', id_str: '999999999999999999', text: 'HISTORICAL_SHOULD_NOT_BE_READ', stime: 1, mode: 1, rawMode: 1, size: 25, color: 16777215, pool: 0, on: false };
  const activeModels = [];
  const listeners = new Map();

  function defineVideoSurface() {
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => state.time, set: value => { state.time = Number(value) || 0; } });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => state.duration });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => state.paused });
    Object.defineProperty(video, 'playbackRate', { configurable: true, get: () => state.rate, set: value => { state.rate = Number(value) || 1; } });
    Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
    Object.defineProperty(video, 'seeking', { configurable: true, get: () => !!state.seeking });
    Object.defineProperty(video, 'played', { configurable: true, get: () => ({ length: state.played ? 1 : 0 }) });
    Object.defineProperty(video, 'buffered', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => Math.min(state.duration, 120) }) });
    video.addEventListener = (type, listener, options) => { const list = listeners.get(type) ?? []; list.push({ listener, options }); listeners.set(type, list); EventTarget.prototype.addEventListener.call(video, type, listener, options); };
    video.removeEventListener = (type, listener, options) => { const list = listeners.get(type) ?? []; listeners.set(type, list.filter(row => row.listener !== listener)); EventTarget.prototype.removeEventListener.call(video, type, listener, options); };
    video.play = async () => { history.playCalls++; state.paused = false; state.played = 1; video.dispatchEvent(new Event('playing')); return undefined; };
    video.pause = () => { history.pauseCalls++; state.paused = true; video.dispatchEvent(new Event('pause')); };
  }

  function item(id, text, stime, mode = 1, extra = {}) {
    const fixtureKey = String(id), dmid = dmidFor(fixtureKey);
    return { dmid, id_str: dmid, fixtureKey, text, stime, mode, rawMode: mode, size: 25, color: 16777215, pool: 0, date: 1750000000, on: false, ...extra };
  }

  function initialPool(cid) {
    return [
      item('mode-1', '普通滚动弹幕', 3, 1),
      item('mode-4', '顶部弹幕', 6, 4),
      item('mode-5', '底部弹幕', 9, 5),
      item('mode-6', '逆向弹幕', 12, 6),
      item('special-7', '特殊样式保留原文', 15, 7),
      item('special-8', '命令样式保留原文', 18, 8),
      item('swap-' + cid, '资源切换前的长文本', 24, 1),
    ];
  }

  function emitEvent(type, value = {}) { history.events.push({ type, at: performance.now(), ...value }); if (history.events.length > 500) history.events.shift(); }
  function dispatch(type) { video.dispatchEvent(new Event(type)); emitEvent(type, { time: state.time, paused: state.paused, rate: state.rate }); }

  function removeRendered(id) {
    for (const node of [...stage.querySelectorAll('[data-dmid]')]) if (node.dataset.dmid === String(id)) node.remove();
    for (let i = activeModels.length - 1; i >= 0; i--) if (String(activeModels[i].textData?.dmid) === String(id)) { activeModels[i].textData.on = false; activeModels.splice(i, 1); }
  }

  function renderNative(itemValue, model) {
    const node = document.createElement('div'); node.dataset.dmid = String(itemValue.dmid); node.textContent = model.text;
    stage.append(node); const row = document.createElement('div'); row.dataset.dmid = String(itemValue.dmid); row.textContent = model.text; rendered.append(row);
    history.renders.push({ id: String(itemValue.dmid), text: model.text, at: performance.now() });
  }

  function createNative(next) {
    for (const model of [...activeModels]) removeRendered(model.textData.dmid);
    state.page = next.page; state.cid = String(next.cid);
    pool.length = 0;
    if (!new URLSearchParams(location.search).has('empty')) {
      pool.push(...initialPool(state.cid));
      pool.push(item('long-' + state.cid, '长文本'.repeat(90), 30, 1));
      pool.push(item('incremental-' + state.cid, '稍后追加的分段弹幕', 36, 1));
    }
    const manager = {
      dataBase: { dmArray: pool },
      allDm: [poison],
      visualArray: activeModels,
      measurements: history.measurements,
      insert(pending) {
        history.insertCalls++;
        const hookPending = pending.slice();
        const result = instance.hooks.beforeRender.call(this, this.visualArray.slice(), hookPending);
        const start = history.renders.length;
        for (const value of pending) {
          if (!value || value.on) continue;
          value.on = true;
          this.initRender(value);
        }
        const measured = history.renders.slice(start).map(row => row.text);
        history.measurements.push({ at: performance.now(), ids: pending.map(value => String(value?.dmid ?? '')), measured });
        return { result, measured };
      },
      initRender(value) {
        const model = { textData: value, text: value.text, width: String(value.text).length * 12, height: 26, showed: true };
        this.visualArray.push(model); renderNative(value, model);
      },
    };
    const hooks = {};
    const nativeHook = function(active, pending) { history.hookCalls++; emitEvent('native-beforeRender', { active: active.length, pending: pending.length }); for (const value of pending) if (value && typeof value === 'object') value.nativeHookTouched = true; return 'native-hook-return'; };
    Object.defineProperty(hooks, 'beforeRender', { configurable: true, enumerable: true, writable: true, value: nativeHook });
    const instance = {
      getMetadata: () => ({ ...metadata }),
      hooks,
      manager,
    };
    const player = {
      getManifest: () => ({ bvid: state.bvid, aid: state.aid, cid: String(next.cid), p: next.page }),
      mediaElement: () => video,
      danmaku: { getDanmakuX: () => { history.getDanmakuCalls++; return instance; } },
    };
    const baseline = { hooks: nativeHook, insert: manager.insert, initRender: manager.initRender, instance, manager, player };
    history.players.push(baseline); window.player = player;
    emitEvent('binding-created', { page: state.page, cid: state.cid });
    return baseline;
  }

  function nativeEvidence() {
    const player = window.player; const api = player?.danmaku; const instance = api?.getDanmakuX?.();
    const config = player?.getManifest();
    const manager = instance?.manager; const descriptor = instance?.hooks && Object.getOwnPropertyDescriptor(instance.hooks, 'beforeRender');
    return { metadata: instance?.getMetadata?.(), identity: config && { bvid: config.bvid, aid: String(config.aid), cid: String(config.cid), page: Number(config.p) },
      getDanmakuCalls: history.getDanmakuCalls, video: { currentTime: video.currentTime, paused: video.paused, playbackRate: video.playbackRate, duration: video.duration, seeking: video.seeking },
      hook: { own: !!descriptor, writable: descriptor?.writable === true, type: typeof instance?.hooks?.beforeRender, wrapped: !!instance && instance.hooks.beforeRender !== history.players.at(-1)?.hooks },
      initWrapped: !!manager && manager.initRender !== history.players.at(-1)?.initRender,
      insertWrapped: !!manager && manager.insert !== history.players.at(-1)?.insert, managerArrays: { dmArray: Array.isArray(manager?.dataBase?.dmArray), visualArray: Array.isArray(manager?.visualArray), allDm: Array.isArray(manager?.allDm) },
      poolCount: manager?.dataBase?.dmArray?.length ?? 0, allDmCount: manager?.allDm?.length ?? 0, history: { hookCalls: history.hookCalls, insertCalls: history.insertCalls, measurements: history.measurements.slice(-12), playCalls: history.playCalls, pauseCalls: history.pauseCalls } };
  }

  function fixtureSnapshot() {
    const manager = window.player?.danmaku?.getDanmakuX?.()?.manager;
    return { page: state.page, cid: state.cid, url: location.href, poolCount: manager?.dataBase?.dmArray?.length ?? 0, pool: manager?.dataBase?.dmArray?.map(value => ({ id: value.fixtureKey ?? String(value.dmid), dmid: String(value.dmid), text: value.text, mode: value.mode })) ?? [], active: manager?.visualArray?.map(value => ({ id: value.textData?.fixtureKey ?? String(value.textData?.dmid), dmid: String(value.textData?.dmid), text: value.textData?.text, modelText: value.text })) ?? [], measurements: history.measurements.slice(-20), renders: history.renders.slice(-30), events: history.events.slice(-30), native: nativeEvidence() };
  }

  function restorations() {
    return history.players.slice(0, -1).map((baseline, index) => ({ index, hookRestored: baseline.instance.hooks.beforeRender === baseline.hooks, insertRestored: baseline.manager.insert === baseline.insert, initRestored: baseline.manager.initRender === baseline.initRender }));
  }

  function itemFor(id) { return window.player?.danmaku?.getDanmakuX?.()?.manager?.dataBase?.dmArray?.find(value => String(value.dmid) === String(id) || value.fixtureKey === String(id)); }
  function sourceIdFor(id) { return itemFor(id)?.dmid ?? dmidFor(id); }
  function render(id, clear = true) { const current = itemFor(id); if (!current) throw new Error('fixture item missing: ' + id); if (clear) removeRendered(current.dmid); return window.player.danmaku.getDanmakuX().manager.insert([current]); }
  function addPool(id, text, stime = 40, mode = 1) { const current = window.player.danmaku.getDanmakuX(); const value = item(id, text, stime, mode); current.manager.dataBase.dmArray.push(value); emitEvent('pool-append', { id: String(id), mode }); return value; }
  function addLongAndActive() { const current = window.player.danmaku.getDanmakuX(); const long = item('long-check', '预译量'.repeat(120), 48, 1); current.manager.dataBase.dmArray.push(long); for (const id of ['active-a', 'active-b']) { const data = item(id, '活动模型原文-' + id, 49, 1); const model = { textData: data, text: data.text, width: 100, height: 20, showed: true }; current.manager.visualArray.push(model); } return { id: long.dmid, text: long.text, activeIds: ['active-a', 'active-b'] }; }
  function prepareSwapItem(id) { const current = itemFor(id); if (!current) throw new Error('swap item missing'); removeRendered(id); return current; }
  function switchPage(page, cid) {
    const oldPlayer = window.player; const oldInstance = oldPlayer.danmaku.getDanmakuX(); const oldManager = oldInstance.manager; const oldItem = prepareSwapItem('swap-' + state.cid); window.history.pushState({}, '', '/video/' + state.bvid + '/?p=' + page); const oldImmediate = oldManager.insert([oldItem]); const oldSummary = { measured: oldImmediate?.measured?.slice?.() ?? [], original: oldItem.text, oldCid: String(oldPlayer.getManifest().cid), url: location.href }; createNative({ page, cid }); history.events.push({ type: 'resource-swap', kind: 'page', old: oldSummary, at: performance.now() }); return oldSummary;
  }
  function rebuildCid(cid) {
    const oldPlayer = window.player, oldInstance = oldPlayer.danmaku.getDanmakuX(), oldManager = oldInstance.manager;
    const oldItem = prepareSwapItem('swap-' + state.cid);
    // A same-URL resource change is established by the current native player,
    // not by an unrelated history entry. Call the retired manager immediately
    // after replacement and before the adapter's next discovery tick.
    createNative({ page: state.page, cid });
    const oldImmediate = oldManager.insert([oldItem]);
    const oldSummary = { measured: oldImmediate?.measured?.slice?.() ?? [], original: oldItem.text, oldCid: String(oldPlayer.getManifest().cid), url: location.href };
    history.events.push({ type: 'resource-swap', kind: 'cid', old: oldSummary, at: performance.now() }); return oldSummary;
  }
  function setTime(value) { state.seeking = true; state.time = Number(value) || 0; dispatch('seeking'); state.seeking = false; dispatch('seeked'); }
  function setRate(value) { state.rate = Number(value) || 1; dispatch('ratechange'); }
  function play() { video.play(); }
  function pause() { video.pause(); }
  function spaDisableEnable() { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); return nativeEvidence(); }
  function clearActive(id) { removeRendered(id); }

  defineVideoSurface();
  const first = createNative({ page: 1, cid: ${JSON.stringify(FIRST_CID)} });
  window.__BILI_FIXTURE__ = { metadata, state, history, player: () => window.player, nativeEvidence, snapshot: fixtureSnapshot, restorations, itemFor, sourceId: sourceIdFor, render, addPool, addLongAndActive, prepareSwapItem, switchPage, rebuildCid, setTime, setRate, play, pause, spaDisableEnable, clearActive, prefix };
  document.querySelector('#fixture-play').onclick = play;
  document.querySelector('#fixture-pause').onclick = pause;
  document.querySelector('#fixture-seek').onclick = () => setTime(42);
  document.querySelector('#fixture-rate').onclick = () => setRate(1.5);
  document.querySelector('#fixture-fullscreen').onclick = () => document.querySelector('#playerWrap').requestFullscreen();
  setInterval(() => { evidenceNode.textContent = JSON.stringify(nativeEvidence(), null, 2); }, 250);
})();
</script>`;

export function pageUrl(page = 1) {
  return `https://www.bilibili.com/video/${BVID}/?p=${page}`;
}
