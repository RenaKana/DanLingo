// Read-only real Niconico LIVE observers shared by focused acceptance scripts.
// No chat/control/prepared injection; original native calls are forwarded unchanged.
export function installObserver() {
  const s = window.__DL_NICO_EXTENSION_EVIDENCE__ = { phase: 'startup', snapshots: [], events: [], prepared: [], delivered: [], controls: [], stages: [], measurements: [], drops: [], wireRows: [], preparedTexts: new Set() };
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.bridge !== 'danlingo-live-v1') return;
    const at = performance.timeOrigin + performance.now();
    if (d.from === 'adapter' && d.type === 'snapshot' && s.snapshots.length < 1500) s.snapshots.push({ ...d, observedAt: at, phase: s.phase, hidden: document.hidden });
    if (d.from === 'adapter' && d.type === 'events') for (const e of d.events) {
      if (s.events.length >= 12000) break;
      const wire = s.wireRows.find(w => w.sourceId === e.sourceId && w.resourceId === d.resourceId && w.originalText === e.originalText);
      s.events.push({ ...e, resourceId: d.resourceId, adapterSession: d.adapterSession, observedAt: at, phase: s.phase,
        nativeSourceIdentity: wire?.nativeSourceIdentity ?? null });
    }
    if (d.from === 'adapter' && d.type === 'delivered' && s.delivered.length < 12000) s.delivered.push({ ...d, observedAt: at, phase: s.phase });
    if (d.from === 'adapter' && d.type === 'dropped' && s.drops.length < 12000) s.drops.push({ ...d, observedAt: at, phase: s.phase });
    if (d.from === 'content' && d.type === 'prepared' && s.prepared.length < 12000) { s.prepared.push({ ...d, observedAt: at, phase: s.phase }); if (typeof d.text === 'string') s.preparedTexts.add(d.text); }
    if (d.from === 'content' && d.type === 'control' && s.controls.length < 1500) s.controls.push({ enabled: d.enabled, bufferMs: d.bufferMs, observedAt: at });
  });
}
export function attachNativeObserver({ infrastructureOnly = false, requirePristine = false } = {}) {
  const s = window.__DL_NICO_EXTENSION_EVIDENCE__;
  s.restorers ||= [];
  s.nativeLifecycle ||= { version: 1, events: [], layers: [], sequence: 0, truncated: false, errors: 0, slotReferences: 0,
    limits: { events: 24000, slotsPerSnapshot: 1000, slotReferences: 120000 } };
  const lifecycle = s.nativeLifecycle;
  const identities = s.nativeObserverIdentities ||= { slots: new WeakMap(), repositories: new WeakMap(), nextSlot: 0, nextRepository: 0, nextCall: 0 };
  const slotId = slot => {
    if (!slot || typeof slot !== 'object') return null;
    if (!identities.slots.has(slot)) identities.slots.set(slot, ++identities.nextSlot);
    return identities.slots.get(slot);
  };
  function sourceIdentity(chat) {
    const raw = chat?.parsedOriginalChat || chat;
    const no = Number(raw?.no), dateSeconds = Number(raw?.date), dateUsec = Number(raw?.dateUsec ?? raw?.date_usec ?? 0);
    return Number.isFinite(no) && Number.isFinite(dateSeconds) && Number.isFinite(dateUsec)
      ? { no, dateSeconds, dateUsec, key: JSON.stringify([no, dateSeconds, dateUsec]) } : null;
  }
  function observeLifecycle(layer, repository, repositoryId, operation, boundary, callId, subjectSlotId = null) {
    if (lifecycle.truncated) return;
    try {
      const slots = repository?.stagingList;
      if (!Array.isArray(slots)) { lifecycle.errors++; return; }
      if (lifecycle.events.length >= lifecycle.limits.events || slots.length > lifecycle.limits.slotsPerSnapshot
        || lifecycle.slotReferences + slots.length > lifecycle.limits.slotReferences) { lifecycle.truncated = true; return; }
      lifecycle.slotReferences += slots.length;
      lifecycle.events.push({ sequence: ++lifecycle.sequence, at: performance.timeOrigin + performance.now(), phase: s.phase,
        layer, repositoryId, operation, boundary, callId, subjectSlotId,
        slots: slots.map(slot => ({ slotId: slotId(slot), nativeSourceIdentity: sourceIdentity(slot.chat), nativeVposMs: slot.chat?.vposMs ?? null })) });
    } catch { lifecycle.errors++; /* Observation must never interrupt native rendering. */ }
  }
  function wrapLifecycle(target, method, layer, repository, repositoryId, hasSlotArgument = false) {
    if (typeof target?.[method] !== 'function') return false;
    const original = target[method], own = Object.getOwnPropertyDescriptor(target, method);
    const operation = (target === repository ? 'repository.' : 'layer.') + method;
    const observer = function(...args) {
      const callId = ++identities.nextCall, subjectSlotId = hasSlotArgument ? slotId(args[0]) : null;
      observeLifecycle(layer, repository, repositoryId, operation, 'before', callId, subjectSlotId);
      let completed = false;
      try { const result = Reflect.apply(original, this, args); completed = true; return result; }
      finally { observeLifecycle(layer, repository, repositoryId, operation, completed ? 'after' : 'throw', callId, subjectSlotId); }
    };
    target[method] = observer;
    (s.nativeLifecycleHooks ||= []).push({ target, method, observer });
    s.restorers.push(() => { if (target[method] === observer) { if (own) Object.defineProperty(target, method, own); else delete target[method]; } });
    return target[method] === observer;
  }
  function attachInfrastructure() {
    if (s.infrastructure) return;
    const dispatch = EventTarget.prototype.dispatchEvent;
    s.infrastructure = { at: performance.timeOrigin + performance.now(),
      pristineDispatcher: /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(dispatch)),
      enabledControlsAtInstall: s.controls.filter(c => c.enabled).length };
    const wireObserver = function(event) {
      try {
        const envelope = event?.type === 'onMessage' && event.detail?.message;
        if (envelope?.payload?.case === 'message' && envelope.payload.value?.data?.case === 'chat' && s.wireRows.length < 12000) {
          const chat = envelope.payload.value.data.value, at = envelope.meta?.at;
          if (at && typeof envelope.meta.id === 'string' && typeof chat.content === 'string') {
            const no = Number(chat.no), dateSeconds = Number(at.seconds), dateUsec = Number(at.nanos) / 1000;
            s.wireRows.push({ sourceId: envelope.meta.id, resourceId: /^\/watch\/(lv\d+)/.exec(location.pathname)?.[1], originalText: chat.content,
              nativeSourceIdentity: { no, dateSeconds, dateUsec, key: JSON.stringify([no, dateSeconds, dateUsec]) }, observedAt: performance.timeOrigin + performance.now() });
          }
        }
      } catch { /* Observation must not interfere with native dispatch. */ }
      return Reflect.apply(dispatch, this, [event]);
    };
    EventTarget.prototype.dispatchEvent = wireObserver; s.originalDispatch = wireObserver;
    s.restorers.push(() => { if (EventTarget.prototype.dispatchEvent === wireObserver) EventTarget.prototype.dispatchEvent = dispatch; });
    const measure = CanvasRenderingContext2D.prototype.measureText;
    const observer = function(text) {
      const result = Reflect.apply(measure, this, [text]);
      if (s.preparedTexts.has(String(text)) && s.measurements.length < 24000) s.measurements.push({ text: String(text), width: result.width, at: performance.timeOrigin + performance.now() });
      return result;
    };
    CanvasRenderingContext2D.prototype.measureText = observer;
    s.restorers.push(() => { if (CanvasRenderingContext2D.prototype.measureText === observer) CanvasRenderingContext2D.prototype.measureText = measure; });
  }
  if (infrastructureOnly) { attachInfrastructure(); return { ...s.infrastructure }; }
  if (s.native) return { found: true, filters: s.filtersBefore, baseline: s.nativeBaseline };
  for (const element of document.querySelectorAll('div[id^="renderer-parent-id-"]')) {
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    for (let f = key && element[key], i = 0; f && i < 20; f = f.return, i++) {
      const c = f.stateNode;
      if (!c?.addToRender || !c.renderer?.layerProcessorList?.length) continue;
      const filters = c.renderer.layerProcessorList.map(l => l.getStagingFilterNameList());
      if (requirePristine && filters.some(names => names.includes('danlingo-live-text-v1'))) {
        return { found: false, blocked: true, reason: 'Production native filter already installed before observer baseline capture', filters };
      }
      s.native = c; s.originalAdd = c.addToRender; s.filtersBefore = filters;
      s.nativeBaseline = { capturedAt: performance.timeOrigin + performance.now(), beforeProductFilter: !filters.some(names => names.includes('danlingo-live-text-v1')) };
      attachInfrastructure();
      for (const layer of c.renderer.layerProcessorList) {
        const layerIndex = c.renderer.layerProcessorList.indexOf(layer), repository = layer.slotRepository;
        let repositoryId = null;
        if (repository && typeof repository === 'object') {
          if (!identities.repositories.has(repository)) identities.repositories.set(repository, ++identities.nextRepository);
          repositoryId = identities.repositories.get(repository);
        }
        const methods = { reset: false, setToStaging: false, backToReserved: false, clear: false, refreshComments: false };
        if (repositoryId !== null) {
          for (const method of ['reset', 'setToStaging', 'backToReserved']) methods[method] = wrapLifecycle(repository, method, layerIndex, repository, repositoryId, method !== 'reset');
          for (const method of ['clear', 'refreshComments']) methods[method] = wrapLifecycle(layer, method, layerIndex, repository, repositoryId);
          observeLifecycle(layerIndex, repository, repositoryId, 'observer.attach', 'after', ++identities.nextCall);
        }
        lifecycle.layers.push({ layer: layerIndex, repositoryId, methods, supported: repositoryId !== null && Object.values(methods).every(Boolean) });
        const processor = layer.processor, original = processor.makeStagingSlot, own = Object.getOwnPropertyDescriptor(processor, 'makeStagingSlot');
        const observer = function(slot, chat, settings, ...rest) {
          const result = Reflect.apply(original, this, [slot, chat, settings, ...rest]);
          try { if (s.stages.length < 24000) {
            const raw = chat.parsedOriginalChat || chat;
            const no = Number(raw.no), dateSeconds = Number(raw.date), dateUsec = Number(raw.dateUsec ?? raw.date_usec ?? 0);
            s.stages.push({ at: performance.timeOrigin + performance.now(), phase: s.phase, no: raw.no,
              sequence: ++lifecycle.sequence, layer: layerIndex, repositoryId, slotId: slotId(slot), outputSlotId: slotId(result),
              nativeSourceIdentity: { no, dateSeconds, dateUsec, key: JSON.stringify([no, dateSeconds, dateUsec]) },
              originalText: chat.content, text: settings.content, nativeVposMs: chat.vposMs,
              sentAtEpochMs: Number(raw.date) * 1000 + Number(raw.dateUsec ?? raw.date_usec ?? 0) / 1000,
              createdSlot: !!result, width: result?.width ?? null, visible: settings.visible,
              position: settings.position, size: settings.size, color: settings.color, font: settings.font });
          } } catch { lifecycle.errors++; }
          return result;
        };
        processor.makeStagingSlot = observer;
        s.restorers.push(() => { if (processor.makeStagingSlot === observer) { if (own) Object.defineProperty(processor, 'makeStagingSlot', own); else delete processor.makeStagingSlot; } });
      }
      return { found: true, filters: s.filtersBefore, baseline: s.nativeBaseline };
    }
  }
  return { found: false };
}

