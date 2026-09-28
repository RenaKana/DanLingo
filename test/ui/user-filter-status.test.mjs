import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../src/i18n/text.ts';
import { userFilterSourceLabel, userFilterStatusText } from '../../src/ui/user-filter-status.ts';

const categories = () => ({
  keyword: { status: 'ready', total: 3, enabled: 2, supported: 2 },
  regexp: { status: 'ready', total: 3, enabled: 2, supported: 2, degraded: 0,
    details: [{ id: 'R1', supported: true, reason: 'work-limit', oldReason: 'quantifier',
      features: ['quantifier'], flags: 'i', nativeValid: true }] },
  sender: { status: 'ready', total: 1, enabled: 1, supported: 1 },
  account: { status: 'unknown', total: 1, enabled: 1, supported: 0, reason: 'account-blacklist-is-not-danmaku-sender-list' },
});

test('declared coverage and sampled candidate hits remain distinct from native observations', () => {
  setLocale('zh-CN');
  const view = { connected: true, stale: false, featureEnabled: true, resourceId: 'av123:cid456', tabId: 12,
    summary: { nativeEnabled: true, readEvidence: { listComplete: true }, categories: categories(),
      sampledHits: { keyword: 4, regexp: 1, sender: 0 }, natural: { matchedUserBranch: 8 } } };
  const result = userFilterStatusText(view);
  assert.equal(result.state, '已声明类别全部覆盖');
  assert.equal(result.source, 'av123 · cid456 · 标签页 12');
  assert.match(result.rows[1].value, /已启用 2.*可支持 2.*不支持 0.*降级 0/);
  assert.match(result.rows[2].value, /可支持 1/);
  assert.match(result.rows[3].value, /未知/);
  assert.match(result.sampled, /关键词 4.*正则 1.*发送者 0/);
  assert.equal(result.nativeBranch, '观察到原生规则分支 8 次');
  assert.match(result.details[0], /R1.*支持.*匹配工作量超过限制.*原分类.*暂不支持量词/);
});

test('disabled, disconnected, stale, failed reads and incomplete coverage are distinguishable', () => {
  setLocale('zh-CN');
  const base = { connected: true, stale: false, featureEnabled: true, summary: {
    nativeEnabled: true, readEvidence: { listComplete: true }, categories: categories() } };
  assert.equal(userFilterStatusText({ ...base, featureEnabled: false }).state, '功能已关闭');
  assert.equal(userFilterStatusText({ ...base, summary: { ...base.summary, nativeEnabled: false } }).state, 'Bilibili 原生屏蔽已关闭');
  assert.equal(userFilterStatusText({ ...base, connected: false }).state, '未连接视频标签页');
  assert.equal(userFilterStatusText({ ...base, stale: true }).state, '规则状态已过期');
  assert.equal(userFilterStatusText({ ...base, readFailed: true }).state, '规则状态读取失败');
  const incomplete = categories(); incomplete.regexp = { ...incomplete.regexp, status: 'partial', supported: 1 };
  assert.equal(userFilterStatusText({ ...base, summary: { ...base.summary, categories: incomplete } }).state,
    '已声明类别部分覆盖');
  const degraded = categories(); degraded.regexp.degraded = 1;
  assert.equal(userFilterStatusText({ ...base, summary: { ...base.summary, categories: degraded } }).state,
    '已声明类别部分覆盖');
  assert.equal(userFilterStatusText({ ...base, summary: { ...base.summary, suppressedCategories: ['sender'] } }).state,
    '已声明类别部分覆盖');
  assert.equal(userFilterStatusText({ ...base, summary: { ...base.summary,
    readEvidence: { listComplete: false } } }).read, '规则列表不完整');
});

test('unknown locale falls back to English and untrusted source/rule fields do not render', () => {
  setLocale('de');
  const result = userFilterStatusText({ connected: true, stale: false, featureEnabled: true,
    resourceId: '<private video text>', summary: { nativeEnabled: true, readEvidence: { listComplete: false },
      categories: { ...categories(), regexp: { ...categories().regexp,
        details: [{ id: '<script>', supported: false, reason: 'unexpected private rule body',
          oldReason: 'private comment', features: ['private body'], flags: 'private', nativeValid: false }] } } } });
  assert.equal(result.source, 'Video');
  assert.equal(result.state, 'Coverage unconfirmed');
  assert.match(result.details[0], /R\?.*Reason unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /<script>|private body|private comment|unexpected private rule body/);
  assert.equal(userFilterSourceLabel('av1:cid2', 3), 'av1 · cid2 · Tab 3');
});
