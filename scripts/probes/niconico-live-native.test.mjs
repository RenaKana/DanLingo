// Focused production-adapter unit checks. Synthetic native contract; real evidence is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { validLiveBufferMs } from '../../src/core/live-budget.ts';
import { needsTranslation } from '../../src/core/messages.ts';
import { getTimeoutRetryPolicy } from '../../src/core/timeout-retry.ts';
import { protectText } from '../../src/translation/text.ts';
const source = ts.transpileModule(readFileSync('src/platforms/niconico-live/sidebar.ts', 'utf8') + '\n' + readFileSync('src/platforms/niconico-live/native.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

function harness({ deferStaging = false, failAdd = false } = {}) {
  let now = 0, sequence = 0, uuid = 0;
  const timers = new Map(), posted = [], rendered = [], calls = [], staging = [];
  class Target {
    handlers = new Map();
    addEventListener(type, cb) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(cb); }
    removeEventListener(type, cb) { this.handlers.get(type)?.delete(cb); }
    dispatchEvent(event) { for (const cb of [...this.handlers.get(event.type) || []]) cb(event); return true; }
  }
  const location = { pathname: '/watch/lv123', origin: 'https://live.nicovideo.jp' };
  const window = new Target(), document = new Target(); document.hidden = false;
  const video = { paused: false, ended: false, readyState: 4, videoWidth: 960, isConnected: true, getBoundingClientRect: () => ({ width: 960, height: 540 }) };
  const createNativeLayer = () => {
    const filters = new Map([['existing-style', (_chat, settings) => ({ ...settings, color: '#ffff00' })]]);
    const processor = { makeStagingSlot(_slot, chat, settings) { rendered.push({ chat, settings }); return { width: settings.content.length * 10 }; } };
    const layer = { processor, filters, addStagingFilter: (id, cb) => filters.set(id, cb), removeStagingFilter: id => filters.delete(id), getStagingFilterNameList: () => [...filters.keys()] };
    return { filters, processor, layer };
  };
  const { filters, layer } = createNativeLayer();
  class Component {
    props = { getCurrentVposMs: () => 100000 + now };
    renderer = { layerProcessorList: [layer] }; threadProcessor = {};
    addToRender(chat) {
      calls.push(chat);
      if (failAdd) return Promise.reject(new Error('native input failed'));
      const targetLayer = this.renderer.layerProcessorList[0];
      const stage = () => {
        const native = { content: chat.content, parsedOriginalChat: { ...chat, dateUsec: chat.date_usec } };
        let settings = { content: chat.content, visible: true, position: 'naka', color: '#ffffff', size: 'medium' };
        for (const filter of targetLayer.filters.values()) settings = filter({ ...native }, settings);
        return targetLayer.processor.makeStagingSlot({}, native, settings);
      };
      if (deferStaging) return new Promise(resolve => staging.push(() => resolve(stage())));
      return stage();
    }
  }
  const component = new Component(), originalAdd = component.addToRender;
  const element = { isConnected: true, __reactFiber$unit: { stateNode: component } };
  const liveState = { status: 'live' };
  const sidebarRows = [];
  const sidebarRow = (sourceId, originalText) => {
    const value = { sourceId, originalText };
    const node = { nodeType: 3, data: originalText };
    const body = { isConnected: true, firstChild: node, childNodes: [node], closest: () => body,
      __reactFiber$unit: { memoizedProps: {}, return: { memoizedProps: { rowIndex: 0, resource: {
        id: () => value.sourceId, text: () => value.originalText, type: () => 'normal', isNg: () => false, isDeleted: () => false,
      } }, return: { get key() { return value.sourceId; } } } } };
    node.parentNode = body; sidebarRows.push(body);
    return { body, node, value };
  };
  document.querySelectorAll = selector => selector === 'div[id^="renderer-parent-id-"]' ? [element]
    : selector === '[data-comment-type="normal"] .comment-text' ? sidebarRows : [];
  document.querySelector = selector => {
    if (selector.includes('videoLayer')) return video;
    if (selector === '[data-live-status="live"]' && liveState.status === 'live') return liveState;
    if (selector === '[data-live-status="chase"]' && liveState.status === 'chase') return liveState;
    return null;
  };
  window.postMessage = payload => { posted.push(payload); window.dispatchEvent({ type: 'message', data: payload, source: window, origin: location.origin }); };
  const schedule = (fn, delay, repeat = false) => { const id = ++sequence; timers.set(id, { fn, at: now + delay, repeat: repeat ? delay : 0 }); return id; };
  const sandbox = { window, document, location, validLiveBufferMs, needsTranslation, getTimeoutRetryPolicy, protectText, navigator: { onLine: true }, EventTarget: Target,
    performance: { timeOrigin: 1000000000000, now: () => now }, crypto: { randomUUID: () => 'session-' + ++uuid },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id), console };
  const context = vm.createContext(sandbox); vm.runInContext(source, context);
  const install = () => vm.runInContext('startNiconicoLiveBridge()', context);
  const stop = install();
  const control = (enabled, bufferMs = 500, retry = {}) => window.postMessage({ bridge: 'danlingo-live-v1', from: 'content', type: 'control', enabled, bufferMs,
    targetLanguage: 'zh-Hans', sourceLanguage: 'auto', ...retry });
  function runTo(time, jump = false) {
    if (jump) now = time;
    for (let count = 0; count < 20000; count++) {
      const next = [...timers].filter(([, t]) => t.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next; timers.delete(id); if (!jump) now = task.at;
      if (task.repeat) timers.set(id, { ...task, at: now + task.repeat }); task.fn();
    }
    now = time;
  }
  const chat = no => ({ no, content: 'こんにちは' + no, vpos: (100000 + now) / 10, date: 1789000000, date_usec: 1000, mail: '184' });
  const protocol = new Target();
  const wire = (chat, id) => protocol.dispatchEvent({ type: 'onMessage', detail: { message: {
    meta: { id, at: { seconds: chat.date, nanos: chat.date_usec * 1000 } },
    payload: { case: 'message', value: { data: { case: 'chat', value: chat } } },
  } } });
  const events = () => posted.filter(x => x.type === 'events').flatMap(x => x.events.map(e => ({ ...e, adapterSession: x.adapterSession, resourceId: x.resourceId })));
  const prepare = (event, text = '你好') => window.postMessage({ bridge: 'danlingo-live-v1', from: 'content', type: 'prepared', platform: 'niconico', ...event, originalText: event.originalText, text });
  const stageAll = () => { while (staging.length) staging.shift()(); };
  const repairResult = (request, text, status = 'translated') => window.postMessage({ bridge: 'danlingo-live-v1', from: 'content', type: 'repair-result',
    platform: 'niconico', resourceId: request.resourceId, adapterSession: request.adapterSession, requestId: request.requestId,
    sourceId: request.sourceId, status, text });
  return { control, stop, install, runTo, chat, component, originalAdd, calls, rendered, posted, events, prepare, repairResult, filters, location, video, Target, sandbox, wire, protocol, stageAll, liveState, createNativeLayer, sidebarRow };
}

test('one prepared result translates the sidebar and native danmaku without another request', () => {
  const h = harness(); h.control(true); const raw = h.chat(80), side = h.sidebarRow('wire-80', raw.content);
  h.wire(raw, 'wire-80'); h.component.addToRender(raw); h.prepare(h.events()[0], '共享译文');
  assert.equal(side.node.data, '共享译文'); assert.equal(side.value.originalText, 'こんにちは80');
  assert.equal(raw.content, 'こんにちは80'); assert.equal(h.events().length, 1);
  assert.equal(h.posted.filter(e => e.type === 'repair-request').length, 0);
  h.runTo(500); assert.equal(h.rendered.length, 1); assert.equal(h.rendered[0].settings.content, '共享译文');
  h.control(false); assert.equal(side.node.data, 'こんにちは80'); h.stop();
});

test('a sidebar row mounted after native release receives its saved result on the existing tick', () => {
  const h = harness(); h.control(true); const raw = h.chat(81);
  h.wire(raw, 'wire-81'); h.component.addToRender(raw); h.prepare(h.events()[0], '延后挂载'); h.runTo(500);
  const side = h.sidebarRow('wire-81', raw.content); h.runTo(750);
  assert.equal(side.node.data, '延后挂载'); assert.equal(h.events().length, 1);
  h.stop(); assert.equal(side.node.data, raw.content);
});

test('late ordinary preparation never repaints an untranslated sidebar row', () => {
  const h = harness(); h.control(true); const raw = h.chat(82), side = h.sidebarRow('wire-82', raw.content);
  h.wire(raw, 'wire-82'); h.component.addToRender(raw); const event = h.events()[0];
  h.runTo(501); h.prepare(event, '迟到结果'); h.runTo(750);
  assert.equal(side.node.data, raw.content); assert.equal(h.rendered[0].settings.content, raw.content); h.stop();
});

test('only the matching on-time held retry can update both comment displays', () => {
  const h = harness(); h.control(true, 500, { niconicoTimeoutRetryEnabled: true, niconicoTimeoutRetryMode: 'hold', niconicoTimeoutRetryExtraMs: 500 });
  const raw = h.chat(83), side = h.sidebarRow('wire-83', raw.content);
  h.wire(raw, 'wire-83'); h.component.addToRender(raw); h.runTo(500);
  const request = h.posted.find(e => e.type === 'repair-request');
  h.repairResult({ ...request, requestId: 'not-the-request' }, '错误结果'); assert.equal(side.node.data, raw.content);
  h.repairResult(request, '有效补译'); assert.equal(side.node.data, '有效补译');
  assert.equal(h.rendered[0].settings.content, '有效补译');
  h.repairResult(request, '重复结果'); assert.equal(side.node.data, '有效补译'); h.stop();
});

for (const change of ['pause', 'room', 'lease', 'stop']) test(`sidebar originals return on ${change}, and stale results cannot reapply`, () => {
  const h = harness(); h.control(true); const raw = h.chat(84), side = h.sidebarRow('wire-84', raw.content);
  h.wire(raw, 'wire-84'); h.component.addToRender(raw); const event = h.events()[0]; h.prepare(event, '当前译文');
  assert.equal(side.node.data, '当前译文');
  if (change === 'pause') h.video.paused = true;
  if (change === 'room') h.location.pathname = '/watch/lv456';
  if (change === 'stop') h.stop();
  h.runTo(change === 'lease' ? 6250 : 250);
  assert.equal(side.node.data, raw.content); h.prepare(event, '过期回写'); assert.equal(side.node.data, raw.content); h.stop();
});

for (const setting of [{ configVersion: 2 }, { targetLanguage: 'en' }, { sourceLanguage: 'ja' }]) test(`sidebar settings reset isolates old results: ${JSON.stringify(setting)}`, () => {
  const h = harness(); h.control(true, 500, { configVersion: 1 });
  const raw = h.chat(85), side = h.sidebarRow('wire-85', raw.content);
  h.wire(raw, 'wire-85'); h.component.addToRender(raw); const old = h.events()[0]; h.prepare(old, '原配置译文');
  h.control(true, 500, { configVersion: 1 }); assert.equal(side.node.data, '原配置译文');
  h.control(true, 500, { configVersion: 1, ...setting }); assert.equal(side.node.data, raw.content);
  h.prepare(old, '旧配置迟到'); assert.equal(side.node.data, raw.content);
  assert.equal(h.posted.find(e => e.type === 'dropped' && e.sourceId === old.sourceId)?.reason, 'session-reset');
  const nextRaw = h.chat(86), nextSide = h.sidebarRow('wire-86', nextRaw.content);
  h.wire(nextRaw, 'wire-86'); h.component.addToRender(nextRaw); const fresh = h.events().at(-1);
  assert.notEqual(fresh.adapterSession, old.adapterSession); h.prepare(fresh, '新配置译文');
  assert.equal(nextSide.node.data, '新配置译文'); h.stop();
});

test('navigation before the next tick rejects a result instead of touching the old room sidebar', () => {
  const h = harness(); h.control(true); const raw = h.chat(87), side = h.sidebarRow('wire-87', raw.content);
  h.wire(raw, 'wire-87'); h.component.addToRender(raw); const old = h.events()[0];
  h.location.pathname = '/watch/lv456'; h.prepare(old, '不应出现'); assert.equal(side.node.data, raw.content); h.stop();
});

test('snapshot original, display prepared text only at deadline, retain native style, release once', () => {
  const h = harness(); h.control(true); const raw = h.chat(1); h.component.addToRender(raw); h.prepare(h.events()[0]);
  raw.content = 'later external mutation'; h.runTo(499); assert.equal(h.calls.length, 0); h.runTo(500);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].content, 'こんにちは1');
  assert.equal(h.rendered[0].settings.content, '你好'); assert.equal(h.rendered[0].settings.color, '#ffff00');
  h.component.addToRender(h.chat(1)); assert.equal(h.events().length, 1); h.stop();
});
test('custom wait accepts non-preset delays without resetting original arrival', () => {
  const h = harness(); h.control(true, 4500); h.component.addToRender(h.chat(99));
  h.runTo(4499); assert.equal(h.calls.length, 0);
  h.runTo(4500); assert.equal(h.calls.length, 1);
  h.prepare(h.events()[0]); h.runTo(4600); assert.equal(h.calls.length, 1);
});
test('late preparation cannot repaint or deliver a second copy', () => {
  const h = harness(); h.control(true); h.component.addToRender(h.chat(2)); const event = h.events()[0];
  h.runTo(501); h.prepare(event); h.runTo(1200);
  assert.equal(h.rendered.length, 1); assert.equal(h.rendered[0].settings.content, event.originalText);
  assert.equal(h.posted.filter(x => x.type === 'delivered').length, 1); h.stop();
});
test('timely prepared identical text still counts as a completed prepared decision', () => {
  const h = harness(); h.control(true); h.component.addToRender(h.chat(8)); const event = h.events()[0];
  h.prepare(event, event.originalText); h.runTo(500);
  assert.equal(h.posted.find(x => x.type === 'delivered').translated, true); h.stop();
});

