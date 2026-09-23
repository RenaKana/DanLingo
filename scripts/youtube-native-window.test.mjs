import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installNativeWindow } from './youtube-native-window.mjs';

function page() {
  let time = 0, nextTimer = 0;
  const epoch = 100000, listeners = new Set(), timers = new Map();
  const location = { href: 'https://www.youtube.com/watch?v=video-one', origin: 'https://www.youtube.com' };
  const style = { display: 'block', visibility: 'visible', opacity: '1' };
  const document = { hidden: false, frames: [], querySelector: () => null,
    querySelectorAll: () => document.frames, defaultView: { getComputedStyle: () => style } };
  const visible = ownerDocument => ({ isConnected: true, parentElement: null, ownerDocument, getClientRects: () => [{}], hasAttribute: () => false });
  function frame(resource = 'video-one') {
    const doc = { hidden: false, defaultView: document.defaultView };
    const list = { ...visible(doc), polymerController: {}, rows: [], querySelectorAll() { return this.rows; } };
    doc.querySelector = selector => selector === 'yt-live-chat-item-list-renderer' ? list : null;
    const value = { ...visible(document), contentWindow: { location: { href: `https://www.youtube.com/live_chat?v=${resource}` } }, contentDocument: doc };
    value.add = (id, text, dataText = text) => {
      const row = { ...visible(doc), data: { id, message: { simpleText: dataText } }, text,
        querySelector() { return { textContent: this.text }; } };
      list.rows.push(row); return row;
    };
    value.list = list;
    return value;
  }
  const primary = frame(); document.frames.push(primary);
  const window = { addEventListener: (name, fn) => { if (name === 'message') listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === 'message') listeners.delete(fn); } };
  window.top = window;
  const context = { window, document, location, URL, performance: { timeOrigin: epoch, now: () => time },
    setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); } };
  const install = () => vm.runInNewContext(`(${installNativeWindow.toString()})({bufferMs:500})`, context);
  install();
  let session = 'session-one';
  const send = (data, envelope = {}) => {
    const message = { bridge: 'danlingo-live-v1', platform: 'youtube', resourceId: 'video-one', adapterSession: session, ...data };
    for (const listener of [...listeners]) listener({ data: message, source: window, origin: location.origin, ...envelope });
  };
  const snapshot = selected => { session = selected ?? session; send({ from: 'adapter', type: 'snapshot', presentationActive: true, connection: 'connected', coverage: 'all' }); };
  snapshot();
  const sources = new Map();
  return { window, document, primary, frame, install, listeners, timers, send, snapshot,
    get api() { return window.__DL_NATIVE_WINDOW__; }, at(ms) { time = ms; },
    source(id, translatable = true, at = time) {
      sources.set(id, at); send({ from: 'adapter', type: 'events', events: [{ sourceId: id, originalText: 'SECRET ORIGINAL TEXT', receivedAt: epoch + at, translatable }] });
    },
    prepared(id, text = '译文', delay = time - sources.get(id)) { send({ from: 'content', type: 'prepared', sourceId: id, text, preparedDelayMs: delay, cached: false }); },
    submitted(id, translated = true, reason = 'ready') { send({ from: 'adapter', type: 'submitted', sourceId: id, stamp: epoch + time, translated, reason }); },
    displayed(id, translated = true) { send({ from: 'adapter', type: 'displayed', sourceId: id, stamp: epoch + time, translated }); },
    tick() { for (const timer of timers.values()) timer(); }, summary() { return JSON.parse(JSON.stringify(window.__DL_NATIVE_WINDOW__.summary())); } };
}

