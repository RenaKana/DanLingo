import test from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryComment, translatedPacket, superChatSource, deletedSuperChats } from '../../src/platforms/bilibili-live/messages.ts';
import { BilibiliNativeQueue } from '../../src/platforms/bilibili-live/queue.ts';
import { BilibiliRepairs } from '../../src/platforms/bilibili-live/repairs.ts';
import { hookMethod, optionalObserver } from '../../src/platforms/bilibili-live/hook.ts';
import { captureNativeDispatch } from '../../src/platforms/bilibili-live/dispatch.ts';

const packet = (id, text = 'これは日本語のコメントです', mode = 1, extra = {}) => {
  const style = [0, mode, 25, 0xffffff, 1234]; style[15] = { extra: JSON.stringify({ ...extra, id_str: id }) };
  return { cmd: 'DANMU_MSG', info: [style, text, [123, 'author']], untouched: true };
};
function harness() {
  let now = 0, seq = 0, current = true, screen = true, chat = true;
  const timers = new Map(), sources = [], decisions = [], submitted = [], removed = [];
  const queue = new BilibiliNativeQueue({ now: () => now, current: () => current, active: () => screen || chat, eligible: () => true,
    setTimeout(fn, ms) { timers.set(++seq, { at: now + ms, fn }); return seq; }, clearTimeout(id) { timers.delete(id); },
    source: s => sources.push(s), decision: d => decisions.push(d), removed: ids => removed.push(...ids) });
  return { queue, sources, decisions, submitted, removed,
    add(id, text, buffer = 2000) { const p = packet(id, text); queue.add(ordinaryComment(p, 'fallback'), buffer, p => submitted.push(p)); return p; },
    active(s, c) { screen = s; chat = c; }, current(value) { current = value; },
    advance(ms) { const end = now + ms; for (let n = 0; n < 2000; n++) { const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = end; },
    prepare(id, text = '译文') { const s = sources.find(s => s.sourceId === `dm:${id}`); return queue.prepare(s.sourceId, s.originalText, text); },
  };
}
test('wire parser preserves long ids, native metadata and original object; special messages remain native', () => {
  const input = packet('123456789012345678901'), before = structuredClone(input), s = ordinaryComment(input, 'occ:1');
  assert.equal(s.sourceId, 'dm:123456789012345678901'); assert.equal(s.translatable, true);
  const copy = translatedPacket(s, '长译文'); assert.equal(copy.info[1], '长译文'); assert.deepEqual(input, before);
  assert.deepEqual(copy.info[0], input.info[0]); assert.deepEqual(copy.info[2], input.info[2]);
  for (const mode of [1,4,5,6]) assert.equal(ordinaryComment(packet('1', undefined, mode), '').translatable, true);
  for (const mode of [2,3,7,8,9]) assert.equal(ordinaryComment(packet('1', undefined, mode), ''), null);
  const special = packet('2'); special.info[0][13] = { emoticon_unique: 'picture' };
  assert.equal(ordinaryComment(special, '').translatable, false);
  const noId = packet(null); assert.equal(ordinaryComment(noId, 'occ:99').sourceId, 'occ:99');
});
test('real empty animation metadata remains translatable while non-empty and array formats stay native', () => {
  const real = { emots: null, mode: 0, animation: {}, dm_type: 0 };
  const empty = ordinaryComment(packet(undefined, undefined, 4, real), 'occ:empty');
  assert.equal(empty?.sourceId, 'occ:empty');
  assert.equal(empty?.translatable, true);
  for (const animation of [{ duration: 120 }, [], ['move']]) {
    const special = ordinaryComment(packet(undefined, undefined, 4, { ...real, animation }), 'occ:special');
    assert.equal(special?.translatable, false);
  }
  for (const animation of [false, null, 0, '']) {
    const safe = ordinaryComment(packet(undefined, undefined, 4, { ...real, animation }), 'occ:safe');
    assert.equal(safe?.translatable, true);
  }
  const missing = { ...real }; delete missing.animation;
  assert.equal(ordinaryComment(packet(undefined, undefined, 4, missing), 'occ:missing')?.translatable, true);
});
test('duplicate no-id messages retain separate occurrences', () => {
  const h = harness(), real = { emots: null, mode: 0, animation: {}, dm_type: 0 };
  const first = ordinaryComment(packet(undefined, '同じ日本語のコメントです', 4, real), 'occ:1');
  const second = ordinaryComment(packet(undefined, '同じ日本語のコメントです', 4, real), 'occ:2');
  assert.equal(first?.translatable, true); assert.equal(second?.translatable, true);
  assert.equal(h.queue.add(first, 2000, p => h.submitted.push(p)), true);
  assert.equal(h.queue.add(second, 2000, p => h.submitted.push(p)), true);
  assert.deepEqual(h.sources.map(s => s.sourceId), ['occ:1', 'occ:2']);
  h.advance(2000);
  assert.deepEqual(h.submitted.map(p => p.info[1]), ['同じ日本語のコメントです', '同じ日本語のコメントです']);
});
test('custom wait beyond three seconds preserves the original arrival deadline', () => {
  const h = harness(); h.add('custom', undefined, 7500); h.advance(7499);
  assert.equal(h.submitted.length, 0); h.advance(1);
  assert.equal(h.decisions[0].releasedAt, 7500); assert.equal(h.decisions[0].reason, 'timeout');
  assert.equal(h.prepare('custom', '迟到'), false);
});
test('one dispatch supplies both native surfaces; distinct occurrences of identical text are retained', () => {
  const h = harness(); h.add('1'); h.add('2'); h.prepare('1'); h.prepare('2');
  assert.equal(h.sources.length, 2); assert.equal(h.submitted.length, 2); assert.ok(h.submitted.every(p => p.info[1] === '译文'));
  assert.deepEqual(h.decisions.map(d => d.source.sourceId), ['dm:1','dm:2']);
});
test('ready tail waits for head; original deadline includes all queue time, late results cannot rewrite', () => {
  const h = harness(); h.add('1'); h.advance(100); h.add('2'); h.prepare('2'); h.advance(1899);
  assert.equal(h.submitted.length, 0); h.advance(1);
  assert.deepEqual(h.decisions.map(d => [d.source.sourceId, d.translated, d.releasedAt]), [['dm:1',false,2000],['dm:2',true,2000]]);
  assert.equal(h.decisions[0].reason, 'timeout'); assert.equal(h.prepare('1','晚到'), false); h.advance(5000); assert.equal(h.submitted.length, 2);
});
test('one hidden or paused surface cannot cancel the other; both inactive hand off originals', () => {
  const h = harness(); h.add('1'); h.active(false, true); h.prepare('1'); assert.equal(h.decisions[0].translated, true);
  h.add('2'); h.active(true, false); h.prepare('2'); assert.equal(h.decisions[1].translated, true);
  h.add('3'); h.active(false, false); h.queue.pump(); assert.equal(h.decisions[2].reason, 'handoff');
});
test('native source mutation is isolated and old-room queue is abandoned', () => {
  const h = harness(), p = h.add('1'); p.info[1] = 'mutated'; h.advance(2000); assert.equal(h.submitted[0].info[1], 'これは日本語のコメントです');
  h.add('2'); h.current(false); h.advance(2000); assert.equal(h.submitted.length, 1); assert.deepEqual(h.removed, ['dm:2']);
});
test('fixed bounded queue overload hands off all occurrences instead of dropping them', () => {
  const h = harness(); for (let i = 1; i <= 1001; i++) h.add(String(i));
  assert.equal(h.submitted.length, 1000); assert.equal(h.queue.size, 1); assert.ok(h.decisions.every(d => d.reason === 'overload'));
  h.advance(2000); assert.equal(h.submitted.length, 1001);
});
function repairsHarness() {
  let now = 100000; const sent = [];
  const ledger = new BilibiliRepairs({ now: () => now, active: () => true, eligible: () => true, timeoutMs: () => 45000, send: row => sent.push(row) });
  return { ledger, sent, advance(ms) { now += ms; ledger.prune(); }, now: () => now };
}
test('SC deletion is final; pin expiry cancels automatic work but retains saved original for manual history repair', () => {
  const h = repairsHarness();
  const p = { cmd: 'SUPER_CHAT_MESSAGE', data: { id: 7, message: '応援しています', end_time: 200 } };
  const source = superChatSource(p, h.now()); h.ledger.capture(source, source); const id = h.ledger.request('sc:7', false);
  h.advance(20000); assert.equal(h.ledger.get('sc:7').request.id, id);
  assert.equal(h.sent.find(r => r.type === 'repair-request').strategy, 'superchat');
  h.ledger.remove(deletedSuperChats({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [7] } }));
  assert.equal(h.ledger.result({ sourceId:'sc:7', requestId:id, status:'translated', text:'迟到' }), false);
  assert.equal(h.ledger.capture(source, source), undefined);
  const later = { ...source, sourceId:'sc:8', nativeId:'8', expiresAt:h.now()+1000 }; h.ledger.capture(later, later); h.ledger.request('sc:8',false);
  h.advance(1000); assert.equal(h.ledger.get('sc:8').state,'expired'); assert.equal(h.ledger.get('sc:8').request,undefined);
  assert.equal(h.ledger.request('sc:8',false),undefined);
  const manual=h.ledger.request('sc:8',true,true); assert.ok(manual);
  assert.equal(h.ledger.result({sourceId:'sc:8',requestId:manual,status:'translated',text:'历史留言重翻'}),true);
  assert.equal(superChatSource(p, 200000),null);
});
test('repair clicks coalesce, forced retry owns the new token, and normal response cannot overwrite manual result', () => {
  const h = repairsHarness(); h.ledger.capture({sourceId:'dm:1',originalText:'保存された原文'});
  const first=h.ledger.request('dm:1',true); assert.equal(h.ledger.request('dm:1',true),first);
  const forced=h.ledger.request('dm:1',true,true); assert.notEqual(forced,first);
  assert.equal(h.ledger.result({sourceId:'dm:1',requestId:first,status:'translated',text:'旧结果'}),false);
  assert.equal(h.ledger.result({sourceId:'dm:1',requestId:forced,status:'translated',text:'新结果'}),true);
  h.ledger.normal('dm:1','普通旧结果'); assert.equal(h.ledger.get('dm:1').text,'新结果');
  assert.ok(h.sent.filter(r=>r.type==='repair-request').every(r=>r.originalText==='保存された原文'));
});
test('native hook retains receiver, arguments, result, exception and restores only its own descriptor',()=>{
  const owner={method(value){assert.equal(this,owner);if(value==='throw')throw new Error('native');return value;}};
  const descriptor=Object.getOwnPropertyDescriptor(owner,'method');
  const hook=hookMethod(owner,'method',original=>function(){return Reflect.apply(original,this,arguments);});
  assert.equal(owner.method(9),9); assert.throws(()=>owner.method('throw'),/native/); assert.equal(hook.restore(),true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(owner,'method'),descriptor);
  const laterHook=hookMethod(owner,'method',original=>function(){return Reflect.apply(original,this,arguments);});
  const later=()=>10; owner.method=later; assert.equal(laterHook.restore(),false); assert.equal(owner.method,later);
  const optional=optionalObserver(owner,'observer',original=>function(){return Reflect.apply(original,this,arguments);});
  assert.equal(owner.observer({cmd:'OTHER'}),undefined); optional.restore(); assert.equal('observer' in owner,false);
});
test('native decoder and filtering see the original exactly once before shared output is queued',()=>{
  const outputs=[],filters=[],input=packet('88'),source=ordinaryComment(input,'fallback');
  const owner={add(value,flag){assert.equal(this,owner);outputs.push(['screen',value,flag]);}},engine={danmaku:owner};
  const context={isBlocked(value){assert.equal(this,context);filters.push(value.text);return false;},emitDanmaku(value){assert.equal(this,context);outputs.push(['chat',value]);},toRender(){assert.equal(this,context);outputs.push(['render']);}};
  let nativeCalls=0;const original=function(p,c){assert.equal(this,engine);nativeCalls++;const decoded={text:p.info[1],size:25};if(c.isBlocked(decoded))return;c.emitDanmaku({...p,cmd:'DANMU_MSG'});this.danmaku.add(decoded,false);c.toRender();return 'native-result';};
  const savedAdd=owner.add,captured=captureNativeDispatch(engine,context,original,[input,context],source);
  assert.deepEqual(filters,[source.originalText]);assert.equal(outputs.length,0);assert.equal(nativeCalls,1);assert.equal(owner.add,savedAdd);assert.equal(captured.result,'native-result');
  captured.submit(translatedPacket(source,'新的译文'));captured.submit(input);
  assert.deepEqual(outputs.map(o=>o[0]),['chat','screen','render']);assert.equal(outputs[0][1].info[1],'新的译文');assert.deepEqual(outputs[1][1],{text:'新的译文',size:25});assert.equal(outputs[1][2],false);assert.equal(input.info[1],source.originalText);
  const blocked={...context,isBlocked:value=>value.text===source.originalText};
  const stopped=captureNativeDispatch(engine,blocked,original,[input,blocked],source);assert.equal(stopped.translatable,false);stopped.submit(input);assert.equal(outputs.length,3);
});
test('unrecognized decoded screen shape hands off original, and a native throw never invokes decoder twice',()=>{
  const seen=[],owner={add:v=>seen.push(v)},engine={danmaku:owner},p=packet('9'),s=ordinaryComment(p,'fallback'),ctx={isBlocked:()=>false,emitDanmaku:()=>{}};
  const before=owner.add,captured=captureNativeDispatch(engine,ctx,function(){this.danmaku.add({unknown:true});},[p,ctx],s);
  assert.equal(captured.translatable,false);captured.submit(p);assert.deepEqual(seen,[{unknown:true}]);assert.equal(owner.add,before);
  let calls=0;assert.throws(()=>captureNativeDispatch(engine,ctx,function(){calls++;this.danmaku.add({text:s.originalText});throw Error('native-failure');},[p,ctx],s),/native-failure/);
  assert.equal(calls,1);assert.equal(owner.add,before);assert.equal(seen.length,2);
});