test('explicit repair scan reads bounded ordinary current slots without restaging or translation injection', () => {
  const h = harness(); h.control(true);
  const raw = h.chat(99); h.wire(raw, 'wire-captured-id');
  const layer = h.component.renderer.layerProcessorList[0];
  layer.slotRepository = { stagingList: [
    { chat: { content: 'translated native settings must not become source', parsedOriginalChat: raw } },
    { chat: { parsedOriginalChat: { ...raw } } },
    { chat: { parsedOriginalChat: { ...h.chat(100), content: '/unsupported' } } },
  ] };
  const snapshot = h.posted.filter(row => row.type === 'snapshot').at(-1);
  const scan = () => h.sandbox.window.postMessage({ bridge: 'danlingo-live-v1', from: 'content', type: 'repair-scan', platform: 'niconico',
    scope: 'loaded', scanId: 'loaded-test', resourceId: snapshot.resourceId, adapterSession: snapshot.adapterSession });
  scan(); const result = h.posted.filter(row => row.type === 'repair-candidates').at(-1);
  assert.equal(result.status, 'supported'); assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceId, 'wire-captured-id'); assert.equal(result.candidates[0].originalText, raw.content);
  assert.equal(h.calls.length, 0); assert.equal(h.rendered.length, 0); assert.equal(h.events().length, 0);
  scan(); assert.equal(h.posted.filter(row => row.type === 'repair-candidates').length, 1, 'rescan cooldown');
  h.runTo(500); layer.slotRepository.stagingList = Array.from({ length: 350 }, (_, index) => ({ chat: { parsedOriginalChat: h.chat(index) } }));
  const before=h.posted.filter(row=>row.type==='repair-candidates').length;
  scan(); const chunks=h.posted.filter(row=>row.type==='repair-candidates').slice(before);
  assert.deepEqual(chunks.map(row=>row.candidates.length),[100,100,100,50]);
  assert.deepEqual(chunks.map(row=>row.chunkIndex),[0,1,2,3]);
  assert.deepEqual(chunks.map(row=>row.done),[false,false,false,true]);
  assert.equal(new Set(chunks.flatMap(row=>row.candidates.map(c=>c.sourceId))).size,350);
  assert.ok(chunks.every(row=>row.scanId==='loaded-test'&&row.scope==='loaded'));
  h.runTo(1000); delete layer.slotRepository; scan(); assert.equal(h.posted.filter(row => row.type === 'repair-candidates').at(-1).status, 'unavailable');
  assert.equal(h.calls.length, 0); h.stop();
});
function visibleFixture(h) {
  const callbacks = new Set();
  const stage = { visible:true, renderable:true, worldAlpha:1 };
  const layer = h.component.renderer.layerProcessorList[0];
  const container = { ...stage, parent:stage }; layer.displayObject = container;
  class Canvas {
    isConnected = true; parentElement = null;
    getBoundingClientRect() { return { left:100,top:50,right:1060,bottom:590,width:960,height:540 }; }
  }
  const canvas = new Canvas();
  const pixi = { renderingToScreen:true,_lastObjectRendered:stage,screen:{x:0,y:0,width:960,height:540},
    on(event,fn){assert.equal(event,'postrender');callbacks.add(fn);}, off(event,fn){callbacks.delete(fn);} };
  Object.assign(h.component.renderer,{ stage,pixiRenderer:pixi,element:canvas });
  Object.assign(h.sandbox,{ HTMLCanvasElement:Canvas, innerWidth:1200,innerHeight:800,
    getComputedStyle:element=>({display:'block',visibility:'visible',opacity:'1',transform:'none',overflowX:'visible',overflowY:'visible',...element.style}) });
  const slot = (id,x,y=20,flags={})=>({ chat:{parsedOriginalChat:h.chat(id)},displayObject:{...stage,parent:container,
    getBounds(skip){assert.equal(skip,true,'never advance native transforms');return{x,y,width:100,height:24};},...flags} });
  layer.slotRepository = {stagingList:[]};
  const snapshot=h.posted.filter(row=>row.type==='snapshot').at(-1);
  const scan=()=>h.sandbox.window.postMessage({bridge:'danlingo-live-v1',from:'content',type:'repair-scan',scope:'visible',scanId:'scan-unit',platform:'niconico',resourceId:snapshot.resourceId,adapterSession:snapshot.adapterSession});
  const draw=()=>{for(const fn of [...callbacks])fn();};
  const results=()=>h.posted.filter(row=>row.type==='repair-candidates');
  return {stage,layer,container,canvas,pixi,slot,scan,draw,results,callbacks};
}
test('visible repair observes next native screen frame, excluding hidden, offscreen, detached and reset slots',()=>{
  const h=harness();h.control(true);const v=visibleFixture(h);
  v.layer.slotRepository.stagingList=[v.slot(1,10),v.slot(2,-110),v.slot(3,960),v.slot(4,10,20,{visible:false}),v.slot(5,10,20,{worldAlpha:0}),
    v.slot(6,10,20,{renderable:false}),v.slot(7,10,20,{parent:null}),{chat:null,displayObject:v.slot(8,10).displayObject},v.slot(9,-90)];
  v.scan();assert.equal(v.results().length,0,'scan must not force a draw or inspect a future frame');
  v.pixi.renderingToScreen=false;v.draw();assert.equal(v.results().length,0,'offscreen render textures are not screen evidence');
  v.pixi.renderingToScreen=true;v.draw();assert.equal(v.results().length,1);
  assert.equal(v.results()[0].scope,'visible');assert.equal(v.results()[0].scanId,'scan-unit');
  assert.deepEqual(Array.from(v.results()[0].candidates,row=>row.originalText).sort(),['こんにちは1','こんにちは9']);
  assert.equal(v.callbacks.size,0);assert.equal(h.calls.length,0);assert.equal(h.events().length,0);h.stop();
});
test('visible repair respects viewport and CSS overflow clips; unknown effects stay explicitly partial',()=>{
  const h=harness();h.control(true);const v=visibleFixture(h);
  h.sandbox.innerWidth=800;
  v.canvas.parentElement={parentElement:null,style:{overflowX:'hidden'},getBoundingClientRect:()=>({left:250,top:0,right:1000,bottom:700})};
  v.layer.slotRepository.stagingList=[v.slot(1,10),v.slot(2,160),v.slot(3,710),v.slot(4,180,20,{mask:{}})];
  v.scan();v.draw();assert.equal(v.results()[0].status,'partial');assert.deepEqual(Array.from(v.results()[0].candidates,row=>row.originalText),['こんにちは2']);
  h.runTo(500);v.layer.slotRepository.stagingList[1].chat=null;v.scan();v.draw();assert.equal(v.results()[1].candidates.length,0,'recycled/reset chat cannot retain old source');h.stop();
});
test('visible repair without a native draw times out and restores its transient listener',()=>{
  const h=harness();h.control(true);const v=visibleFixture(h);v.scan();h.runTo(1001);
  assert.equal(v.results()[0].status,'unavailable');assert.equal(v.callbacks.size,0);h.stop();
});

