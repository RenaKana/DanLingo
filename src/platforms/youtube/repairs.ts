import { prepareNativeChatText, type PreparedNativeChatText } from './native-text.ts';
import { comparableChatText, latestChatRecords, nativeMessageText, unchangedChatTranslation } from './repair-state.ts';

type Data = Record<string, any>;
type State = 'unprocessed' | 'queued' | 'translating' | 'translated' | 'failed' | 'expired' | 'unneeded' | 'suspected';
type DisplayState = State | 'not-displayed' | 'source-unavailable';
interface SourceMemory { original: Data; outputs: Set<string>; time: number; order: number; at: number; result?: Data; manualPriority?: boolean }
interface RecordEntry {
  id: string; text: PreparedNativeChatText; source: SourceMemory; superChat: boolean; state: State;
  authorId?: string; result?: Data; automatic: boolean; manualPriority: boolean;
  showingOriginal?: boolean;
  timeoutRetried?: boolean; automaticUpdate?: boolean;
  request?: { id: string; batchId?: string; previous: State; previousPriority: boolean; timer: ReturnType<typeof setTimeout>; purpose?: 'pinned' | 'timeout'; deadline: number };
}
interface Display { record: RecordEntry; body: HTMLElement; data: Data; signature: string; written?: string }
interface Candidate { id: string; record?: RecordEntry; time: number; order: number }
interface Batch {
  id: string; queue: Candidate[]; queued: Set<RecordEntry>; active: Set<RecordEntry>; force: boolean; total: number;
  done: number; failed: number; skipped: number; stopped: boolean;
}
interface Options {
  doc: Document; resourceId?: string; active(): boolean; eligible(text: string): boolean; timeoutMs(): number; now?(): number;
  send(payload: Data): void;
}
const SELECTOR = 'yt-live-chat-text-message-renderer,yt-live-chat-paid-message-renderer,yt-live-chat-ticker-paid-message-item-renderer';
const PINNED = 'yt-live-chat-banner-renderer';
const labels: Record<DisplayState, string> = { unprocessed: '未处理', queued: '排队中', translating: '翻译中', translated: '已译', failed: '失败', expired: '超时', unneeded: '无需翻译', suspected: '疑似未翻译', 'not-displayed': '译文未显示', 'source-unavailable': '缺少可靠原文' };
// Native data can contain our translations after hooks detach. Preserve originals per document/room.
const originals = new WeakMap<Document, { resourceId: string; sources: Map<string, SourceMemory>; removed: Set<string> }>();
let captureOrder = 0;
type RepairIcon = 'retry' | 'original' | 'translation';
const SVG_NS = 'http://www.w3.org/2000/svg';
const iconPaths: Record<RepairIcon, readonly string[]> = {
  retry: ['M20 11a8 8 0 0 0-14.7-4.4L3 9', 'M3 4.5V9h4.5', 'M4 13a8 8 0 0 0 14.7 4.4L21 15', 'M21 19.5V15h-4.5'],
  original: ['M6 3.5h8l4 4v13H6z', 'M14 3.5v4h4', 'M9 12h6M9 15.5h6M9 19h4'],
  translation: ['M5 5h14M5 12h9M5 19h14', 'm16 9 3 3-3 3'],
};
function createIcon(doc: Document, name: RepairIcon): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.dataset.danlingoIcon = name;
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.style.cssText = 'display:block;width:max(12px,.95em);height:max(12px,.95em);pointer-events:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round';
  for (const d of iconPaths[name]) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
