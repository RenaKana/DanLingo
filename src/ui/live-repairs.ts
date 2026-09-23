import type { TranslationOutput } from '../core/types.ts';

export type LiveRepairState = 'unprocessed' | 'queued' | 'translating' | 'translated' | 'failed' | 'expired' | 'unneeded';
export type LiveRepairApplication = 'generated' | 'native-updated' | 'recent-only';
export type LiveRepairStrategy = 'manual' | 'superchat';
export type LiveRepairScanStatus = 'supported' | 'partial' | 'unavailable';

export interface RecentRepairRequest {
  requestId: string;
  /** The first captured original is authoritative for retries and force retries. */
  sourceId: string;
  originalText: string;
  strategy: LiveRepairStrategy;
  manual: true;
  force: boolean;
  /** Optional so older coordinators can keep using single requests. */
  batchId?: string;
}

export interface LiveRepairScanCandidate {
  sourceId: string;
  originalText: string;
  strategy?: LiveRepairStrategy;
  state?: LiveRepairState;
  text?: string;
  supported?: boolean;
}

export interface LiveRepairScanChunk {
  scanId: string;
  candidates: LiveRepairScanCandidate[];
  status: LiveRepairScanStatus;
  done: boolean;
}

export interface LiveRepairSync {
  state?: LiveRepairState;
  requestId?: string;
  text?: string;
  resultVersion?: number;
  application?: LiveRepairApplication;
}

interface Entry {
  sourceId: string;
  /** Never replace this after the first capture. */
  originalText: string;
  text?: string;
  state: LiveRepairState;
  /** First-seen timestamp. Duplicate captures intentionally do not renew it. */
  at: number;
  order: number;
  requestId?: string;
  requestOrigin?: 'local' | 'native';
  strategy: LiveRepairStrategy;
  supported: boolean;
  showingOriginal: boolean;
  resultVersion: number;
  application?: LiveRepairApplication;
  tombstone: boolean;
  displayExpired?: boolean;
  interacting: boolean;
  hovered: boolean;
  pressed: boolean;
  focused: boolean;
}

interface RowNodes {
  root: HTMLDivElement;
  state: HTMLSpanElement;
  button: HTMLButtonElement;
  originalButton: HTMLButtonElement;
  original: HTMLDivElement;
  text: HTMLDivElement;
  application: HTMLSpanElement;
}

interface BatchState {
  scanId: string;
  active: boolean;
  cancelled: boolean;
  scanDone: boolean;
  scanStatus?: LiveRepairScanStatus;
  recentSnapshot: number;
  loadedSnapshot: number;
  truncated: boolean;
  total: number;
  completed: number;
  activeRequests: number;
  queue: Entry[];
  queuedIds: Set<string>;
  loadedIds: Set<string>;
  requestIds: Set<string>;
  snapshot: Map<string, Entry>;
}

const labels: Record<LiveRepairState, string> = {
  unprocessed: '未处理', queued: '排队中', translating: '翻译中', translated: '已翻译',
  failed: '失败', expired: '超时', unneeded: '无需翻译',
};
const TTL_MS = 300000;
const MAX_RECORDS = 300;
const MAX_BATCH_RECENT = 300;
const MAX_BATCH_LOADED = 600;
const MAX_BATCH_TOTAL = MAX_BATCH_RECENT + MAX_BATCH_LOADED;
const BATCH_CONCURRENCY = 4;
const MAX_TEXT = 2000;
const MAX_ORIGINAL = 1000;
const requestableStates = new Set<LiveRepairState>(['unprocessed', 'failed', 'expired', 'unneeded']);

function finiteVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function selectionOffset(root: Node, node: Node, offset: number): number {
  try {
    const range = document.createRange(); range.selectNodeContents(root); range.setEnd(node, offset); return range.toString().length;
  } catch { return 0; }
}

function locateTextOffset(root: Node, wanted: number): { node: Node; offset: number } | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null, remaining = Math.max(0, wanted);
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  return { node: root, offset: root.childNodes.length };
}

function saveSelection(root: Node): { start: number; end: number; backward: boolean } | undefined {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
  const range = selection.getRangeAt(0);
  const start = selectionOffset(root, range.startContainer, range.startOffset);
  const end = selectionOffset(root, range.endContainer, range.endOffset);
  const backward = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
  return { start, end, backward };
}

function restoreSelection(root: Node, saved: { start: number; end: number; backward: boolean } | undefined) {
  if (!saved) return;
  const start = locateTextOffset(root, saved.start), end = locateTextOffset(root, saved.end);
  if (!start || !end) return;
  const range = document.createRange(); range.setStart(start.node, Math.min(start.offset, start.node.textContent?.length ?? start.offset));
  range.setEnd(end.node, Math.min(end.offset, end.node.textContent?.length ?? end.offset));
  const selection = document.getSelection(); if (!selection) return;
  selection.removeAllRanges(); selection.addRange(range);
  if (saved.backward && selection.extend) selection.extend(start.node, Math.min(start.offset, start.node.textContent?.length ?? start.offset));
}

