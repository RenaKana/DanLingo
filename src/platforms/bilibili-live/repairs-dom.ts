import { decimalId, ordinaryMessageId } from './messages.ts';
import { BilibiliRepairs, type RepairRecord } from './repairs.ts';
import { readNativeBody } from './body.ts';

type Data = Record<string, any>;
interface Display { row: Element; body: HTMLElement; record: RepairRecord; actions: HTMLSpanElement; button: HTMLButtonElement; originalButton: HTMLButtonElement; showingOriginal: boolean; written?: string; nodes?: { node: Text; text: string | null }[] }
type RepairIcon = 'retry' | 'original' | 'translation';
const SVG_NS = 'http://www.w3.org/2000/svg';
const iconPaths: Record<RepairIcon, string> = {
  retry: '<path d="M20 11a8 8 0 0 0-14.7-4.4L3 9"/><path d="M3 4.5V9h4.5"/><path d="M4 13a8 8 0 0 0 14.7 4.4L21 15"/><path d="M21 19.5V15h-4.5"/>',
  original: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6M9 19h4"/>',
  translation: '<path d="M5 5h14M5 12h9M5 19h14"/><path d="m16 9 3 3-3 3"/>',
};
function createIcon(ownerDocument: Document, name: RepairIcon): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, 'svg');
  svg.dataset.danlingoIcon = name;
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.style.cssText = 'display:block;width:max(12px,.95em);height:max(12px,.95em);pointer-events:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round';
  svg.innerHTML = iconPaths[name]; return svg;
}
function iconButton(ownerDocument: Document, icon: RepairIcon, label: string, title: string): HTMLButtonElement {
  const button = ownerDocument.createElement('button'); button.type = 'button'; button.append(createIcon(ownerDocument, icon));
  button.setAttribute('aria-label', label); button.title = title; return button;
}
function updateIconButton(button: HTMLButtonElement, icon: RepairIcon, label: string, title: string) {
  const current = button.querySelector<SVGSVGElement>(':scope > svg[data-danlingo-icon]');
  if (!current || current.dataset.danlingoIcon !== icon) button.replaceChildren(createIcon(button.ownerDocument, icon));
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  if (button.title !== title) button.title = title;
}
export function visible(element: Element): boolean {
  let current: Element | null = element;
  for (;;) {
    const ownerDocument: Document = current.ownerDocument;
    const view = ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (!view) return false;
    for (let node: Element | null = current; node; node = node.parentElement) {
      if (!node.isConnected || !node.getClientRects().length) return false;
      let style: CSSStyleDeclaration;
      try { style = view.getComputedStyle(node); } catch { return false; }
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || node.hasAttribute('hidden')) return false;
    }
    let frame: Element | null;
    try {
      if (view.parent === view) return true;
      // A cross-origin child cannot expose its frameElement. Treat that as
      // inaccessible instead of claiming that its native row is visible.
      frame = view.frameElement;
    } catch { return false; }
    if (!frame) return false;
    current = frame;
  }
}
function vueMessage(row: Element, field: string): Data | null {
  for (let node: Element | null = row, depth=0; node && depth<5; node=node.parentElement,depth++) {
    try {
      const vm=(node as unknown as Data).__vue__, message=vm?.[field] ?? vm?.$props?.[field];
      if (decimalId(message?.id) && typeof message.message==='string') return message;
    } catch { /* Unrecognized or destroyed Vue owners stay untouched. */ }
  }
  return null;
}
/** Native IDs bind cards; ID-less history uses a single DOM occurrence and its
 * native data-danmaku original, never matching different rows by message text. */