// Explicit active-navigation mode only; never disable production to obtain this baseline.
export function installEarlyNativeObserver(attach) {
  const s = window.__DL_NICO_EXTENSION_EVIDENCE__;
  const proof = s.earlyNativeObserver = { status: 'running', attempts: 0, infrastructure: attach({ infrastructureOnly: true }) };
  if (!proof.infrastructure.pristineDispatcher || proof.infrastructure.enabledControlsAtInstall !== 0) {
    proof.status = 'INCOMPLETE'; proof.reason = 'Cannot establish observer dispatcher baseline before production activation'; return;
  }
  let interval, mutations, stopped = false;
  const stop = () => { stopped = true; clearInterval(interval); mutations?.disconnect(); window.removeEventListener('pagehide', stop); };
  const discover = () => {
    if (stopped) return;
    proof.attempts++; proof.native = attach({ requirePristine: true });
    if (proof.native.found || proof.native.blocked) { proof.status = proof.native.found ? 'PASS' : 'INCOMPLETE'; stop(); }
  };
  mutations = new MutationObserver(discover); mutations.observe(document, { childList: true, subtree: true });
  interval = setInterval(discover, 25); window.addEventListener('pagehide', stop); discover();
}

// Counts native coexistence separately from repeated makeStagingSlot calls. A cached
// renderer refresh implementation alone is never evidence that an old slot exited.
export function auditNativeSlotLifecycles(observation, { sources, phase, observedUntil }) {
  const lifecycle = observation.nativeLifecycle;
  const supported = !!lifecycle?.layers?.length && lifecycle.layers.every(layer => layer.supported);
  const events = (lifecycle?.events || []).filter(event => event.at <= observedUntil);
  const afterCalls = new Map(events.filter(event => event.boundary === 'after').map(event => [event.callId, event]));
  const hasSlot = (event, id, key) => event.slots.some(slot => slot.slotId === id && slot.nativeSourceIdentity?.key === key);
  const repositoryStates = new Map(), concurrentSnapshots = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    repositoryStates.set(event.repositoryId, event.slots);
    const byKey = new Map();
    for (const [repositoryId, slots] of repositoryStates) for (const slot of slots) {
      const key = slot.nativeSourceIdentity?.key; if (!key) continue;
      const entries = byKey.get(key) || new Map(); entries.set(slot.slotId, { repositoryId, slotId: slot.slotId }); byKey.set(key, entries);
    }
    for (const [key, slots] of byKey) if (slots.size > 1) concurrentSnapshots.push({ key, event, slots: [...slots.values()] });
  }
  const rows = sources.map(source => {
    const key = source.nativeSourceIdentity?.key;
    const stages = (observation.stages || []).filter(stage => key && stage.createdSlot && stage.nativeSourceIdentity?.key === key
      && stage.at >= source.receivedAt && stage.at <= observedUntil && stage.phase === phase);
    const concurrent = concurrentSnapshots.filter(row => row.key === key && row.event.at >= source.receivedAt);
    const admissions = stages.map(stage => {
      const nextUse = observation.stages.find(next => next.repositoryId === stage.repositoryId && next.outputSlotId === stage.outputSlotId && next.sequence > stage.sequence);
      return events.find(event => event.operation === 'repository.setToStaging' && event.boundary === 'after'
        && event.repositoryId === stage.repositoryId && event.sequence > stage.sequence && event.sequence < (nextUse?.sequence ?? Infinity)
        && event.subjectSlotId === stage.outputSlotId && hasSlot(event, stage.outputSlotId, key));
    });
    const repetitions = stages.slice(1).map((stage, i) => {
      const previous = stages[i], admission = admissions[i], currentAdmission = admissions[i + 1];
      const removal = admission && events.find(event => {
        const after = afterCalls.get(event.callId);
        return event.boundary === 'before' && event.repositoryId === previous.repositoryId && event.sequence > admission.sequence
          && after?.sequence < stage.sequence && ['repository.reset', 'repository.backToReserved'].includes(event.operation)
          && hasSlot(event, previous.outputSlotId, key) && !hasSlot(after, previous.outputSlotId, key);
      });
      return { previousStageAt: previous.at, stageAt: stage.at, previousSlotId: previous.outputSlotId ?? null, slotId: stage.outputSlotId ?? null,
        classification: concurrent.length ? 'observed-concurrent-native-slots' : removal && currentAdmission
          ? 'observed-recreation-after-removal' : 'unverified-prior-slot-exit',
        removal: removal ? { operation: removal.operation, callId: removal.callId, beforeSequence: removal.sequence,
          afterSequence: afterCalls.get(removal.callId).sequence } : null };
    });
    return { id: source.id, nativeSourceIdentity: source.nativeSourceIdentity ?? null, successfulCreations: stages.length,
      allCreationsObservedInRepository: stages.every((_, i) => !!admissions[i]), repetitions,
      concurrentObservations: concurrent.map(({ event, slots }) => ({ at: event.at, sequence: event.sequence, operation: event.operation, boundary: event.boundary, slots })) };
  });
  const evidenceComplete = supported && lifecycle.currentHooks !== false && !lifecycle.truncated && lifecycle.errors === 0
    && rows.every(row => row.nativeSourceIdentity && row.allCreationsObservedInRepository
      && row.repetitions.every(repetition => repetition.classification !== 'unverified-prior-slot-exit'));
  const concurrentSourceCount = rows.filter(row => row.concurrentObservations.length).length;
  return { supported, evidenceComplete, repeatedCreationCount: rows.reduce((n, row) => n + Math.max(0, row.successfulCreations - 1), 0),
    concurrentSourceCount, noConcurrentNativeSlots: evidenceComplete ? concurrentSourceCount === 0 : null, rows,
    limitation: 'Repository membership and observed removal only; no physical pixel proof. Repeated creation remains recorded even after an observed reset. Missing lifecycle evidence stays unverified.' };
}

