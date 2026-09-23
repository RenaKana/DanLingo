import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveScheduler } from '../../src/core/live-scheduler.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
const session = { platform: 'youtube', scenario: 'live', resourceId: 'abcdefghijk', sessionId: 'ordered', generation: 1 };
const playing = { paused: false, seeking: false, contentActive: true, atLiveEdge: true };
const hiddenVideo = { paused: true, seeking: true, contentActive: false, atLiveEdge: false };
const msg = (id, receivedAt = 0, extra = {}) => ({ id, sourceId: id, originalText: 'これはテストです', receivedAt, translatable: true, ...extra });
const output = (id, status = 'translated', text = `译文:${id}`) => ({ id, status, text });

function harness(t, buffer = 500, options = {}) {
  let now = 0, timerId = 0;
  const timers = new Map(), calls = [], released = [], prepared = [];
  const settings = { ...DEFAULT_SETTINGS, enabled: true, liveSourceLanguage: 'ja', liveBufferMs: buffer };
  const scheduler = new LiveScheduler({ settings, clock: {
    now: () => now, wallNow: () => 1000000 + now,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, request: (resource, items, signal, onResult) => new Promise(resolve => calls.push({ resource, items, signal, onResult, resolve })),
  prepare: event => prepared.push(event), release: event => { released.push(event); return true; }, ...options });
  scheduler.start(session);
  scheduler.setPresentation({ releasePolicy: 'ready-in-order', active: true });
  scheduler.setConnection('connected');
  scheduler.setPlayback(hiddenVideo);
  t.after(() => scheduler.dispose());
  return { scheduler, settings, calls, released, prepared, jump(ms) { now += ms; },
    async advance(ms) {
      const target = now + ms;
      for (let n = 0; ; n++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(n < 10000, 'timer loop');
        now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = target; await flush();
    } };
}

for (const buffer of [500, 1000, 2000, 3000]) test(`ordered ${buffer}ms buffer releases ready output immediately but bounds a missing head`, async t => {
  const h = harness(t, buffer);
  h.scheduler.ingest([msg('ready'), msg('missing')]); await flush(); await h.advance(100);
  h.calls[0].onResult(output('ready'));
  assert.deepEqual(h.released.map(e => [e.source.id, e.displayAt, e.releasedAt]), [['ready', buffer, 100]]);
  assert.equal(h.prepared[0].preparedAt, 100);
  assert.equal(h.calls[0].signal.aborted, false, 'a streaming sibling retains the shared request');
  await h.advance(buffer - 101); assert.equal(h.released.length, 1);
  await h.advance(1);
  assert.deepEqual(h.released.map(e => [e.source.id, e.translated, e.releasedAt]), [['ready', true, 100], ['missing', false, buffer]]);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.scheduler.getStats().timedOut, 1);
});

test('ordered slow head holds later output only until the head deadline', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('first')]); await flush(); await h.advance(100);
  h.scheduler.ingest([msg('second', 100)]); await flush();
  h.calls[1].resolve([output('second', 'cached')]); await flush();
  assert.equal(h.released.length, 0);
  await h.advance(400);
  assert.deepEqual(h.released.map(e => [e.source.id, e.translated, e.displayAt, e.releasedAt]),
    [['first', false, 500, 500], ['second', true, 600, 500]]);
  h.calls[0].onResult(output('first')); h.calls[0].resolve([output('first')]); await flush();
  assert.equal(h.released.length, 2);
  assert.equal(h.scheduler.getStats().cacheHits, 1);
});

test('ordered partial and aggregate results drain in arrival order without cancelling remaining siblings', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a'), msg('b'), msg('c')]); await flush(); await h.advance(50);
  h.calls[0].onResult(output('c')); assert.equal(h.released.length, 0);
  h.calls[0].onResult(output('a')); assert.deepEqual(h.released.map(e => e.source.id), ['a']);
  assert.equal(h.calls[0].signal.aborted, false);
  h.calls[0].resolve([output('a', 'cached', '不能覆盖'), output('b'), output('c')]); await flush();
  assert.deepEqual(h.released.map(e => [e.source.id, e.text, e.releasedAt]), [['a', '译文:a', 50], ['b', '译文:b', 50], ['c', '译文:c', 50]]);
  assert.deepEqual(h.prepared.map(e => e.source.id), ['c', 'a', 'b']);
  assert.equal(h.scheduler.getStats().inflight, 0);
  assert.equal(h.scheduler.getStats().onTimeReady, 3);
});

test('ordered aggregate results in reverse order still release each sibling exactly once', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a'), msg('b'), msg('c')]); await flush();
  h.calls[0].resolve(['c', 'b', 'a'].map(id => output(id))); await flush();
  assert.deepEqual(h.released.map(e => e.source.id), ['a', 'b', 'c']);
  assert.equal(h.scheduler.getStats().translated, 3);
});

