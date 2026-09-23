// L0 experiment only. Receives real page comments; no provider and no synthetic messages.
export function installWireObserver() {
  const original = EventTarget.prototype.dispatchEvent;
  const state = window.__DL_NL_WIRE__ = { messages: [], counts: {}, originals: [], phase: 'startup' };
  EventTarget.prototype.dispatchEvent = function(event) {
    const envelope = event?.type === 'onMessage' && event.detail?.message;
    if (envelope?.payload && envelope.meta) {
      const payload = envelope.payload;
      const kind = payload.case === 'message' ? payload.value?.data?.case : payload.case;
      state.counts[kind] = (state.counts[kind] || 0) + 1;
      if (state.messages.length < 240 && kind === 'chat') {
        const chat = payload.value.data.value;
        const at = envelope.meta.at;
        const sample = { id: envelope.meta.id, phase: state.phase, receivedAtMs: Date.now(), playlist: event.detail.playlist?.case,
          atSeconds: at ? Number(at.seconds) : null, atNanos: at?.nanos ?? null, no: chat.no, vpos: chat.vpos,
          content: chat.content, modifier: chat.modifier ? { position: chat.modifier.position, size: chat.modifier.size,
            color: chat.modifier.color, font: chat.modifier.font, opacity: chat.modifier.opacity } : null };
        state.messages.push(sample);
        state.originals.push({ chat, content: chat.content, vpos: chat.vpos });
      }
    }
    return Reflect.apply(original, this, [event]);
  };
  state.stop = () => { EventTarget.prototype.dispatchEvent = original; };
}

