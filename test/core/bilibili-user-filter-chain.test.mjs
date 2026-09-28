import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBilibiliUserRules } from '../../src/platforms/bilibili/user-filters.ts';
import { simulateUserFilterDemand } from '../../src/diagnostics/user-filter-simulation.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const source = (id, originalText, mediaTimeMs = 2000) => ({
  id, sourceId: id, resourceId: 'BV-fixture', threadId: '1', fork: 'main', platform: 'bilibili',
  originalText, mediaTimeMs, renderAtMs: mediaTimeMs - 2000, translatable: true,
  style: { position: 'scroll', size: 'normal', color: '#fff', font: '', commands: [] },
});
const clock = { mediaTimeMs: 0, playbackRate: 1, paused: true, seeking: false, contentActive: true,
  durationMs: 600000, buffered: [] };

function matched(sources, native, rules) {
  const matcher = compileBilibiliUserRules({ scope: 'fixture-session', revision: 3,
    verified: true, enabled: true, complete: true, rules });
  return sources.map((event, index) => ({ id: event.id, originalText: event.originalText,
    ...matcher.match(native[index]) }));
}

for (const backend of ['online', 'local']) {
  test(`${backend} matcher decisions reach an isolated scheduler and provider without overstating shared-text savings`, async () => {
    const a = source('blocked-author', '共有テストです'), b = source('retained-author', '共有テストです');
    const keyword = source('keyword', '秘密の文章です'), regexp = source('regexp', '画面の文章です');
    const unknown = source('unknown', '普通の文章です');
    const sources = [a, b, keyword, regexp, unknown];
    const native = [
      { text: a.originalText, mode: 1, border: 0, shooterType: 0, uhash: 'hash-a' },
      { text: b.originalText, mode: 1, border: 0, shooterType: 0, uhash: 'hash-b' },
      { text: keyword.originalText, mode: 1, border: 0, shooterType: 0, uhash: 'hash-b' },
      { text: regexp.originalText, mode: 1, border: 0, shooterType: 0, uhash: 'hash-b' },
      { text: unknown.originalText, mode: 1, border: 0, shooterType: 0 },
    ];
    const decisions = matched(sources, native, [
      { type: 0, filter: '秘密', opened: true },
      { type: 1, filter: '/画面/i', opened: true },
      { type: 2, filter: 'hash-a', opened: true },
    ]);
    assert.deepEqual(decisions.map(item => item.state), ['exclude', 'retain', 'exclude', 'exclude', 'unknown']);
    const settings = Object.freeze(onlineSettings({ backend, endpoint: backend === 'local' ? '' : 'https://api.minimax.cn/v1/chat/completions',
      model: backend === 'local' ? '' : 'MiniMax-M3', localModelId: 'fixture-local',
      localPerformance: { promptMode: 'json', languageValidation: 'strict' },
      enabled: false, displayMode: 'original', translationScope: 'all', batchSize: 8, videoBatchSize: 8, concurrency: 2 }));
    const report = await simulateUserFilterDemand({ sources, decisions, settings, clock, epoch: 0 });
    assert.equal(settings.enabled, false);
    assert.equal(settings.displayMode, 'original');
    assert.equal(report.candidateEvents, 5);
    assert.deepEqual(report.userRuleHitsByCategory, { keyword: 1, regexp: 1, sender: 1, account: 0, unattributed: 0 });
    assert.equal(report.unknownEvents, 1);
    assert.equal(report.disabled.effectiveSubscriptions, 5);
    assert.equal(report.enabled.effectiveSubscriptions, 2);
    assert.equal(report.disabled.uniquePendingTexts, 4);
    assert.equal(report.enabled.uniquePendingTexts, 2);
    assert.equal(report.disabled.simulatedProviderInputs, 4);
    assert.equal(report.enabled.simulatedProviderInputs, 2);
    assert.equal(report.sameTextGroupsStillNeeded, 1);
    assert.equal(report.incrementalExcludedEvents, 3);
    assert.equal(report.incrementalExcludedUniqueTexts, 2);
    assert.equal(report.actualModelCalls, 0);
    assert.equal(report.evidence, 'memory-provider-only');
    const exported = JSON.stringify(report);
    for (const privateValue of ['hash-a', '秘密', a.originalText, 'fixture-local'])
      assert.equal(exported.includes(privateValue), false);
  });
}