test('capacity drops overload without releasing accepted comments before deadline', () => {
  const h = harness(); h.control(true); for (let i = 0; i < 301; i++) h.component.addToRender(h.chat(i));
  assert.equal(h.calls.length, 0); assert.equal(h.events().length, 300);
  assert.equal(h.posted.filter(x => x.type === 'dropped' && x.reason === 'capacity').length, 1);
  h.runTo(499); assert.equal(h.calls.length, 0); h.runTo(500); assert.equal(h.calls.length, 300); h.stop();
});
test('event loop backlog beyond deadline tolerance is dropped instead of burst replay', () => {
  const h = harness(); h.control(true); h.component.addToRender(h.chat(3)); h.runTo(1501, true);
  assert.equal(h.calls.length, 0); assert.equal(h.posted.filter(x => x.type === 'dropped' && x.reason === 'age').length, 1); h.stop();
});
test('disable and lease loss restore input, dispatcher and preexisting filters', () => {
  const h = harness(), dispatch = h.Target.prototype.dispatchEvent; h.control(true); h.component.addToRender(h.chat(4)); h.control(false);
  assert.equal(h.calls.length, 1); assert.equal(h.component.addToRender, h.originalAdd); assert.equal(h.Target.prototype.dispatchEvent, dispatch);
  assert.deepEqual([...h.filters.keys()], ['existing-style']); h.control(true); h.runTo(6250);
  assert.equal(h.component.addToRender, h.originalAdd); assert.equal(h.Target.prototype.dispatchEvent, dispatch); h.stop();
});
test('same-page reinjection disposes prior adapter and changing room never reattaches old player', () => {
  const h = harness(); h.control(true); h.component.addToRender(h.chat(5)); const stop2 = h.install();
  assert.equal(h.calls.length, 1); h.control(true); h.component.addToRender(h.chat(6)); const event = h.events().at(-1);
  h.location.pathname = '/watch/lv456'; h.runTo(250); h.prepare(event); h.runTo(1000);
  assert.equal(h.calls.length, 1); assert.equal(h.component.addToRender, h.originalAdd); stop2();
});
test('ended program video cannot become active because another page video plays', () => {
  const h = harness(); h.video.ended = true; h.control(true); h.component.addToRender(h.chat(7));
  assert.equal(h.events().length, 0); assert.equal(h.calls.length, 1); h.stop();
});

