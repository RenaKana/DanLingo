import test from 'node:test';
import assert from 'node:assert/strict';
import { bilibiliRoomIdentity } from '../../src/platforms/bilibili-live/identity.ts';

function clientRoom() {
  const document = { querySelector: () => ({ contains: node => node === video }) };
  const video = { ownerDocument: document, tagName: 'VIDEO' };
  const info = { liveStatus: 1, timeShift: 0 };
  const host = { BilibiliLive: { ROOMID: 545068, SHORT_ROOMID: 7777 },
    EmbedPlayer: { instance: { getVideoEl: () => video, getPlayerInfo: () => info } } };
  return { document, video, info, host };
}
test('client-rendered rooms confirm both canonical and short IDs without SSR data', () => {
  const { host, document } = clientRoom();
  for (const id of ['7777', '545068']) assert.deepEqual(bilibiliRoomIdentity(host, document, id), { roomId: '545068', live: true });
  assert.equal(bilibiliRoomIdentity(host, document, '1111'), null);
});
test('client identity rejects loading, foreign players, stale IDs and failed public APIs', () => {
  for (const change of [
    ({ host }) => { delete host.EmbedPlayer; },
    ({ host }) => { host.BilibiliLive.ROOMID = 0; },
    ({ host }) => { host.BilibiliLive.SHORT_ROOMID = 1111; },
    ({ video }) => { video.ownerDocument = {}; },
    ({ video }) => { video.tagName = 'DIV'; },
    ({ document }) => { document.querySelector = () => ({ contains: () => false }); },
    ({ document }) => { document.querySelector = () => null; },
    ({ info }) => { delete info.timeShift; },
    ({ info }) => { info.liveStatus = undefined; },
    ({ host }) => { host.EmbedPlayer.instance.getPlayerInfo = () => { throw Error('not ready'); }; },
  ]) {
    const room = clientRoom(); change(room);
    assert.equal(bilibiliRoomIdentity(room.host, room.document, '7777'), null);
  }
});
test('ended and timeshift players cannot open a live translation session', () => {
  const { host, document, info } = clientRoom();
  for (const update of [{ liveStatus: 0, timeShift: 0 }, { liveStatus: 2, timeShift: 0 }, { liveStatus: 1, timeShift: 30 }]) {
    Object.assign(info, update);
    assert.deepEqual(bilibiliRoomIdentity(host, document, '7777'), { roomId: '545068', live: false });
  }
});
test('SSR rooms retain native room/short-ID cross-checks, including contradictory data', () => {
  const { host, document } = clientRoom();
  delete host.EmbedPlayer;
  host.__NEPTUNE_IS_MY_WAIFU__ = { roomInitRes: { data: { room_id: 545068, short_id: 7777, live_status: 1 } } };
  assert.deepEqual(bilibiliRoomIdentity(host, document, '7777'), { roomId: '545068', live: true });
  host.__NEPTUNE_IS_MY_WAIFU__.roomInitRes.data.live_status = 2;
  assert.equal(bilibiliRoomIdentity(host, document, '7777').live, false);
  host.__NEPTUNE_IS_MY_WAIFU__.roomInitRes.data.room_id = 888;
  assert.equal(bilibiliRoomIdentity(host, document, '7777'), null);
});
