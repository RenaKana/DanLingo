import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSources, watchIdFromUrl, needsTranslation } from '../../src/core/messages.ts';

const raw = (sourceId, originalText = 'すごい！') => ({ sourceId, threadId: '42', fork: 'main', originalText, mediaTimeMs: 3000, renderAtMs: 1000, translatable: true, style: { color: '#ff0000', position: 'naka', commands: ['red'] } });
test('source events preserve repeats, scope IDs, and never manufacture missing times', () => {
  const rows = parseSources([raw('1'), raw('2'), raw('1'), { ...raw('3'), mediaTimeMs: undefined }], 'sm9');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].originalText, rows[1].originalText);
  assert.equal(rows[0].sentAtEpochMs, undefined);
  assert.equal(rows[0].resourceId, 'sm9');
  assert.notEqual(rows[0].id, parseSources([raw('1')], 'sm10')[0].id);
});
test('watch identity rejects misleading origins and non-watch pages', () => {
  assert.equal(watchIdFromUrl('https://www.nicovideo.jp/watch/sm9?from=search'), 'sm9');
  assert.equal(watchIdFromUrl('https://www.nicovideo.jp.evil.test/watch/sm9'), null);
  assert.equal(watchIdFromUrl('https://www.nicovideo.jp/my'), null);
});
test('language bypass retains emoticons and repetitions without rewriting them', () => {
  assert.equal(needsTranslation('www草！！！', 'zh-Hans'), false);
  assert.equal(needsTranslation('www', 'zh-Hans'), false);
  assert.equal(needsTranslation('最高だwww', 'zh-Hans'), true);
  assert.equal(needsTranslation('可愛いMiku！', 'zh-Hans'), true);
  assert.equal(needsTranslation('你好', 'zh-Hans'), false);
  assert.equal(needsTranslation('最高', 'zh-Hans', 'ja'), true);
  assert.equal(needsTranslation('www草！！！', 'zh-Hans', 'ja'), false);
  assert.equal(parseSources([raw('9', 'www草！！！')], 'sm9')[0].originalText, 'www草！！！');
});
