import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../src/i18n/text.ts';
import { displayPlanText } from '../../src/ui/display-plan.ts';

const preview = () => ({
  enabled: true, connected: true, resourceId: 'av123:cid456', status: 'preview',
  parameters: { lookaheadMs: 10000, freezeMs: 5000, bucketMs: 1000, limit: 2 },
  frozenBuckets: 4, selected: 6, translationNeeded: 3, unknown: 2,
  upcoming: [{ id: 'dmid-1', mediaTimeMs: 12000, originalText: 'PRIVATE ORIGINAL 日本語',
    unknown: true, needsTranslation: true }],
  reasons: { userExcluded: 2, outOfScope: 1, unsupportedType: 3, densityNotSelected: 4,
    lateArrival: 5, expired: 6, snapshotInvalid: 7, outsideWindow: 8, nativeFiltered: 9 },
});

test('preview summary keeps display events, translation demand and unknown separate', () => {
  setLocale('zh-CN');
  const text = displayPlanText(preview());
  assert.equal(text.title, '显示名单规划（仅预览）');
  assert.equal(text.state, '预览就绪');
  assert.equal(text.resource, '视频 · av123 · cid456');
  assert.match(text.parameters, /前瞻 10 视频秒.*提前冻结 5 视频秒.*时间桶 1 视频秒.*每桶上限 2/);
  assert.match(text.counts, /当前 epoch 累计冻结桶 4.*累计拟选 6.*待到期需译 3.*待到期未知 2/);
  for (const reason of ['用户排除 2', '范围外 1', '类型不支持 3', '密度未选 4', '晚到 5', '已过期 6', '快照失效 7', '时间窗外 8', '原生已过滤 9'])
    assert.ok(text.reasons.includes(reason), reason);
  assert.equal(text.notice, '仅预览 DanLingo 拟选名单；不改变原生显示，不调用翻译模型。部分用户规则尚未覆盖，名单不是原生最终准入结果。');
  assert.doesNotMatch(JSON.stringify(text), /PRIVATE ORIGINAL|dmid-1/);
});

test('disabled, disconnected and failed views do not retain counts or content', () => {
  setLocale('zh-CN');
  const base = preview();
  for (const value of [null, { ...base, enabled: false }, { ...base, connected: false }]) {
    const text = displayPlanText(value);
    assert.equal(text.enabled, false);
    assert.equal(text.counts, '');
    assert.equal(text.parameters, '');
    assert.equal(text.reasons, '');
    assert.doesNotMatch(JSON.stringify(text), /PRIVATE ORIGINAL|dmid-1/);
  }
  assert.equal(displayPlanText({ ...base, enabled: false }).state, '已关闭');
  assert.equal(displayPlanText({ ...base, connected: false }).state, '视频未连接');
  assert.equal(displayPlanText({ ...base, error: 'PRIVATE SERVER BODY' }).state, '预览状态读取失败');
  assert.equal(displayPlanText({ ...base, error: 'PRIVATE SERVER BODY' }).counts, '');
  assert.doesNotMatch(JSON.stringify(displayPlanText({ ...base, error: 'PRIVATE SERVER BODY' })), /PRIVATE SERVER BODY/);
});

test('truncation and recognized stop reasons remain visible without stale plan data', () => {
  setLocale('zh-CN');
  const base = preview();
  const truncated = displayPlanText({ ...base, truncated: true });
  assert.equal(truncated.state, '预览就绪 · 记录已截断，计数可能不完整');
  assert.equal(truncated.hasData, true);
  for (const [stopReason, state] of [
    ['cleanup', '清理后已停止'], ['invalidated', '视频上下文变化，规划已停止'],
    ['constructor', '规划已停止'],
  ]) {
    const stopped = displayPlanText({ ...base, status: 'stopped', stopReason, truncated: true });
    assert.equal(stopped.state, `${state} · 记录已截断，计数可能不完整`);
    assert.equal(stopped.hasData, false);
    assert.equal(stopped.counts, '');
    assert.equal(stopped.parameters, '');
    assert.equal(stopped.reasons, '');
    assert.doesNotMatch(JSON.stringify(stopped), /PRIVATE ORIGINAL|dmid-1|constructor/);
  }
  for (const status of ['invalid', 'snapshot-invalid', 'stale']) {
    const invalid = displayPlanText({ ...base, status });
    assert.equal(invalid.hasData, false);
    assert.equal(invalid.counts, '');
    assert.equal(invalid.reasons, '');
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE ORIGINAL|dmid-1/);
  }
});

test('unknown locale uses English, and unexpected resource/reason values stay private', () => {
  setLocale('de');
  const result = displayPlanText({ ...preview(), resourceId: '<private resource>',
    parameters: { lookaheadMs: NaN, freezeMs: -1, bucketMs: 1000, limit: null },
    reasons: { 'private-rule-body': 10, 'late-arrival': 2 } });
  assert.equal(result.state, 'Preview ready');
  assert.equal(result.resource, 'Video · Video identity unavailable');
  assert.match(result.parameters, /Lookahead —.*freeze —.*bucket 1.*limit none/);
  assert.equal(result.reasons, 'Late arrival 2');
  assert.doesNotMatch(JSON.stringify(result), /private resource|private-rule-body|PRIVATE ORIGINAL/);
  const stopped = displayPlanText({ ...preview(), enabled: false, status: 'stopped', stopReason: 'invalidated' });
  assert.equal(stopped.state, 'Stopped because the video context changed');
  assert.equal(stopped.counts, '');
  assert.match(result.counts, /Current epoch frozen buckets 4.*total proposed 6.*pending due needing translation 3.*pending due with unknown rule coverage 2/);
});