const inactiveStates = {
  pause: (h, inactive) => { h.video.paused = inactive; },
  seeking: (h, inactive) => { h.video.seeking = inactive; },
  hidden: (h, inactive) => { h.sandbox.document.hidden = inactive; },
  offline: (h, inactive) => { h.sandbox.navigator.onLine = !inactive; },
};
for (const [label, setInactive] of Object.entries(inactiveStates)) {
  test(`${label} cancels pending originals and resumes only from new native identities`, () => {
    const h = harness(); h.control(true); h.component.addToRender(h.chat(20)); const old = h.events()[0]; h.prepare(old);
    h.runTo(100); setInactive(h, true);
    if (label === 'hidden') h.sandbox.document.dispatchEvent({ type: 'visibilitychange' });
    h.runTo(250);
    assert.equal(h.calls.length, 0);
    const dropped = h.posted.filter(x => x.type === 'dropped');
    assert.equal(dropped.length, 1); assert.equal(dropped[0].reason, 'inactive');
    assert.equal(dropped[0].adapterSession, old.adapterSession); assert.equal(dropped[0].resourceId, old.resourceId);
    h.prepare(old); h.component.addToRender(h.chat(21));
    assert.equal(h.calls.length, 1); assert.equal(h.events().length, 1);
    setInactive(h, false); h.runTo(500);
    h.component.addToRender(h.chat(20)); h.component.addToRender(h.chat(21)); h.component.addToRender(h.chat(22)); h.runTo(1000);
    assert.deepEqual(h.calls.map(chat => chat.no), [21, 22]);
    assert.equal(h.events().length, 2); assert.equal(h.posted.filter(x => x.type === 'dropped').length, 1); h.stop();
  });
  test(`${label} cannot release at a deadline before the next playback poll`, () => {
    const h = harness(); h.control(true); h.runTo(100); h.component.addToRender(h.chat(23)); const old = h.events()[0]; h.prepare(old);
    h.runTo(550); setInactive(h, true); h.runTo(600);
    assert.equal(h.calls.length, 0);
    const dropped = h.posted.filter(x => x.type === 'dropped');
    assert.equal(dropped.length, 1); assert.equal(dropped[0].reason, 'inactive');
    assert.equal(dropped[0].adapterSession, old.adapterSession); h.runTo(1000);
    assert.equal(h.posted.filter(x => x.type === 'dropped').length, 1); h.stop();
  });
}