export class BilibiliRepairDom {
  private displays=new Map<Element,Display>();
  private history = new WeakMap<Element, { signature: string; sourceId: string }>();
  private automatic = new Set<string>();
  private readonly options: { ledger: BilibiliRepairs; active(): boolean };
  private readonly document: Document;
  private readonly style: HTMLStyleElement;
  constructor(options: { ledger: BilibiliRepairs; active(): boolean; document?: Document }) {
    this.options=options; this.document=options.document ?? globalThis.document;
    this.style=this.document.createElement('style');
    this.style.textContent=`
      [data-danlingo-bili-actions]{display:inline-flex;align-items:center;gap:1px;margin-left:5px;vertical-align:-.18em;white-space:nowrap;line-height:1}
      [data-danlingo-bili-actions]>button{box-sizing:border-box;appearance:none;display:inline-grid;place-items:center;font:inherit;width:max(18px,1.3em);height:max(18px,1.3em);margin:0;padding:0;border:0;border-radius:6px 0 0 6px;color:inherit;background:transparent;line-height:1;cursor:pointer;opacity:.68}
      [data-danlingo-bili-actions]>button+button{border-left:1px solid color-mix(in srgb,currentColor 26%,transparent);border-radius:0 6px 6px 0}
      [data-danlingo-bili-actions]>button:is(:hover,[aria-pressed="true"]):not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
      [data-danlingo-bili-actions]>button:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:1px}
      [data-danlingo-bili-actions]>button:disabled{opacity:.35;cursor:default}
    `;
    (this.document.head ?? this.document.documentElement).append(this.style);
  }
  private candidates(): { row:Element; body:HTMLElement; record:RepairRecord }[] {
    const result: { row:Element; body:HTMLElement; record:RepairRecord }[]=[];
    for(const row of this.document.querySelectorAll('#chat-items .chat-item.danmaku-item[data-id_str]')) {
      const id=ordinaryMessageId(row.getAttribute('data-id_str')),record=id?this.options.ledger.get(`dm:${id}`):undefined;
      const body=row.querySelector<HTMLElement>('.danmaku-item-right');
      if(record&&body)result.push({row,body,record});
    }
    for(const [selector,bodySelector,field] of [
      ['.super-chat-bubble-main','.content-message','currentSuperChat'],
      ['.detail-info .card-detail','.card-item-middle-bottom .input-contain > .text','currentCardData'],
    ]) for(const row of this.document.querySelectorAll(selector!)) {
      const message=vueMessage(row,field!),id=decimalId(message?.id);
      const body=row.querySelector<HTMLElement>(bodySelector!);
      let record=id?this.options.ledger.get(`sc:${id}`):undefined;
      if (!record && id && body && message && readNativeBody(body,message.message)?.text === message.message) {
        const end = typeof message.endTime === 'number' ? message.endTime * 1000 : undefined;
        record=this.options.ledger.capture({sourceId:`sc:${id}`,nativeId:id,originalText:message.message},
          { ...(end !== undefined && Number.isFinite(end) ? {expiresAt:end} : {}) });
      }
      if(record&&body&&message?.message===record.originalText)result.push({row,body,record});
    }
    // Reviewed native history rows have no SC id or Vue owner. data-danmaku is
    // assigned from the wire original before .input-contain > .text is rendered.
    for (const row of this.document.querySelectorAll('#chat-items .chat-item.danmaku-item.superChat-card-detail[data-danmaku]')) {
      const original = row.getAttribute('data-danmaku') || '', body = row.querySelector<HTMLElement>('.card-item-middle-bottom .input-contain > .text');
      if (!body || !original.trim() || original.length > 1000) continue;
      const signature = JSON.stringify([original,row.getAttribute('data-ts'),row.getAttribute('data-uid')]);
      let identity = this.history.get(row);
      if (identity && identity.signature !== signature) {
        // The site reused this node. Do not restore an old body's text into it.
        const old = this.displays.get(row); old?.actions.remove(); this.displays.delete(row);
        this.options.ledger.remove([identity.sourceId]); this.history.delete(row); identity=undefined;
      }
      if (!identity) {
        if (readNativeBody(body,original)?.text !== original) continue;
        identity={signature,sourceId:`sc-dom:${crypto.randomUUID()}`}; this.history.set(row,identity);
      }
      const record=this.options.ledger.get(identity.sourceId) ?? this.options.ledger.capture({sourceId:identity.sourceId,originalText:original},{});
      if (record) result.push({row,body,record});
    }
    return result;
  }
  private restore(display: Display) {
    if(display.nodes && display.written!==undefined && display.nodes.every(n=>display.body.contains(n.node)) &&
        readNativeBody(display.body,display.record.originalText,display.record.inlineEmotes)?.text===display.written)
      for(const n of display.nodes) { if(n.text===null)n.node.remove();else n.node.data=n.text; }
    display.actions.remove();
  }
  private write(display: Display, text: string): boolean {
    const native = readNativeBody(display.body, display.record.originalText, display.record.inlineEmotes);
    if (!native) return false;
    if (native.text === text) { display.written = text; return true; }
    if (!display.nodes || display.nodes.length !== native.nodes.length || !display.nodes.every(n => native.nodes.includes(n.node))) display.nodes = native.nodes.map(node => ({ node, text: node.data }));
    const added = native.write(text);
    if (!added) return false;
    display.nodes.push(...added.map(node => ({ node, text: null }))); display.written = text; return true;
  }
  private updateControls(display: Display) {
    const record=display.record, disabled=!!record.request||!this.options.active(), label=record.request?'翻译中':'强制重译';
    display.button.disabled=disabled;
    const title=record.request?'翻译进行中':'强制重译：从保存的原文重新翻译，绕过成功缓存';
    updateIconButton(display.button,'retry',label,title);
    const originalLabel=display.showingOriginal?'显示译文':'显示原文';
    updateIconButton(display.originalButton,display.showingOriginal?'translation':'original',originalLabel,display.showingOriginal?'显示已保存的译文，不发起翻译请求':'显示保存的原文，不发起翻译请求');
    display.originalButton.setAttribute('aria-pressed',String(display.showingOriginal));
    display.originalButton.disabled=display.showingOriginal&&!record.text;
  }
  scan(skipAutomatic = false) {
    this.options.ledger.prune();
    const found=new Set<Element>();
    for(const candidate of this.candidates()) {
      const {row,body,record}=candidate, native=readNativeBody(body,record.originalText,record.inlineEmotes); if(!native)continue;
      const text=native.text;
      let display=this.displays.get(row);
      if(display && (display.record!==record || display.body!==body)) { this.restore(display); this.displays.delete(row); display=undefined; }
      if(text!==record.originalText && text!==record.text && text!==record.displayedText && text!==record.submittedText && text!==display?.written)continue;
      found.add(row);
      this.options.ledger.seen(record.sourceId);
      if(!display) {
        const button=iconButton(this.document,'retry','强制重译','强制重译：从保存的原文重新翻译，绕过成功缓存'); button.setAttribute('data-danlingo-bili-retry','');
        const originalButton=iconButton(this.document,'original','显示原文','显示保存的原文，不发起翻译请求'); originalButton.setAttribute('data-danlingo-bili-original','');
        const actions=this.document.createElement('span');actions.setAttribute('data-danlingo-bili-actions','');actions.setAttribute('role','group');actions.setAttribute('aria-label','翻译操作');actions.append(button,originalButton);
        // Native ordinary bodies use middle alignment; baseline text keeps the approved optical offset.
        if(this.document.defaultView?.getComputedStyle(body).verticalAlign==='middle')actions.style.verticalAlign='middle';
        // Remember the first native automatic translation as the per-display baseline.
        display={...candidate,actions,button,originalButton,showingOriginal:false,written:text}; this.displays.set(row,display); body.after(actions);
        button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();
          const current=this.displays.get(row); if(!current || current.record!==this.options.ledger.get(record.sourceId))return;
          current.showingOriginal=false; this.options.ledger.request(record.sourceId,true,true); this.scan();});
        originalButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();
          const current=this.displays.get(row); if(!current || current.record!==this.options.ledger.get(record.sourceId))return;
          if(current.showingOriginal){if(!record.text)return;current.showingOriginal=false;this.write(current,record.text);}
          else if(this.write(current,record.originalText))current.showingOriginal=true;
          this.updateControls(current);});
      }
      if (display.actions.previousSibling !== body) body.after(display.actions);
      this.updateControls(display);
      // First-round late results never rewrite a displayed row. Only an explicitly
      // enabled second attempt (or a manual repair) may update an ordinary chat body.
      if(record.text && !display.showingOriginal && (record.strategy==='superchat'||record.manualPriority||record.automaticUpdate) && text!==record.text && this.options.active()) this.write(display,record.text);
      if (visible(row)) {
        const current=readNativeBody(body,record.originalText,record.inlineEmotes);if(current)this.options.ledger.confirm(record.sourceId,current.text);
      }
    }
    for(const [row,display] of this.displays) if(!found.has(row)) {
      this.restore(display);this.displays.delete(row);
      const identity=this.history.get(row);
      if(identity){this.options.ledger.remove([identity.sourceId]);this.history.delete(row);}
    }
    const updated = new Set([...this.displays.values()].filter(d=>d.record.text && readNativeBody(d.body,d.record.originalText,d.record.inlineEmotes)?.text===d.record.text).map(d=>d.record.sourceId));
    for (const record of this.options.ledger.records.values()) if (record.text) this.options.ledger.applied(record.sourceId, record.resultVersion, updated.has(record.sourceId));
    if (!skipAutomatic && this.options.active()) for (const {record} of this.displays.values()) if (record.strategy==='superchat' && !this.automatic.has(record.sourceId)) {
      this.automatic.add(record.sourceId);
      if (!record.request && record.state==='unprocessed') this.options.ledger.request(record.sourceId,false);
    }
    for (const id of this.automatic) if (!this.options.ledger.records.has(id)) this.automatic.delete(id);
  }
  loadedIds(): Set<string> { return new Set([...this.displays.values()].map(d=>d.record.sourceId)); }
  visibleIds(): Set<string> { return new Set([...this.displays.values()].filter(d=>visible(d.row)).map(d=>d.record.sourceId)); }
  dispose() { for(const display of this.displays.values())this.restore(display);this.displays.clear();this.automatic.clear();this.style.remove(); }
}