export function inspectNativeRestoration({ captureBeforeDisable = false } = {}) {
  const s = window.__DL_NICO_EXTENSION_EVIDENCE__;
  if (!s?.native) return { restored: null, filterRestoration: null };
  const ownFilter = 'danlingo-live-text-v1', layers = [...s.native.renderer.layerProcessorList];
  const current = layers.map(layer => [...layer.getStagingFilterNameList()]);
  const active = s.earlyNativeObserver?.status === 'PASS';
  const at = performance.timeOrigin + performance.now();
  if (captureBeforeDisable) {
    s.filtersAtDisable = { at, names: current, layers };
  }
  const before = s.filtersAtDisable;
  const expected = active ? before?.names.map(names => names.filter(name => name !== ownFilter)) : s.filtersBefore;
  const sameLayerInstances = !!before && layers.length === before.layers.length && layers.every((layer, i) => layer === before.layers[i]);
  const exactlyOneOwnFilterBefore = !!before && before.names.length > 0 && before.names.every(names => names.filter(name => name === ownFilter).length === 1);
  const ownFilterRemoved = current.every(names => !names.includes(ownFilter));
  const exactExpectedList = Array.isArray(expected) && JSON.stringify(expected) === JSON.stringify(current);
  return {
    restored: { input: s.native.addToRender === s.originalAdd, dispatcher: EventTarget.prototype.dispatchEvent === s.originalDispatch,
      filters: active ? sameLayerInstances && exactlyOneOwnFilterBefore && ownFilterRemoved && exactExpectedList : exactExpectedList },
    filterRestoration: { at, mode: active ? 'active-pre-disable-exact-site-filter-preservation' : 'strict-initial-baseline',
      initialBaseline: s.filtersBefore, beforeDisable: before ? { at: before.at, names: before.names } : null,
      expectedAfterDisable: expected ?? null, actual: current,
      checks: { sameLayerInstances, exactlyOneOwnFilterBefore, ownFilterRemoved, exactExpectedList } },
  };
}