test('ordered ineligible messages release immediately but never overtake an eligible head', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('plain', 0, { translatable: false }), msg('head'), msg('tail', 0, { translatable: false })]);
  assert.deepEqual(h.released.map(e => e.source.id), ['plain']); await flush();
  assert.deepEqual(h.calls[0].items.map(e => e.id), ['head']);
  h.calls[0].onResult(output('head'));
  assert.deepEqual(h.released.map(e => e.source.id), ['plain', 'head', 'tail']);
  assert.equal(h.scheduler.getStats().timedOut, 0);
});

for (const status of ['cached', 'translated']) test(`ordered ${status} result at the deadline never replaces original`, async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a')]); await flush(); h.jump(500);
  h.calls[0].onResult(output('a', status)); h.calls[0].resolve([output('a', status)]); await flush();
  h.scheduler.tick();
  assert.deepEqual(h.released.map(e => [e.text, e.translated]), [['これはテストです', false]]);
  assert.equal(h.prepared.length, 0);
  await h.advance(1000); assert.equal(h.released.length, 1);
});

test('chat visibility clears outstanding work and baselines hidden events despite paused video', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('old')]); await flush();
  assert.equal(h.calls.length, 1, 'chat remains active while real video is paused/seeking/inactive');
  h.scheduler.setPresentation({ releasePolicy: 'ready-in-order', active: false });
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.scheduler.getStats().queued, 0);
  h.scheduler.ingest([msg('hidden')]);
  h.calls[0].onResult(output('old')); h.calls[0].resolve([output('old')]); await flush();
  h.scheduler.setPresentation({ releasePolicy: 'ready-in-order', active: true });
  h.scheduler.ingest([msg('old'), msg('hidden'), msg('new')]); await flush();
  assert.deepEqual(h.calls[1].items.map(e => e.id), ['new']);
  h.calls[1].onResult(output('new'));
  assert.deepEqual(h.released.map(e => e.source.id), ['new']);
});

test('presentation override retains settings, connection and session gates', async t => {
  const h = harness(t);
  h.scheduler.configure({ ...h.settings, enabled: false }); h.scheduler.ingest([msg('disabled')]);
  h.scheduler.configure({ ...h.settings, displayMode: 'original' }); h.scheduler.ingest([msg('original')]);
  h.scheduler.configure(h.settings); h.scheduler.setConnection('reconnecting'); h.scheduler.ingest([msg('offline')]);
  h.scheduler.dispose(); h.scheduler.setPresentation({ releasePolicy: 'ready-in-order', active: true });
  h.scheduler.setConnection('connected'); h.scheduler.ingest([msg('sessionless')]); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.released.length, 0);
});

test('buffer configuration never extends assigned deadlines and identity changes isolate results', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('fixed')]); await flush();
  h.scheduler.configure({ ...h.settings, liveBufferMs: 3000 });
  await h.advance(500); assert.equal(h.released[0].releasedAt, 500);
  h.scheduler.ingest([msg('old-config', 500)]); await flush();
  h.scheduler.configure({ ...h.settings, targetLanguage: 'en' });
  assert.equal(h.calls[1].signal.aborted, true);
  h.calls[1].onResult(output('old-config')); h.calls[1].resolve([output('old-config')]); await flush();
  h.scheduler.ingest([msg('new-config', 500)]); await flush(); h.calls[2].onResult(output('new-config'));
  assert.deepEqual(h.released.map(e => e.source.id), ['fixed', 'new-config']);
});

test('restoring deadline/null uses actual playback and Niconico scheduled time with original stats', async t => {
  const h = harness(t);
  h.scheduler.setPresentation({ releasePolicy: 'deadline', active: null });
  h.scheduler.ingest([msg('paused')]); await flush(); assert.equal(h.calls.length, 0);
  h.scheduler.start({ ...session, platform: 'niconico', resourceId: 'lv9' });
  h.scheduler.setConnection('connected'); h.scheduler.setPlayback(playing);
  h.scheduler.ingest([msg('nico', 0, { scheduledAt: 100 })]); await flush(); await h.advance(50);
  h.calls[0].onResult(output('nico', 'cached')); assert.equal(h.released.length, 0);
  await h.advance(550);
  assert.deepEqual(h.released.map(e => [e.source.id, e.displayAt, e.releasedAt]), [['nico', 600, 600]]);
  const stats = h.scheduler.getStats();
  assert.deepEqual([stats.released, stats.translated, stats.cacheHits, stats.original, stats.timedOut, stats.recentEligible, stats.recentTranslated], [1, 1, 1, 0, 0, 1, 1]);
});

test('release acknowledgements and ingestion cannot recursively dispatch duplicate requests', async t => {
  const released = [];
  let scheduler;
  const h = harness(t, 500, { release: event => {
    released.push(event.source.id); scheduler.remove([event.source.id]);
    if (event.source.id === 'a') scheduler.ingest([msg('next')]);
    return true;
  } });
  scheduler = h.scheduler;
  scheduler.ingest([msg('a'), msg('b')]); await flush();
  h.calls[0].onResult(output('a')); await flush();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].items.map(e => e.id), ['next']);
  h.calls[1].onResult(output('next')); h.calls[0].onResult(output('b'));
  assert.deepEqual(released, ['a', 'b', 'next']);
  assert.equal(h.scheduler.getStats().queued, 0);
});
