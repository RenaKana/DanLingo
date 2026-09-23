import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';
import { timeoutRetryBudget } from '../../src/core/timeout-retry.ts';
import { translationIdentity } from '../../src/core/scheduler.ts';
import { BilibiliNativeQueue } from '../../src/platforms/bilibili-live/queue.ts';
import { BilibiliRepairs } from '../../src/platforms/bilibili-live/repairs.ts';
import { ordinaryComment } from '../../src/platforms/bilibili-live/messages.ts';
import { needsTranslation } from '../../src/core/messages.ts';

test('second attempt defaults off, adds 1s to the first budget, and preserves existing preferences/cache identity', () => {
  const before = normalizeSettings({ ...DEFAULT_SETTINGS, liveBufferMs: 2000, targetLanguage: 'en', concurrency: 12, requestTimeoutMs: 7000 });
  assert.equal(before.bilibiliTimeoutRetryEnabled, false);
  assert.equal(before.bilibiliTimeoutRetryExtraMs, 1000);
  assert.equal(before.bilibiliTimeoutRetryMode, 'hold');
  assert.equal(timeoutRetryBudget(2000, before.bilibiliTimeoutRetryExtraMs), 3000);
  const after = normalizeSettings({ ...before, bilibiliTimeoutRetryEnabled: true, bilibiliTimeoutRetryExtraMs: 2500, bilibiliTimeoutRetryMode: 'release' });
  assert.equal(after.targetLanguage, 'en'); assert.equal(after.concurrency, 12); assert.equal(after.requestTimeoutMs, 7000);
  assert.equal(translationIdentity(before), translationIdentity(after));
  assert.equal(after.bilibiliTimeoutRetryMode, 'release'); assert.equal(timeoutRetryBudget(2000, after.bilibiliTimeoutRetryExtraMs), 4500);
  for (const [value, expected] of [[-1, 0], [30001, 30000], [1250.9, 1250], [Infinity, 1000], ['2000', 1000]]) {
    assert.equal(normalizeSettings({ bilibiliTimeoutRetryExtraMs: value }).bilibiliTimeoutRetryExtraMs, expected);
  }
  assert.equal(normalizeSettings({ bilibiliTimeoutRetryEnabled: 'true', bilibiliTimeoutRetryMode: 'unknown' }).bilibiliTimeoutRetryEnabled, false);
  assert.equal(normalizeSettings({ bilibiliTimeoutRetryMode: 'unknown' }).bilibiliTimeoutRetryMode, 'hold');
});

function harness({ enabled = true, hold = true, extra = 1000, eligible = () => true } = {}) {
  let now = 0, sequence = 0, active = true, current = true;
  const timers = new Map(), sent = [], presented = [], decisions = [], removed = [];
  const ledger = new BilibiliRepairs({ now: () => now, active: () => active && current, eligible, timeoutMs: () => 15000, send: value => sent.push(value) });
  const queue = new BilibiliNativeQueue({ now: () => now, active: () => active, current: () => current, eligible,
    setTimeout(fn, ms) { timers.set(++sequence, { at: now + ms, fn }); return sequence; }, clearTimeout(id) { timers.delete(id); },
    source: source => ledger.capture(source), decision: d => { decisions.push(d); ledger.normal(d.source.sourceId, d.translated ? d.text : undefined, d); }, removed: ids => removed.push(...ids),
    retryPolicy: () => enabled ? { timeoutMs: timeoutRetryBudget(2000, extra), hold } : undefined,
    retry: (source, deadline) => ledger.requestTimeout(source.sourceId, deadline - now), cancelRetry: id => ledger.cancelTimeout(id) });
  const add = (id = 'opaque-A', text = '保存的原文', translatable = true) => {
    const style = [0, 1]; style[15] = { extra: JSON.stringify({ id_str: id, animation: {} }) };
    const source = ordinaryComment({ cmd: 'DANMU_MSG', info: [style, text] }, 'occ:1'); source.translatable = translatable;
    queue.add(source, 2000, packet => presented.push({ id, text: packet.info[1], at: now })); return source;
  };
  const advance = ms => {
    const end = now + ms;
    for (let i = 0; i < 10000; i++) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) { now = end; return; }
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    throw new Error('unbounded timer loop');
  };
  const request = id => sent.findLast(row => row.type === 'repair-request' && row.sourceId === 'dm:' + id);
  const reply = (id = 'opaque-A', text = '第二轮译文', status = 'translated') => {
    const r = request(id); assert.ok(r); const record = ledger.get(r.sourceId);
    const accepted = ledger.result({ ...r, text, status });
    if (accepted && record) queue.retryResult(record.sourceId, record.originalText, record.state === 'translated' ? record.text : undefined);
    return accepted;
  };
  return { ledger, queue, sent, presented, decisions, removed, add, advance, request, reply,
    jump(ms) { now += ms; queue.pump(); }, inactive() { active = false; queue.pump(); }, leave() { current = false; queue.pump(); } };
}

