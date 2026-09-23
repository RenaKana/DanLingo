import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceFromUrl, sameResource, sameSession, validSession, cacheResource, liveEventId, localDeadline } from '../../src/core/resource.ts';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, KEY_STORAGE_KEY } from '../../src/core/config.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';

test('exact platform URL candidates distinguish ordinary video and live scenarios', () => {
  const cases = [
    ['https://www.nicovideo.jp/watch/sm9?from=search', 'niconico', 'video', 'sm9'],
    ['https://www.nicovideo.jp/watch/so123/', 'niconico', 'video', 'so123'],
    ['https://live.nicovideo.jp/watch/lv123/', 'niconico', 'live', 'lv123'],
    ['https://www.youtube.com/watch?v=abc_DEF-123&list=other', 'youtube', 'live', 'abc_DEF-123'],
    ['https://www.youtube.com/live/abc_DEF-123/', 'youtube', 'live', 'abc_DEF-123'],
  ];
  for (const [url, platform, scenario, resourceId] of cases) assert.deepEqual(resourceFromUrl(url), { platform, scenario, resourceId });
  // YouTube watch URLs are candidates only: adapters must reject recordings using playback evidence.
});

test('nonmatching origins, paths, IDs and unsupported replay URL forms do not become candidates', () => {
  for (const url of ['not a URL', 'http://www.youtube.com/watch?v=abc_DEF-123', 'https://youtube.com/watch?v=abc_DEF-123',
    'https://www.youtube.com.evil.test/watch?v=abc_DEF-123', 'https://www.youtube.com:444/watch?v=abc_DEF-123',
    'https://www.youtube.com/watch?v=too-short', 'https://www.youtube.com/shorts/abc_DEF-123',
    'https://www.youtube.com/embed/abc_DEF-123', 'https://youtu.be/abc_DEF-123',
    'https://live.nicovideo.jp/watch/sm9', 'https://www.nicovideo.jp/watch/lv9',
    'https://live.nicovideo.jp/watch/lv9/timeshift', 'https://live.nicovideo.jp.evil.test/watch/lv9']) {
    assert.equal(resourceFromUrl(url), null, url);
  }
});

test('resource and session identity separate platform, scenario, ID and generation', () => {
  const session = { platform: 'niconico', scenario: 'live', resourceId: 'lv9', sessionId: 's-1', generation: 1 };
  assert.ok(validSession(session)); assert.ok(sameSession(session, { ...session }));
  assert.ok(sameResource(session, { ...session, generation: 2 }));
  for (const changed of [{ platform: 'youtube' }, { scenario: 'video' }, { resourceId: 'lv10' }, { sessionId: 's-2' }, { generation: 2 }]) {
    assert.equal(sameSession(session, { ...session, ...changed }), false);
  }
  assert.equal(sameSession(undefined, undefined), false);
  for (const input of [null, {}, { ...session, platform: 'twitch' }, { ...session, scenario: 'replay' }, { ...session, sessionId: '../bad' },
    { ...session, generation: -1 }, { ...session, generation: 0.5 }, { ...session, generation: Infinity }, { ...session, resourceId: '' }]) assert.equal(validSession(input), false);
});

test('live event IDs and cache namespaces cannot collide across platform or scenario', () => {
  const resources = ['niconico', 'youtube'].flatMap(platform => ['video', 'live'].map(scenario => ({ platform, scenario, resourceId: 'same-id' })));
  assert.equal(new Set(resources.map(cacheResource)).size, 4);
  assert.equal(new Set(resources.map(resource => liveEventId(resource, 'same-event'))).size, 4);
  assert.notEqual(liveEventId(resources[0], 'a,b'), liveEventId({ ...resources[0], resourceId: 'same-id,a' }, 'b'));
});