test('strict deadline separates submission from presentation and preserves cancelled, timeout and missing eligibility', () => {
  const p = page(); p.api.begin();
  for (const id of ['good', 'late-prepare', 'late-submit', 'late-display', 'timeout', 'cancelled', 'missing']) p.source(id);
  p.source('not-eligible', false);
  p.at(100);
  for (const id of ['good', 'late-submit', 'late-display']) p.prepared(id);
  p.submitted('good'); p.submitted('late-display');
  p.at(200); p.displayed('good'); p.primary.add('good', '译文');
  p.at(500); p.prepared('late-prepare', '译文', 100); // Declared ready early, but bridge arrival exactly at deadline.
  p.submitted('late-prepare'); p.displayed('late-prepare'); p.primary.add('late-prepare', '译文');
  p.submitted('late-submit'); p.displayed('late-submit'); p.primary.add('late-submit', '译文');
  p.displayed('late-display'); p.primary.add('late-display', '译文');
  p.submitted('timeout', false, 'timeout'); p.displayed('timeout', false); p.primary.add('timeout', 'original fallback');
  p.send({ from: 'adapter', type: 'events', events: [], removes: ['cancelled'] });
  p.at(1000); p.api.end();
  const s = p.summary();
  assert.equal(s.received, 8); assert.equal(s.eligible, 7);
  assert.equal(s.onTimeTranslated, 2); assert.equal(s.onTimeRatio, 2 / 7); assert.equal(s.onTimeItemsPerSecond, 2);
  assert.equal(s.presentedBeforeDeadline, 1); assert.equal(s.presentationOnTimeRatio, 1 / 7);
  assert.equal(s.onTimeCharacters, 4); assert.equal(s.timeout, 1); assert.equal(s.cancelNotifications, 1);
  assert.equal(s.missing, 3); assert.equal(s.windowMs, 1000);
  assert.equal(s.readinessMs.p95, 500); assert.equal(s.declaredReadinessMs.p95, 100);
  assert.equal(s.domObservationDelayMs.p50, 1000);
  assert.ok(!JSON.stringify(s).includes('SECRET')); assert.ok(!JSON.stringify(s).includes('session-one'));
  assert.ok(!JSON.stringify(s).includes('video-one')); assert.ok(!JSON.stringify(s).includes('译文'));
});

test('DOM corroboration requires prepared text, same source/resource/session and pinned frame document', () => {
  const p = page(); p.api.begin(); p.source('same-id');
  p.at(10); p.prepared('same-id', '旧译'); p.submitted('same-id'); p.displayed('same-id');
  const wrong = p.frame('other-video'); wrong.add('same-id', '旧译'); p.document.frames.push(wrong);
  assert.equal(p.summary().presented, 0, 'a matching ID on a different resource is not evidence');
  p.snapshot('session-two'); p.at(20); p.source('same-id'); p.prepared('same-id', '新译'); p.submitted('same-id'); p.displayed('same-id');
  const row = p.primary.add('same-id', '旧译');
  assert.equal(p.summary().presented, 0, 'old-session text cannot prove the new session');
  row.text = '新译';
  assert.equal(p.summary().presented, 0, 'DOM and native data must agree');
  row.data.message.simpleText = '新译';
  assert.equal(p.summary().presented, 1); assert.equal(p.summary().eligible, 2); assert.equal(p.summary().missing, 1);
  p.send({ from: 'adapter', type: 'events', events: [{ sourceId: 'foreign', receivedAt: 100020, translatable: true }] }, { source: {} });
  p.send({ from: 'adapter', type: 'events', events: [{ sourceId: 'foreign', receivedAt: 100020, translatable: true }] }, { origin: 'https://other.invalid' });
  p.send({ from: 'adapter', type: 'events', resourceId: 'wrong-video', events: [{ sourceId: 'foreign', receivedAt: 100020, translatable: true }] });
  assert.equal(p.summary().received, 2);
  p.at(30); p.source('replaced'); p.prepared('replaced'); p.submitted('replaced'); p.displayed('replaced');
  const replacement = p.frame(); replacement.add('replaced', '译文'); p.document.frames = [replacement];
  assert.equal(p.summary().presented, 1, 'replacement documents cannot corroborate rows captured against the old document');
});

test('begin resets all counters, distributions and duration; stop removes observer listeners and timers', () => {
  const p = page(); p.api.begin(); p.source('one'); p.source('two'); p.source('one');
  p.at(10); p.prepared('two'); p.submitted('two'); p.displayed('two'); p.primary.add('two', '译文');
  p.prepared('one'); p.submitted('one'); p.displayed('one'); const row = p.primary.add('one', '译文');
  p.submitted('one'); p.displayed('one'); p.prepared('one');
  p.tick(); row.text = 'changed'; row.data.message.simpleText = 'changed'; p.tick(); p.tick();
  p.at(100); p.api.end();
  const first = p.summary(); assert.equal(first.duplicate, 4); assert.equal(first.overtakes, 1); assert.equal(first.observedPostDisplayTextChanges, 1);
  p.at(200); p.api.begin();
  p.source('late-from-old-window', true, 50);
  let s = p.summary();
  assert.equal(s.received, 0); assert.equal(s.duplicate, 0); assert.equal(s.overtakes, 0); assert.equal(s.observedPostDisplayTextChanges, 0);
  assert.equal(s.readinessMs.samples, 0); assert.equal(s.windowMs, 0);
  p.at(250); p.source('new'); p.at(300); p.api.end();
  // A bridge event delivered during drain still belongs to the fixed source-time window.
  p.at(350); p.source('delayed-delivery', true, 299); p.source('exact-end-excluded', true, 300);
  s = p.summary(); assert.equal(s.received, 2); assert.equal(s.windowMs, 100);
  p.api.end(); assert.equal(p.summary().windowMs, 100);
  p.api.stop(); p.api.stop(); assert.equal(p.listeners.size, 0); assert.equal(p.timers.size, 0); assert.equal(p.api.active(), false);
  const stopped = p.summary(); p.source('after-stop'); p.tick(); assert.deepEqual(p.summary(), stopped);
  assert.throws(() => p.api.begin(), /observer-stopped/);
  p.install(); assert.equal(p.listeners.size, 1); assert.equal(p.timers.size, 1);
  p.install(); assert.equal(p.listeners.size, 1); assert.equal(p.timers.size, 1);
});