test('reconnect dedupes stable native keys across wire ID changes and records inactive native baseline', () => {
  const h = harness(); h.control(true); const oldChat = h.chat(30); h.wire(oldChat, 'wire-before'); h.component.addToRender(oldChat);
  const old = h.events()[0]; assert.equal(old.sourceId, 'wire-before');
  h.protocol.dispatchEvent({ type: 'onError', detail: { code: 'Closed' } });
  assert.equal(h.calls.length, 0);
  const dropped = h.posted.find(x => x.type === 'dropped');
  assert.equal(dropped.reason, 'session-reset'); assert.equal(dropped.adapterSession, old.adapterSession);
  h.component.addToRender(h.chat(31)); assert.equal(h.events().length, 1);
  h.wire(oldChat, 'wire-after'); h.component.addToRender(oldChat); h.component.addToRender(h.chat(31)); h.component.addToRender(h.chat(32)); h.runTo(500);
  assert.deepEqual(h.calls.map(chat => chat.no), [31, 32]); assert.equal(h.events().length, 2); h.stop();
});

for (const identicalText of [false, true]) test(`asynchronous native staging survives a same-room reset with its captured generation (identical text: ${identicalText})`, () => {
  const h = harness({ deferStaging: true }); h.control(true); h.component.addToRender(h.chat(40)); const old = h.events()[0];
  h.prepare(old, identicalText ? old.originalText : '你好');
  h.runTo(500); assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 0);
  h.video.seeking = true; h.runTo(750); h.video.seeking = false; h.runTo(1000);
  assert.notEqual(h.posted.filter(x => x.type === 'snapshot').at(-1).adapterSession, old.adapterSession);
  h.stageAll();
  assert.equal(h.rendered[0].settings.content, old.originalText);
  const delivered = h.posted.filter(x => x.type === 'delivered');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].adapterSession, old.adapterSession);
  assert.equal(delivered[0].resourceId, old.resourceId); assert.equal(delivered[0].translated, false);
  assert.equal(h.posted.filter(x => x.type === 'dropped').length, 0);
  h.component.addToRender(h.chat(40)); h.runTo(1500); h.stageAll();
  assert.equal(h.calls.length, 1); assert.equal(h.posted.filter(x => x.type === 'delivered').length, 1); h.stop();
});

