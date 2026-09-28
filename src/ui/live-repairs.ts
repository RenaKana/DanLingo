import type { TranslationOutput } from '../core/types.ts';
import { initLocale, t } from '../i18n';
import { bindLocalizedAttribute, bindLocalizedText } from './localized-text.ts';

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

const labelKeys: Record<LiveRepairState, string> = {
  unprocessed: 'm_83fbf42f9e87', queued: 'm_d6f766f2adf5', translating: 'm_aeda1aa78563', translated: 'm_fe87640f656c',
  failed: 'm_28384d7afd2e', expired: 'm_e512cf016f96', unneeded: 'm_d7a08d8864bb',
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
    :host{font:14px/1.45 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#28323a}*{box-sizing:border-box}[hidden]{display:none!important}
    details{position:relative}summary{cursor:pointer;display:inline-flex;align-items:center;gap:7px;list-style:none;user-select:none}
    summary::-webkit-details-marker{display:none}details>summary:before{content:"";width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg)}details[open]>summary:before{transform:rotate(45deg)}
    .summary-title{white-space:nowrap}.summary-quick{color:#23649b;border-color:#b8cde0;background:#f4f8fc}
    button{font:inherit;color:#34414a;border:1px solid #cbd4da;border-radius:4px;background:#fff;min-height:30px;padding:3px 9px;cursor:pointer;white-space:nowrap}
    button:hover:not(:disabled),summary:hover{color:#23649b}button:hover:not(:disabled){background:#f4f8fc;border-color:#a8c4dd}button:disabled{opacity:.5;cursor:default}
    button:focus-visible,summary:focus-visible,.list:focus-visible{outline:2px solid #2675ae;outline-offset:2px}
    .menu{position:fixed;inset:auto;margin:0;width:min(456px,calc(100vw - 16px));max-height:min(460px,calc(100vh - 16px));display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#28323a;border:1px solid #d0d9df;border-radius:6px;padding:10px 12px;box-shadow:0 8px 24px #1f2c381c}.menu:not(:popover-open){display:none}
    .toolbar{flex:0 0 auto;display:grid;gap:8px;padding-bottom:9px;border-bottom:1px solid #e1e6ea}.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.actions button{white-space:normal;text-align:center}
    .toolbar>details{display:flex;align-items:center;gap:6px}.toolbar>details>summary{min-height:30px;padding:3px 9px;border:1px solid #cbd4da;border-radius:4px}.toolbar>details>button{margin-inline-start:6px}
    .note{font-size:14px;color:#68747c;margin:0}.scan-note:empty{display:none}.scan-note:not(:empty){color:#34414a}
    .list{flex:1 1 auto;min-height:48px;max-height:320px;overflow:auto;overflow-anchor:none;overscroll-behavior:contain;scroll-behavior:auto;padding-inline-end:3px}
    .entry{padding:10px 1px;border-top:1px solid #e1e6ea;overflow-wrap:anywhere;contain:layout style}.entry:first-child{border-top:0}.entry[data-tombstone="true"]{opacity:.7}
    .line{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:30px}.line-left{display:flex;gap:8px;align-items:baseline;min-width:0}.state{font-weight:600}.application{color:#68747c}
    .source{color:#68747c;white-space:pre-wrap}.text{white-space:pre-wrap;margin-top:4px;overflow-wrap:anywhere}
    .line-actions{display:flex;align-items:center;gap:3px;flex:0 0 auto}.entry .line-actions button{width:28px;height:28px;min-height:0;padding:0;border-color:transparent;display:grid;place-items:center;line-height:1;text-align:center}
    .entry .line-actions button:hover:not(:disabled),.entry .line-actions button[aria-pressed="true"]:not(:disabled){border-color:#cbd4da;background:#f4f8fc}.entry .line-actions button:disabled{opacity:.4}
    .empty{padding:12px 1px;color:#68747c}.back-latest{margin-inline-start:auto}
    @media(max-width:480px){.menu{padding:9px}.actions{gap:5px}.actions button{flex:1 1 auto}.back-latest{margin-inline-start:0}}
  </style><details><summary><span class="summary-title" data-i18n="m_7acc84c1b930">近期弹幕补翻</span><button id="quick-visible" class="summary-quick" type="button" data-i18n="m_ba37f0bd03a4">一键补翻漏译</button></summary><div class="menu" popover="auto"><div class="toolbar"><div class="actions"><button id="visible-scan" type="button" data-i18n="m_865563f08f89">补翻当前可见未译</button><button id="batch" type="button" data-i18n="m_18aae413fec9">补翻近期未译</button><button id="cancel-batch" type="button" data-i18n="m_02b3bc2a57f4" hidden>停止补翻</button><button id="latest" class="back-latest" type="button" data-i18n="m_1c59875d3a15">回到最新</button></div><details><summary data-i18n="m_38844b135cf7">更多</summary><button id="scan" type="button" data-i18n="m_b4b4c262c946">原生队列补扫</button></details><p class="note" data-i18n="m_cc8bcfe58bf9">译文显示在此，不重新发射弹幕。</p><div id="scan-note" class="note scan-note" role="status"></div></div><div id="items" class="list" tabindex="0" aria-label="近期弹幕补翻记录" data-i18n-aria-label="m_fdcc6c950859"><div class="empty" data-i18n="m_94b67101eb98">暂无记录。已消失且未捕获的内容无法恢复。</div></div></div></details>`;
  const localeReady = initLocale(root);

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

  const setScanNote = (render: () => string) => bindLocalizedText(scanNote, render);

  const updateBatchControls = () => {
    const active = !!batch?.active && !batch.cancelled;
    batchButton.disabled = active;
    bindLocalizedText(batchButton, () => active ? t('m_973a7874b34e') : t('m_18aae413fec9'));
    cancelBatchButton.hidden = !active; cancelBatchButton.disabled = !active;
    latestButton.disabled = target.scrollTop <= 1;
    const activeSummary = () => active ? t('m_36e600949392', { p0: batch!.completed, p1: Math.max(batch!.total, batch!.completed) }) : '';
    if (active && !scanNote.textContent?.includes(t('m_2d1341db7717'))) setScanNote(activeSummary);
  };

  const updateRow = (row: Entry, nodes: RowNodes) => {
    nodes.root.dataset.sourceId = row.sourceId; nodes.root.dataset.state = row.state;
    const expired = row.tombstone || row.displayExpired;
    nodes.root.dataset.tombstone = String(!!expired); nodes.root.dataset.supported = String(row.supported);
    nodes.root.dataset.requestId = row.requestId || '';
    bindLocalizedText(nodes.state, () => expired ? t('m_2fe5a8d0eee9') : t(labelKeys[row.state]));
    const applicationText = () => row.application === 'native-updated' ? t('m_0a937d6d4f51') : row.application === 'generated' ? t('m_11448fff91a4') : row.application === 'recent-only' ? t('m_f4b0f641d977') : '';
    bindLocalizedText(nodes.application, applicationText); nodes.application.hidden = !applicationText();
    updateText(nodes.original, row.originalText); nodes.original.hidden = row.showingOriginal;
    const displayText = row.showingOriginal ? row.originalText : row.text || '';
    updateText(nodes.text, displayText); nodes.text.hidden = !displayText;
    updateIconButton(nodes.button, 'retry');
    bindLocalizedAttribute(nodes.button, 'aria-label', () => expired ? t('m_0bcb7c62fd02') : row.supported ? t('m_dee9278dcdbe') : t('m_374930f1453f'));
    nodes.button.disabled = !!expired || !row.supported || !!row.requestId || !requestableStates.has(row.state) && row.state !== 'translated';
    bindLocalizedAttribute(nodes.button, 'title', () => row.tombstone ? t('m_51595178ec76') : row.supported ? t('m_9bae35753b2b') : t('m_b931579d86f4'));
    updateIconButton(nodes.originalButton, row.showingOriginal ? 'translation' : 'original');
    bindLocalizedAttribute(nodes.originalButton, 'aria-label', () => row.showingOriginal ? t('m_7cd62999f274') : t('m_098e66189da8'));
    nodes.originalButton.setAttribute('aria-pressed', String(row.showingOriginal));
    bindLocalizedAttribute(nodes.originalButton, 'title', () => row.showingOriginal ? t('m_57b624cf8552') : t('m_f67014ece527'));
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
      current.active = false; setScanNote(() => (t('m_8f2df88da722', { p0: current.completed, p1: current.total, p2: current.scanStatus === 'partial' ? t('m_685a47744fb4') : current.scanStatus === 'unavailable' ? t('m_83890a9c9bde') : '' }))); updateBatchControls();
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
      if (candidate.state && labelKeys[candidate.state]) row.state = candidate.state;
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
    if (batch?.active && !batch.cancelled) { const current = batch; openMenu(); setScanNote(() => (t('m_a73ae5face34', { p0: current.completed, p1: Math.max(current.total, current.completed) }))); return; }
    prune();
    const current: BatchState = { scanId: crypto.randomUUID(), active: true, cancelled: false, scanDone: !includeLoaded, scanStatus: undefined, recentSnapshot: 0, loadedSnapshot: 0, truncated: false, total: 0, completed: 0, activeRequests: 0, queue: [], queuedIds: new Set(), loadedIds: new Set(), requestIds: new Set(), snapshot: new Map() };
    batch = current; openMenu();
    for (const row of sorted().slice(0, MAX_BATCH_RECENT)) {
      current.recentSnapshot++; addBatchCandidate(current, { sourceId: row.sourceId, originalText: row.originalText, strategy: row.strategy, state: row.state, supported: row.supported }, false);
    }
    setScanNote(() => (includeLoaded ? t('m_8018a5e50a7b', { p0: current.recentSnapshot }) : t('m_4979ecc5a44c', { p0: current.recentSnapshot })));
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
    current.queue.length = 0; setScanNote(() => (t('m_2c6d40105132', { p0: current.completed, p1: current.total }))); render();
  }

  function startVisibleScan() {
    if (disposed || visibleScanActive) return;
    visibleScanActive = true; clearTimeout(visibleScanTimer); openMenu(); setScanNote(() => (t('m_960f60200288')));
    visibleScanTimer = setTimeout(() => { visibleScanActive = false; setScanNote(() => (t('m_c547bc5768ba'))); }, 5000);
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
  root.getElementById('scan')!.addEventListener('click', () => { setScanNote(() => (t('m_0fb38a610f44'))); options.scan('queue'); });

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
      const suffix = () => status === 'partial' ? t('m_5b02c888bd0b') : '';
      setScanNote(() => (scope === 'visible'
        ? status === 'unavailable' ? t('m_c547bc5768ba') : t('m_1dc820b6558f', { p0: count, p1: requested, p2: suffix() })
        : status === 'unavailable' ? t('m_cc2a2b665151') : t('m_903332313229', { p0: count, p1: suffix() })));
      if (scope === 'loaded' && batch) { batch.scanStatus = status as LiveRepairScanStatus; batch.scanDone = true; finishBatchIfDone(batch); }
    },
    scanChunk(chunk: LiveRepairScanChunk) {
      const current = batch; if (!current || !current.active || current.cancelled || current.scanDone || !chunk || chunk.scanId !== current.scanId || !Array.isArray(chunk.candidates)) return false;
      current.scanStatus = chunk.status; for (const candidate of chunk.candidates) addBatchCandidate(current, candidate, true);
      if (chunk.done) current.scanDone = true;
      setScanNote(() => (chunk.done ? t('m_7eda5edf4e4e', { p0: current.loadedSnapshot, p1: current.total, p2: current.truncated ? t('m_5d836bb749db') : '' }) : t('m_0b81e36ec699', { p0: current.loadedSnapshot, p1: current.total })));
      pumpBatch(current); finishBatchIfDone(current); render(); return true;
    },
    sync(sourceId: string, update: LiveRepairSync) {
      const row = records.get(sourceId); if (!row || row.tombstone || row.displayExpired || !update || update.state !== undefined && !labelKeys[update.state]) return false;
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
      void localeReady.then(disposeLocale => disposeLocale());
      host.remove(); records.clear(); rows.clear();
    },
  };
  captureEntry = view.capture;
  syncEntry = view.sync;
  return view;
}