test('native filtered status stays independent of user-rule hits in an auto full pool', async () => {
  const near = source('near', '秘密の近い文章です');
  const far = source('far', '遠い普通の文章です', 300000);
  const nativeFiltered = source('native-filtered', '秘密の遠い文章です', 301000);
  const sources = [near, far, nativeFiltered];
  const decisions = matched(sources, sources.map(event => ({ text: event.originalText, mode: 1, border: 0, shooterType: 0 })),
    [{ type: 0, filter: '秘密', opened: true }]);
  const settings = onlineSettings({ enabled: false, displayMode: 'original', translationScope: 'auto',
    prefetchSeconds: 20, batchSize: 2, videoBatchSize: 2, concurrency: 2 });
  const normalEligibility = { revision: 0, epoch: 2, reset: true, capability: 'filtered-pool', display: 'visible',
    items: sources.map(event => ({ id: event.id, originalText: event.originalText,
      state: event.id === nativeFiltered.id ? 'filtered' : 'eligible' })) };
  const report = await simulateUserFilterDemand({ sources, decisions, settings, clock, epoch: 2, normalEligibility });
  assert.equal(report.candidateEvents, 3);
  assert.equal(report.userRuleHitsByCategory.keyword, 2);
  assert.equal(report.disabled.effectiveSubscriptions, 2);
  assert.equal(report.enabled.effectiveSubscriptions, 1);
  assert.equal(report.incrementalExcludedEvents, 1);
  assert.equal(report.incrementalExcludedUniqueTexts, 1);
  assert.ok(report.disabled.simulatedProviderInputs > report.enabled.simulatedProviderInputs);
  assert.equal(report.actualModelCalls, 0);
});

test('both simulations sample the same running playback window boundary', async () => {
  const edge = source('edge', '境界の文章です', 60000);
  const decisions = matched([edge], [{ text: edge.originalText, mode: 1, border: 0, shooterType: 0 }], []);
  const settings = onlineSettings({ enabled: false, displayMode: 'original', translationScope: 'window',
    prefetchSeconds: 60, batchSize: 1, videoBatchSize: 1 });
  const report = await simulateUserFilterDemand({ sources: [edge], decisions, settings,
    clock: { ...clock, paused: false }, epoch: 0 });
  assert.equal(report.disabled.effectiveSubscriptions, 1);
  assert.equal(report.enabled.effectiveSubscriptions, 1);
  assert.equal(report.incrementalExcludedEvents, 0);
  assert.equal(report.actualModelCalls, 0);
});

for (const backend of ['local', 'online']) test(`${backend} new regex support removes only incremental demand through real scheduler and memory provider`, async () => {
  const sources = [source('new', 'Repeated synthetic spammmm'), source('overlap', 'Keyword synthetic spammmm'),
    source('author-a', 'Shared ordinary message'), source('author-b', 'Shared ordinary message'),
    source('control', 'Independent retained message')];
  const native = sources.map((row, i) => ({ text: row.originalText, mode: 1, uhash: i === 2 ? 'sender-a' : 'sender-b' }));
  const matcher = compileBilibiliUserRules({ scope: 'synthetic', revision: 4, verified: true, enabled: true, complete: true,
    rules: [{ type: 0, opened: true, filter: 'Keyword' }, { type: 1, opened: true, filter: 'spam{2,}' },
      { type: 2, opened: true, filter: 'sender-a' }] });
  const decisions = sources.map((row, index) => ({ id: row.id, originalText: row.originalText,
    ...matcher.match(native[index]), legacyState: matcher.matchLegacy(native[index]).state }));
  const settings = onlineSettings({ backend, sourceLanguage: 'en', targetLanguage: 'ja', enabled: false,
    displayMode: 'original', translationScope: 'all', localModelId: 'fixture-only', videoBatchSize: 8 });
  const report = await simulateUserFilterDemand({ sources, decisions, settings, clock, epoch: 0 });
  assert.equal(report.regexpIncremental.baseline.effectiveSubscriptions, 3);
  assert.equal(report.regexpIncremental.current.effectiveSubscriptions, 2);
  assert.equal(report.regexpIncremental.excludedEvents, 1, 'keyword overlap is not counted twice');
  assert.equal(report.regexpIncremental.excludedUniqueTexts, 1);
  assert.equal(report.regexpIncremental.current.simulatedProviderInputs, 2, 'unblocked controls reach the memory provider');
  assert.equal(report.actualModelCalls, 0);
});
