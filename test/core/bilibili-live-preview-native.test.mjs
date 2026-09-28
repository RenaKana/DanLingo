import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBilibiliNative } from '../../src/platforms/bilibili/video.ts';

const identity = { resourceId: 'av2:cid62131', urlResourceId: 'BV1xx411c7mD:p1', aid: '2', cid: '62131',
  page: 1, bvid: 'BV1xx411c7mD' };

function fixture({ paused = true } = {}) {
  const posted = [], listeners = new Map(), calls = { play: 0, pause: 0, insert: 0, initRender: 0 };
  const video = { currentTime: 11.25, duration: 120, playbackRate: 1.5, paused, seeking: false,
    ended: false, isConnected: true, played: { length: paused ? 0 : 1 }, buffered: { length: 0 },
    play() { calls.play++; this.paused = false; return Promise.resolve(); },
    pause() { calls.pause++; this.paused = true; },
    closest: () => video,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); } };
  const source = { dmid: '9007199254740993', text: '原文', stime: 50, mode: 1, on: false };
  const manager = { dataBase: { dmArray: [source] }, visualArray: [],
    insert() { calls.insert++; }, initRender() { calls.initRender++; }, validate: () => true };
  const danmaku = { hooks: { beforeRender: () => {} } };
  const attachment = attachBilibiliNative({ player: {}, danmaku, manager, video, identity },
    { post: message => posted.push(message), now: () => 1000 });
  const control = (displayPlanPlayback, extra = {}) => attachment.onMessage({ data: {
    bridge: 'danlingo.native.v1', from: 'content', session: attachment.session,
    resourceId: identity.resourceId, urlResourceId: identity.urlResourceId, type: 'control',
    generation: 1, enabled: false, bilibiliUserFilters: false, displayPlanPlayback, ...extra,
  } });
  const snapshot = () => { attachment.tick(); return posted.filter(row => row.type === 'snapshot').at(-1); };
  return { attachment, video, source, manager, calls, listeners, control, snapshot };
}

test('live preparation requires its exact owner/range and leaves native translation disabled', t => {
  const h = fixture(); t.after(() => h.attachment.stop());
  for (const extra of [
    { displayPlanOwner: 'render-preview', livePreviewFromMs: 45000 },
    { displayPlanOwner: 'live-preview', livePreviewFromMs: -1 },
    { displayPlanOwner: 'live-preview', livePreviewFromMs: 85001 },
    { displayPlanOwner: 'live-preview', livePreviewFromMs: 45000, enabled: true },
  ]) h.control('prepare-live', extra);
  assert.equal(h.video.currentTime, 11.25); assert.equal(h.video.playbackRate, 1.5);
  assert.equal(h.calls.pause, 0); assert.equal(h.listeners.has('pointerdown'), false);
  h.control('prepare-live', { displayPlanOwner: 'live-preview', livePreviewFromMs: 45000 });
  assert.equal(h.video.currentTime, 45); assert.equal(h.video.paused, true);
  assert.equal(h.video.playbackRate, 1); assert.equal(h.calls.play, 0);
  const state = h.snapshot();
  assert.equal(state.displayPlanPlayback.owner, 'live-preview');
  assert.equal(state.displayPlanPlayback.playbackListeners, 2);
  assert.deepEqual(state.counts, { translated: 0, original: 0 });
  assert.equal(h.attachment.prepared.size, 0);
  assert.equal(h.source.text, '原文'); assert.equal(h.source.on, false);
  assert.equal(h.calls.insert, 0); assert.equal(h.calls.initRender, 0);
});

test('explicit play and restore return the exact baseline time, paused state and rate', async t => {
  const h = fixture({ paused: false }); t.after(() => h.attachment.stop());
  h.control('prepare-live', { displayPlanOwner: 'live-preview', livePreviewFromMs: 45000 });
  h.control('play'); await Promise.resolve();
  assert.equal(h.video.paused, false);
  h.control('restore'); await Promise.resolve();
  assert.equal(h.video.currentTime, 11.25); assert.equal(h.video.playbackRate, 1.5);
  assert.equal(h.video.paused, false);
  const state = h.snapshot().displayPlanPlayback;
  assert.equal(state.restored, true); assert.equal(state.restoreDisposition, 'restored-baseline');
  assert.equal(state.playbackListeners, 0);
  assert.equal(h.listeners.has('pointerdown'), false);
  assert.equal(h.listeners.has('keydown'), false);
});

test('a trusted user interaction preserves subsequent playback changes on restore', t => {
  const h = fixture(); t.after(() => h.attachment.stop());
  h.control('prepare-live', { displayPlanOwner: 'live-preview', livePreviewFromMs: 45000 });
  h.listeners.get('pointerdown')({ isTrusted: true });
  h.video.currentTime = 72; h.video.playbackRate = 1.25; h.video.paused = false;
  h.control('restore');
  assert.equal(h.video.currentTime, 72); assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.video.paused, false);
  assert.equal(h.snapshot().displayPlanPlayback.restoreDisposition, 'preserved-external-change');
  assert.equal(h.listeners.has('pointerdown'), false);
});