export function attachNativeExperiment() {
  let component;
  for (const element of document.querySelectorAll('div[id^="renderer-parent-id-"],canvas')) {
    let parent = element;
    for (let depth = 0; parent && depth < 4 && !component; depth++, parent = parent.parentElement) {
      const key = Object.keys(parent).find(k => /^__react(?:Fiber|InternalInstance)\$/.test(k));
      for (let fiber = key && parent[key], n = 0; fiber && n < 20; fiber = fiber.return, n++) {
        const c = fiber.stateNode;
        if (typeof c?.addToRender === 'function' && c.renderer?.layerProcessorList?.length && c.threadProcessor) { component = c; break; }
      }
    }
    if (component) break;
  }
  if (!component) return { found: false };
  const layers = component.renderer.layerProcessorList;
  if (!layers.every(l => typeof l.addStagingFilter === 'function' && typeof l.processor?.makeStagingSlot === 'function')) return { found: false, unsupportedShape: true };
  const state = window.__DL_NL_NATIVE__ = { component, phase: 'enabled', enabled: true, rows: [], staged: [], measurements: [], maxQueued: 0,
    nativeFilters: layers.map(l => l.getStagingFilterNameList()), initialNativeClockMs: component.props.getCurrentVposMs(), queue: new Map(), display: new Map(), restorers: [] };
  const originalAdd = component.addToRender;
  const ownedAdd = Object.hasOwn(component, 'addToRender');
  const keyOf = chat => String(chat.no ?? chat.parsedOriginalChat?.no ?? chat.id ?? '') + ':' + String(chat.date ?? chat.parsedOriginalChat?.date ?? '');
  const style = settings => Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'content').map(([key, value]) => [key, Number.isNaN(value) ? 'NaN' : value]));
  const release = (row, reason) => {
    if (row.released) return;
    row.released = true; row.releaseCalls++; clearTimeout(row.timer); state.queue.delete(row.sequence);
    row.releaseReason = reason; row.heldMs = performance.now() - row.receivedAt; row.releaseClockMs = component.props.getCurrentVposMs();
    const copy = { ...row.source, vpos: Math.max(row.original.vpos, Math.trunc(row.releaseClockMs / 10)) };
    if (state.enabled && reason === 'deadline') state.display.set(row.key, { text: '【L0】' + row.original.content, row });
    row.releasedVpos = copy.vpos;
    void Reflect.apply(originalAdd, component, [copy, ...row.rest]);
  };
  component.addToRender = function(chat, ...rest) {
    if (!state.enabled || typeof chat?.content !== 'string' || !chat.content.trim() || chat.content.startsWith('/') || chat.yourpost || state.rows.length >= 96) return Reflect.apply(originalAdd, this, [chat, ...rest]);
    const row = { sequence: state.rows.length, key: keyOf(chat), source: chat, rest, receivedAt: performance.now(), receivedClockMs: component.props.getCurrentVposMs(),
      original: { content: chat.content, vpos: chat.vpos, mail: chat.mail, no: chat.no, date: chat.date, date_usec: chat.date_usec }, releaseCalls: 0 };
    state.rows.push(row); state.queue.set(row.sequence, row); state.maxQueued = Math.max(state.maxQueued, state.queue.size);
    // Bound the experiment to 16 queued messages and 450ms. Overflow is released once as original.
    if (state.queue.size > 16) { const oldest = state.queue.values().next().value; release(oldest, 'overflow'); }
    row.timer = setTimeout(() => release(row, 'deadline'), 450);
    return Promise.resolve();
  };
  state.restorers.push(() => { if (ownedAdd) component.addToRender = originalAdd; else delete component.addToRender; });
  for (const [index, layer] of layers.entries()) {
    layer.addStagingFilter('danlingo-live-l0-marker', (chat, settings) => {
      const display = state.display.get(keyOf(chat));
      if (!state.enabled || !settings.visible || !display || settings.content !== display.row.original.content) return settings;
      display.row.filterStyle = style(settings); display.row.filterContent = settings.content;
      return { ...settings, content: display.text };
    });
    const processor = layer.processor, originalMake = processor.makeStagingSlot;
    const ownMake = Object.hasOwn(processor, 'makeStagingSlot');
    processor.makeStagingSlot = function(slot, chat, settings, ...rest) {
      const display = state.display.get(keyOf(chat));
      const marked = typeof settings.content === 'string' && settings.content.startsWith('【L0】');
      const output = Reflect.apply(originalMake, this, [slot, chat, settings, ...rest]);
      if (state.staged.length < 200) state.staged.push({ phase: state.phase, layer: index, no: chat.no, key: keyOf(chat), text: settings.content,
        original: chat.content, marked, clockMs: component.props.getCurrentVposMs(), vposMs: chat.vposMs, style: style(settings),
        stylePreserved: display ? JSON.stringify(style(settings)) === JSON.stringify(display.row.filterStyle) : null,
        createdSlot: output !== null, slotWidth: output?.width ?? output?._width ?? null });
      return output;
    };
    state.restorers.push(() => { layer.removeStagingFilter('danlingo-live-l0-marker'); if (ownMake) processor.makeStagingSlot = originalMake; else delete processor.makeStagingSlot; });
  }
  const originalMeasure = CanvasRenderingContext2D.prototype.measureText;
  CanvasRenderingContext2D.prototype.measureText = function(text) {
    const output = Reflect.apply(originalMeasure, this, [text]);
    if (String(text).startsWith('【L0】') && state.measurements.length < 160) state.measurements.push({ text: String(text), width: output.width, at: performance.now() });
    return output;
  };
  state.restorers.push(() => { CanvasRenderingContext2D.prototype.measureText = originalMeasure; });
  state.disable = () => {
    state.enabled = false; state.phase = 'disabled';
    for (const row of [...state.queue.values()]) release(row, 'disable');
    state.display.clear();
    // Keep the makeStagingSlot observer until final snapshot to observe normal post-disable text.
    for (const layer of layers) layer.removeStagingFilter('danlingo-live-l0-marker');
    if (ownedAdd) component.addToRender = originalAdd; else delete component.addToRender;
  };
  state.snapshot = () => ({ found: true, phase: state.phase, maxQueued: state.maxQueued, queueSize: state.queue.size,
    nativeFiltersBefore: state.nativeFilters, nativeFiltersNow: layers.map(l => l.getStagingFilterNameList()),
    inputMethodRestored: component.addToRender === originalAdd, clockMs: component.props.getCurrentVposMs(),
    rows: state.rows.map(({ source, rest, timer, ...row }) => ({ ...row, originalPreserved: source.content === row.original.content && source.vpos === row.original.vpos && source.mail === row.original.mail })),
    staged: state.staged, measurements: state.measurements,
  });
  state.stop = () => { state.disable(); for (const restore of state.restorers) restore(); return state.snapshot(); };
  return { found: true, layers: layers.length, nativeFilters: state.nativeFilters };
}
