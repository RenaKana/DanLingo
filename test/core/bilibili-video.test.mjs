import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachBilibiliNative,
  clonePendingItems,
  parseBilibiliVideoUrl,
  resolveBilibiliBinding,
  sourceMessageFromDanmaku,
  REVIEWED_DANMAKU_BUILDS,
} from '../../src/platforms/bilibili/video.ts';

const href = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1';
const identityConfig = { bvid: 'BV1xx411c7mD', aid: '2', cid: '62131', p: 1 };

function harness({ metadata = { version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' }, windowBeforeAttach = false } = {}) {
  let now = 0;
  const posted = [], rendered = [], hookCalls = [], videoHandlers = new Map();
  const source = { dmid: '9007199254740993', text: '原文', stime: 1.25, mode: 1, rawMode: 1, size: 25, color: 16777215, pool: 0, on: false };
  const special = { dmid: '9007199254740994', text: '特殊', stime: 2.5, mode: 7, rawMode: 7, size: 25, color: 16777215, pool: 0, on: false };
  const blocked = new Set(), filters = [];
  const manager = {
    dataBase: { dmArray: [source] }, visualArray: [],
    insert(pending) {
      // This is the observed native shape: the hook receives a shallow array
      // copy, while the original argument is filtered and measured below.
      const hookPending = pending.slice();
      const result = instance.hooks.beforeRender(this.visualArray.slice(), hookPending);
      const start = rendered.length;
      for (const item of pending) {
        filters.push(item.text);
        if (item.on || blocked.has(item.text)) continue;
        item.on = true; this.initRender(item);
      }
      return { result, measured: rendered.slice(start).map(row => row.text) };
    },
    initRender(item) { const model = { textData: item, text: item.text, width: item.text.length * 12 }; this.visualArray.push(model); rendered.push({ item, text: item.text, model }); },
  };
  const nativeHook = function (active, pending) {
    hookCalls.push({ active, pending });
    for (const item of pending) if (item) item.nativeHookTouched = true;
    return 'native-hook-return';
  };
  const instance = { getMetadata: () => metadata, hooks: { beforeRender: nativeHook }, manager };
  const video = {
    currentTime: 0, duration: 120, playbackRate: 1, paused: true, seeking: false, ended: false, isConnected: true,
    played: { length: 0 }, buffered: { length: 0 },
    addEventListener(type, fn) { videoHandlers.set(type, fn); },
    removeEventListener(type, fn) { if (videoHandlers.get(type) === fn) videoHandlers.delete(type); },
  };
  const player = { danmaku: { getDanmakuX: () => instance }, manifest: { ...identityConfig }, getManifest() { return this.manifest; }, mediaElement: () => video };
  const binding = resolveBilibiliBinding(player, href);
  assert.ok(binding, 'fixture player identity should bind');
  const originalInsert = manager.insert;
  const originalInit = manager.initRender;
  const originalHook = instance.hooks.beforeRender;
  if (windowBeforeAttach) globalThis.window = { player, location: { origin: 'https://www.bilibili.com', href }, history: { length: 1 } };
  const attachment = attachBilibiliNative(binding, { post: value => posted.push(value), now: () => now });
  const content = (payload) => attachment.onMessage({ data: {
    bridge: 'danlingo.native.v1', from: 'content', session: attachment.session,
    resourceId: attachment.identity.resourceId, urlResourceId: attachment.identity.urlResourceId, ...payload,
  } });
  const destroy = () => { for (const model of manager.visualArray) model.textData.on = false; manager.visualArray.length = 0; };
  return { source, special, manager, instance, nativeHook, player, video, binding, attachment, originalInsert, originalInit, originalHook, content, posted, rendered, hookCalls, blocked, filters, destroy,
    setNow(value) { now = value; }, seek() { destroy(); video.seeking = true; videoHandlers.get('seeking')?.(); video.seeking = false; },
    play() { video.paused = false; video.played.length = 1; videoHandlers.get('playing')?.(); } };
}

test('Bilibili URL identity and exact version fail closed', () => {
  assert.deepEqual(parseBilibiliVideoUrl(href), { urlResourceId: 'BV1xx411c7mD:p1', page: 1, bvid: 'BV1xx411c7mD' });
  assert.deepEqual(parseBilibiliVideoUrl('https://www.bilibili.com/video/av2?p=3'), { urlResourceId: 'av2:p3', page: 3, aid: '2' });
  assert.equal(parseBilibiliVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=0'), null);
  assert.equal(parseBilibiliVideoUrl('https://bilibili.com/video/BV1xx411c7mD'), null);
  const player = { danmaku: { getDanmakuX: () => ({ getMetadata: () => ({ version: '1.1.22', lastCompiled: 'old' }) }) }, config: identityConfig };
  assert.equal(resolveBilibiliBinding(player, href), null);
});

test('source identity preserves decimal dmid precision and native timing', () => {
  const h = harness();
  const row = sourceMessageFromDanmaku(h.source, h.binding.identity);
  assert.equal(row.sourceId, '9007199254740993');
  assert.equal(row.threadId, '62131');
  assert.equal(row.id, JSON.stringify(['bilibili', 'av2:cid62131', '9007199254740993']));
  assert.equal(row.mediaTimeMs, 1250);
  assert.equal(row.renderAtMs, 1250);
  assert.equal(row.originalText, '原文');
  assert.equal(sourceMessageFromDanmaku({ ...h.source, dmid: 9007199254740992 }, h.binding.identity), null);
  h.attachment.stop();
});

for (const metadata of REVIEWED_DANMAKU_BUILDS) test(`native ${metadata.version} initRender measures a clone after original hook/filter and preserves native on lifecycle`, () => {
  const h = harness({ metadata });
  h.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated' });
  h.attachment.tick();
  const sourceRow = h.posted.find(message => message.type === 'sources')?.upserts.find(row => row.sourceId === h.source.dmid);
  assert.ok(sourceRow);
  h.content({ type: 'prepared', generation: 0, items: [{ id: sourceRow.id, originalText: '原文', text: '译文' }] });
  const result = h.manager.insert([h.source]);
  assert.equal(result.measured[0], '译文');
  assert.equal(h.rendered.at(-1).text, '译文');
  assert.equal(h.source.text, '原文', 'source text remains original');
  assert.equal(h.source.on, true, 'native active flag remains on the original timeline item');
  assert.notEqual(h.rendered.at(-1).item, h.source);
  assert.deepEqual(h.filters, ['原文']);
  assert.equal(h.hookCalls.length, 1);
  assert.equal(h.hookCalls[0].pending[0], h.source, 'native hook still receives its original source object');
  h.manager.insert([h.source]);
  assert.equal(h.rendered.length, 1, 'overlapping timeline windows cannot re-stage an active occurrence');
  h.destroy();
  assert.equal(h.source.on, false, 'native model destroy propagates through its textData clone');
  h.manager.insert([h.source]);
  assert.equal(h.rendered.length, 2);
  assert.equal(h.rendered.at(-1).text, '译文');
  h.attachment.stop();
});

test('special mode is published as non-translatable and never receives prepared text', () => {
  const h = harness();
  h.manager.dataBase.dmArray.push(h.special);
  h.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated' });
  h.attachment.tick();
  const specialRow = h.posted.find(message => message.type === 'sources')?.upserts.find(row => row.sourceId === h.special.dmid);
  assert.ok(specialRow);
  assert.equal(specialRow.translatable, false);
  h.content({ type: 'prepared', generation: 0, items: [{ id: specialRow.id, originalText: '特殊', text: '不应替换' }] });
  const result = h.manager.insert([h.special]);
  assert.equal(result.measured[0], '特殊');
  h.attachment.stop();
});

test('native hook return/throw semantics and owned restoration are preserved', () => {
  const h = harness();
  const originalInsert = h.originalInsert;
  const originalHook = h.originalHook;
  h.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated' });
  const stopped = h.attachment.stop();
  assert.equal(stopped.hookRestored, true);
  assert.equal(stopped.insertRestored, true);
  assert.equal(stopped.initRestored, true);
  assert.equal(h.manager.insert, originalInsert);
  assert.equal(h.manager.initRender, h.originalInit);
  assert.equal(h.instance.hooks.beforeRender, originalHook);

  const throwing = harness();
  const thrown = new Error('native hook failure');
  const originalInsertAfterAttach = throwing.originalInsert;
  throwing.instance.hooks.beforeRender = () => { throw thrown; };
  // Existing attachment owns the old function; replacing it simulates a site
  // wrapper arriving after us.  It must be preserved when we stop.
  const later = throwing.instance.hooks.beforeRender;
  assert.throws(() => throwing.manager.insert([throwing.source]), thrown);
  const result = throwing.attachment.stop();
  assert.equal(result.hookRestored, false);
  assert.equal(throwing.instance.hooks.beforeRender, later);
  assert.equal(throwing.manager.insert, originalInsertAfterAttach);
  assert.throws(() => throwing.manager.insert([throwing.source]), thrown);
});

test('seek keeps prepared translations but changes epoch; a different CID cannot reuse the old binding', () => {
  const h = harness();
  h.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated' });
  h.attachment.tick();
  const row = h.posted.find(message => message.type === 'sources')?.upserts.find(item => item.sourceId === h.source.dmid);
  h.content({ type: 'prepared', generation: 0, items: [{ id: row.id, originalText: '原文', text: '译文' }] });
  h.manager.insert([h.source]);
  const beforeEpoch = h.attachment.epoch;
  h.seek();
  assert.ok(h.attachment.epoch > beforeEpoch);
  h.manager.insert([h.source]);
  assert.equal(h.rendered.at(-1).text, '译文');

  const otherPlayer = { ...h.player, manifest: { ...identityConfig, cid: '99999' } };
  assert.notEqual(resolveBilibiliBinding(otherPlayer, href).identity.resourceId, h.attachment.identity.resourceId);
  h.attachment.stop();
});

test('manager.insert fails closed when the page swaps CID immediately before the old insert', () => {
  const h = harness();
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { player: h.player, location: { origin: 'https://www.bilibili.com', href } };
    h.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated' });
    h.attachment.tick();
    const row = h.posted.find(message => message.type === 'sources')?.upserts.find(item => item.sourceId === h.source.dmid);
    assert.ok(row);
    h.content({ type: 'prepared', generation: 0, items: [{ id: row.id, originalText: '原文', text: '译文' }] });
    const rebuiltPlayer = { ...h.player, manifest: { ...identityConfig, cid: '99999' }, danmaku: { getDanmakuX: () => h.instance } };
    globalThis.window.player = rebuiltPlayer;
    const result = h.manager.insert([h.source]);
    assert.equal(result.measured[0], '原文');
    assert.equal(h.source.text, '原文');
  } finally {
    h.attachment.stop();
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
});

test('clonePendingItems is shallow and does not pretend array-slot replacement reaches native downstream', () => {
  const nested = { value: 1 }, source = { text: '原文', nested };
  const copies = clonePendingItems([source]);
  assert.notEqual(copies[0], source);
  assert.equal(copies[0].nested, nested);
  copies[0].text = '译文';
  assert.equal(source.text, '原文');
});

test('unrelated same-resource history and query changes do not disable translation', () => {
  const previous = globalThis.window;
  const h = harness({ windowBeforeAttach: true });
  try {
    h.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated' });
    h.attachment.tick();
    const row = sourceMessageFromDanmaku(h.source, h.binding.identity);
    h.content({ type: 'prepared', generation: 0, items: [{ id: row.id, originalText: '原文', text: '译文' }] });
    globalThis.window.history.length++;
    globalThis.window.location.href = href + '&share_source=test';
    assert.equal(h.manager.insert([h.source]).measured[0], '译文');
    h.destroy();
    globalThis.window.player.manifest = { ...identityConfig, cid: '99999' };
    assert.equal(h.manager.insert([h.source]).measured[0], '原文', 'native CID changes still invalidate the old session');
  } finally {
    h.attachment.stop();
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
});

test('native keyword blocking sees original text and blocked occurrences never construct a model', () => {
  const h = harness();
  h.content({ type: 'control', generation: 0, enabled: true }); h.attachment.tick();
  const row = sourceMessageFromDanmaku(h.source, h.binding.identity);
  h.content({ type: 'prepared', generation: 0, items: [{ id: row.id, originalText: '原文', text: '译文' }] });
  h.blocked.add('原文');
  assert.deepEqual(h.manager.insert([h.source]).measured, []);
  assert.equal(h.source.on, false);
  h.blocked.clear(); h.blocked.add('译文');
  assert.deepEqual(h.manager.insert([h.source]).measured, ['译文'], 'translated-only keyword must not change original admission');
  assert.deepEqual(h.filters, ['原文', '原文']);
  h.attachment.stop();
});
