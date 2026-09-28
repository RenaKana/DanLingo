import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBilibiliNative, sourceMessageFromDanmaku } from '../../src/platforms/bilibili/video.ts';
import { BilibiliUserFilterSession } from '../../src/platforms/bilibili/user-filter-session.ts';

const identity = { resourceId: 'av2:cid62131', urlResourceId: 'BV1xx411c7mD:p1', aid: '2', cid: '62131', page: 1,
  bvid: 'BV1xx411c7mD' };
const source = { dmid: '9007199254740993', text: '原文', stime: 12.5, mode: 1, rawMode: 1,
  size: 25, color: 16777215, pool: 0, on: false };

test('only ordinary scrolling sources can enter the proposed display plan', () => {
  const variants = [
    [source, true],
    [{ ...source, mode: 4, rawMode: 4 }, false],
    [{ ...source, mode: 7, rawMode: 7 }, false],
    [{ ...source, rawMode: 7 }, false],
    [{ ...source, shooterType: 1 }, false],
    [{ ...source, emoticons: { id: 'special' } }, false],
    [{ ...source, action: 'native-action' }, false],
    [{ ...source, pool: 1 }, false],
    [{ ...source, border: true }, false],
  ];
  for (const [item, expected] of variants) {
    const before = { ...item };
    const row = sourceMessageFromDanmaku(item, identity);
    assert.ok(row);
    assert.equal(row.displayPlanEligible, expected);
    assert.equal(row.originalText, item.text);
    assert.equal(row.mediaTimeMs, 12_500);
    assert.deepEqual(item, before, 'planning metadata must not mutate a native source');
  }
});

function attachmentFixture({ paused = true } = {}) {
  const calls = { play: 0, pause: 0, insert: 0, initRender: 0, hook: 0, validate: 0 };
  const posted = [], handlers = new Map();
  const video = {
    currentTime: 11.25, duration: 120, playbackRate: 1, paused, seeking: false, ended: false,
    isConnected: true, played: { length: paused ? 0 : 1 }, buffered: { length: 0 },
    play() { calls.play++; this.paused = false; return Promise.resolve(); },
    pause() { calls.pause++; this.paused = true; },
    addEventListener(type, callback) { handlers.set(type, callback); },
    removeEventListener(type, callback) { if (handlers.get(type) === callback) handlers.delete(type); },
  };
  const manager = {
    dataBase: { dmArray: [source] }, visualArray: [],
    insert() { calls.insert++; }, initRender() { calls.initRender++; },
    validate() { calls.validate++; return true; },
  };
  const hook = () => { calls.hook++; };
  const danmaku = { hooks: { beforeRender: hook } };
  const binding = { player: {}, danmaku, manager, video, identity };
  const attachment = attachBilibiliNative(binding, { post: message => posted.push(message), now: () => 1000 });
  const control = (displayPlanPlayback, extra = {}) => attachment.onMessage({ data: {
    bridge: 'danlingo.native.v1', from: 'content', session: attachment.session,
    resourceId: identity.resourceId, urlResourceId: identity.urlResourceId,
    type: 'control', generation: 1, enabled: false, bilibiliUserFilters: false,
    displayPlanPlayback, ...extra,
  } });
  return { attachment, calls, video, manager, danmaku, posted, control, hook, handlers };
}

