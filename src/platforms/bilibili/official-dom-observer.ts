export const OFFICIAL_DANMAKU_SELECTOR = '.bili-danmaku-x-dm';
export const OFFICIAL_DOM_OBSERVER_INTERVAL_MS = 100;
export const OFFICIAL_DOM_OBSERVER_CAPACITY = 20_000;

type RectInput = {
  left?: unknown; top?: unknown; right?: unknown; bottom?: unknown;
  x?: unknown; y?: unknown; width?: unknown; height?: unknown;
};

export interface OfficialDomRect {
  x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number;
}

export interface OfficialDomClip {
  source: string;
  rect: RectInput;
  clipX?: boolean;
  clipY?: boolean;
}

export interface OfficialDomGeometry {
  intersects: boolean;
  intersectionAreaPx2: number;
  visibleRect: OfficialDomRect | null;
  clipChain: { source: string; rect: OfficialDomRect | null; clipX: boolean; clipY: boolean }[];
}

export interface OfficialDomStyleEvidence {
  className: string;
  inlineStyle: string;
  computed: {
    display: string | null;
    visibility: string | null;
    opacity: number | null;
    position: string | null;
    transform: string | null;
    animationName: string | null;
    animationPlayState: string | null;
    zIndex: string | null;
  } | null;
  ancestors: { display: string | null; visibility: string | null; opacity: number | null }[];
  effectiveOpacity: number | null;
  renderableByStyle: boolean | null;
}

export interface OfficialDomSample {
  sampledAtEpochMs: number;
  sampledMediaMs: number | null;
  geometry: OfficialDomGeometry;
  style: OfficialDomStyleEvidence;
  geometryIntersects: boolean;
  styleAllowsRendering: boolean | null;
  visibleCandidate: boolean;
  visibilityBasis: 'geometry-and-computed-style-not-pixel-proof';
}

export interface OfficialDomRow {
  identity: 'unavailable-dom-only';
  dmid: null;
  elementId: number;
  occurrence: number;
  text: string;
  firstSeenAtEpochMs: number;
  firstSeenMediaMs: number | null;
  firstSeenMonotonicMs: number;
  visibleAtEpochMs: number | null;
  visibleAtMediaMs: number | null;
  visibleEvidence: OfficialDomSample | null;
  lastSample: OfficialDomSample | null;
  endedAtEpochMs: number | null;
  endedMediaMs: number | null;
  endReason: string | null;
}

interface Options {
  container: any;
  video: any;
  now?: () => number;
  epochNow?: () => number;
}

interface ClockSample { monotonicMs: number; epochMs: number; mediaMs: number | null }
interface InternalRow { element: any; row: OfficialDomRow; lastGeometrySampleMonotonicMs: number | null }

function plainRect(value: RectInput | null | undefined): OfficialDomRect | null {
  if (!value) return null;
  const left = Number(value.left ?? value.x), top = Number(value.top ?? value.y);
  const right = Number(value.right ?? (left + Number(value.width)));
  const bottom = Number(value.bottom ?? (top + Number(value.height)));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
}

function intersectAxis(currentStart: number, currentEnd: number, clipStart: number, clipEnd: number,
  enabled: boolean): [number, number] {
  return enabled ? [Math.max(currentStart, clipStart), Math.min(currentEnd, clipEnd)] : [currentStart, currentEnd];
}