function updateText(element: HTMLElement, value: string) {
  if (element.textContent === value) return;
  const saved = saveSelection(element); element.textContent = value; restoreSelection(element, saved);
}

type RepairIcon = 'retry' | 'original' | 'translation';
const SVG_NS = 'http://www.w3.org/2000/svg';
const iconPaths: Record<RepairIcon, string> = {
  retry: '<path d="M20 11a8 8 0 0 0-14.7-4.4L3 9"/><path d="M3 4.5V9h4.5"/><path d="M4 13a8 8 0 0 0 14.7 4.4L21 15"/><path d="M21 19.5V15h-4.5"/>',
  original: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6M9 19h4"/>',
  translation: '<path d="M5 5h14M5 12h9M5 19h14"/><path d="m16 9 3 3-3 3"/>',
};
function createIcon(name: RepairIcon): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.dataset.danlingoIcon = name;
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.style.cssText = 'display:block;width:max(12px,.95em);height:max(12px,.95em);pointer-events:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round';
  svg.innerHTML = iconPaths[name]; return svg;
}
function updateIconButton(button: HTMLButtonElement, icon: RepairIcon) {
  const current = button.querySelector<SVGSVGElement>(':scope > svg[data-danlingo-icon]');
  if (!current || current.dataset.danlingoIcon !== icon) button.replaceChildren(createIcon(icon));
}