test('unconfirmed, hidden and ambiguous native surfaces never become successful presentations', () => {
  const p = page(); p.api.begin(); p.source('one');
  p.at(10); p.prepared('one'); p.submitted('one'); p.displayed('one'); const row = p.primary.add('one', '译文');
  row.isConnected = false; assert.equal(p.summary().presented, 0);
  row.isConnected = true; p.document.hidden = true; assert.equal(p.summary().presented, 0);
  p.document.hidden = false; const duplicateSurface = p.frame(); p.document.frames.push(duplicateSurface);
  assert.equal(p.summary().presented, 0, 'multiple matching frames leave the binding ambiguous');
  p.document.frames.pop(); assert.equal(p.summary().presented, 1);
});

test('declared readiness exactly at deadline is excluded even if received and submitted earlier', () => {
  const p = page(); p.api.begin(); p.source('exact-declared');
  p.at(100); p.prepared('exact-declared', '译文', 500); p.submitted('exact-declared'); p.displayed('exact-declared');
  p.primary.add('exact-declared', '译文');
  assert.equal(p.summary().presented, 1); assert.equal(p.summary().onTimeTranslated, 0);
  assert.equal(p.summary().declaredReadinessMs.p50, 500);
});

test('restored protected fragments use production acknowledgement plus independent pinned DOM/data corroboration', () => {
  const p = page(); p.api.begin();
  for (const id of ['rich-link', 'rich-newline', 'rich-emoji', 'rich-no-ack', 'plain-mismatch']) p.source(id);
  p.at(100);
  p.prepared('rich-link', '请查看[[DL:ytchat_v1_ab12_0]]获取说明');
  p.prepared('rich-newline', '第一行[[DL:ytchat_v1_abc_1_0]]第二行');
  p.prepared('rich-emoji', '太棒了[[DL:ytchat_v1_123_0]]继续加油');
  p.prepared('rich-no-ack', '请查看[[DL:ytchat_v1_ab12_0]]获取说明');
  p.prepared('plain-mismatch', '准确的译文');
  for (const id of ['rich-link', 'rich-newline', 'rich-emoji', 'rich-no-ack', 'plain-mismatch']) p.submitted(id);
  for (const id of ['rich-link', 'rich-newline', 'rich-emoji', 'plain-mismatch']) p.displayed(id);
  const link = p.primary.add('rich-link', '请查看官方页面获取说明');
  link.data.message = { runs: [{ text: '请查看' }, { text: '官方页面', navigationEndpoint: { urlEndpoint: { url: 'https://example.invalid' } } }, { text: '获取说明' }] };
  p.primary.add('rich-newline', '第一行\n第二行');
  const emoji = p.primary.add('rich-emoji', '太棒了继续加油');
  emoji.data.message = { runs: [{ text: '太棒了' }, { emoji: { emojiId: 'fixture-emoji' } }, { text: '继续加油' }] };
  p.primary.add('rich-no-ack', '请查看官方页面获取说明');
  p.primary.add('plain-mismatch', '其他文字');
  p.at(1000); p.api.end();
  let s = p.summary();
  assert.equal(s.eligible, 5); assert.equal(s.onTimeTranslated, 3); assert.equal(s.richFragmentCorroborated, 3);
  assert.equal(s.richFragmentOnTimeTranslated, 3); assert.equal(s.missing, 2);
  assert.match(s.richFragmentEvidence, /without independently reconstructing/);
  assert.ok(!JSON.stringify(s).includes('[[DL:'));
  // A rich message still needs independently consistent DOM/native data before its first corroboration.
  p.at(1100); p.api.begin(); p.source('rich-bad-data'); p.prepared('rich-bad-data', '译文[[DL:ytchat_v1_ab_0]]');
  p.submitted('rich-bad-data'); p.displayed('rich-bad-data'); p.primary.add('rich-bad-data', 'DOM文字', '不同的数据');
  s = p.summary(); assert.equal(s.richFragmentCorroborated, 0); assert.equal(s.onTimeTranslated, 0); assert.equal(s.eligible, 1);
});