test('asynchronous staging suppresses prepared text immediately on inactive playback before polling', () => {
  const h = harness({ deferStaging: true }); h.control(true); h.component.addToRender(h.chat(41)); const old = h.events()[0]; h.prepare(old);
  h.runTo(500); h.video.paused = true; h.stageAll();
  assert.equal(h.rendered[0].settings.content, old.originalText);
  assert.equal(h.posted.find(x => x.type === 'delivered').translated, false); h.stop();
});

test('disable hands back an original and restores hooks without inventing asynchronous delivery', () => {
  const h = harness({ deferStaging: true }); h.control(true); h.component.addToRender(h.chat(42)); h.prepare(h.events()[0]); h.control(false);
  assert.equal(h.calls.length, 1); assert.equal(h.component.addToRender, h.originalAdd);
  assert.deepEqual([...h.filters.keys()], ['existing-style']);
  assert.equal(h.posted.filter(x => x.type === 'delivered' || x.type === 'dropped').length, 0);
  h.stageAll(); assert.equal(h.rendered[0].settings.content, 'こんにちは42');
  assert.equal(h.posted.filter(x => x.type === 'delivered' || x.type === 'dropped').length, 0); h.stop();
});

test('lease expiry hands back pending originals before restoring native hooks', () => {
  const h = harness(); h.control(true); h.runTo(6100); h.component.addToRender(h.chat(45)); const old = h.events()[0]; h.prepare(old);
  h.runTo(6250);
  assert.equal(h.calls.length, 1); assert.equal(h.rendered[0].settings.content, old.originalText);
  assert.equal(h.component.addToRender, h.originalAdd); assert.deepEqual([...h.filters.keys()], ['existing-style']);
  assert.equal(h.posted.filter(x => x.type === 'dropped').length, 0);
  assert.equal(h.posted.find(x => x.type === 'delivered').adapterSession, old.adapterSession); h.stop();
});