/** Readable manual results for native canvas comments; never reinsert or retime the source. */
export function createLiveRepairs(options: {
  request(value: RecentRepairRequest): Promise<TranslationOutput | undefined>;
  timeoutMs?(value: RecentRepairRequest): number;
  scan(scope?: 'visible' | 'queue' | 'loaded', scanId?: string): void;
  cancel?(requestId: string): void;
}) {
  const host = document.createElement('span'); host.id = 'danlingo-live-repairs';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:inherit}*{box-sizing:border-box}
    details{position:relative}summary{cursor:pointer;display:flex;align-items:center;gap:8px;list-style-position:outside;user-select:none}
    summary::-webkit-details-marker{margin-right:2px}.summary-title{flex:0 0 auto}.summary-quick{font-size:11px;padding:1px 5px}
    button{font:inherit;color:inherit;border:1px solid #8a9b8e;border-radius:3px;background:transparent;padding:1px 5px;cursor:pointer}button:disabled{opacity:.5;cursor:default}
    .menu{position:fixed;inset:auto;margin:0;width:min(420px,84vw);max-height:min(430px,calc(100vh - 16px));display:flex;flex-direction:column;overflow:hidden;background:#f3f7f3;color:#243f30;border:1px solid #a4b8a9;border-radius:5px;padding:8px;box-shadow:0 4px 12px #0002}.menu:not(:popover-open){display:none}
    .toolbar{flex:0 0 auto;display:flex;flex-direction:column;gap:5px}.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.actions button{white-space:nowrap}
    .note{font-size:11px;color:#526c5a;margin:2px 0}.progress{min-height:16px}.list{flex:1 1 auto;min-height:36px;max-height:330px;overflow:auto;overflow-anchor:none;overscroll-behavior:contain;scroll-behavior:auto;padding-right:3px}
    .entry{padding:7px 0;border-top:1px solid #d1ded4;overflow-wrap:anywhere;contain:layout style}.entry:first-child{border-top:0}.entry[data-tombstone="true"]{opacity:.7}
    .source{font-size:11px;color:#526c5a;white-space:pre-wrap}.line{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:22px}.line-left{display:flex;gap:6px;align-items:baseline;min-width:0}.state{font-weight:600}.application{font-size:10px;color:#67806e}.line-actions{display:flex;align-items:center;gap:1px;flex:0 0 auto}.entry .line-actions button{width:max(18px,1.3em);height:max(18px,1.3em);padding:0;border:0;border-radius:6px 0 0 6px;display:grid;place-items:center;line-height:1;text-align:center;white-space:nowrap;opacity:.68}.entry .line-actions button+button{border-left:1px solid color-mix(in srgb,currentColor 26%,transparent);border-radius:0 6px 6px 0}.entry .line-actions button:is(:hover,[aria-pressed="true"]):not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}.entry .line-actions button:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:1px}.entry .line-actions button:disabled{opacity:.35}.text{white-space:pre-wrap;margin-top:3px;overflow-wrap:anywhere}.empty{padding:12px 0;color:#526c5a}
    .back-latest{margin-left:auto}.scan-note{min-height:16px}
  </style><details><summary><span class="summary-title">近期弹幕补翻</span><button id="quick-visible" class="summary-quick" type="button">一键补翻漏译</button></summary><div class="menu" popover="auto"><div class="toolbar"><div class="actions"><button id="visible-scan" type="button">补翻当前可见未译</button><button id="batch" type="button">补翻近期未译</button><button id="cancel-batch" type="button" hidden>停止补翻</button><button id="latest" class="back-latest" type="button">回到最新</button></div><details><summary>更多</summary><button id="scan" type="button">原生队列补扫</button></details><p class="note">译文显示在此，不重新发射弹幕。</p><div id="scan-note" class="note scan-note" role="status"></div></div><div id="items" class="list" tabindex="0" aria-label="近期弹幕补翻记录"><div class="empty">暂无记录。已消失且未捕获的内容无法恢复。</div></div></div></details>`;

  const records = new Map<string, Entry>();
  const rows = new Map<string, RowNodes>();
  let sequence = 0;
  let disposed = false;
  let visibleScanActive = false;
  let visibleScanTimer: ReturnType<typeof setTimeout> | undefined;
  let batch: BatchState | undefined;
  let activeAnchorSourceId: string | undefined;
  let lifecycleVersion = 0;
  let rendering = false;
  let anchorKey = '', scrollRemainder = 0;

  const details = root.querySelector('details')!;
  const menu = root.querySelector<HTMLElement>('.menu')!;
  const target = root.getElementById('items')!;
  const empty = root.querySelector<HTMLElement>('.empty')!;
  const scanNote = root.getElementById('scan-note')!;
  const batchButton = root.querySelector<HTMLButtonElement>('#batch')!;
  const cancelBatchButton = root.querySelector<HTMLButtonElement>('#cancel-batch')!;
  const latestButton = root.querySelector<HTMLButtonElement>('#latest')!;

  const sorted = () => [...records.values()].sort((a, b) => b.order - a.order);
  const isRequestable = (row: Entry) => !row.tombstone && Date.now() - row.at <= TTL_MS && row.supported && !row.requestId && requestableStates.has(row.state);
  const selected = (row: Entry) => {
    const selection = document.getSelection(), node = rows.get(row.sourceId)?.root;
    return !!node && !!selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode) || selection.containsNode(node, true));
  };
  const interacting = (row: Entry) => row.interacting || selected(row);

  const positionMenu = () => {
    if (!menu.matches(':popover-open')) return;
    const anchor = details.querySelector('summary')!.getBoundingClientRect();
    if (anchor.bottom <= 0 || anchor.top >= innerHeight || !host.isConnected || host.getClientRects().length === 0) { if (typeof menu.hidePopover === 'function') menu.hidePopover(); return; }
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))}px`;
    const below = anchor.bottom + 4;
    menu.style.top = `${Math.max(8, Math.min(below + box.height <= innerHeight - 8 ? below : anchor.top - box.height - 4, innerHeight - box.height - 8))}px`;
  };

  const captureAnchor = () => {
    const box = target.getBoundingClientRect();
    if (activeAnchorSourceId) {
      const active = rows.get(activeAnchorSourceId)?.button;
      if (active?.isConnected) {
        const rect = active.getBoundingClientRect();
        if (rect.bottom > box.top && rect.top < box.bottom) return { sourceId: activeAnchorSourceId, top: rect.top, button: true };
      }
    }
    if (target.scrollTop <= 1) return;
    for (const node of [...target.children] as HTMLElement[]) {
      const rect = node.getBoundingClientRect();
      if (node.dataset.sourceId && rect.bottom > box.top + 1 && rect.top < box.bottom - 1) return { sourceId: node.dataset.sourceId, top: rect.top, button: false };
    }
  };

  const restoreAnchor = (anchor: { sourceId: string; top: number; button: boolean } | undefined) => {
    if (!anchor) return;
    const nodes = rows.get(anchor.sourceId), node = anchor.button ? nodes?.button : nodes?.root;
    if (!node || !node.isConnected) return;
    const key = `${anchor.sourceId}:${anchor.button}`;
    if (anchorKey !== key) { anchorKey = key; scrollRemainder = 0; }
    // Chromium may round scrollTop to physical pixels. Carry the fractional
    // remainder so many half-pixel row heights cannot accumulate cursor drift.
    const desired = target.scrollTop + node.getBoundingClientRect().top - anchor.top + scrollRemainder;
    target.scrollTop = desired;
    scrollRemainder = Math.abs(desired - target.scrollTop) < 1 ? desired - target.scrollTop : 0;
  };

  const markTombstone = (row: Entry) => {
    if (row.tombstone) return;
    if (row.requestId) options.cancel?.(row.requestId);
    row.requestId = undefined; row.requestOrigin = undefined; row.state = 'expired'; row.tombstone = true;
  };

  const prune = (protectedSourceId?: string) => {
    const now = Date.now();
    const retained = new Set(sorted().filter(row => !row.tombstone && !row.displayExpired && now - row.at <= TTL_MS).slice(0, MAX_RECORDS));
    for (const row of records.values()) {
      if (now - row.at > TTL_MS) markTombstone(row);
      if (!row.tombstone && retained.has(row)) continue;
      row.displayExpired = true;
      // Batch snapshots own bounded originals independently of the 300-row view.
      // A real deletion/TTL invalidates that source; UI capacity eviction alone does not.
      if (interacting(row) || row.sourceId === protectedSourceId) continue;
      records.delete(row.sourceId);
    }
  };

  const setScanNote = (value: string) => updateText(scanNote, value);

  const updateBatchControls = () => {
    const active = !!batch?.active && !batch.cancelled;
    batchButton.disabled = active;
    batchButton.textContent = active ? '补翻进行中' : '补翻近期未译';
    cancelBatchButton.hidden = !active; cancelBatchButton.disabled = !active;
    latestButton.disabled = target.scrollTop <= 1;
    const activeSummary = active ? `补翻进度 ${batch!.completed}/${Math.max(batch!.total, batch!.completed)} · 可停止` : '';
    if (activeSummary && !scanNote.textContent?.includes('正在读取')) setScanNote(activeSummary);
  };

  const updateRow = (row: Entry, nodes: RowNodes) => {
    nodes.root.dataset.sourceId = row.sourceId; nodes.root.dataset.state = row.state;
    const expired = row.tombstone || row.displayExpired;
    nodes.root.dataset.tombstone = String(!!expired); nodes.root.dataset.supported = String(row.supported);
    nodes.root.dataset.requestId = row.requestId || '';
    updateText(nodes.state, expired ? '已失效' : labels[row.state]);
    const application = row.application === 'native-updated' ? '原生已更新' : row.application === 'generated' ? '已生成' : row.application === 'recent-only' ? '仅近期记录' : '';
    updateText(nodes.application, application); nodes.application.hidden = !application;
    updateText(nodes.original, row.originalText); nodes.original.hidden = row.showingOriginal;
    const displayText = row.showingOriginal ? row.originalText : row.text || '';
    updateText(nodes.text, displayText); nodes.text.hidden = !displayText;
    updateIconButton(nodes.button, 'retry');
    nodes.button.setAttribute('aria-label', expired ? '记录已失效' : row.supported ? '强制重译' : '暂不支持');
    nodes.button.disabled = !!expired || !row.supported || !!row.requestId || !requestableStates.has(row.state) && row.state !== 'translated';
    nodes.button.title = row.tombstone ? '记录已过期，操作后移除' : row.supported ? '使用原文强制重译，绕过缓存' : '原生扫描不支持此条目';
    updateIconButton(nodes.originalButton, row.showingOriginal ? 'translation' : 'original');
    nodes.originalButton.setAttribute('aria-label', row.showingOriginal ? '显示译文' : '显示原文');
    nodes.originalButton.setAttribute('aria-pressed', String(row.showingOriginal));
    nodes.originalButton.title = row.showingOriginal ? '显示已保存译文，不请求' : '显示保存原文，不请求';
    nodes.originalButton.disabled = !!expired || !row.originalText || row.showingOriginal && !row.text;
  };

  const makeRow = (row: Entry): RowNodes => {
    const entry = document.createElement('div'); entry.className = 'entry'; entry.tabIndex = -1;
    const line = document.createElement('div'); line.className = 'line';
    const left = document.createElement('div'); left.className = 'line-left';
    const state = document.createElement('span'); state.className = 'state';
    const application = document.createElement('span'); application.className = 'application';
    const button = document.createElement('button'); button.type = 'button';
    const originalButton = document.createElement('button'); originalButton.type = 'button';
    const actions = document.createElement('div'); actions.className = 'line-actions'; actions.append(button, originalButton);
    const original = document.createElement('div'); original.className = 'source';
    const text = document.createElement('div'); text.className = 'text';
    left.append(state, application); line.append(left, actions); entry.append(line, original, text);
    const nodes = { root: entry, state, button, originalButton, original, text, application };
    button.addEventListener('click', event => {
      event.stopPropagation(); const current = records.get(row.sourceId);
      if (!current || current !== row || row.tombstone || row.displayExpired) return;
      row.showingOriginal = false;
      void request(row, true);
    });
    originalButton.addEventListener('click', event => {
      event.stopPropagation(); const current = records.get(row.sourceId);
      if (!current || current !== row || row.tombstone || row.displayExpired || row.showingOriginal && !row.text) return;
      row.showingOriginal = !row.showingOriginal; render();
    });
    const refreshInteraction = () => {
      row.interacting = row.hovered || row.pressed || row.focused;
      if (row.interacting) activeAnchorSourceId = row.sourceId;
      else if (activeAnchorSourceId === row.sourceId) activeAnchorSourceId = undefined;
    };
    entry.addEventListener('pointerenter', () => { row.hovered = true; refreshInteraction(); });
    entry.addEventListener('pointerleave', () => { row.hovered = false; refreshInteraction(); if (row.displayExpired || row.tombstone) queueMicrotask(render); });
    entry.addEventListener('pointerdown', event => {
      row.pressed = true; refreshInteraction();
      // A held button keeps ownership of pointerup/click while the scroll
      // container is compensated around incoming rows.
      if (event.target instanceof Node && (button.contains(event.target) || originalButton.contains(event.target))) {
        const owner = button.contains(event.target) ? button : originalButton;
        try { owner.setPointerCapture(event.pointerId); } catch { /* Synthetic/retired pointers have no capture. */ }
      }
    });
    entry.addEventListener('focusin', () => { row.focused = true; refreshInteraction(); });
    entry.addEventListener('focusout', () => { row.focused = false; refreshInteraction(); if (row.displayExpired || row.tombstone) queueMicrotask(render); });
    entry.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { row.pressed = true; refreshInteraction(); } });
    return nodes;
  };

  function render() {
    if (disposed || rendering) return;
    if (!details.open) { prune(); updateBatchControls(); return; }
    rendering = true;
    const anchor = captureAnchor(); prune(anchor?.sourceId);
    const visible = sorted(); const desired = new Set(visible.map(row => row.sourceId));
    for (let index = 0; index < visible.length; index++) {
      const row = visible[index]!; let nodes = rows.get(row.sourceId);
      if (!nodes) { nodes = makeRow(row); rows.set(row.sourceId, nodes); }
      updateRow(row, nodes);
      const currentAt = target.children[index]; if (currentAt !== nodes.root) target.insertBefore(nodes.root, currentAt || null);
    }
    for (const [sourceId, nodes] of rows) {
      if (desired.has(sourceId)) continue;
      nodes.root.remove(); rows.delete(sourceId);
    }
    empty.hidden = visible.length > 0; updateBatchControls(); positionMenu(); restoreAnchor(anchor); rendering = false;
  }
  const releaseInteraction = () => {
    const ended: Entry[] = [];
    for (const row of records.values()) if (row.pressed) {
      row.pressed = false;
      if (row.displayExpired || row.tombstone) { row.hovered = false; row.focused = false; ended.push(row); }
      row.interacting = row.hovered || row.focused;
      if (!row.interacting && activeAnchorSourceId === row.sourceId) activeAnchorSourceId = undefined;
    }
    // Keep the original click target through pointerup and the ensuing click event.
    setTimeout(() => {
      for (const row of ended) if (records.get(row.sourceId) === row && !selected(row)) records.delete(row.sourceId);
      render();
    }, 0);
  };
  window.addEventListener('pointerup', releaseInteraction, true);
  window.addEventListener('pointercancel', releaseInteraction, true);
  window.addEventListener('keyup', releaseInteraction, true);
  document.addEventListener('selectionchange', render);
  const retentionTimer = setInterval(render, 1000);

  function openMenu() {
    details.open = true;
    if (typeof menu.showPopover === 'function' && !menu.matches(':popover-open')) menu.showPopover();
    positionMenu(); render();
  }

  async function request(row: Entry, force: boolean, batchId?: string): Promise<void> {
    const detachedBatchEntry = !!batchId;
    if (disposed || row.requestId || row.tombstone || Date.now() - row.at > TTL_MS || !row.supported || !detachedBatchEntry && (row.displayExpired || records.get(row.sourceId) !== row)) return;
    if (!force && !requestableStates.has(row.state)) return;
    const requestId = crypto.randomUUID(), version = lifecycleVersion; row.showingOriginal = false; row.requestId = requestId; row.requestOrigin = 'local'; row.state = 'translating'; row.tombstone = false;
    render();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const input: RecentRepairRequest = { requestId, sourceId: row.sourceId, originalText: row.originalText, strategy: row.strategy, manual: true, force, ...(batchId ? { batchId } : {}) };
      const timeoutMs = Math.max(1000, Math.min(120000, options.timeoutMs?.(input) ?? 15000));
      const output = await Promise.race<TranslationOutput | undefined>([options.request(input), new Promise<TranslationOutput>(resolve => {
        timer = setTimeout(() => resolve({ id: requestId, status: 'expired' }), timeoutMs + 250);
      })]);
      if (disposed || version !== lifecycleVersion || !detachedBatchEntry && records.get(row.sourceId) !== row || row.requestId !== requestId) return;
      if (output && ['translated', 'cached'].includes(output.status) && validText(output.text, MAX_TEXT)) {
        row.state = 'translated'; row.text = output.text; row.application = 'recent-only';
      } else row.state = output?.status === 'expired' ? 'expired' : 'failed';
    } catch { if (records.get(row.sourceId) === row && row.requestId === requestId) row.state = 'failed'; }
    finally {
      clearTimeout(timer); if (row.requestId === requestId) { row.requestId = undefined; row.requestOrigin = undefined; }
      render();
    }
  }

  const finishBatchIfDone = (current: BatchState) => {
    if (current.active && current.scanDone && current.activeRequests === 0 && current.queue.length === 0) {
      current.active = false; setScanNote(`补翻完成 ${current.completed}/${current.total} 条${current.scanStatus === 'partial' ? '；部分结构不可用' : current.scanStatus === 'unavailable' ? '；扫描不可用' : ''}。`); updateBatchControls();
    }
  };

  const pumpBatch = (current: BatchState) => {
    if (!current.active || current.cancelled || disposed) return;
    while (current.activeRequests < BATCH_CONCURRENCY && current.queue.length) {
      const row = current.queue.shift()!; if (!isRequestable(row)) { current.completed++; continue; }
      current.activeRequests++;
      const startedRequest = request(row, false, current.scanId);
      const requestId = row.requestId; if (requestId) current.requestIds.add(requestId);
      void startedRequest.finally(() => {
        if (requestId) current.requestIds.delete(requestId);
        current.activeRequests--;
        if (!current.cancelled) { current.completed++; pumpBatch(current); finishBatchIfDone(current); }
      });
    }
    finishBatchIfDone(current); updateBatchControls(); render();
  };

  let captureEntry: (sourceId: string, originalText: string, state: LiveRepairState, strategy?: LiveRepairStrategy, supported?: boolean, timestamp?: number) => void;
  let syncEntry: (sourceId: string, update: LiveRepairSync) => boolean;

  const addBatchCandidate = (current: BatchState, candidate: LiveRepairScanCandidate, loaded: boolean) => {
    if (typeof candidate?.sourceId !== 'string' || !candidate.sourceId || candidate.sourceId.length > 300 || !validText(candidate.originalText, MAX_ORIGINAL)) return;
    if (loaded) {
      if (current.loadedSnapshot >= MAX_BATCH_LOADED) { current.truncated = true; current.scanStatus = 'partial'; return; }
      if (current.loadedIds.has(candidate.sourceId)) return;
      current.loadedIds.add(candidate.sourceId); current.loadedSnapshot++;
    }
    // Reuse the snapshot object even when its UI row was capacity-evicted.
    let row = current.snapshot.get(candidate.sourceId) ?? records.get(candidate.sourceId);
    if (row && row.originalText !== candidate.originalText) return;
    if (!row) {
      captureEntry(candidate.sourceId, candidate.originalText, candidate.state || 'unprocessed', candidate.strategy || 'manual', candidate.supported !== false);
      row = records.get(candidate.sourceId);
    } else if (records.has(candidate.sourceId)) {
      captureEntry(candidate.sourceId, candidate.originalText, candidate.state || row.state, candidate.strategy || row.strategy, candidate.supported !== false);
    }
    if (!row) return;
    if (!row.requestId && row.state !== 'translated') {
      if (candidate.state && labels[candidate.state]) row.state = candidate.state;
      if (validText(candidate.text, MAX_TEXT)) { row.text = candidate.text; row.state = 'translated'; }
    }
    if (candidate.text && validText(candidate.text, MAX_TEXT)) syncEntry(row.sourceId, { state: 'translated', text: candidate.text, application: 'recent-only' });
    if (candidate.state && candidate.state !== 'unprocessed') syncEntry(row.sourceId, { state: candidate.state, text: candidate.text, application: 'recent-only' });
    current.snapshot.set(row.sourceId, row);
    if (current.total >= MAX_BATCH_TOTAL) { current.truncated = true; current.scanStatus = 'partial'; return; }
    if (current.queuedIds.has(row.sourceId) || !isRequestable(row)) return;
    current.queuedIds.add(row.sourceId); current.queue.push(row); current.total++;
  };

  function startBatch(includeLoaded = true) {
    if (disposed) return;
    if (batch?.active && !batch.cancelled) { openMenu(); setScanNote(`补翻进行中 ${batch.completed}/${Math.max(batch.total, batch.completed)} 条；已合并重复点击。`); return; }
    prune();
    const current: BatchState = { scanId: crypto.randomUUID(), active: true, cancelled: false, scanDone: !includeLoaded, scanStatus: undefined, recentSnapshot: 0, loadedSnapshot: 0, truncated: false, total: 0, completed: 0, activeRequests: 0, queue: [], queuedIds: new Set(), loadedIds: new Set(), requestIds: new Set(), snapshot: new Map() };
    batch = current; openMenu();
    for (const row of sorted().slice(0, MAX_BATCH_RECENT)) {
      current.recentSnapshot++; addBatchCandidate(current, { sourceId: row.sourceId, originalText: row.originalText, strategy: row.strategy, state: row.state, supported: row.supported }, false);
    }
    setScanNote(includeLoaded ? `已固定近期 ${current.recentSnapshot} 条，读取已加载记录…` : `已固定近期 ${current.recentSnapshot} 条，开始补翻…`);
    if (includeLoaded) options.scan('loaded', current.scanId);
    pumpBatch(current);
  }

  function stopBatch() {
    const current = batch; if (!current?.active) return;
    current.cancelled = true; current.active = false; options.cancel?.(current.scanId);
    for (const requestId of current.requestIds) options.cancel?.(requestId);
    for (const row of current.snapshot.values()) if (row.requestId && row.requestOrigin === 'local' && current.requestIds.has(row.requestId)) {
      row.requestId = undefined; row.requestOrigin = undefined; if (row.state === 'translating') row.state = 'failed';
    }
    current.queue.length = 0; setScanNote(`已停止补翻，已完成 ${current.completed}/${current.total} 条。`); render();
  }

  function startVisibleScan() {
    if (disposed || visibleScanActive) return;
    visibleScanActive = true; clearTimeout(visibleScanTimer); openMenu(); setScanNote('正在读取当前可见弹幕…');
    visibleScanTimer = setTimeout(() => { visibleScanActive = false; setScanNote('当前画面暂不可补扫；已捕获记录仍可补翻。'); }, 5000);
    options.scan('visible');
  }

  details.addEventListener('toggle', () => {
    if (details.open) { if (typeof menu.showPopover === 'function' && !menu.matches(':popover-open')) menu.showPopover(); render(); }
    else if (menu.matches(':popover-open') && typeof menu.hidePopover === 'function') menu.hidePopover();
  });
  menu.addEventListener('toggle', event => { if ((event as ToggleEvent).newState === 'closed') details.open = false; });
  window.addEventListener('resize', positionMenu); window.addEventListener('scroll', positionMenu, true);
  target.addEventListener('scroll', updateBatchControls);
  root.getElementById('quick-visible')!.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); startBatch(true); });
  root.getElementById('visible-scan')!.addEventListener('click', startVisibleScan);
  batchButton.addEventListener('click', () => startBatch(false)); cancelBatchButton.addEventListener('click', stopBatch);
  latestButton.addEventListener('click', () => { target.scrollTop = 0; updateBatchControls(); positionMenu(); });
  root.getElementById('scan')!.addEventListener('click', () => { setScanNote('正在读取当前原生弹幕队列…'); options.scan('queue'); });

  const view = {
    host,
    capture(sourceId: string, originalText: string, state: LiveRepairState, strategy: LiveRepairStrategy = 'manual', supported = true, timestamp?: number) {
      if (disposed || typeof sourceId !== 'string' || !sourceId || sourceId.length > 300 || !validText(originalText, MAX_ORIGINAL)) return;
      const previous = records.get(sourceId);
      if (previous) {
        if (previous.originalText !== originalText) return;
        const beforeState = previous.state; previous.supported = previous.supported && supported;
        if (!previous.requestId && beforeState !== 'translated' && !previous.tombstone && state !== 'unprocessed') previous.state = state;
        if (previous.strategy !== 'superchat' && strategy === 'superchat') previous.strategy = strategy;
        render(); return;
      }
      const at = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
      records.set(sourceId, { sourceId, originalText, state, strategy, at, order: ++sequence, supported, showingOriginal: false, resultVersion: 0, tombstone: false, interacting: false, hovered: false, pressed: false, focused: false });
      render();
    },
    prepared(sourceId: string, text: string) {
      const row = records.get(sourceId); if (!row || row.tombstone || row.displayExpired || row.requestId || !validText(text, MAX_TEXT)) return;
      row.text = text; row.state = 'translated'; row.application = 'generated'; render();
    },
    delivered(sourceId: string, translated: boolean) {
      const row = records.get(sourceId); if (!row || row.requestId || row.state === 'translated' || row.state === 'unneeded') return;
      row.state = translated ? 'translated' : 'expired'; row.tombstone = false; render();
    },
    failed(sourceId: string) { const row = records.get(sourceId); if (row && !row.requestId && row.state !== 'translated') { row.state = 'failed'; row.tombstone = false; render(); } },
    repairVisible(sourceId: string) {
      const row = records.get(sourceId); if (!row || !isRequestable(row)) return false;
      void request(row, false); return true;
    },
    scanStatus(status: string, count: number, scope: 'visible' | 'queue' | 'loaded' = 'queue', requested = 0) {
      if (scope === 'visible') { visibleScanActive = false; clearTimeout(visibleScanTimer); visibleScanTimer = undefined; }
      const suffix = status === 'partial' ? '；部分渲染结构未支持或达到本次上限' : '';
      setScanNote(scope === 'visible'
        ? status === 'unavailable' ? '当前画面暂不可补扫；已捕获记录仍可补翻。' : `已读取 ${count} 条可见消息，补翻 ${requested} 条${suffix}。`
        : status === 'unavailable' ? '原生队列暂不可用；已捕获记录仍可补翻。' : `已补扫 ${count} 条消息${suffix}；可单条或批量补翻。`);
      if (scope === 'loaded' && batch) { batch.scanStatus = status as LiveRepairScanStatus; batch.scanDone = true; finishBatchIfDone(batch); }
    },
    scanChunk(chunk: LiveRepairScanChunk) {
      const current = batch; if (!current || !current.active || current.cancelled || current.scanDone || !chunk || chunk.scanId !== current.scanId || !Array.isArray(chunk.candidates)) return false;
      current.scanStatus = chunk.status; for (const candidate of chunk.candidates) addBatchCandidate(current, candidate, true);
      if (chunk.done) current.scanDone = true;
      setScanNote(chunk.done ? `已读取 ${current.loadedSnapshot} 条，准备补翻 ${current.total} 条${current.truncated ? '；达到上限' : ''}…` : `已读取 ${current.loadedSnapshot} 条，发现 ${current.total} 条待补翻…`);
      pumpBatch(current); finishBatchIfDone(current); render(); return true;
    },
    sync(sourceId: string, update: LiveRepairSync) {
      const row = records.get(sourceId); if (!row || row.tombstone || row.displayExpired || !update || update.state !== undefined && !labels[update.state]) return false;
      const incomingVersion = finiteVersion(update.resultVersion);
      const newer = incomingVersion !== undefined && incomingVersion > row.resultVersion;
      if (row.requestOrigin === 'local' && row.requestId && update.requestId !== row.requestId && !newer) return false;
      if (incomingVersion !== undefined && incomingVersion < row.resultVersion) return false;
      if (update.state === undefined) {
        if (row.requestOrigin === 'local' && row.requestId && !newer) return false;
        if (incomingVersion !== undefined) row.resultVersion = incomingVersion;
        if (validText(update.text, MAX_TEXT)) row.text = update.text;
        if (update.application) row.application = update.application;
        render(); return true;
      }
      const wasLocal = row.requestOrigin === 'local';
      if (update.state === 'translating' || update.state === 'queued') {
        if (wasLocal && update.requestId !== row.requestId && !newer) return false;
        row.state = update.state; row.requestId = update.requestId || row.requestId; row.requestOrigin = row.requestId === update.requestId ? wasLocal ? 'local' : 'native' : row.requestOrigin;
        row.tombstone = false;
      } else {
        if (wasLocal && row.requestId && update.requestId !== row.requestId && !newer) return false;
        row.state = update.state; row.requestId = undefined; row.requestOrigin = undefined;
        if (incomingVersion !== undefined) row.resultVersion = incomingVersion;
        if (validText(update.text, MAX_TEXT)) row.text = update.text;
        if (update.application) row.application = update.application;
        // Translation deadlines remain retryable. Tombstones are reserved for
        // retention expiry or native removal, where the source can no longer
        // be safely retried from the line-side lifecycle.
        row.tombstone = false;
      }
      if (update.application) row.application = update.application;
      render(); return true;
    },
    applied(sourceId: string, resultVersion?: number, application: LiveRepairApplication = 'native-updated') {
      const row = records.get(sourceId), version = finiteVersion(resultVersion); if (!row || version !== undefined && version < row.resultVersion) return false;
      if (version !== undefined) row.resultVersion = version; row.application = application; if (application === 'native-updated' && row.state === 'translating') { row.state = 'translated'; row.requestId = undefined; row.requestOrigin = undefined; }
      render(); return true;
    },
    clear() {
      lifecycleVersion++;
      if (batch?.active) stopBatch();
      for (const row of records.values()) if (row.requestId) options.cancel?.(row.requestId);
      batch = undefined; records.clear(); rows.clear(); target.querySelectorAll('.entry').forEach(node => node.remove()); activeAnchorSourceId = undefined; render();
    },
    remove(sourceId: string) {
      const row = records.get(sourceId), snapshot = batch?.snapshot.get(sourceId);
      if (row) markTombstone(row);
      if (snapshot && snapshot !== row) markTombstone(snapshot);
      render();
    },
    cancelPending() { for (const row of records.values()) if (row.requestId) { options.cancel?.(row.requestId); row.requestId = undefined; row.requestOrigin = undefined; row.state = 'failed'; } if (batch?.active) stopBatch(); render(); },
    invalidate() {
      lifecycleVersion++;
      if (batch?.active) stopBatch();
      for (const row of records.values()) { if (row.requestId) options.cancel?.(row.requestId); row.text = undefined; row.application = undefined; row.requestId = undefined; row.requestOrigin = undefined; row.state = 'unprocessed'; row.resultVersion = 0; }
      batch = undefined; render();
    },
    dispose() {
      if (batch?.active) stopBatch();
      for (const row of records.values()) if (row.requestId) options.cancel?.(row.requestId);
      disposed = true; lifecycleVersion++; clearInterval(retentionTimer); clearTimeout(visibleScanTimer);
      if (menu.matches(':popover-open') && typeof menu.hidePopover === 'function') menu.hidePopover();
      window.removeEventListener('resize', positionMenu); window.removeEventListener('scroll', positionMenu, true);
      window.removeEventListener('pointerup', releaseInteraction, true); window.removeEventListener('pointercancel', releaseInteraction, true);
      window.removeEventListener('keyup', releaseInteraction, true); document.removeEventListener('selectionchange', render);
      host.remove(); records.clear(); rows.clear();
    },
  };
  captureEntry = view.capture;
  syncEntry = view.sync;
  return view;
}
