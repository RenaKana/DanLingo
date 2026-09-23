// Self-contained MAIN-world L0 probe. Runtime tokens/context remain in the page and never enter artifacts.
// This is a probe, not production platform support or a stable public YouTube API contract.
export function installYoutubeLiveProbe(requestedMode) {
  const existing = window.__DANLINGO_YOUTUBE_L0__;
  existing?.stop();
  const find = (value, key, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 24) return null;
    if (value[key]) return value[key];
    for (const v of Object.values(value)) { const result = find(v, key, depth + 1); if (result) return result; }
    return null;
  };
  const text = value => typeof value?.simpleText === 'string' ? value.simpleText
    : (value?.runs || []).map(run => typeof run.text === 'string' ? run.text : run.emoji?.shortcuts?.[0] || run.emoji?.accessibility?.accessibilityData?.label || '').join('');
  const continuationOf = renderer => {
    for (const name of ['invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData']) {
      for (const entry of renderer?.continuations || []) {
        if (typeof entry[name]?.continuation === 'string') return { type: name, value: entry[name].continuation, timeoutMs: Number(entry[name].timeoutMs) || 1000 };
      }
    }
    return null;
  };
  const initialPlayer = window.ytInitialPlayerResponse;
  const watchId = new URL(location.href).searchParams.get('v');
  const liveNow = initialPlayer?.videoDetails?.isLive === true || initialPlayer?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true;
  const watchRenderer = find(window.ytInitialData, 'liveChatRenderer');
  const apiContext = window.ytcfg?.get('INNERTUBE_CONTEXT');
  const requestedItem = requestedMode === 'all' ? find(watchRenderer?.header, 'sortFilterSubMenuRenderer')?.subMenuItems?.[1] : null;
  const initialContinuation = requestedItem ? continuationOf({ continuations: [requestedItem.continuation] }) : continuationOf(watchRenderer);
  if (location.origin !== 'https://www.youtube.com' || location.pathname !== '/watch' || !watchId || initialPlayer?.videoDetails?.videoId !== watchId) throw new Error('Current watch scope unavailable');
  if (!liveNow || watchRenderer?.isReplay) throw new Error('Not a currently live non-replay watch session');
  if (!apiContext?.client || !initialContinuation) throw new Error('Current page chat continuation/context unavailable');
  const state = {
    watchId, title: initialPlayer.videoDetails.title, liveNow, phase: 'visible', stopped: false,
    baseline: null, requests: [], events: [], errors: [], nativeModes: [], mode: 'unknown',
    initial: { rendererKeys: Object.keys(watchRenderer), continuationType: initialContinuation.type, continuationLength: initialContinuation.value.length, contextKeys: Object.keys(apiContext), clientKeys: Object.keys(apiContext.client), clientName: apiContext.client.clientName, clientVersion: apiContext.client.clientVersion, initialDisplayState: watchRenderer.initialDisplayState },
  };
  let current = initialContinuation, primed = false, dueAt = 0, controller = null;
  const seen = new Map(), tombstones = new Set();
  const bound = () => { while (seen.size > 5000) seen.delete(seen.keys().next().value); while (tombstones.size > 5000) tombstones.delete(tombstones.values().next().value); };
  const modesFrom = renderer => {
    const submenu = find(renderer?.header, 'sortFilterSubMenuRenderer');
    const rows = (submenu?.subMenuItems || []).map(item => ({ title: item.title, selected: item.selected === true, hasContinuation: !!item.continuation?.reloadContinuationData?.continuation, continuationType: Object.keys(item.continuation || {}) }));
    if (rows.length) { state.nativeModes = rows; state.mode = rows.find(item => item.selected)?.title || 'unknown'; }
  };
  modesFrom(watchRenderer);
  const messageOf = item => {
    const type = Object.keys(item || {}).find(key => key.endsWith('Renderer'));
    const renderer = item?.[type];
    if (!renderer || typeof renderer.id !== 'string') return null;
    const originalText = text(renderer.message);
    return { id: renderer.id, type, originalText, authorId: renderer.authorExternalChannelId || null, timestampUsec: renderer.timestampUsec || null,
      rendererKeys: Object.keys(renderer), hasEmoji: !!renderer.message?.runs?.some(run => !!run.emoji), translatable: ['liveChatTextMessageRenderer', 'liveChatPaidMessageRenderer'].includes(type) && !!originalText.trim() };
  };
  const snapshot = () => JSON.parse(JSON.stringify(state));
  window.__DANLINGO_YOUTUBE_L0__ = {
    snapshot,
    stop() { state.stopped = true; controller?.abort(); },
    phase(value) { state.phase = String(value); },
    async poll() {
      if (state.stopped) throw new Error('Probe stopped');
      if (new URL(location.href).searchParams.get('v') !== watchId || window.ytInitialPlayerResponse?.videoDetails?.videoId !== watchId) { this.stop(); throw new Error('Watch session changed'); }
      if (controller) throw new Error('A request is already in flight');
      if (Date.now() < dueAt) return { deferredMs: dueAt - Date.now() };
      const row = { at: new Date().toISOString(), phase: state.phase, baseline: !primed, inputContinuationType: current.type, inputContinuationLength: current.value.length };
      state.requests.push(row);
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20000);
      try {
        const response = await fetch('/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
          method: 'POST', credentials: 'same-origin', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ context: apiContext, continuation: current.value, webClientInfo: { isDocumentHidden: document.hidden } }),
        });
        row.status = response.status;
        if (!response.ok) { dueAt = Date.now() + 15000; throw new Error('get_live_chat HTTP ' + response.status); }
        const body = await response.json();
        const renderer = body.continuationContents?.liveChatContinuation;
        row.responseKeys = Object.keys(body);
        if (!renderer) throw new Error('No liveChatContinuation in successful response');
        row.rendererKeys = Object.keys(renderer);
        modesFrom(renderer);
        row.actionTypes = {};
        const adds = [], removes = [], authorRemovals = [];
        for (const action of renderer.actions || []) {
          for (const key of Object.keys(action)) if (key !== 'clickTrackingParams') row.actionTypes[key] = (row.actionTypes[key] || 0) + 1;
          const added = action.addChatItemAction;
          if (added) { const m = messageOf(added.item); if (m) adds.push({ ...m, clientIdPresent: typeof added.clientId === 'string' }); }
          const replaced = action.replaceChatItemAction;
          if (replaced) { if (replaced.targetItemId) removes.push(replaced.targetItemId); const m = messageOf(replaced.replacementItem); if (m) adds.push({ ...m, replacement: true }); }
          const removed = action.removeChatItemAction || action.markChatItemAsDeletedAction;
          if (typeof removed?.targetItemId === 'string') removes.push(removed.targetItemId);
          const author = action.markChatItemsByAuthorAsDeletedAction?.externalChannelId;
          if (typeof author === 'string') authorRemovals.push(author);
        }
        let emitted = 0, duplicates = 0;
        // Seed and suppress every initial item, including messages older than probe attachment.
        // Receipt order is preserved; remote timestamps are source metadata, never a media clock.
        for (const m of adds) {
          if (seen.has(m.id) || tombstones.has(m.id)) { duplicates++; continue; }
          seen.set(m.id, m.authorId);
          if (primed && m.translatable) { state.events.push({ op: 'add', phase: state.phase, receivedAt: Date.now(), ...m }); emitted++; }
        }
        for (const id of removes) { seen.delete(id); tombstones.add(id); if (primed) state.events.push({ op: 'remove', phase: state.phase, id }); }
        for (const authorId of authorRemovals) {
          const ids = [...seen].filter(([, author]) => author === authorId).map(([id]) => id);
          for (const id of ids) { seen.delete(id); tombstones.add(id); }
          if (primed) state.events.push({ op: 'remove-author', phase: state.phase, authorId, ids });
        }
        row.items = adds.length; row.emitted = emitted; row.duplicates = duplicates; row.removals = removes.length; row.authorRemovals = authorRemovals.length;
        row.samples = adds.slice(0, 3);
        if (!primed) state.baseline = { at: row.at, items: adds.length, emitted: 0, ids: adds.map(m => m.id), mode: state.mode };
        primed = true; bound();
        const next = continuationOf(renderer);
        if (!next) { this.stop(); throw new Error('Live continuation ended or unavailable'); }
        current = next; dueAt = Date.now() + next.timeoutMs;
        row.nextContinuationType = next.type; row.nextContinuationLength = next.value.length; row.timeoutMs = next.timeoutMs;
        row.fullscreen = !!document.fullscreenElement;
        row.nativeChatConnected = !!document.querySelector('ytd-live-chat-frame');
        row.completedAt = new Date().toISOString();
        return { request: row, dueMs: next.timeoutMs };
      } catch (error) { row.error = String(error.message).slice(0, 160); state.errors.push({ phase: state.phase, error: row.error }); throw error; }
      finally { clearTimeout(timeout); controller = null; }
    },
  };
  return snapshot();
}