test('preview start/seek/restore preserves paused source, native methods and original text', async t => {
  const originalSetAudit = BilibiliUserFilterSession.prototype.setAudit;
  let auditCalls = 0;
  BilibiliUserFilterSession.prototype.setAudit = function (enabled) {
    auditCalls++;
    return originalSetAudit.call(this, enabled);
  };
  t.after(() => { BilibiliUserFilterSession.prototype.setAudit = originalSetAudit; });
  const h = attachmentFixture(); t.after(() => h.attachment.stop());
  const originalPool = h.manager.dataBase.dmArray;
  h.control('start');
  assert.equal(h.video.paused, false);
  assert.equal(h.video.currentTime, 11.25);
  h.control('seek');
  assert.equal(h.video.currentTime, 23.25);
  assert.equal(h.video.paused, false);
  h.control('restore');
  await Promise.resolve();
  assert.equal(h.video.currentTime, 11.25);
  assert.equal(h.video.paused, true);
  h.attachment.tick();
  const snapshot = h.posted.filter(row => row.type === 'snapshot').at(-1);
  assert.deepEqual(snapshot.displayPlanPlayback, { started: false, restored: true, seekCount: 1 });
  assert.equal(snapshot.userFilterSummary.observation.started, false, 'old regexp observation stays off');
  assert.deepEqual(snapshot.userFilterSummary.semanticFixtures, []);
  assert.deepEqual(snapshot.userFilterSummary.semanticAudit, []);
  assert.equal(auditCalls, 0, 'display planning must not enable the regexp differential audit');
  assert.deepEqual(h.calls, { play: 2, pause: 1, insert: 0, initRender: 0, hook: 0, validate: 0 });
  assert.equal(h.manager.dataBase.dmArray, originalPool);
  assert.equal(source.text, '原文');
  assert.equal(source.on, false);
  assert.equal(h.danmaku.hooks.beforeRender, h.hook);
});

test('preview restore returns a playing source to its original time and playback state', async t => {
  const h = attachmentFixture({ paused: false }); t.after(() => h.attachment.stop());
  h.control('start');
  h.control('seek');
  h.control('restore');
  await Promise.resolve();
  assert.equal(h.video.currentTime, 11.25);
  assert.equal(h.video.paused, false);
  assert.equal(h.calls.pause, 1);
  assert.equal(h.calls.play, 3);
  assert.equal(h.calls.insert, 0);
  assert.equal(h.calls.validate, 0);
});

test('a failed restore retains the original playback state for an explicit retry', t => {
  const h = attachmentFixture(); t.after(() => h.attachment.stop());
  h.control('start'); h.control('seek');
  const pause = h.video.pause;
  let fail = true;
  h.video.pause = function () {
    if (fail) { fail = false; throw new Error('temporary-pause-failure'); }
    return pause.call(this);
  };
  h.control('restore');
  assert.equal(h.video.currentTime, 23.25);
  h.attachment.tick();
  assert.deepEqual(h.posted.filter(row => row.type === 'snapshot').at(-1).displayPlanPlayback,
    { started: true, restored: false, seekCount: 1 });
  h.control('restore');
  assert.equal(h.video.currentTime, 11.25);
  assert.equal(h.video.paused, true);
  h.attachment.tick();
  assert.deepEqual(h.posted.filter(row => row.type === 'snapshot').at(-1).displayPlanPlayback,
    { started: false, restored: true, seekCount: 1 });
});

test('adapter disposal restores the old video binding even without a restore control', () => {
  const h = attachmentFixture();
  h.control('start'); h.control('seek');
  assert.equal(h.video.currentTime, 23.25);
  h.attachment.stop();
  assert.equal(h.video.currentTime, 11.25);
  assert.equal(h.video.paused, true);
  assert.equal(h.calls.insert, 0);
  assert.equal(h.calls.validate, 0);
});

test('render preview pause/play is explicit and cleanup does not overwrite later native user input', async t => {
  const h = attachmentFixture(); t.after(() => h.attachment.stop());
  h.control('start', { displayPlanOwner: 'render-preview' });
  assert.equal(h.video.paused, false);
  h.control('pause'); assert.equal(h.video.paused, true);
  h.control('play'); await Promise.resolve(); assert.equal(h.video.paused, false);
  assert.equal(h.handlers.has('pointerdown'), true);
  h.handlers.get('pointerdown')({ isTrusted: true });
  h.video.currentTime = 80; h.video.paused = true;
  h.control('restore'); h.attachment.tick();
  assert.equal(h.video.currentTime, 80); assert.equal(h.video.paused, true);
  assert.equal(h.handlers.has('pointerdown'), false);
  assert.equal(h.handlers.has('keydown'), false);
  const playback = h.posted.filter(row => row.type === 'snapshot').at(-1).displayPlanPlayback;
  assert.equal(playback.restored, true);
  assert.equal(playback.restoreDisposition, 'preserved-external-change');
  assert.equal(playback.playbackListeners, 0);
});