/** Returns the rectangular viewport/container/overflow intersection, not proof of rasterized pixels. */
export function computeOfficialDomGeometry(elementRect: RectInput, viewportRect: RectInput, containerRect: RectInput,
  ancestorClips: readonly OfficialDomClip[] = []): OfficialDomGeometry {
  const sourceClips: OfficialDomClip[] = [
    { source: 'viewport', rect: viewportRect },
    { source: 'container', rect: containerRect },
    ...ancestorClips,
  ];
  let current = plainRect(elementRect);
  const clipChain: OfficialDomGeometry['clipChain'] = [];
  for (const clip of sourceClips) {
    const bounds = plainRect(clip.rect);
    const clipX = clip.clipX !== false, clipY = clip.clipY !== false;
    clipChain.push({ source: clip.source, rect: bounds, clipX, clipY });
    if (!current || !bounds) { current = null; continue; }
    const [left, right] = intersectAxis(current.left, current.right, bounds.left, bounds.right, clipX);
    const [top, bottom] = intersectAxis(current.top, current.bottom, bounds.top, bounds.bottom, clipY);
    current = right > left && bottom > top
      ? { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
  }
  const area = current ? current.width * current.height : 0;
  return { intersects: area > 0, intersectionAreaPx2: area, visibleRect: current, clipChain };
}

function hasClass(element: any, name: string): boolean {
  try {
    if (typeof element?.classList?.contains === 'function') return element.classList.contains(name);
    const className = typeof element?.className === 'string' ? element.className : '';
    return className.split(/\s+/).includes(name);
  } catch { return false; }
}

function attribute(element: any, name: string): string | null {
  try {
    const value = element?.getAttribute?.(name);
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

function containsToken(className: unknown, token: string): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes(token);
}

function finiteStyleNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number.parseFloat(String(value));
  return Number.isFinite(number) ? number : null;
}

function overflowClips(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value !== 'visible';
}

function rectFromElement(element: any): OfficialDomRect | null {
  try { return plainRect(element?.getBoundingClientRect?.()); } catch { return null; }
}

/** Observes only rendered DOM. It never reads native models or infers a dmid from text. */
export class OfficialDomObserver {
  instrumentationErrors = 0;

  private readonly container: any;
  private readonly video: any;
  private readonly now: () => number;
  private readonly epochNow: () => number;
  private readonly rows: OfficialDomRow[] = [];
  private readonly active = new Map<object, InternalRow>();
  private readonly elementIds = new WeakMap<object, number>();
  private readonly occurrences = new WeakMap<object, number>();
  private nextElementId = 1;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mutationObserver: any = null;
  private _capacityExceeded = false;

  constructor({ container, video, now, epochNow }: Options) {
    this.container = container;
    this.video = video;
    this.now = now ?? (() => globalThis.performance?.now?.() ?? Date.now());
    this.epochNow = epochNow ?? (() => Date.now());
  }

  get capacityExceeded(): boolean { return this._capacityExceeded; }

  start(): void {
    if (this.running || this.capacityExceeded) return;
    this.running = true;
    this.installMutationObserver();
    this.scanInitial();
    if (!this.running) return;
    try { this.timer = globalThis.setInterval(() => this.guard(() => this.sampleActive()), OFFICIAL_DOM_OBSERVER_INTERVAL_MS); }
    catch { this.instrumentationErrors++; }
  }

  snapshot(): OfficialDomRow[] {
    return this.rows.map(row => ({
      ...row,
      visibleEvidence: row.visibleEvidence ? this.cloneSample(row.visibleEvidence) : null,
      lastSample: row.lastSample ? this.cloneSample(row.lastSample) : null,
    }));
  }

  stop(): void { this.halt('observer-stopped'); }

  private installMutationObserver(): void {
    const document = this.container?.ownerDocument ?? (globalThis as any).document;
    const view = document?.defaultView;
    const Observer = view?.MutationObserver ?? (globalThis as any).MutationObserver;
    if (typeof Observer !== 'function') { this.instrumentationErrors++; return; }
    try {
      this.mutationObserver = new Observer((records: any[]) => this.guard(() => this.onMutations(records)));
      this.mutationObserver.observe(this.container, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeOldValue: true, characterDataOldValue: true, attributeFilter: ['class'] });
    } catch {
      this.instrumentationErrors++;
      try { this.mutationObserver?.disconnect?.(); } catch { this.instrumentationErrors++; }
      this.mutationObserver = null;
    }
  }

  private scanInitial(): void {
    const stamp = this.clock();
    for (const element of this.queryCandidates(this.container)) {
      this.syncElement(element, stamp);
      if (!this.running) break;
    }
  }

  private onMutations(records: any[]): void {
    const stamp = this.clock();
    const affected = new Set<object>();
    const classChanges = new Map<object, any[]>();
    for (const record of records ?? []) {
      if (record?.type === 'attributes' && record.attributeName === 'style') continue;
      const target = record?.target;
      if (target && typeof target === 'object') {
        const row = this.closestDanmaku(target);
        if (row) affected.add(row);
        else if (this.active.has(target)) affected.add(target);
      }
      if (record?.type === 'attributes' && record.attributeName === 'class' && target && typeof target === 'object') {
        const list = classChanges.get(target) ?? [];
        list.push(record); classChanges.set(target, list);
      }
      if (record?.type === 'childList') {
        for (const removed of Array.from(record.removedNodes ?? []) as any[]) this.endRemovedSubtree(removed, stamp);
        for (const added of Array.from(record.addedNodes ?? []) as any[])
          for (const element of this.queryCandidates(added)) affected.add(element);
      }
    }

    for (const [element, changes] of classChanges) {
      for (let index = 0; index < changes.length; index++) {
        const before = changes[index]?.oldValue ?? '';
        const next = changes.slice(index + 1).find(change => change.target === element);
        const after = next ? (next.oldValue ?? '') : (attribute(element, 'class') ?? '');
        const wasDanmaku = containsToken(before, 'bili-danmaku-x-dm');
        const isDanmaku = containsToken(after, 'bili-danmaku-x-dm');
        if (wasDanmaku && !isDanmaku) this.endElement(element, stamp, 'class-exit');
        else if (!wasDanmaku && isDanmaku) this.beginOccurrence(element, this.readText(element), stamp);
      }
      affected.add(element);
    }

    for (const element of affected) {
      this.syncElement(element, stamp);
      if (!this.running) return;
    }
  }

  private queryCandidates(root: any): any[] {
    const result: any[] = [];
    try {
      if (hasClass(root, 'bili-danmaku-x-dm')) result.push(root);
      if (typeof root?.querySelectorAll === 'function')
        result.push(...Array.from(root.querySelectorAll(OFFICIAL_DANMAKU_SELECTOR)) as any[]);
    } catch { this.instrumentationErrors++; }
    return result;
  }

  private closestDanmaku(node: any): any | null {
    let current = node?.nodeType === 1 ? node : node?.parentElement;
    while (current) {
      if (hasClass(current, 'bili-danmaku-x-dm')) return current;
      if (current === this.container) break;
      current = current.parentElement;
    }
    return null;
  }

  private endRemovedSubtree(node: any, stamp: ClockSample): void {
    if (!node || typeof node !== 'object') return;
    if (this.active.has(node)) this.endElement(node, stamp, 'node-removed');
    for (const child of this.queryCandidates(node)) if (child !== node && this.active.has(child))
      this.endElement(child, stamp, 'node-removed');
  }

  private syncElement(element: any, stamp: ClockSample): void {
    if (!element || typeof element !== 'object') return;
    const attached = this.isAttached(element);
    const isDanmaku = hasClass(element, 'bili-danmaku-x-dm');
    const text = this.readText(element);
    const current = this.active.get(element);
    if (!attached || !isDanmaku || !text.trim()) {
      if (current) this.endElement(element, stamp, !attached ? 'node-removed' : !isDanmaku ? 'class-exit' : 'text-empty');
      return;
    }
    let record = current;
    if (record && record.row.text !== text) {
      this.endElement(element, stamp, 'text-changed');
      record = undefined;
    }
    if (!record) record = this.beginOccurrence(element, text, stamp);
    if (record) this.sampleRecord(record, stamp);
  }

  private beginOccurrence(element: any, text: string, stamp: ClockSample): InternalRow | undefined {
    if (!this.running || !hasClass(element, 'bili-danmaku-x-dm') || !text.trim()) return undefined;
    if (this.rows.length >= OFFICIAL_DOM_OBSERVER_CAPACITY) {
      this.halt('capacity-exceeded', true);
      return undefined;
    }
    const key = element as object;
    let elementId = this.elementIds.get(key);
    if (elementId === undefined) { elementId = this.nextElementId++; this.elementIds.set(key, elementId); }
    const occurrence = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, occurrence);
    const row: OfficialDomRow = {
      identity: 'unavailable-dom-only', dmid: null, elementId, occurrence, text,
      firstSeenAtEpochMs: stamp.epochMs, firstSeenMediaMs: stamp.mediaMs, firstSeenMonotonicMs: stamp.monotonicMs,
      visibleAtEpochMs: null, visibleAtMediaMs: null, visibleEvidence: null, lastSample: null,
      endedAtEpochMs: null, endedMediaMs: null, endReason: null,
    };
    const record = { element, row, lastGeometrySampleMonotonicMs: null };
    this.rows.push(row); this.active.set(key, record);
    return record;
  }

  private endElement(element: any, stamp: ClockSample, reason: string): void {
    const record = this.active.get(element);
    if (!record) return;
    record.row.endedAtEpochMs = stamp.epochMs;
    record.row.endedMediaMs = stamp.mediaMs;
    record.row.endReason = reason;
    this.active.delete(element);
  }

  private sampleActive(): void {
    if (!this.running) return;
    const stamp = this.clock();
    for (const element of [...this.active.keys()]) {
      if (!this.isAttached(element)) this.endElement(element, stamp, 'node-removed');
      else this.syncElement(element, stamp);
      if (!this.running) return;
    }
  }

  private sampleRecord(record: InternalRow, stamp: ClockSample): void {
    if (record.lastGeometrySampleMonotonicMs !== null &&
        stamp.monotonicMs - record.lastGeometrySampleMonotonicMs < OFFICIAL_DOM_OBSERVER_INTERVAL_MS) return;
    record.lastGeometrySampleMonotonicMs = stamp.monotonicMs;
    const { element, row } = record;
    const elementRect = rectFromElement(element);
    const containerRect = rectFromElement(this.container);
    const viewportRect = this.viewportRect(element);
    const geometry = elementRect && containerRect && viewportRect
      ? computeOfficialDomGeometry(elementRect, viewportRect, containerRect, this.overflowClips(element))
      : { intersects: false, intersectionAreaPx2: 0, visibleRect: null, clipChain: [] };
    const style = this.styleEvidence(element);
    const visibleCandidate = geometry.intersects && style.renderableByStyle === true;
    const sample: OfficialDomSample = {
      sampledAtEpochMs: stamp.epochMs, sampledMediaMs: stamp.mediaMs, geometry, style,
      geometryIntersects: geometry.intersects, styleAllowsRendering: style.renderableByStyle,
      visibleCandidate, visibilityBasis: 'geometry-and-computed-style-not-pixel-proof',
    };
    row.lastSample = sample;
    if (visibleCandidate && row.visibleAtEpochMs === null) {
      row.visibleAtEpochMs = stamp.epochMs;
      row.visibleAtMediaMs = stamp.mediaMs;
      row.visibleEvidence = this.cloneSample(sample);
    }
  }

  private viewportRect(element: any): OfficialDomRect | null {
    try {
      const document = element?.ownerDocument ?? this.container?.ownerDocument ?? (globalThis as any).document;
      const view = document?.defaultView;
      const width = Number(view?.innerWidth ?? document?.documentElement?.clientWidth);
      const height = Number(view?.innerHeight ?? document?.documentElement?.clientHeight);
      return plainRect({ left: 0, top: 0, right: width, bottom: height });
    } catch { this.instrumentationErrors++; return null; }
  }

  private overflowClips(element: any): OfficialDomClip[] {
    const clips: OfficialDomClip[] = [];
    const document = element?.ownerDocument ?? this.container?.ownerDocument ?? (globalThis as any).document;
    const view = document?.defaultView;
    let current = element?.parentElement;
    while (current) {
      if (current !== this.container) {
        try {
          const style = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(current) : null;
          const clipX = overflowClips(style?.overflowX ?? style?.overflow);
          const clipY = overflowClips(style?.overflowY ?? style?.overflow);
          const rect = (clipX || clipY) ? rectFromElement(current) : null;
          if (rect) clips.push({ source: 'overflow-ancestor', rect, clipX, clipY });
        } catch { this.instrumentationErrors++; }
      }
      if (current === document?.documentElement) break;
      current = current.parentElement;
    }
    return clips;
  }

  private styleEvidence(element: any): OfficialDomStyleEvidence {
    const document = element?.ownerDocument ?? this.container?.ownerDocument ?? (globalThis as any).document;
    const view = document?.defaultView;
    const read = (node: any) => {
      try {
        if (typeof view?.getComputedStyle !== 'function') return null;
        const style = view.getComputedStyle(node);
        return {
          display: typeof style?.display === 'string' ? style.display : null,
          visibility: typeof style?.visibility === 'string' ? style.visibility : null,
          opacity: finiteStyleNumber(style?.opacity),
          position: typeof style?.position === 'string' ? style.position : null,
          transform: typeof style?.transform === 'string' ? style.transform : null,
          animationName: typeof style?.animationName === 'string' ? style.animationName : null,
          animationPlayState: typeof style?.animationPlayState === 'string' ? style.animationPlayState : null,
          zIndex: typeof style?.zIndex === 'string' ? style.zIndex : null,
        };
      } catch { this.instrumentationErrors++; return null; }
    };
    const computed = read(element);
    const ancestors: OfficialDomStyleEvidence['ancestors'] = [];
    let effectiveOpacity = 1, opacityKnown = true, styleKnown = !!computed, hidden = false;
    for (let current = element; current; current = current.parentElement) {
      const item = current === element ? computed : read(current);
      if (!item) { styleKnown = false; opacityKnown = false; }
      else {
        ancestors.push({ display: item.display, visibility: item.visibility, opacity: item.opacity });
        if (item.display === 'none' || item.visibility === 'hidden' || item.visibility === 'collapse') hidden = true;
        if (item.opacity === null) opacityKnown = false;
        else effectiveOpacity *= item.opacity;
      }
      if (current === document?.documentElement) break;
    }
    if (!opacityKnown) effectiveOpacity = NaN;
    const renderableByStyle = styleKnown && opacityKnown
      ? !hidden && effectiveOpacity > 0
      : null;
    return {
      className: typeof element?.className === 'string' ? element.className : '',
      inlineStyle: attribute(element, 'style') ?? '',
      computed: computed ? {
        display: computed.display, visibility: computed.visibility, opacity: computed.opacity,
        position: computed.position, transform: computed.transform, animationName: computed.animationName,
        animationPlayState: computed.animationPlayState, zIndex: computed.zIndex,
      } : null,
      ancestors, effectiveOpacity: Number.isFinite(effectiveOpacity) ? effectiveOpacity : null,
      renderableByStyle,
    };
  }

  private isAttached(element: any): boolean {
    try {
      if (element?.isConnected === false) return false;
      if (element === this.container) return true;
      if (typeof this.container?.contains === 'function') return this.container.contains(element) === true;
      return true;
    } catch { this.instrumentationErrors++; return false; }
  }

  private readText(element: any): string {
    try { return typeof element?.textContent === 'string' ? element.textContent : ''; }
    catch { this.instrumentationErrors++; return ''; }
  }

  private clock(): ClockSample {
    let monotonicMs = Date.now(), epochMs = Date.now(), mediaMs: number | null = null;
    try { const value = this.now(); if (Number.isFinite(value)) monotonicMs = value; else this.instrumentationErrors++; }
    catch { this.instrumentationErrors++; }
    try { const value = this.epochNow(); if (Number.isFinite(value)) epochMs = value; else this.instrumentationErrors++; }
    catch { this.instrumentationErrors++; }
    try {
      const value = Number(this.video?.currentTime);
      if (Number.isFinite(value) && value >= 0) mediaMs = value * 1000;
    } catch { this.instrumentationErrors++; }
    return { monotonicMs, epochMs, mediaMs };
  }

  private cloneSample(sample: OfficialDomSample): OfficialDomSample {
    return {
      ...sample,
      geometry: { ...sample.geometry, visibleRect: sample.geometry.visibleRect ? { ...sample.geometry.visibleRect } : null,
        clipChain: sample.geometry.clipChain.map(item => ({ ...item, rect: item.rect ? { ...item.rect } : null })) },
      style: { ...sample.style, computed: sample.style.computed ? { ...sample.style.computed } : null,
        ancestors: sample.style.ancestors.map(item => ({ ...item })) },
    };
  }

  private guard(action: () => void): void {
    try { action(); } catch { this.instrumentationErrors++; }
  }

  private halt(reason: string, exceeded = false): void {
    if (exceeded) this._capacityExceeded = true;
    if (!this.running) return;
    this.running = false;
    try { this.mutationObserver?.disconnect?.(); } catch { this.instrumentationErrors++; }
    this.mutationObserver = null;
    if (this.timer !== null) {
      try { globalThis.clearInterval(this.timer); } catch { this.instrumentationErrors++; }
      this.timer = null;
    }
    const stamp = this.clock();
    for (const element of [...this.active.keys()]) this.endElement(element, stamp, reason);
  }
}