test('native call failure never reports a delivered or cancelled submitted comment', async () => {
  const h = harness({ failAdd: true }); h.control(true); h.component.addToRender(h.chat(43)); h.runTo(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 0);
  assert.equal(h.posted.filter(x => x.type === 'delivered' || x.type === 'dropped').length, 0); h.stop();
});

test('player replacement and room navigation cancel only unsubmitted entries using their old resource', () => {
  for (const navigate of [false, true]) {
    const h = harness(); h.control(true); h.component.addToRender(h.chat(44)); const old = h.events()[0];
    if (navigate) h.location.pathname = '/watch/lv456'; else h.component.threadProcessor = {};
    h.runTo(250);
    assert.equal(h.calls.length, 0);
    const dropped = h.posted.filter(x => x.type === 'dropped');
    assert.equal(dropped.length, 1); assert.equal(dropped[0].reason, 'session-reset');
    assert.equal(dropped[0].resourceId, old.resourceId); assert.equal(dropped[0].adapterSession, old.adapterSession); h.stop();
  }
});

for (const status of ['chase', 'unknown']) test(`${status} live-status cancels pending work and returning LIVE translates only new sources`, () => {
  const h = harness(); h.control(true); h.component.addToRender(h.chat(50)); const old = h.events()[0]; h.prepare(old, '旧译文');
  h.runTo(100); h.liveState.status = status; h.runTo(250);
  const inactive = h.posted.filter(x => x.type === 'snapshot').at(-1);
  assert.equal(inactive.playback.atLiveEdge, false);
  assert.equal(inactive.playback.contentActive, true); assert.equal(inactive.playback.paused, false); assert.equal(inactive.playback.seeking, false);
  assert.equal(h.calls.length, 0); assert.equal(h.rendered.length, 0);
  const dropped = h.posted.filter(x => x.type === 'dropped');
  assert.equal(dropped.length, 1); assert.equal(dropped[0].reason, 'inactive');
  assert.equal(dropped[0].sourceId, old.sourceId); assert.equal(dropped[0].adapterSession, old.adapterSession);
  // Site-originated comments remain native originals while the extension establishes its no-catchup baseline.
  h.prepare(old, '迟到旧译文'); h.component.addToRender(h.chat(51));
  assert.equal(h.events().length, 1); assert.equal(h.posted.filter(x => x.type === 'delivered').length, 0);
  assert.equal(h.rendered.length, 1); assert.equal(h.rendered[0].settings.content, 'こんにちは51');
  h.liveState.status = 'live'; h.runTo(500);
  h.component.addToRender(h.chat(50)); h.component.addToRender(h.chat(51));
  const freshRaw = h.chat(52); h.component.addToRender(freshRaw); const fresh = h.events().at(-1); h.prepare(fresh, '恢复译文');
  assert.equal(h.events().length, 2); assert.notEqual(fresh.adapterSession, old.adapterSession);
  h.runTo(999); assert.equal(h.calls.length, 1); h.runTo(1000);
  assert.deepEqual(h.calls.map(chat => chat.no), [51, 52]); assert.equal(freshRaw.content, 'こんにちは52');
  assert.equal(h.rendered[1].settings.content, '恢复译文'); assert.equal(h.rendered[1].settings.color, '#ffff00');
  const delivered = h.posted.filter(x => x.type === 'delivered');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].translated, true); assert.equal(delivered[0].sourceId, fresh.sourceId);
  assert.equal(delivered[0].adapterSession, fresh.adapterSession); assert.equal(h.posted.filter(x => x.type === 'dropped').length, 1);
  h.runTo(1250); assert.equal(h.posted.filter(x => x.type === 'snapshot').at(-1).playback.atLiveEdge, true); h.stop();
});

for (const replacement of ['renderer', 'layers']) test(`${replacement} replacement rediscovers native hooks and delivers a fresh prepared source`, () => {
  const h = harness(); h.control(true); h.component.addToRender(h.chat(60)); const old = h.events()[0]; h.prepare(old, '旧渲染器译文');
  const next = h.createNativeLayer();
  if (replacement === 'renderer') h.component.renderer = { layerProcessorList: [next.layer] };
  else h.component.renderer.layerProcessorList = [next.layer];
  h.runTo(250);
  assert.equal(h.calls.length, 0); assert.equal(h.rendered.length, 0);
  assert.deepEqual([...h.filters.keys()], ['existing-style']);
  assert.equal(next.filters.has('danlingo-live-text-v1'), true);
  const dropped = h.posted.filter(x => x.type === 'dropped');
  assert.equal(dropped.length, 1); assert.equal(dropped[0].reason, 'session-reset');
  assert.equal(dropped[0].sourceId, old.sourceId); assert.equal(dropped[0].adapterSession, old.adapterSession);
  h.prepare(old, '迟到旧渲染器译文'); h.component.addToRender(h.chat(60));
  const freshRaw = h.chat(61); h.component.addToRender(freshRaw); const fresh = h.events().at(-1); h.prepare(fresh, '新渲染器译文');
  assert.equal(h.events().length, 2); assert.notEqual(fresh.adapterSession, old.adapterSession);
  h.runTo(749); assert.equal(h.calls.length, 0); h.runTo(750);
  assert.deepEqual(h.calls.map(chat => chat.no), [61]); assert.equal(freshRaw.content, 'こんにちは61');
  assert.equal(h.rendered.length, 1); assert.equal(h.rendered[0].settings.content, '新渲染器译文');
  assert.equal(h.rendered[0].settings.color, '#ffff00');
  const delivered = h.posted.filter(x => x.type === 'delivered');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].sourceId, fresh.sourceId); assert.equal(delivered[0].translated, true);
  assert.equal(delivered[0].adapterSession, fresh.adapterSession); assert.equal(h.posted.filter(x => x.type === 'dropped').length, 1);
  h.stop(); assert.deepEqual([...next.filters.keys()], ['existing-style']);
});