test('off keeps original first deadline and never retries; successful/special messages do not retry', () => {
  const off = harness({ enabled: false }); off.add(); off.advance(2000);
  assert.deepEqual(off.presented, [{ id: 'opaque-A', text: '保存的原文', at: 2000 }]); assert.equal(off.request('opaque-A'), undefined);
  assert.equal(off.ledger.get('dm:opaque-A').state, 'expired');
  const h = harness(); h.add('ready'); h.queue.prepare('dm:ready', '保存的原文', '首轮译文'); h.add('special', '原生特殊内容', false); h.advance(10000);
  assert.equal(h.sent.filter(r => r.type === 'repair-request').length, 0); assert.equal(h.presented.length, 2);
});

for (const policy of [{ enabled: false }, { enabled: true, hold: true }, { enabled: true, hold: false }]) {
  test(`Chinese-to-Chinese and symbols remain unneeded with timeout retry ${JSON.stringify(policy)}`, () => {
    const h = harness({ ...policy, eligible: text => needsTranslation(text, 'zh-Hans', 'zh') });
    const texts = ['何意味', '论文我去', '论文吗', '?', '走走走', 'www草！！！'];
    for (const [i, text] of texts.entries()) h.add('unneeded-' + i, text);
    h.advance(10000);
    assert.deepEqual(h.presented.map(row => row.text), texts);
    assert.ok(h.decisions.every(row => row.eligible === false && row.reason === 'ready' && !row.translated));
    for (const i of texts.keys()) {
      const id = 'dm:unneeded-' + i, record = h.ledger.get(id);
      assert.equal(record.state, 'unneeded'); assert.equal(record.text, undefined);
      assert.equal(h.sent.findLast(row => row.type === 'repair-record' && row.sourceId === id).state, 'unneeded');
    }
    assert.equal(h.decisions.filter(row => row.reason === 'timeout').length, 0);
    assert.equal(h.sent.filter(row => row.type === 'repair-request').length, 0);
  });
}

test('unneeded tail stays unneeded even when a held head exceeds the original deadline', () => {
  const h = harness({ eligible: text => needsTranslation(text, 'zh-Hans') });
  h.add('head', 'これは翻訳が必要です'); h.add('tail', '这条无需翻译'); h.advance(5000);
  assert.deepEqual(h.presented.map(row => row.id), ['head', 'tail']);
  assert.equal(h.ledger.get('dm:head').state, 'expired');
  assert.equal(h.ledger.get('dm:tail').state, 'unneeded');
  assert.equal(h.decisions.filter(row => row.reason === 'timeout').length, 1);
  assert.equal(h.request('tail'), undefined);
});

for (const reason of ['handoff', 'overload']) test(`${reason} is not reported as a translation timeout`, () => {
  const h = harness({ eligible: text => needsTranslation(text, 'zh-Hans') });
  h.add('pending', 'これは翻訳が必要です'); h.add('tail', '这条无需翻译'); h.queue.flush(reason);
  assert.ok(h.decisions.every(row => row.reason === reason));
  assert.equal(h.ledger.get('dm:pending').state, 'failed');
  assert.equal(h.ledger.get('dm:tail').state, 'unneeded');
  assert.equal(h.sent.filter(row => row.type === 'repair-request').length, 0);
});

test('unneeded originals can still be manually forced without a normal release overwriting the result', () => {
  const h = harness({ eligible: text => needsTranslation(text, 'zh-Hans') });
  h.add('manual', '这条无需翻译');
  assert.equal(h.ledger.get('dm:manual').state, 'unneeded');
  const requestId = h.ledger.request('dm:manual', true, true), request = h.request('manual');
  assert.ok(requestId); assert.equal(request.originalText, '这条无需翻译'); assert.equal(request.force, true);
  assert.equal(h.ledger.result({ sourceId: 'dm:manual', requestId, status: 'translated', text: '手动重译结果' }), true);
  h.ledger.normal('dm:manual', undefined, h.decisions[0]);
  assert.equal(h.ledger.get('dm:manual').state, 'translated');
  assert.equal(h.ledger.get('dm:manual').text, '手动重译结果');
});

test('a successful unchanged result is translated, not a timeout or a language skip', () => {
  const h = harness(); h.add('same', 'Shared name'); h.queue.prepare('dm:same', 'Shared name', 'Shared name', true);
  assert.equal(h.ledger.get('dm:same').state, 'translated');
  assert.equal(h.decisions[0].reason, 'ready'); assert.equal(h.decisions[0].cached, true);
});