function iconButton(doc: Document, icon: RepairIcon, label: string, title: string): HTMLButtonElement {
  const button = doc.createElement('button'); button.type = 'button'; button.append(createIcon(doc, icon));
  button.setAttribute('aria-label', label); button.title = title; return button;
}
function updateIconButton(button: HTMLButtonElement, icon: RepairIcon, label: string, title: string) {
  const current = button.querySelector<SVGSVGElement>(':scope > svg[data-danlingo-icon]');
  if (!current || current.dataset.danlingoIcon !== icon) button.replaceChildren(createIcon(button.ownerDocument, icon));
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  if (button.title !== title) button.title = title;
}
function dataOf(row: Element): Data | null { const value = row as unknown as Data; return value.polymerController?.data || value.inst?.data || value.data || null; }
function messageData(row: Element): Data | null {
  const data = dataOf(row);
  return data?.showItemEndpoint?.showLiveChatItemEndpoint?.renderer?.liveChatPaidMessageRenderer
    || data?.showItemEndpoint?.showLiveChatItemEndpoint?.item?.liveChatPaidMessageRenderer
    || data?.liveChatPaidMessageRenderer || data;
}
function visible(row: Element) {
  if (!row.isConnected || !row.getClientRects().length) return false;
  const view = row.ownerDocument.defaultView, rect = row.getBoundingClientRect();
  let top = Math.max(0, rect.top), bottom = Math.min(view?.innerHeight || 0, rect.bottom);
  for (let node: Element | null = row; node; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (node.hasAttribute('hidden') || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') return false;
    if (node !== row && /auto|scroll|hidden|clip/.test(style?.overflowY || '')) {
      const clip = node.getBoundingClientRect(); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    }
  }
  return bottom > top;
}

/** Message results and each actual DOM presentation are deliberately separate. */
export class YoutubeChatRepairs {
  private records = new Map<string, RecordEntry>();
  private displays = new Map<Element, Display>();
  private sources: Map<string, SourceMemory>;
  private removed = new Set<string>();
  private panel: HTMLElement;
  private recent: HTMLDetailsElement;
  private progress: HTMLElement;
  private stopButton: HTMLButtonElement;
  private batchButtons: HTMLButtonElement[] = [];
  private batch?: Batch;
  private pumping = false;
  private scanning = false;
  private disposed = false;
  private options: Options;
  private now(): number { return this.options.now?.() ?? performance.now(); }
  constructor(options: Options) {
    this.options = options;
    const doc = options.doc, resourceId = options.resourceId || '';
    let memory = originals.get(doc);
    if (!memory || memory.resourceId !== resourceId) { memory = { resourceId, sources: new Map(), removed: new Set() }; originals.set(doc, memory); }
    this.sources = memory.sources; this.removed = memory.removed;
    const theme = doc.defaultView?.getComputedStyle(doc.body);
    this.panel = doc.createElement('div'); this.panel.dataset.danlingoRepairs = '';
    this.panel.style.cssText = 'position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;padding:4px 8px;font:12px sans-serif';
    this.panel.style.background = `var(--yt-live-chat-background-color,${theme?.backgroundColor || 'Canvas'})`;
    this.panel.style.color = `var(--yt-live-chat-primary-text-color,${theme?.color || 'CanvasText'})`;
    const style = doc.createElement('style');
    style.textContent = `
      [data-danlingo-repairs] button,[data-danlingo-repairs] input{font:inherit;color:inherit;background:transparent;border:1px solid #8888;border-radius:3px;padding:2px 4px}
      [data-danlingo-repairs] button{cursor:pointer}[data-danlingo-repairs] button:disabled{cursor:default;opacity:.5}
      [data-danlingo-repairs] :focus-visible{outline:2px solid currentColor;outline-offset:2px}[data-danlingo-repair-status]{flex-basis:100%;font-size:11px}
      [data-danlingo-yt-actions]{display:inline-flex;align-items:center;gap:1px;margin-left:5px;vertical-align:-.18em;white-space:nowrap;line-height:1}
      [data-danlingo-yt-actions]>button{box-sizing:border-box;appearance:none;display:inline-grid;place-items:center;font:inherit;width:max(18px,1.3em);height:max(18px,1.3em);margin:0;padding:0;border:0;border-radius:6px 0 0 6px;color:inherit;background:transparent;line-height:1;cursor:pointer;opacity:.68}
      [data-danlingo-yt-actions]>button+button{border-left:1px solid color-mix(in srgb,currentColor 26%,transparent);border-radius:0 6px 6px 0}
      [data-danlingo-yt-actions]>button:is(:hover,[aria-pressed="true"]):not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
      [data-danlingo-yt-actions]>button:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:1px}
      [data-danlingo-yt-actions]>button:disabled{opacity:.35;cursor:default}
    `;
    const button = (text: string, action: () => void) => { const node = doc.createElement('button'); node.type = 'button'; node.textContent = text; node.addEventListener('click', action); return node; };
    const all = button('补翻全部漏译', () => this.retryAll()); all.title = '补翻页面已加载的漏译，包括置顶；不加载历史';
    const group = doc.createElement('span'); group.style.cssText = 'display:inline-flex;gap:4px;align-items:center';
    const count = doc.createElement('input'); count.type = 'number'; count.min = '1'; count.max = '2000'; count.step = '1'; count.required = true; count.value = '50'; count.style.width = '4.5em'; count.setAttribute('aria-label', '重翻条数');
    const latest = button('重翻最新', () => { if (count.reportValidity()) this.retranslateLatest(Number(count.value)); });
    latest.title = '从原文重翻最新 N 条，绕过缓存，会产生新的翻译请求';
    group.append(latest, count, doc.createTextNode('条'));
    this.batchButtons = [all, latest];
    this.stopButton = button('停止', () => this.stopBatch()); this.stopButton.hidden = true;
    this.progress = doc.createElement('span'); this.progress.dataset.danlingoRepairStatus = ''; this.progress.setAttribute('role', 'status'); this.progress.setAttribute('aria-live', 'polite'); this.progress.hidden = true;
    this.recent = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = '近期漏译'; this.recent.append(summary);
    this.recent.addEventListener('toggle', () => { if (this.recent.open) this.renderRecent(); });
    this.panel.append(style, all, group, this.recent, this.stopButton, this.progress);
    doc.querySelector('yt-live-chat-item-list-renderer')?.before(this.panel);
  }
  capture(renderer: Data, superChat: boolean, state: State = 'unprocessed'): RecordEntry | undefined {
    const id = renderer?.id, message = renderer?.message;
    if (typeof id !== 'string' || !id || id.length > 300 || !message || this.removed.has(id)) return;
    const signature = JSON.stringify(message), old = this.records.get(id);
    if (old && (JSON.stringify(old.source.original) === signature || old.source.outputs.has(signature))) return old;
    if (old) this.cancel(old);
    let source = this.sources.get(id);
    if (!source || JSON.stringify(source.original) !== signature && !source.outputs.has(signature)) {
      const text = prepareNativeChatText(message); if (!text || text.text.length > 1000) return;
      const usec = Number(renderer.timestampUsec), at = Date.now();
      source = { original: structuredClone(message), outputs: new Set(), time: Number.isSafeInteger(usec) && usec > 0 ? usec / 1000 : at, order: ++captureOrder, at };
      this.sources.set(id, source);
    }
    const prepared = prepareNativeChatText(source.original); if (!prepared) return;
    prepared.translatable = prepared.translatable && /\p{L}/u.test(nativeMessageText(source.original));
    const record: RecordEntry = { id, text: prepared, source, superChat, state, automatic: false, manualPriority: source.manualPriority === true, authorId: renderer.authorExternalChannelId };
    if (!prepared.translatable || !this.options.eligible(prepared.text)) record.state = 'unneeded';
    if (source.result) this.rememberResult(record, source.result);
    this.records.set(id, record); return record;
  }
  private prune(loaded: Set<string>) {
    const detached = [...this.sources.entries()].filter(([id]) => !loaded.has(id) && !this.records.get(id)?.request && !this.batch?.queued.has(this.records.get(id)!));
    for (const [index, [id, source]] of detached.entries()) if (index < detached.length - 300 || Date.now() - source.at > 300000) {
      this.records.delete(id); this.sources.delete(id);
    }
    while (this.removed.size > 20000) this.removed.delete(this.removed.values().next().value!);
  }
  private rememberResult(record: RecordEntry, message: Data) {
    record.result = structuredClone(message); record.source.result = record.result; record.source.outputs.add(JSON.stringify(message));
    record.state = unchangedChatTranslation(record.source.original, message, this.options.eligible(record.text.text)) ? 'suspected' : 'translated';
  }
  decision(id: string, message: Data, translated: boolean, reason: string) {
    const record = this.records.get(id); if (!record) return translated;
    const effective = translated && !unchangedChatTranslation(record.source.original, message, this.options.eligible(record.text.text));
    // Remember native outputs for identity validation even when a manual result has won.
    if (translated) record.source.outputs.add(JSON.stringify(message));
    if (record.request || record.manualPriority) return effective;
    if (translated) this.rememberResult(record, message);
    else record.state = record.state === 'unneeded' ? 'unneeded' : reason === 'timeout' ? 'expired' : 'failed';
    return effective;
  }
  scan(auto = true) {
    if (this.disposed || this.scanning || !this.options.active()) return;
    this.scanning = true;
    const loaded = new Set<string>(), automatic = new Map<RecordEntry, boolean>();
    try {
      for (const [row, display] of this.displays) if (!row.isConnected || messageData(row) !== display.data || row.querySelector('#message') !== display.body) this.displays.delete(row);
      for (const row of this.options.doc.querySelectorAll(SELECTOR)) {
        const data = messageData(row), body = row.querySelector<HTMLElement>('#message');
        if (!data?.message || !body || body.closest(SELECTOR) !== row || this.removed.has(data.id)) continue;
        loaded.add(data.id);
        if (!this.sources.has(data.id) && ['translated', 'suspected', 'not-displayed', 'source-unavailable'].includes(row.getAttribute('data-danlingo-state') || '')) {
          this.unavailable(row); continue;
        }
        const superChat = row.localName !== 'yt-live-chat-text-message-renderer';
        const record = this.capture(data, superChat); if (!record) { this.unavailable(row); continue; }
        row.querySelector(':scope > [data-danlingo-unavailable]')?.remove();
        const previous = this.displays.get(row);
        if (!previous || previous.record !== record || previous.body !== body || previous.data !== data) this.displays.set(row, { record, body, data, signature: JSON.stringify(data.message) });
        this.render(row);
        const pinned = !!row.closest(PINNED);
        if ((superChat || pinned) && auto && !record.automatic && ['unprocessed', 'failed', 'expired'].includes(record.state) && !this.batchOwns(record)) automatic.set(record, pinned && !superChat);
      }
      this.prune(loaded);
    } finally { this.scanning = false; }
    for (const [record, pinned] of automatic) { record.automatic = true; this.request(record, false, false, undefined, pinned); }
    this.pumpBatch();
  }
  private valid(row: Element, display: Display): boolean {
    const { record, body, data } = display, signature = JSON.stringify(data.message);
    return this.records.get(record.id) === record && !this.removed.has(record.id) && messageData(row) === data && data.id === record.id && body.isConnected && row.querySelector('#message') === body &&
      (signature === display.signature || signature === JSON.stringify(record.source.original) || record.source.outputs.has(signature));
  }
  private unavailable(row: Element) {
    row.setAttribute('data-danlingo-state', 'source-unavailable');
    row.querySelector('[data-danlingo-yt-actions]')?.remove(); this.displays.delete(row);
    if (row.querySelector(':scope > [data-danlingo-unavailable]')) return;
    const label = this.options.doc.createElement('span'); label.dataset.danlingoUnavailable = '';
    label.textContent = '缺少原文，已跳过'; label.style.cssText = 'font:11px sans-serif;margin:0 4px';
    label.title = '无法取得可靠原文，不会把当前译文作为原文再次翻译'; row.append(label);
  }
  private render(row: Element): DisplayState | undefined {
    const display = this.displays.get(row); if (!display || !this.valid(row, display)) return;
    const { record, body } = display; let state: DisplayState = record.state;
    if (record.showingOriginal || record.result && record.state === 'translated') {
      const message = record.showingOriginal ? record.source.original : record.result!;
      const expected = comparableChatText(nativeMessageText(message));
      if (comparableChatText(body.textContent || '') !== expected && this.writeMessage(body, message)) display.written = body.textContent || '';
      if (comparableChatText(body.textContent || '') !== expected) state = 'not-displayed';
    }
    if (this.batch?.queued.has(record)) state = 'queued';
    if (row.getAttribute('data-danlingo-state') !== state) row.setAttribute('data-danlingo-state', state);
    let actions = row.querySelector<HTMLSpanElement>('[data-danlingo-yt-actions]');
    if (!actions) {
      actions=this.options.doc.createElement('span');actions.dataset.danlingoYtActions='';actions.setAttribute('role','group');actions.setAttribute('aria-label','翻译操作');
      if(this.options.doc.defaultView?.getComputedStyle(body).verticalAlign==='middle')actions.style.verticalAlign='middle';
    }
    let button = actions.querySelector<HTMLButtonElement>('[data-danlingo-retry]');
    let original = actions.querySelector<HTMLButtonElement>('[data-danlingo-original]');
    if (!button) {
      button = iconButton(this.options.doc, 'retry', '强制重译', '强制重译：从保存的原文重新翻译，绕过成功缓存'); button.dataset.danlingoRetry = '';
      button.addEventListener('click', event => {
        event.stopPropagation(); const current = this.displays.get(row);
        if (!current || !this.valid(row, current) || this.batchOwns(current.record)) return;
        this.render(row);
        current.record.showingOriginal = false;
        this.request(current.record, true, true);
      }); actions.append(button);
    }
    if (!original) {
      original = iconButton(this.options.doc, 'original', '显示原文', '显示保存的原文，不发起翻译请求'); original.dataset.danlingoOriginal = '';
      original.addEventListener('click', event => {
        event.stopPropagation(); const current = this.displays.get(row);
        if (!current || !this.valid(row, current)) return;
        this.setOriginal(current.record, !current.record.showingOriginal);
      }); actions.append(original);
    }
    if (actions.previousSibling !== body) body.after(actions);
    const label = '强制重译';
    const title = state === 'translated' ? '强制重译：从保存的原文重新翻译，绕过成功缓存' : `${labels[state]}；强制重译从保存的原文发起并绕过缓存`;
    updateIconButton(button, 'retry', label, title);
    const disabled = !!record.request || this.batchOwns(record);
    if (button.disabled !== disabled) button.disabled = disabled;
    if (button.hidden) button.hidden = false;
    const originalLabel = record.showingOriginal ? '显示译文' : '显示原文';
    const originalTitle = record.showingOriginal ? '显示已保存的译文，不发起翻译请求' : '显示保存的原文，不发起翻译请求';
    updateIconButton(original, record.showingOriginal ? 'translation' : 'original', originalLabel, originalTitle);
    original.setAttribute('aria-pressed',String(!!record.showingOriginal));
    original.disabled = !!record.showingOriginal && !record.result;
    if (original.hidden) original.hidden = false;
    return state;
  }
  private writeBody(body: HTMLElement, message: Data): boolean {
    const doc = this.options.doc, nodes: Node[] = [], used = new Set<Node>();
    if (typeof message.simpleText === 'string') {
      if (body.querySelector('a,img,button')) return false;
      nodes.push(doc.createTextNode(message.simpleText));
    } else if (Array.isArray(message.runs)) {
      for (const run of message.runs) {
        if (typeof run.text === 'string' && Object.keys(run).length === 1) { nodes.push(doc.createTextNode(run.text)); continue; }
        const candidates = [...body.querySelectorAll(run.emoji ? 'img' : 'a,b,strong,em,i,span')];
        const identifiers = run.emoji ? [run.emoji.emojiId, ...(run.emoji.shortcuts || []), run.emoji.accessibility?.accessibilityData?.label, run.emoji.image?.accessibility?.accessibilityData?.label].filter(Boolean) : [];
        const element = candidates.find(node => !used.has(node) && (run.emoji ? identifiers.some(value => node.getAttribute('alt') === value || node.getAttribute('aria-label') === value) : node.textContent === run.text));
        if (!element) return false; used.add(element); nodes.push(element);
      }
    } else return false;
    if ([...body.querySelectorAll('a,img,button')].some(node => ![...used].some(kept => kept === node || kept.contains(node)))) return false;
    body.replaceChildren(...nodes); return true;
  }
  private writeMessage(body: HTMLElement, message: Data): boolean {
    if (this.writeBody(body, message)) return true;
    const text = nativeMessageText(message);
    if (!text || body.querySelector('a,img,button')) return false;
    body.textContent = text; return true;
  }
  private setOriginal(record: RecordEntry, showing: boolean) {
    record.showingOriginal = showing;
    for (const [row, display] of this.displays) if (display.record === record && this.valid(row, display)) this.render(row);
    if (this.recent.open) this.renderRecent();
  }
  private request(record: RecordEntry, manual: boolean, force: boolean, batchId?: string, pinned = false): boolean {
    if (this.disposed || !this.options.active() || this.records.get(record.id) !== record || !record.text.translatable || this.removed.has(record.id)) return false;
    if (!manual && record.state === 'unneeded') return false;
    if (manual) record.showingOriginal = false;
    if (manual && record.result && unchangedChatTranslation(record.source.original, record.result, this.options.eligible(record.text.text))) force = true;
    if (record.request) {
      if (!manual || record.request.purpose !== 'timeout') return false;
      this.cancel(record);
    }
    const id = crypto.randomUUID(), previous = record.state, previousPriority = record.manualPriority;
    if (manual) { record.manualPriority = true; record.source.manualPriority = true; }
    const timeoutMs = record.superChat ? this.options.timeoutMs() : 15000;
    const timer = setTimeout(() => {
      this.options.send({ type: 'repair-cancel', requestId: id, sourceId: record.id, ...(batchId ? { batchId } : {}) });
      this.result({ requestId: id, sourceId: record.id, batchId, status: 'expired' });
    }, timeoutMs + 250);
    record.request = { id, previous, previousPriority, timer, batchId, deadline: this.now() + timeoutMs, ...(pinned ? { purpose: 'pinned' as const } : {}) }; record.state = 'translating';
    this.options.send({ type: 'repair-request', requestId: id, sourceId: record.id, originalText: record.text.text,
      strategy: record.superChat ? 'superchat' : 'manual', manual, force, timeoutMs, ...(batchId ? { batchId } : {}), ...(pinned ? { purpose: 'pinned' } : {}) });
    this.scan(false); if (this.recent.open) this.renderRecent(); return true;
  }
  requestTimeout(id: string, originalText: string, retryDeadline: number): boolean {
    const record = this.records.get(id);
    if (!record || record.superChat || record.request || record.timeoutRetried || record.manualPriority || record.result ||
        record.text.text !== originalText || !record.text.translatable || !this.options.active() || !Number.isFinite(retryDeadline) || retryDeadline <= this.now()) return false;
    const timeoutMs = Math.max(1, Math.ceil(retryDeadline - this.now()));
    const requestId = crypto.randomUUID(), previous = record.state, previousPriority = record.manualPriority;
    const timer = setTimeout(() => {
      this.options.send({ type: 'repair-cancel', requestId, sourceId: record.id });
      this.result({ requestId, sourceId: record.id, purpose: 'timeout', status: 'expired' });
    }, timeoutMs + 250);
    record.request = { id: requestId, previous, previousPriority, timer, deadline: retryDeadline, purpose: 'timeout' };
    record.timeoutRetried = true; record.state = 'translating';
    this.options.send({ type: 'repair-request', requestId, sourceId: record.id, originalText: record.text.text,
      strategy: 'manual', manual: false, force: false, timeoutMs, purpose: 'timeout', retryDeadlineAt: retryDeadline });
    this.scan(false); if (this.recent.open) this.renderRecent(); return true;
  }
  timeoutRequest(id: string, requestId: string): string | undefined {
    const record = this.records.get(id);
    return record?.request?.purpose === 'timeout' && record.request.id === requestId ? record.text.text : undefined;
  }
  cancelTimeout(id: string) {
    const record = this.records.get(id);
    if (record?.request?.purpose !== 'timeout') return;
    this.cancel(record); record.state = 'expired'; this.scan(false); if (this.recent.open) this.renderRecent();
  }
  result(value: Data) {
    const record = this.records.get(value.sourceId), request = record?.request;
    if (this.disposed || !record || !request || request.id !== value.requestId || request.batchId !== value.batchId) return;
    clearTimeout(request.timer); record.request = undefined;
    const result = ['translated', 'cached'].includes(value.status) && typeof value.text === 'string' ? record.text.restore(value.text) : null;
    if (result) { this.rememberResult(record, result); if (request.purpose === 'timeout') record.automaticUpdate = true; }
    else record.state = value.status === 'expired' ? 'expired' : value.status === 'original' && value.reason === 'not-needed' ? 'unneeded' : 'failed';
    this.scan(false);
    const batch = this.batch;
    if (batch && batch.id === request.batchId && batch.active.delete(record)) {
      const states = [...this.displays].filter(([row, display]) => display.record === record && this.valid(row, display)).map(([row]) => this.render(row));
      if (!states.length || record.state === 'unneeded') batch.skipped++;
      else if (record.state === 'translated' && states.every(state => state === 'translated')) batch.done++;
      else batch.failed++;
    }
    this.pumpBatch(); if (this.recent.open) this.renderRecent();
  }
  private cancel(record: RecordEntry) {
    const request = record.request; if (!request) return;
    clearTimeout(request.timer); record.request = undefined; record.state = request.previous;
    record.manualPriority = request.previousPriority; record.source.manualPriority = request.previousPriority;
    this.options.send({ type: 'repair-cancel', requestId: request.id, sourceId: record.id, ...(request.batchId ? { batchId: request.batchId } : {}) });
    if (this.batch && this.batch.id === request.batchId && this.batch.active.delete(record)) this.batch.skipped++;
  }
  private loaded(): Candidate[] {
    const rows = new Map<string, Candidate>();
    for (const row of this.options.doc.querySelectorAll(SELECTOR)) {
      const data = messageData(row), display = this.displays.get(row);
      if (!data?.message || !row.querySelector('#message') || typeof data.id !== 'string' || this.removed.has(data.id)) continue;
      const record = display && this.valid(row, display) ? display.record : undefined;
      rows.set(data.id, { id: data.id, record, time: record?.source.time || Number(data.timestampUsec) / 1000 || 0, order: record?.source.order || 0 });
    } return [...rows.values()];
  }
  private missing(record: RecordEntry): boolean {
    if (record.state === 'unneeded' || record.request) return false;
    return record.state !== 'translated' || [...this.displays].some(([row, display]) => display.record === record && this.valid(row, display) && this.render(row) === 'not-displayed');
  }
  private batchOwns(record: RecordEntry): boolean { return !!this.batch && (this.batch.active.has(record) || this.batch.queued.has(record)); }
  retryAll() { if (this.batch) return; this.scan(false); this.startBatch(this.loaded().filter(item => !item.record || this.missing(item.record)), false); }
  retranslateLatest(count: number) { if (this.batch || !Number.isInteger(count) || count < 1 || count > 2000) return; this.scan(false); this.startBatch(latestChatRecords(this.loaded(), count), true); }
  /** Keep the old programmatic visible entry for existing integrations. */
  retryVisible() {
    if (this.batch) return; this.scan(false);
    const ids = new Set([...this.displays].filter(([row]) => visible(row)).map(([, d]) => d.record.id));
    this.startBatch(this.loaded().filter(item => ids.has(item.id) && (!item.record || item.record.state !== 'translated')), false);
  }
  private startBatch(queue: Candidate[], force: boolean) {
    if (this.disposed || !this.options.active() || this.batch) return;
    this.batch = { id: crypto.randomUUID(), queue, queued: new Set(queue.flatMap(item => item.record ? [item.record] : [])), active: new Set(), force, total: queue.length, done: 0, failed: 0, skipped: 0, stopped: false };
    this.pumpBatch(); this.scan(false);
  }
  private pumpBatch() {
    const batch = this.batch; if (!batch || this.pumping) return;
    this.pumping = true;
    try {
      while (!batch.stopped && this.options.active() && batch.active.size < 2 && batch.queue.length) {
        const item = batch.queue.shift()!, record = item.record;
        if (record) batch.queued.delete(record);
        if (!record || this.records.get(item.id) !== record || !record.text.translatable || ![...this.displays].some(([row, d]) => d.record === record && this.valid(row, d))) { batch.skipped++; continue; }
        if (record.request) { if (batch.force) this.cancel(record); else { batch.skipped++; continue; } }
        if (!batch.force && record.state === 'unneeded') { batch.skipped++; continue; }
        if (!batch.force && record.result && record.state === 'translated') {
          const states = [...this.displays].filter(([row, d]) => d.record === record && this.valid(row, d)).map(([row]) => this.render(row));
          if (states.every(state => state === 'translated')) batch.done++; else batch.failed++; continue;
        }
        batch.active.add(record);
        if (!this.request(record, true, batch.force || record.state === 'suspected', batch.id)) { batch.active.delete(record); batch.skipped++; }
      }
      this.updateProgress(batch);
      if (!batch.queue.length && !batch.active.size) this.batch = undefined;
    } finally { this.pumping = false; }
  }
  private updateProgress(batch: Batch) {
    const active = !!(batch.queue.length || batch.active.size) && !batch.stopped;
    this.progress.hidden = false;
    this.progress.textContent = `${batch.stopped ? '已停止' : active ? '处理中' : '已结束'} ${batch.done + batch.failed + batch.skipped}/${batch.total} · 完成 ${batch.done} · 失败 ${batch.failed} · 跳过 ${batch.skipped}`;
    this.stopButton.hidden = !active; for (const button of this.batchButtons) button.disabled = active;
  }
  stopBatch() {
    const batch = this.batch; if (!batch) return;
    batch.stopped = true; batch.skipped += batch.queue.length; batch.queue = []; batch.queued.clear();
    for (const record of [...batch.active]) this.cancel(record);
    this.updateProgress(batch); this.batch = undefined; this.scan(false);
  }
  private renderRecent() {
    for (const node of [...this.recent.children].slice(1)) node.remove();
    const list = this.options.doc.createElement('div');
    list.style.cssText = 'position:absolute;right:4px;max-width:320px;max-height:260px;overflow:auto;padding:8px;border:1px solid #888'; list.style.background = this.panel.style.background;
    for (const record of [...this.records.values()].sort((a, b) => b.source.order - a.source.order).slice(0, 30)) {
      const row = this.options.doc.createElement('div'); row.style.marginBottom = '6px';
      const text = this.options.doc.createElement('span');
      const state: DisplayState = record.state === 'translated' && [...this.displays].some(([element, d]) => d.record === record && this.valid(element, d) && this.render(element) === 'not-displayed') ? 'not-displayed' : record.state;
      text.textContent = `${labels[state]} · ${nativeMessageText(record.showingOriginal ? record.source.original : record.result || record.source.original).slice(0, 80)} `;
      const retry = iconButton(this.options.doc, 'retry', '强制重译', '强制重译：从保存的原文重新翻译，绕过成功缓存'); retry.dataset.danlingoRetry = '';
      retry.disabled = !!record.request || this.batchOwns(record) || !record.text.translatable;
      retry.addEventListener('click', () => { record.showingOriginal = false; this.request(record, true, true); });
      const original = iconButton(this.options.doc, record.showingOriginal ? 'translation' : 'original', record.showingOriginal ? '显示译文' : '显示原文', record.showingOriginal ? '显示已保存的译文，不发起翻译请求' : '显示保存的原文，不发起翻译请求'); original.dataset.danlingoOriginal = '';
      original.disabled = !!record.showingOriginal && !record.result;
      original.setAttribute('aria-pressed',String(!!record.showingOriginal));
      original.addEventListener('click', () => this.setOriginal(record, !record.showingOriginal));
      const actions=this.options.doc.createElement('span');actions.dataset.danlingoYtActions='';actions.setAttribute('role','group');actions.setAttribute('aria-label','翻译操作');actions.append(retry,original);
      row.append(text, actions); list.append(row);
    }
    if (!list.children.length) list.textContent = '暂无已捕获消息。未捕获且已消失的历史无法恢复。'; this.recent.append(list);
  }
  remove(ids: string[]) {
    for (const id of ids) {
      const record = this.records.get(id); if (record) this.cancel(record);
      this.records.delete(id); this.sources.delete(id); this.removed.add(id);
      for (const [row, display] of this.displays) if (display.record.id === id) { this.displays.delete(row); row.removeAttribute('data-danlingo-state'); row.querySelector('[data-danlingo-yt-actions]')?.remove(); }
    }
  }
  removeAuthor(author: string) { this.remove([...this.records.values()].filter(record => record.authorId === author).map(record => record.id)); }
  replace(item: Data) {
    const renderer = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer;
    if (!renderer || typeof renderer.id !== 'string') return;
    this.removed.delete(renderer.id); this.capture(renderer, !!item.liveChatPaidMessageRenderer);
  }
  clear() { this.stopBatch(); this.remove([...this.records.keys()]); }
  dispose() {
    this.disposed = true; this.stopBatch();
    for (const record of this.records.values()) this.cancel(record);
    for (const [row, display] of this.displays) {
      if (display.written !== undefined && this.valid(row, display) && display.body.textContent === display.written) this.writeBody(display.body, display.record.source.original);
      row.removeAttribute('data-danlingo-state');
    }
    this.prune(new Set(this.loaded().map(row => row.id))); this.records.clear(); this.displays.clear(); this.panel.remove();
    for (const node of this.options.doc.querySelectorAll('[data-danlingo-yt-actions],[data-danlingo-unavailable]')) node.remove();
  }
}