test('schema migration preserves usable sm cache entries while live cache is isolated', async () => {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, schemaVersion: 2, model: 'saved-model', thinkingEffort:'default' });
  const resource = { platform: 'niconico', scenario: 'video', resourceId: 'sm9' };
  const cache = new MemoryTranslationCache({ now: () => 10000 });
  const text = 'これはテストです';
  const oldKey = translationCacheKey('sm9', text, settings);
  await cache.set(oldKey, '历史译文', { resourceId: 'sm9' });
  assert.equal(cacheResource(resource), 'sm9');
  assert.equal(await cache.get(translationCacheKey(cacheResource(resource), text, settings)), '历史译文');
  assert.equal(await cache.get(translationCacheKey(cacheResource({ ...resource, scenario: 'live' }), text, settings)), undefined);
  assert.equal((await cache.stats()).entries, 1);
});

test('transport and later async work consume one fixed local deadline', async () => {
  let now = 40;
  const deadline = localDeadline(500, 10000, 10120, now);
  assert.equal(deadline, 420, '120ms transport consumes part of the 500ms budget');
  await Promise.resolve(); now += 200; // Storage/settings lookup occurs after deadline conversion.
  assert.equal(deadline - now, 180);
  await Promise.resolve(); now += 181;
  assert.ok(deadline <= now, 'Async work cannot renew the original budget');
  assert.equal(localDeadline(500, 10000, 10700, 10), 10);
  assert.equal(localDeadline(9000, 10000, 10100, 10, 500), 410);
});

test('malformed, expired and implausibly future transport stamps fail closed', () => {
  for (const args of [[NaN, 0, 0, 20], [500, Infinity, 0, 20], [500, 0, NaN, 20], [0, 0, 0, 20], [-1, 0, 0, 20], [500, 2001, 1000, 20]]) {
    assert.equal(localDeadline(...args), 20);
  }
  assert.equal(localDeadline(500, 1050, 1000, 20), 520, 'Small clock skew never grants more than the stated budget');
});

test('schema 2 upgrades to 3 without changing provider preferences or credential storage names', () => {
  const previous = { schemaVersion: 2, endpoint: 'https://service.test/v1/chat/completions', model: 'my-saved-model', profile: 'deepseek', thinkingEffort: 'high',
    sourceLanguage: 'ko', targetLanguage: 'en', enabled: true, displayMode: 'original', translationScope: 'window',
    prefetchSeconds: 30, urgentSeconds: 8, batchSize: 20, maxBatchChars: 6000, concurrency: 7,
    requestTimeoutMs: 23000, thinkingRequestTimeoutMs: 95000, cacheMaxEntries: 3000, cacheTtlDays: 14 };
  const migrated = normalizeSettings(previous, {stored:true});
  assert.equal(migrated.schemaVersion, 3);
  for (const [key, value] of Object.entries(previous)) if (key !== 'schemaVersion') assert.equal(migrated[key], value, key);
  assert.deepEqual([migrated.liveBufferMs, migrated.liveSourceLanguage, migrated.liveFontSize, migrated.liveSpeed, migrated.liveOpacity, migrated.liveDensity], [2000, 'auto', 24, 120, 0.85, 6]);
  assert.equal(SETTINGS_KEY, 'settings.v1'); assert.equal(KEY_STORAGE_KEY, 'providerKey.v1');
  assert.deepEqual(normalizeSettings(migrated, {stored:true}), migrated);
  assert.equal('apiKey' in migrated, false);
});

test('live settings retain custom buffer choices and clamp bounded visual values', () => {
  for (const liveBufferMs of [500, 1000, 1500, 2000, 3000, 7500]) assert.equal(normalizeSettings({ liveBufferMs }).liveBufferMs, liveBufferMs);
  for (const liveBufferMs of [0, -1500, '500', Infinity]) assert.equal(normalizeSettings({ liveBufferMs }).liveBufferMs, 2000);
  const low = normalizeSettings({ liveFontSize: 0, liveSpeed: 0, liveDensity: 0, liveOpacity: 0 });
  assert.deepEqual([low.liveFontSize, low.liveSpeed, low.liveDensity, low.liveOpacity], [16, 60, 1, 0.2]);
  const high = normalizeSettings({ liveFontSize: 100, liveSpeed: 900, liveDensity: 50, liveOpacity: 5, liveSourceLanguage: 'fr' });
  assert.deepEqual([high.liveFontSize, high.liveSpeed, high.liveDensity, high.liveOpacity, high.liveSourceLanguage], [48, 240, 12, 1, 'fr']);
});