test('hold starts once at first deadline, ignores first-round fallbacks/late results, and releases distinct second text once', () => {
  const h = harness(); h.add(); h.advance(2000);
  assert.equal(h.presented.length, 0); const request = h.request('opaque-A');
  assert.equal(request.retryDeadlineAt, 5000); assert.equal(request.manual, false); assert.equal(request.force, false); assert.equal(request.purpose, 'timeout');
  h.queue.original('dm:opaque-A', '保存的原文'); assert.equal(h.presented.length, 0);
  assert.equal(h.queue.prepare('dm:opaque-A', '保存的原文', '旧首轮结果'), false);
  assert.equal(h.ledger.requestTimeout('dm:opaque-A', 3000), false);
  h.advance(2400); assert.equal(h.reply(), true);
  assert.deepEqual(h.presented, [{ id: 'opaque-A', text: '第二轮译文', at: 4400 }]);
  assert.equal(h.ledger.get('dm:opaque-A').resultVersion, 1);
  h.advance(10000); assert.equal(h.presented.length, 1); assert.equal(h.sent.filter(r => r.type === 'repair-request').length, 1);
});

test('held head preserves a timely translated tail instead of expiring it while waiting in native order', () => {
  const h = harness(); h.add('head'); h.advance(100); h.add('tail');
  h.queue.prepare('dm:tail', '保存的原文', '及时尾部译文'); h.advance(3900);
  assert.equal(h.presented.length, 0); h.reply('head', '第二轮头部译文');
  assert.deepEqual(h.presented.map(r => [r.id, r.text]), [['head', '第二轮头部译文'], ['tail', '及时尾部译文']]);
  assert.equal(h.request('tail'), undefined);
});

test('second timeout/failure falls back and cannot loop or accept late second results', () => {
  const h = harness(); h.add(); h.advance(5000);
  assert.equal(h.presented[0].at, 5000); assert.equal(h.presented[0].text, '保存的原文'); assert.equal(h.decisions[0].reason, 'timeout');
  assert.equal(h.reply(), false); h.advance(20000); assert.equal(h.presented.length, 1);
  assert.equal(h.sent.filter(r => r.type === 'repair-request').length, 1);
  const failed = harness(); failed.add(); failed.advance(2000); failed.reply('opaque-A', undefined, 'failed');
  assert.equal(failed.presented[0].text, '保存的原文'); assert.equal(failed.presented[0].at, 2000);
});

test('release mode submits original at first deadline and retains second result without replaying the native occurrence', () => {
  const h = harness({ hold: false }); h.add(); h.advance(2000);
  assert.equal(h.presented[0].text, '保存的原文'); assert.equal(h.presented[0].at, 2000);
  h.ledger.confirm('dm:opaque-A', '保存的原文'); h.advance(1000); h.reply();
  const record = h.ledger.get('dm:opaque-A');
  assert.equal(record.automaticUpdate, true); assert.equal(record.displayedText, '保存的原文'); assert.equal(record.text, '第二轮译文');
  assert.equal(record.manualPriority, false); h.advance(10000); assert.equal(h.presented.length, 1);
});

test('delay before retry uses remaining absolute budget, not a restarted full timer', () => {
  const h = harness(); h.add(); h.jump(4200);
  assert.equal(h.request('opaque-A').retryDeadlineAt, 5000); h.advance(800); assert.equal(h.presented[0].at, 5000);
  const stalled = harness(); stalled.add(); stalled.jump(6000);
  assert.equal(stalled.request('opaque-A'), undefined); assert.equal(stalled.presented[0].text, '保存的原文');
});

test('handoff cancels held attempt and releases original; old room discards it and rejects late token', () => {
  const h = harness(); h.add(); h.advance(2000); h.inactive();
  assert.equal(h.presented[0].text, '保存的原文'); assert.equal(h.decisions[0].reason, 'handoff'); assert.equal(h.reply(), false);
  const old = harness(); old.add(); old.advance(2000); old.leave();
  assert.equal(old.presented.length, 0); assert.deepEqual(old.removed, ['dm:opaque-A']); assert.equal(old.reply(), false);
});

test('manual supersession owns its token and expired/deleted records cannot start another automatic attempt', () => {
  const h = harness(); h.add(); h.advance(2000); const old = h.request('opaque-A');
  const manual = h.ledger.request('dm:opaque-A', true, true);
  assert.notEqual(manual, old.requestId);
  assert.equal(h.ledger.result({ ...old, status: 'translated', text: '旧自动结果' }), false);
  h.ledger.result({ sourceId: 'dm:opaque-A', requestId: manual, status: 'translated', text: '手动新结果' });
  assert.equal(h.ledger.get('dm:opaque-A').text, '手动新结果');
  assert.equal(h.ledger.requestTimeout('dm:opaque-A', 3000), false);
  h.ledger.remove(['dm:opaque-A']); assert.equal(h.ledger.requestTimeout('dm:opaque-A', 3000), false);
  h.ledger.capture({ sourceId: 'sc:1', nativeId: '1', originalText: 'SC' }, { expiresAt: 60000 });
  assert.equal(h.ledger.requestTimeout('sc:1', 3000), false);
});
