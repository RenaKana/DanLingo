import test from 'node:test';
import assert from 'node:assert/strict';
import { activityPlayerRoom, sameBilibiliView } from '../../src/platforms/bilibili-live/view.ts';

test('activity player accepts same-origin room aliases independently of presentation parameters', () => {
  for (const path of ['/47867', '/blanc/47867', '/blanc/47867?liteVersion=true', '/blanc/47867?liteVersion=false'])
    assert.equal(activityPlayerRoom('https://live.bilibili.com' + path), '47867');
  for (const url of [
    'http://live.bilibili.com/blanc/47867?liteVersion=true',
    'https://evil.invalid/blanc/47867?liteVersion=true', 'https://live.bilibili.com.evil.invalid/blanc/47867?liteVersion=true',
    'https://key@live.bilibili.com/blanc/47867?liteVersion=true', 'https://live.bilibili.com/blanc/0?liteVersion=true',
    'https://live.bilibili.com/blanc/47867/other?liteVersion=true', 'about:blank',
  ]) assert.equal(activityPlayerRoom(url), null, url);
});

test('activity ownership binds both room and concrete embedded document', () => {
  const view = { document: {}, frame: {}, urlResourceId: '213', playerRoomId: '47867' };
  assert.equal(sameBilibiliView(view, { ...view }), true);
  for (const next of [null, { ...view, document: {} }, { ...view, frame: {} }, { ...view, urlResourceId: '214' }, { ...view, playerRoomId: '7777' }])
    assert.equal(sameBilibiliView(view, next), false);
});