test('timeout retry hold sends one bounded request and delivers one translated native message', () => {
  const h = harness(); h.control(true, 500, {
    niconicoTimeoutRetryEnabled: true, niconicoTimeoutRetryExtraMs: 500, niconicoTimeoutRetryMode: 'hold',
  });
  h.component.addToRender(h.chat(70)); h.runTo(499); assert.equal(h.calls.length, 0); h.runTo(500);
  const request = h.posted.filter(row => row.type === 'repair-request').at(-1);
  assert.ok(request); assert.equal(h.posted.filter(row => row.type === 'repair-request').length, 1);
  assert.deepEqual({ strategy: request.strategy, manual: request.manual, force: request.force, purpose: request.purpose, timeoutMs: request.timeoutMs },
    { strategy: 'manual', manual: false, force: false, purpose: 'timeout', timeoutMs: 1000 });
  assert.equal(request.retryDeadlineAt, h.sandbox.performance.timeOrigin + 1500);
  assert.equal(h.calls.length, 0);
  h.repairResult(request, '二轮译文');
  assert.equal(h.calls.length, 1); assert.equal(h.rendered[0].settings.content, '二轮译文');
  assert.equal(h.posted.filter(row => row.type === 'delivered').length, 1);
  assert.equal(h.posted.find(row => row.type === 'delivered').translated, true);
  h.repairResult(request, '迟到重复'); h.runTo(2000);
  assert.equal(h.calls.length, 1); assert.equal(h.posted.filter(row => row.type === 'delivered').length, 1); h.stop();
});

test('timeout retry release presents the original once and ignores its late result', () => {
  const h = harness(); h.control(true, 500, {
    niconicoTimeoutRetryEnabled: true, niconicoTimeoutRetryExtraMs: 500, niconicoTimeoutRetryMode: 'release',
  });
  h.component.addToRender(h.chat(71)); h.runTo(500);
  const request = h.posted.filter(row => row.type === 'repair-request').at(-1);
  assert.ok(request); assert.equal(h.calls.length, 1); assert.equal(h.rendered[0].settings.content, 'こんにちは71');
  assert.equal(h.posted.filter(row => row.type === 'delivered').length, 1);
  assert.equal(h.posted.find(row => row.type === 'delivered').translated, false);
  h.repairResult(request, '不应重放'); h.runTo(2000);
  assert.equal(h.calls.length, 1); assert.equal(h.rendered.length, 1); assert.equal(h.posted.filter(row => row.type === 'delivered').length, 1); h.stop();
});

test('non-translatable native messages do not request an automatic timeout retry', () => {
  const h = harness(); h.control(true, 500, {
    niconicoTimeoutRetryEnabled: true, niconicoTimeoutRetryExtraMs: 500, niconicoTimeoutRetryMode: 'hold',
  });
  const raw = h.chat(72); raw.content = '123'; h.component.addToRender(raw); h.runTo(500);
  assert.equal(h.events()[0].translatable, false); assert.equal(h.posted.filter(row => row.type === 'repair-request').length, 0);
  assert.equal(h.calls.length, 1); assert.equal(h.rendered[0].settings.content, '123'); h.stop();
});

test('room change cancels a held retry and rejects its old result', () => {
  const h = harness(); h.control(true, 500, {
    niconicoTimeoutRetryEnabled: true, niconicoTimeoutRetryExtraMs: 500, niconicoTimeoutRetryMode: 'hold',
  });
  h.component.addToRender(h.chat(73)); const old = h.events()[0]; h.runTo(500);
  const request = h.posted.filter(row => row.type === 'repair-request').at(-1); assert.ok(request);
  h.location.pathname = '/watch/lv456'; h.runTo(750);
  const cancel = h.posted.find(row => row.type === 'repair-cancel' && row.requestId === request.requestId);
  assert.ok(cancel); assert.equal(cancel.sourceId, old.sourceId);
  const dropped = h.posted.find(row => row.type === 'dropped' && row.sourceId === old.sourceId);
  assert.equal(dropped.reason, 'session-reset'); assert.equal(h.calls.length, 0);
  h.repairResult(request, '迟到译文'); h.runTo(2000);
  assert.equal(h.calls.length, 0); assert.equal(h.posted.filter(row => row.type === 'delivered').length, 0); h.stop();
});
