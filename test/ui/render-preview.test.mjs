import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPreviewScopedCounts, renderTranslationAllowed } from '../../src/ui/render-preview.ts';

test('summary counts entered and sampled events after they have exited, scoped to one epoch', () => {
  const row = (id, state, extra = {}) => ({ id, resourceId: 'av1:cid2', epoch: 3,
    state, chosenAtMediaMs: null, visibleSamples: 0, unknown: false, ...extra });
  const rows = [
    row('pending', 'reserved'), row('moving', 'committed', { chosenAtMediaMs: 1000, visibleSamples: 3, unknown: true }),
    row('done', 'exited', { chosenAtMediaMs: 2000, visibleSamples: 2 }),
    row('rejected', 'oversize', { unknown: true }),
    row('old-epoch', 'exited', { epoch: 2, chosenAtMediaMs: 1000, visibleSamples: 1 }),
    row('other-video', 'committed', { resourceId: 'av1:cid3', chosenAtMediaMs: 1000 }),
  ];
  assert.deepEqual(renderPreviewScopedCounts(rows, 'av1:cid2', 3), {
    proposed: 4, reserved: 1, entered: 2, sampled: 2, rejected: 1, unknown: 2,
  });
});

test('only identity-bound existing results enter the optional translation channel', () => {
  const seed = { origin: 'existing-cache', id: 'exact-dmid', sourceId: 'thread:exact-dmid',
    resourceId: 'av1:cid2', epoch: 3, originalText: '日本語', targetLanguage: 'zh',
    text: '已有译文', availableAtWallMs: 1200 };
  assert.equal(renderTranslationAllowed(seed, 'av1:cid2', 3, 'zh'), true);
  assert.equal(renderTranslationAllowed({ ...seed, origin: 'export' }, 'av1:cid2', 3, 'zh'), true);
  for (const invalid of [
    { ...seed, origin: 'simulation' }, { ...seed, resourceId: 'av1:cid3' },
    { ...seed, epoch: 2 }, { ...seed, targetLanguage: 'en' },
    { ...seed, text: '' }, { ...seed, availableAtWallMs: NaN },
  ]) assert.equal(renderTranslationAllowed(invalid, 'av1:cid2', 3, 'zh'), false);
});

test('live-local results require the exact run and configuration plus per-result identity', () => {
  const liveIdentity = { runId: 'run-1', configIdentity: 'config-1' };
  const seed = { origin: 'live-local', id: 'exact-dmid', sourceId: 'thread:exact-dmid',
    resourceId: 'av1:cid2', epoch: 3, originalText: '日本語', targetLanguage: 'ja',
    text: '実際の結果', availableAtWallMs: 1200, availableAtMediaMs: 900,
    runId: 'run-1', requestId: 'request-1', resultId: 'result-1', configIdentity: 'config-1' };
  assert.equal(renderTranslationAllowed(seed, 'av1:cid2', 3, 'ja'), false);
  assert.equal(renderTranslationAllowed(seed, 'av1:cid2', 3, 'ja', liveIdentity), true);
  for (const wrong of [
    { ...seed, runId: 'run-old' }, { ...seed, configIdentity: 'config-old' },
    { ...seed, requestId: '' }, { ...seed, resultId: '' },
    { ...seed, originalText: 42 }, { ...seed, targetLanguage: 'en' },
    { ...seed, availableAtMediaMs: NaN }, { ...seed, availableAtMediaMs: undefined },
  ]) assert.equal(renderTranslationAllowed(wrong, 'av1:cid2', 3, 'ja', liveIdentity), false);
  assert.equal(renderTranslationAllowed({ ...seed, origin: 'simulation' },
    'av1:cid2', 3, 'ja', liveIdentity), false);
});
