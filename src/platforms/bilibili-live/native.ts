import { clockStamp, resourceFromUrl } from '../../core/resource.ts';
import { needsTranslation } from '../../core/messages.ts';
import { validLiveBufferMs } from '../../core/live-budget.ts';
import { protectText } from '../../translation/text.ts';
import { ordinaryComment, ordinaryMessageId, decimalId, superChatSource, deletedSuperChats } from './messages.ts';
import { BilibiliNativeQueue, type BilibiliDecision } from './queue.ts';
import { BilibiliRepairs } from './repairs.ts';
import { BilibiliRepairDom, visible } from './repairs-dom.ts';
import { readNativeBody } from './body.ts';
import { hookMethod, optionalObserver } from './hook.ts';
import { captureNativeDispatch } from './dispatch.ts';
import { timeoutRetryBudget, MAX_TIMEOUT_RETRY_EXTRA_MS } from '../../core/timeout-retry.ts';
import { bilibiliLiveView, sameBilibiliView, type BilibiliLiveView } from './view.ts';
import { bilibiliRoomIdentity } from './identity.ts';

type Data = Record<string, any>;
type Hook = NonNullable<ReturnType<typeof hookMethod>>;
interface Identity { roomId: string; resourceId: string; urlResourceId: string; live: boolean }
interface Binding extends Identity {
  engine?: Data; core?: Data; layer?: Element; root: Element; session: string; queue: BilibiliNativeQueue; repairs: BilibiliRepairs; dom: BilibiliRepairDom;
  awaiting: Map<string, { decision: BilibiliDecision; expires: number }>;
  repairApplied: Map<string, number>;
}
const BRIDGE = 'danlingo-live-v1';
const CORE_VERSION = '1.1.20', CORE_COMPILED = '2026-02-09T19:30:27+08:00';

/** No socket/network hook: defer only the reviewed decoded-message dispatch to both native surfaces. */
export function startBilibiliLiveBridge(): () => void {
  if (window.top !== window || location.origin !== 'https://live.bilibili.com') return () => {};
  const page = window as Window & typeof globalThis, owner = page as unknown as Data;
  owner.__danlingoBilibiliLiveStop?.();
  let view: BilibiliLiveView | null = null, stopRoom: (() => void) | undefined, disposed = false, frozen = false;
  const tick = () => {
    if (disposed || frozen) return;
    const next = bilibiliLiveView(page);
    if (sameBilibiliView(view, next)) return;
    stopRoom?.(); stopRoom = undefined; view = next;
    if (next) stopRoom = startRoomBridge(next, () => sameBilibiliView(next, bilibiliLiveView(page)));
  };
  const hide = () => { frozen = true; stopRoom?.(); stopRoom = undefined; view = null; };
  const show = () => { frozen = false; tick(); };
  const timer = setInterval(tick, 250);
  const stop = () => {
    if (disposed) return;
    disposed = true; clearInterval(timer); stopRoom?.();
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
    if (owner.__danlingoBilibiliLiveStop === stop) delete owner.__danlingoBilibiliLiveStop;
  };
  window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
  owner.__danlingoBilibiliLiveStop = stop; tick(); return stop;
}

