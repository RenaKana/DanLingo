// Bounded page-local observer. Source IDs and prepared/native text stay inside the page.
export function installNativeWindow({ bufferMs }) {
  if (window.top !== window) return;
  if (![500, 1000, 2000, 3000].includes(bufferMs)) throw new Error('invalid-buffer');
  window.__DL_NATIVE_WINDOW__?.stop();
  let active = false, open = false, stopped = false, began = null, ended = null, sequence = 0;
  let duplicate = 0, overtakes = 0, lateRewrite = 0, overflow = 0, overflowEligible = 0, invalid = 0;
  let coverage = 'unknown', currentSession = '', currentResource = '';
  const records = new Map(), nativeTexts = new Map(), bindings = new Map(), lastOrders = new Map();
  const stamp = () => performance.timeOrigin + performance.now();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
  const key = (d, id) => JSON.stringify([d.resourceId, d.adapterSession, id]);
  const sessionKey = d => JSON.stringify([d.resourceId, d.adapterSession]);
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  const distribution = values => {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    const at = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
    return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99) };
  };
  const pageResource = () => { try { return new URL(location.href).searchParams.get('v'); } catch { return null; } };
  // A continuation-only frame must match a liveChatRenderer continuation actually present on this watch page.
  const continuationMatches = token => {
    if (!token || token.length > 10000) return false;
    const queue = [document.querySelector('ytd-watch-flexy')?.data, window.ytInitialData], seen = new Set();
    for (let steps = 0; queue.length && steps < 2000; steps++) {
      const item = queue.shift();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      if (item.liveChatRenderer?.continuations?.some(row => row?.reloadContinuationData?.continuation === token)) return true;
      for (const value of Object.values(item)) if (value && typeof value === 'object') queue.push(value);
    }
    return false;
  };
  const surface = resource => {
    if (resource !== pageResource()) return null;
    const matches = [];
    for (const frame of document.querySelectorAll('ytd-live-chat-frame iframe')) try {
      const url = new URL(frame.contentWindow.location.href);
      if (!frame.isConnected || url.origin !== location.origin || url.pathname !== '/live_chat') continue;
      if (url.searchParams.has('v') ? url.searchParams.get('v') !== resource : !continuationMatches(url.searchParams.get('continuation'))) continue;
      const doc = frame.contentDocument, list = doc?.querySelector('yt-live-chat-item-list-renderer');
      if (!list) continue;
      matches.push({ frame, doc, list, owner: list.polymerController || list.inst || list });
    } catch { /* Cross-origin or replaced frames cannot corroborate a row. */ }
    return matches.length === 1 ? matches[0] : null;
  };
  const visible = element => {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (!style || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0 || node.hasAttribute('hidden')) return false;
    }
    return true;
  };
  const inspect = () => {
    if (stopped || began === null || document.hidden) return;
    const binding = bindings.get(JSON.stringify([currentResource, currentSession]));
    const current = surface(currentResource);
    if (!binding || !current || current.frame !== binding.frame || current.doc !== binding.doc || current.list !== binding.list || current.owner !== binding.owner
      || binding.doc.hidden || !visible(binding.frame) || !visible(binding.list)) return;
    for (const element of binding.list.querySelectorAll('yt-live-chat-text-message-renderer')) {
      const data = element.polymerController?.data || element.inst?.data || element.data;
      const row = records.get(key({ resourceId: currentResource, adapterSession: currentSession }, data?.id));
      if (!row || !finite(row.displayed) || row.binding !== binding || !visible(element)) continue;
      const text = element.querySelector('#message')?.textContent;
      const plain = typeof data?.message?.simpleText === 'string' ? data.message.simpleText
        : Array.isArray(data?.message?.runs) ? data.message.runs.map(run => typeof run.text === 'string' ? run.text : '').join('') : null;
      if (typeof text !== 'string' || plain === null || normalize(text) !== normalize(plain)) continue;
      if (row.domSeen) {
        if (nativeTexts.get(row) !== text) { lateRewrite++; nativeTexts.set(row, text); }
        continue;
      }
      // Native restoration replaces these protected tokens with emoji/link/line-break runs.
      // The production displayed acknowledgement already verifies its exact restored structure;
      // this observer independently verifies the pinned DOM/data pair, without reconstructing fragments.
      if (row.displayedTranslated !== row.translated || row.translated && !row.richFragments && normalize(text) !== row.preparedText) continue;
      row.domSeen = true; row.domObservedAt = stamp(); row.characters = [...text].length; nativeTexts.set(row, text);
    }
  };
  const onMessage = event => {
    if (stopped || event.source !== window || event.origin !== location.origin) return;
    const d = event.data;
    if (d?.bridge !== 'danlingo-live-v1' || d.platform !== 'youtube' || !identity(d.resourceId) || !identity(d.adapterSession)) return;
    if (d.from === 'adapter' && d.type === 'snapshot') {
      if (d.resourceId !== pageResource()) return;
      active = d.presentationActive === true && d.connection === 'connected';
      coverage = ['all', 'top', 'unknown'].includes(d.coverage) ? d.coverage : 'unknown';
      currentResource = d.resourceId; currentSession = d.adapterSession;
      return;
    }
    if (began === null) return;
    if (d.from === 'adapter' && d.type === 'events') {
      if (d.resourceId !== pageResource()) return;
      for (const id of Array.isArray(d.removes) ? d.removes : []) {
        const row = records.get(key(d, id)); if (row) row.cancelled = true;
      }
      for (const source of Array.isArray(d.events) ? d.events : []) {
        if (!identity(source?.sourceId) || !finite(source.receivedAt)) { invalid++; continue; }
        if (source.receivedAt < began || source.receivedAt >= (open ? stamp() + .001 : ended ?? began)) continue;
        const id = key(d, source.sourceId);
        if (records.has(id)) { duplicate++; continue; }
        if (records.size >= 10000) { overflow++; if (source.translatable === true) overflowEligible++; continue; }
        const bindingKey = sessionKey(d);
        if (!bindings.has(bindingKey)) bindings.set(bindingKey, d.resourceId === currentResource && d.adapterSession === currentSession ? surface(d.resourceId) : null);
        records.set(id, { binding: bindings.get(bindingKey), scope: bindingKey, order: ++sequence,
          at: source.receivedAt, eligible: source.translatable === true, deadline: source.receivedAt + bufferMs });
      }
      return;
    }
    const row = records.get(key(d, d.sourceId));
    if (!row) return;
    if (d.from === 'content' && d.type === 'prepared') {
      if (finite(row.readyReceived)) { duplicate++; return; }
      if (!finite(d.preparedDelayMs) || d.preparedDelayMs < 0 || d.preparedDelayMs > 6000 || typeof d.text !== 'string' || !d.text.trim() || d.text.length > 2000) { invalid++; return; }
      row.readyDeclared = row.at + d.preparedDelayMs; row.readyReceived = stamp(); row.cached = d.cached === true; row.preparedText = normalize(d.text);
      row.richFragments = /\[\[DL:ytchat_v1_[a-z0-9_]+\]\]/u.test(d.text);
    }
    if (d.from === 'adapter' && d.type === 'submitted') {
      if (finite(row.submitted)) { duplicate++; return; }
      if (!finite(d.stamp) || d.stamp < row.at || d.stamp > stamp() + 1) { invalid++; return; }
      row.submitted = d.stamp; row.translated = d.translated === true;
      row.reason = ['timeout', 'overload', 'handoff', 'ready'].includes(d.reason) ? d.reason : 'other';
      const lastOrder = lastOrders.get(row.scope) ?? 0;
      if (row.order < lastOrder) overtakes++;
      lastOrders.set(row.scope, Math.max(lastOrder, row.order));
    }
    if (d.from === 'adapter' && d.type === 'displayed') {
      if (finite(row.displayed)) { duplicate++; return; }
      if (!finite(row.submitted) || !finite(d.stamp) || d.stamp < row.submitted || d.stamp > stamp() + 1) { invalid++; return; }
      row.displayed = d.stamp; row.displayedTranslated = d.translated === true;
    }
  };
  window.addEventListener('message', onMessage);
  const timer = setInterval(inspect, 100);
  const api = {
    begin() {
      if (stopped) throw new Error('observer-stopped');
      records.clear(); nativeTexts.clear(); bindings.clear(); lastOrders.clear();
      sequence = duplicate = overtakes = lateRewrite = overflow = overflowEligible = invalid = 0;
      began = stamp(); ended = null; open = true;
    },
    end() { if (began !== null && ended === null) { ended = stamp(); open = false; } },
    active: () => !stopped && active,
    summary() {
      inspect();
      const rows = [...records.values()], eligible = rows.filter(row => row.eligible);
      const onTime = eligible.filter(row => row.translated && row.displayedTranslated && row.domSeen && finite(row.readyDeclared)
        && row.readyDeclared >= row.at && row.readyDeclared < row.deadline && finite(row.readyReceived) && row.readyReceived < row.deadline
        && row.submitted < row.deadline);
      const presentedInTime = onTime.filter(row => row.displayed < row.deadline);
      const characters = onTime.reduce((sum, row) => sum + row.characters, 0);
      const windowMs = began === null ? 0 : Math.max(0, (ended ?? stamp()) - began), seconds = windowMs / 1000;
      const denominator = eligible.length + overflowEligible;
      return { received: rows.length + overflow, eligible: denominator, submitted: rows.filter(row => finite(row.submitted)).length,
        presented: rows.filter(row => finite(row.displayed) && row.domSeen).length,
        onTimeTranslated: onTime.length, onTimeCharacters: characters, onTimeItemsPerSecond: seconds > 0 ? onTime.length / seconds : null,
        onTimeCharactersPerSecond: seconds > 0 ? characters / seconds : null, onTimeRatio: denominator ? onTime.length / denominator : null,
        onTimePopulation: 'Eligible arrivals in the fixed window, prepared and natively submitted strictly before their deadline, with eventual matching DOM corroboration; cancellations, missing and failed rows remain in denominator.',
        presentedBeforeDeadline: presentedInTime.length, presentationOnTimeRatio: denominator ? presentedInTime.length / denominator : null,
        presentationPopulation: 'On-time submission population additionally confirmed by native displayed stamp strictly before deadline and eventual matching DOM; DOM polling time is separate.',
        richFragmentCorroborated: rows.filter(row => row.richFragments && row.translated && row.displayedTranslated && row.domSeen).length,
        richFragmentOnTimeTranslated: onTime.filter(row => row.richFragments).length,
        richFragmentEvidence: 'Protected fragment restoration is verified by the production displayed acknowledgement; this observer verifies the same source/session/frame DOM and native data agree, without independently reconstructing emoji, link or line-break fragments. Plain prepared text additionally requires exact normalized text equality.',
        cachedOnTime: onTime.filter(row => row.cached).length, original: rows.filter(row => finite(row.submitted) && !row.translated).length,
        timeout: rows.filter(row => row.reason === 'timeout').length, overload: rows.filter(row => row.reason === 'overload').length,
        cancelNotifications: rows.filter(row => row.cancelled).length, missing: rows.filter(row => !finite(row.displayed) || !row.domSeen).length + overflow,
        duplicate, overtakes, observedPostDisplayTextChanges: lateRewrite, overflow, overflowEligible, invalidNotifications: invalid,
        unboundSourceOccurrences: rows.filter(row => !row.binding).length, coverage, windowMs,
        readinessMs: distribution(rows.filter(row => finite(row.readyReceived)).map(row => row.readyReceived - row.at)),
        declaredReadinessMs: distribution(rows.filter(row => finite(row.readyDeclared)).map(row => row.readyDeclared - row.at)),
        submissionDelayMs: distribution(rows.filter(row => finite(row.submitted)).map(row => row.submitted - row.at)),
        presentationDelayMs: distribution(rows.filter(row => finite(row.displayed) && row.domSeen).map(row => row.displayed - row.at)),
        domObservationDelayMs: distribution(rows.filter(row => row.domSeen).map(row => row.domObservedAt - row.at)) };
    },
    stop() { if (stopped) return; api.end(); stopped = true; open = false; active = false; clearInterval(timer); window.removeEventListener('message', onMessage); },
  };
  window.__DL_NATIVE_WINDOW__ = api;
}
