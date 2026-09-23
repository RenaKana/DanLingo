import test from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryMessageId, decimalId, ordinaryComment, superChatSource } from '../../src/platforms/bilibili-live/messages.ts';
import { BilibiliRepairs } from '../../src/platforms/bilibili-live/repairs.ts';
import { nativeMetrics } from '../../src/core/live-metrics.ts';
import { liveStatusText } from '../../src/ui/live-status.ts';

test('ordinary opaque IDs retain alphabetic digits, leading zeros and case without weakening room/SC IDs', () => {
  for (const id of ['0123456789abcdef0123456789abcdefABC', '123456789012345678901234567890', '0', 'Aa-_09']) {
    assert.equal(ordinaryMessageId(id), id);
    const style = [0, 1]; style[15] = { extra: JSON.stringify({ id_str: id, animation: {} }) };
    const result = ordinaryComment({ cmd: 'DANMU_MSG', info: [style, '原文'] }, 'occ:1');
    assert.equal(result.sourceId, 'dm:' + id); assert.equal(result.nativeId, id);
  }
  for (const invalid of [undefined, null, 123, {}, [], '', 'a b', 'a\nb', 'x:y', '你好', 'x'.repeat(129)]) assert.equal(ordinaryMessageId(invalid), null);
  assert.equal(decimalId('deadbeef123'), null); assert.equal(decimalId('00123'), null);
  assert.equal(superChatSource({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 'abc', message: '原文', end_time: 100 } }, 0), null);
});

function ledger() {
  let now = 0; const events = [];
  const repairs = new BilibiliRepairs({ now: () => now, active: () => true, eligible: () => true, timeoutMs: () => 45000, send: event => events.push(event) });
  repairs.capture({ sourceId: 'dm:abc', nativeId: 'abc', originalText: '保存的原文' });
  return { repairs, events, advance: ms => { now += ms; repairs.prune(); } };
}
test('automatic A is generated first, confirmed independently, then first forced B preserves the old display baseline', () => {
  const { repairs, events } = ledger();
  repairs.normal('dm:abc', 'automatic A');
  const record = repairs.get('dm:abc');
  assert.equal(record.text, 'automatic A'); assert.equal(record.displayedText, undefined);
  assert.equal(record.application, 'generated');
  repairs.confirm('dm:abc', 'automatic A');
  const requestId = repairs.request('dm:abc', true, true);
  assert.equal(events.filter(e => e.type === 'repair-request').at(-1).originalText, '保存的原文');
  assert.equal(repairs.result({ sourceId: 'dm:abc', requestId, status: 'translated', text: 'forced B' }), true);
  assert.equal(record.displayedText, 'automatic A'); assert.equal(record.text, 'forced B');
  assert.equal(record.resultVersion, 2); assert.equal(record.application, 'generated');
  repairs.confirm('dm:abc', 'forced B'); repairs.applied('dm:abc', 2, true);
  assert.equal(record.displayedText, 'forced B'); assert.equal(record.application, 'native-updated');
  assert.equal(repairs.applied('dm:abc', 1, true), false);
  assert.equal(repairs.applied('dm:abc', 2, true), false, 'multiple cards do not repeat the same receipt');
});
test('cancel and replacement own the request token; old results cannot update targets or revive removed records', () => {
  const { repairs } = ledger(); const a = repairs.request('dm:abc', true);
  assert.equal(repairs.request('dm:abc', true), a);
  const b = repairs.request('dm:abc', true, true);
  assert.notEqual(a,b); repairs.abort('dm:abc',a);
  assert.equal(repairs.get('dm:abc').request.id,b);
  assert.equal(repairs.result({sourceId:'dm:abc',requestId:a,status:'translated',text:'stale'}),false);
  repairs.abort('dm:abc', b); assert.equal(repairs.get('dm:abc').request, undefined);
  assert.equal(repairs.result({sourceId:'dm:abc',requestId:b,status:'translated',text:'cancelled'}),false);
  const c=repairs.request('dm:abc',true); repairs.remove(['dm:abc']);
  assert.equal(repairs.result({sourceId:'dm:abc',requestId:c,status:'translated',text:'deleted'}),false);
});
test('record-only manual result is not falsely counted as native presentation', () => {
  const { repairs, events } = ledger(); const requestId=repairs.request('dm:abc',true);
  repairs.result({sourceId:'dm:abc',requestId,status:'translated',text:'new'});
  repairs.applied('dm:abc',1,false);
  assert.equal(repairs.get('dm:abc').displayedText,undefined);
  assert.equal(events.at(-1).application,'recent-only');
});
test('Bilibili display scope and unconfirmed counters remain distinct from actual dropped messages', () => {
  const input={received:4,submitted:4,presented:2,translated:1,original:1,timedOut:1,overloaded:0,removed:0,abandoned:0,pending:0,translatedChars:2,cachedTranslated:0,observationMs:1,
    unconfirmed:2,repaired:3,repairApplied:1,readinessMs:{p50:1,p95:1,p99:1,samples:1},releaseDelayMs:{p50:1,p95:1,p99:1,samples:1}};
  assert.deepEqual(nativeMetrics(input),input);
  assert.equal(nativeMetrics({...input,unconfirmed:-1}),undefined);
  const text=liveStatusText({platform:'bilibili',scenario:'live',state:'ready',connection:'connected',messages:4,translated:1,original:1,cacheHits:0,queued:0,dropped:0,liveMetrics:input});
  assert.match(text.metrics,/聊天译文 1/); assert.match(text.metrics,/显示未确认 2/); assert.doesNotMatch(text.metrics,/丢弃/);
  assert.match(text.coverage,/不含屏幕弹幕和醒目留言/);
});