/** DOM/engine live in the selected room; the message bus and extension authority stay in the top document. */
function startRoomBridge(view: BilibiliLiveView, currentView: () => boolean): () => void {
  const document = view.document, host = view.window as unknown as Data;
  const Element = view.window.Element, HTMLElement = view.window.HTMLElement;
  let disposed = false, frozen = false, enabled = false, lastControl = -Infinity;
  let bufferMs = 2000, superChatTimeoutMs = 15000, targetLanguage = 'zh-Hans', sourceLanguage = 'auto', configVersion = -1;
  let retryEnabled = false, retryExtraMs = 1000, retryHold = true;
  let binding: Binding | null = null, session = crypto.randomUUID(), sequence = 0;
  let method: Hook | null = null, methodOwner: Data | null = null, observerHook: Hook | null = null;
  let failedOwner: Data | null = null, observedAt = performance.now();
  const counts = { received: 0, submitted: 0, presented: 0, translated: 0, original: 0, timedOut: 0, overloaded: 0, removed: 0, abandoned: 0, translatedChars: 0, cachedTranslated: 0,
    unconfirmed: 0, repaired: 0, repairApplied: 0 };
  let delays: number[] = [], readiness: number[] = [];
  let recent: { id: string; at: number; deadline: number; eligible: boolean; chatExpected: boolean; presented: boolean; translated: boolean }[] = [];
  const identity = (): Identity | null => {
    try {
      const candidate = resourceFromUrl(location.href);
      if (candidate?.platform !== 'bilibili' || candidate.scenario !== 'live' || !currentView()) return null;
      const room = bilibiliRoomIdentity(host, document, view.playerRoomId);
      return room ? { ...room, resourceId: `room:${room.roomId}`, urlResourceId: candidate.resourceId } : null;
    } catch { return null; }
  };
  const post = (payload: Data, b = binding) => {
    const id = b ?? identity(); if (!id) return;
    window.postMessage({ bridge: BRIDGE, from: 'adapter', platform: 'bilibili', resourceId: id.resourceId,
      urlResourceId: id.urlResourceId, adapterSession: b?.session ?? session, ...payload }, location.origin);
  };
  const sameOwner = (b: Binding): boolean => {
    try {
      const id = identity();
      return binding === b && !disposed && !frozen && !!id?.live && id.resourceId === b.resourceId && id.urlResourceId === b.urlResourceId &&
        b.root === document.querySelector('#live-player') && (!b.engine || !!b.layer?.isConnected && b.root.contains(b.layer) &&
        decimalId(b.engine.opts?.roomId) === b.roomId && b.engine.layerWrap === b.layer && b.engine.danmaku?.core === b.core);
    } catch { return false; }
  };
  const surfaces = (b: Binding) => {
    const video = b.root.querySelector('video');
    const fullscreen = document.fullscreenElement;
    const chat = document.querySelector('#chat-items');
    const chatActive = !document.hidden && !!chat && visible(chat) && (!fullscreen || fullscreen.contains(chat));
    const screen = !!b.engine && !!b.layer && !document.hidden && visible(b.layer) && !!video && !video.paused && !video.seeking && !video.ended && !video.error &&
      (!fullscreen || fullscreen.contains(b.layer));
    return { chat: chatActive, screen };
  };
  const active = (b: Binding) => enabled && method?.intact() === true && performance.now() - lastControl <= 6000 && sameOwner(b) && (surfaces(b).chat || surfaces(b).screen);
  const percentile = (rows: number[]) => {
    const sorted = [...rows].sort((a,b) => a-b), at = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p)-1]! : null;
    return { p50: at(.5), p95: at(.95), p99: at(.99), samples: sorted.length };
  };
  const publish = () => {
    const b = binding, id = identity(), available = !!b && sameOwner(b) && method?.intact() === true;
    const video = b?.root.querySelector('video'), now = performance.now();
    recent = recent.filter(row => now-row.at <= 60000).slice(-20000);
    const cohort = recent.filter(row => row.eligible && row.presented);
    post({ type: 'snapshot', connection: id && !id.live ? 'ended' : available ? 'connected' : enabled ? 'connecting' : 'disconnected',
      coverage: 'unknown', presentationActive: available && active(b!),
      playback: { paused: video?.paused !== false, seeking: video?.seeking !== false, contentActive: !!id?.live, atLiveEdge: !!id?.live },
      liveMetrics: { ...counts, pending: b?.queue.size ?? 0, observationMs: now-observedAt, readinessMs: percentile(readiness), releaseDelayMs: percentile(delays) },
      recentEligible: cohort.length, recentTranslated: cohort.filter(row => row.translated).length,
      reason: !available && enabled ? 'native-entry-unavailable' : available && !active(b!) && enabled ? 'surfaces-hidden' : available && !b!.engine ? 'superchat-only' : '', stamp: clockStamp() });
  };
  const inspectPresented = (b: Binding) => {
    if (!sameOwner(b)) return;
    const now = performance.now();
    for (const [id, waiting] of b.awaiting) if (now >= waiting.expires) { b.awaiting.delete(id); counts.unconfirmed++; }
    if (!surfaces(b).chat) return;
    // Submission is not presentation. Only identity-correlated visible native chat is counted here.
    for (const row of document.querySelectorAll('#chat-items .chat-item.danmaku-item[data-id_str]')) {
      const nativeId = ordinaryMessageId(row.getAttribute('data-id_str')); if (!nativeId) continue;
      const id = `dm:${nativeId}`;
      const waiting = b.awaiting.get(id), body = row.querySelector('.danmaku-item-right');
      if (!waiting || !(body instanceof HTMLElement) || !visible(row) ||
          readNativeBody(body,waiting.decision.source.originalText,waiting.decision.source.inlineEmotes)?.text !== waiting.decision.text) continue;
      const d = waiting.decision; b.awaiting.delete(id); counts.presented++;
      b.repairs.confirm(id, d.text);
      if (d.translated) { counts.translated++; counts.translatedChars += d.text.length; if (d.cached) counts.cachedTranslated++; } else counts.original++;
      const sample = recent.find(row => row.id === id); if (sample) { sample.presented = true; sample.translated = d.translated; }
      post({ type: 'displayed', sourceId: id, translated: d.translated, stamp: clockStamp() }, b);
    }
  };
  const detach = (handoff: boolean) => {
    const b = binding; if (!b) return;
    if (handoff && sameOwner(b)) b.queue.flush(); else b.queue.abandon();
    b.dom.dispose(); b.repairs.dispose(); b.awaiting.clear(); binding = null; session = crypto.randomUUID();
  };
  const attach = (engine?: Data, context?: Data): Binding | null => {
    try {
      const id = identity(), root = document.querySelector('#live-player'), layer = engine?.layerWrap;
      if (!id?.live || !root) return null;
      if (engine && (!(layer instanceof Element) || !root.contains(layer) ||
          !(engine.config?.container instanceof Element) || !root.contains(engine.config.container) ||
          decimalId(engine.opts?.roomId) !== id.roomId || typeof context?.isBlocked !== 'function' || typeof context?.emitDanmaku !== 'function')) return null;
      const metadata = engine?.danmaku?.core?.getMetadata?.();
      if (engine && (metadata?.version !== CORE_VERSION || metadata.lastCompiled !== CORE_COMPILED)) return null;
      // Paid DOM history is independently identifiable before the first socket
      // message. Upgrade that session only after the ordinary engine is verified.
      if (engine && binding && !binding.engine && sameOwner(binding)) {
        Object.assign(binding,{engine,core:engine.danmaku.core,layer}); return binding;
      }
      detach(false); session = crypto.randomUUID();
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
      delays = []; readiness = []; recent = []; observedAt = performance.now();
      const b = { ...id, engine, core: engine?.danmaku.core, layer, root, session, awaiting: new Map(), repairApplied: new Map() } as Binding;
      b.repairs = new BilibiliRepairs({ now: Date.now, active: () => active(b), eligible: text => needsTranslation(text,targetLanguage,sourceLanguage) && !protectText(text).reason,
        timeoutMs: () => superChatTimeoutMs, send: payload => {
          if (payload.type === 'repair-applied' && payload.application === 'native-updated' && b.repairs.records.get(payload.sourceId)?.manualPriority && b.repairApplied.get(payload.sourceId) !== payload.resultVersion) {
            counts.repairApplied++; b.repairApplied.set(payload.sourceId, payload.resultVersion);
            while (b.repairApplied.size > 300) b.repairApplied.delete(b.repairApplied.keys().next().value!);
          }
          post(payload,b);
        } });
      b.dom = new BilibiliRepairDom({ ledger: b.repairs, active: () => active(b), document });
      b.queue = new BilibiliNativeQueue({ now: () => performance.now(), current: () => sameOwner(b), active: () => active(b),
        eligible: text => needsTranslation(text,targetLanguage,sourceLanguage) && !protectText(text).reason,
        retryPolicy: () => retryEnabled ? { timeoutMs: timeoutRetryBudget(bufferMs,retryExtraMs), hold: retryHold } : undefined,
        retry: (source,deadline) => b.repairs.requestTimeout(source.sourceId, deadline-performance.now()),
        cancelRetry: id => b.repairs.cancelTimeout(id),
        setTimeout: (fn,ms) => setTimeout(fn,ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        source: (source,at) => {
          counts.received++; b.repairs.capture(source);
          recent.push({ id: source.sourceId, at, deadline: at+bufferMs, eligible: source.translatable, chatExpected: false, presented: false, translated: false });
          post({ type: 'events', events: [{ sourceId: source.sourceId, nativeId: source.nativeId, originalText: source.originalText, translatable: source.translatable,
            ...(source.inlineEmotes ? { emoteTokens: Object.keys(source.inlineEmotes) } : {}), receivedAt: performance.timeOrigin+at }], stamp: clockStamp() },b);
        },
        decision: decision => {
          counts.submitted++; if (decision.reason === 'timeout') counts.timedOut++; if (decision.reason === 'overload') counts.overloaded++;
          delays.push(decision.releasedAt-decision.receivedAt); if (delays.length>1200) delays.shift();
          b.repairs.normal(decision.source.sourceId, decision.translated ? decision.text : undefined, decision);
          const sample=recent.find(row=>row.id===decision.source.sourceId);if(sample)sample.chatExpected=surfaces(b).chat;
          b.awaiting.set(decision.source.sourceId,{ decision, expires: performance.now()+10000 });
          post({ type:'submitted', sourceId:decision.source.sourceId, translated:decision.translated, reason:decision.reason, stamp:clockStamp() },b);
          inspectPresented(b); b.dom.scan();
        },
        removed: ids => { counts.abandoned += ids.length; post({type:'events',events:[],removes:ids,stamp:clockStamp()},b); },
      });
      return b;
    } catch { return null; }
  };
  const install = () => {
    const owner = host.LiveDanmakuEngine?.default?.prototype;
    if (!owner || owner === failedOwner) return;
    if (method && methodOwner === owner && method.intact()) return;
    if (method && methodOwner === owner && !method.intact()) { failedOwner=owner; detach(true); method=null; return; }
    method?.restore(); methodOwner = owner;
    method = hookMethod(owner,'handleSocketMessage', original => function(this: Data, packet: Data, context: Data) {
      const args = [...arguments];
      if (!enabled || frozen || disposed || performance.now()-lastControl>6000 || !method?.intact()) return Reflect.apply(original,this,args);
      let source: ReturnType<typeof ordinaryComment> = null;
      try {
        if (!binding || binding.engine !== this || !sameOwner(binding)) {
          const next=attach(this,context); if(next) binding=next; else if(binding?.engine) detach(false); publish();
        }
        if (binding?.engine === this && active(binding)) source=ordinaryComment(packet,`occ:${++sequence}`);
      } catch { /* Fail closed before invoking the site. */ }
      const b=binding;
      if(!b||!source?.translatable)return Reflect.apply(original,this,args);
      const receivedAt=performance.now();
      const captured=captureNativeDispatch(this,context,original,args,source);
      if(!captured)return Reflect.apply(original,this,args);
      if(!captured.translatable||!b.queue.add(source,bufferMs,translated=>{
        if(!sameOwner(b))throw new Error('native-owner-replaced');captured.submit(translated);
      },receivedAt))captured.submit(source.packet);
      return captured.result;
    });
  };
  const observeSc = () => {
    if (observerHook?.intact()) return;
    // An existing replacement is not ours to overwrite; wait for the next page lifecycle.
    if (observerHook) return;
    observerHook = optionalObserver(host,'__GREAT_TOILET__',original => function(this: unknown, packet: Data) {
      const result = Reflect.apply(original,this,arguments);
      try {
        const b = binding;
        if (b && sameOwner(b)) {
          b.repairs.remove(deletedSuperChats(packet));
          const source = superChatSource(packet,Date.now());
          if (source && active(b)) { b.repairs.capture(source,source); b.repairs.request(source.sourceId,false); }
        }
      } catch { /* Read-only observation cannot interrupt the site's dispatcher. */ }
      return result;
    });
  };
  const tick = () => {
    if (disposed) return;
    if (performance.now()-lastControl>6000) enabled=false;
    if (binding && !sameOwner(binding)) detach(false);
    if (!enabled || frozen) {
      detach(true); method?.restore(); method=null; methodOwner=null; observerHook?.restore(); observerHook=null;
      publish();
    } else {
      install(); observeSc();
      if (!binding && document.querySelector('.super-chat-bubble-main,.detail-info .card-detail,#chat-items .superChat-card-detail[data-danmaku]')) {
        binding=attach();
      }
      // Establish the session/connection in the content bridge before emitting
      // newly discovered paid records or repair requests (also on late loading).
      publish();
      if (binding) { binding.queue.pump(); binding.repairs.prune(); inspectPresented(binding); binding.dom.scan(); }
    }
  };
  const control = (event: MessageEvent) => {
    const d=event.data;
    if (event.source!==window || event.origin!==location.origin || d?.bridge!==BRIDGE || d.from!=='content') return;
    if (d.type==='control') {
      if (typeof d.enabled!=='boolean' || !validLiveBufferMs(d.bufferMs) || !Number.isSafeInteger(d.configVersion) ||
          d.configVersion<0 || typeof d.targetLanguage!=='string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(d.targetLanguage) ||
          typeof d.sourceLanguage!=='string' || !/^(auto|[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)$/.test(d.sourceLanguage)) return;
      if (configVersion!==d.configVersion || targetLanguage!==d.targetLanguage || sourceLanguage!==d.sourceLanguage) detach(true);
      enabled=d.enabled; lastControl=performance.now(); bufferMs=d.bufferMs; configVersion=d.configVersion; targetLanguage=d.targetLanguage; sourceLanguage=d.sourceLanguage;
      retryEnabled=d.bilibiliTimeoutRetryEnabled===true;
      retryExtraMs=Number.isSafeInteger(d.bilibiliTimeoutRetryExtraMs)&&d.bilibiliTimeoutRetryExtraMs>=0&&d.bilibiliTimeoutRetryExtraMs<=MAX_TIMEOUT_RETRY_EXTRA_MS?d.bilibiliTimeoutRetryExtraMs:1000;
      retryHold=d.bilibiliTimeoutRetryMode!=='release';
      superChatTimeoutMs=Number.isInteger(d.superChatTimeoutMs)?Math.max(1000,Math.min(120000,d.superChatTimeoutMs)):15000;
      tick(); return;
    }
    const b=binding;
    if (!b || !sameOwner(b) || d.platform!=='bilibili' || d.resourceId!==b.resourceId || d.adapterSession!==b.session) return;
    if (d.type==='repair-result') {
      const before = b.repairs.get(d.sourceId), manual = before?.request?.manual, retry = before?.request?.purpose==='timeout';
      if (b.repairs.result(d)) {
        const record=b.repairs.get(d.sourceId);
        if (manual && record?.state==='translated') counts.repaired++;
        if (retry && record) b.queue.retryResult(d.sourceId,record.originalText,record.state==='translated'?record.text:undefined,d.status==='cached');
      }
      b.dom.scan(); return;
    }
    if (d.type==='repair-abort') {
      const record=b.repairs.get(d.sourceId), retry=record?.request?.id===d.requestId&&record?.request?.purpose==='timeout';
      b.repairs.abort(d.sourceId,d.requestId);
      if(retry&&record)b.queue.retryResult(d.sourceId,record.originalText);
      b.dom.scan(); return;
    }
    if (d.type==='repair-start') {
      if (typeof d.sourceId==='string' && typeof d.originalText==='string' && typeof d.requestId==='string' && typeof d.manual==='boolean' && typeof d.force==='boolean')
        b.repairs.start(d.sourceId,d.originalText,d.requestId,d.manual,d.force,true,d.purpose==='timeout'?'timeout':undefined,d.timeoutMs);
      return;
    }
    if (d.type==='repair-scan') {
      if (!['visible','queue','loaded'].includes(d.scope) || typeof d.scanId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(d.scanId)) return;
      b.dom.scan();
      const ids = d.scope === 'visible' ? b.dom.visibleIds() : d.scope === 'loaded' ? b.dom.loadedIds() : null;
      const candidates=[...b.repairs.records.values()].filter(row => !ids || ids.has(row.sourceId))
        .map(({sourceId,originalText,strategy,state,text,resultVersion,application})=>({sourceId,originalText,strategy,state,text,resultVersion,application}));
      // Only page-loaded paid originals and captured records are inspected;
      // never fetch missing server history or re-emit vanished screen models.
      for (let offset=0; offset<Math.max(1,candidates.length); offset+=100) post({type:'repair-candidates',scope:d.scope,scanId:d.scanId,
        chunkIndex:offset/100,done:offset+100>=candidates.length,status:'partial',candidates:candidates.slice(offset,offset+100)},b);
      return;
    }
    if (typeof d.sourceId!=='string' || typeof d.originalText!=='string' || !active(b)) return;
    if (d.type==='release-original') b.queue.original(d.sourceId,d.originalText);
    if (d.type==='prepared' && typeof d.text==='string' && typeof d.cached==='boolean') {
      const at=performance.now();
      if (b.queue.prepare(d.sourceId,d.originalText,d.text,d.cached)) {
        const sample=recent.find(row=>row.id===d.sourceId); if(sample){readiness.push(at-sample.at);if(readiness.length>1200)readiness.shift();}
      }
    }
  };
  const hide = () => { detach(true); frozen=true; tick(); };
  const show = () => { frozen=false; failedOwner=null; tick(); };
  window.addEventListener('message',control); window.addEventListener('pagehide',hide); window.addEventListener('pageshow',show);
  const timer=setInterval(tick,250);
  const stop=() => {
    if(disposed)return;
    if (binding) post({ type: 'session-ended', stamp: clockStamp() }, binding);
    detach(true); disposed=true; clearInterval(timer); method?.restore(); observerHook?.restore();
    window.removeEventListener('message',control); window.removeEventListener('pagehide',hide); window.removeEventListener('pageshow',show);
  };
  tick(); return stop;
}
