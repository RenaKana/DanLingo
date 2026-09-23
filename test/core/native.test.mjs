import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as messages from '../../src/core/messages.ts';
import * as scheduling from '../../src/core/scheduler.ts';
import * as stream from '../../src/core/source-stream.ts';

const compiled = ts.transpileModule(
  readFileSync(new URL('../../src/platforms/niconico/native.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const body = 'ミクちゃん19周年おめでとうございます';
const chat = (id, commands = ['184', 'device:Switch'], patch = {}) => ({
  id, thread: 'thread', fork: 'main', position: 'naka', vposMs: 7750,
  size: 'medium', color: '#ffffff', font: 'defont', comment: { body, commands }, ...patch,
});

// Run the production bridge (including discovery, classification and publication),
// mocking only browser/native-player boundaries. No duplicate eligibility predicate.
function bridge(chats, { played = true } = {}) {
  const h = { sent: [], now: 10000, refreshes: 0, filters: new Map() };
  const handlers = new Map();
  const location = { href: 'https://www.nicovideo.jp/watch/sm1715919', origin: 'https://www.nicovideo.jp' };
  const window = { postMessage: data => h.sent.push(data),
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  class Node {}
  class Video extends Node {
    isConnected = true; paused = true; seeking = false;
    played = { length: played ? 1 : 0 }; buffered = { length: 0 };
    handlers = new Map();
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    removeEventListener(name) { this.handlers.delete(name); }
  }
  const video = new Video();
  const layer = { stagingChatManager: { chatList: chats }, processor: { contentLengthMs: 60000 },
    addStagingFilter: (key, fn) => h.filters.set(key, fn), removeStagingFilter: key => h.filters.delete(key) };
  const player = { watch: { video: { id: 'sm1715919', duration: 60 } },
    getCurrentTime: () => 0, getPlaybackRate: () => 1, getVideoElement: () => video,
    isReady: () => true, isPlaying: () => !video.paused, isSeeking: () => false,
    commentRenderer: { parentElement: { isConnected: true, dataset: {} }, layerProcessorList: [layer],
      refreshComments: () => h.refreshes++ } };
  video.__reactFiber$fixture = { memoizedProps: { player } };
  const dependencies = { '../../core/messages.ts': messages, '../../core/source-stream.ts': stream,
    '../../core/scheduler.ts': scheduling };
  const exports = {};
  runInNewContext(compiled, { exports, window, location, Node, HTMLVideoElement: Video,
    document: { querySelectorAll: () => [video] }, crypto, TextEncoder, URL, queueMicrotask,
    performance: { now: () => h.now }, setInterval: fn => { h.tick = fn; return 1; }, clearInterval() {},
    require: key => { assert.ok(key in dependencies, key); return dependencies[key]; } });
  h.dispose = exports.startNativeBridge();
  h.tick();
  const snapshot = h.sent.find(d => d.type === 'snapshot');
  assert.ok(snapshot, 'production player discovery succeeded');
  h.send = data => handlers.get('message')({ source: window, origin: location.origin,
    data: { bridge: exports.BRIDGE, from: 'content', session: snapshot.session,
      resourceId: snapshot.resourceId, generation: 1, ...data } });
  h.rows = h.sent.filter(d => d.type === 'sources').flatMap(d => d.upserts);
  h.send({ type: 'control', enabled: true, displayMode: 'translated' });
  h.stage = (item, settings = { visible: true, content: item.comment.body }) => {
    assert.equal(h.filters.size, 1);
    return [...h.filters.values()][0](item, settings);
  };
  h.prepare = (item, text = '初音未来十九周年快乐') => {
    const row = h.rows.find(row => row.sourceId === item.id);
    assert.ok(row, 'source was published');
    h.send({ type: 'prepared', items: [{ id: row.id, originalText: item.comment.body, text }] });
  };
  h.seek = () => video.handlers.get('seeking')();
  return h;
}

test('native publication admits device metadata and retains strict command/layout exclusions', t => {
  const cases = [
    ['switch', ['184', 'device:Switch'], true],
    ['case', ['DEVICE:Switch', 'UE', '#Ab1234'], true],
    ['device-token', ['device:android_app-1'], true],
    ['ordinary', ['184', 'medium', 'cyan2', 'gothic'], true],
    ['full', ['device:Switch', 'full'], false],
    ['ender', ['device:Switch', 'ender'], false],
    ['middle', ['middle'], false],
    ['unknown', ['device:Switch', 'unknown-command'], false],
    ['empty-device', ['device:'], false],
    ['spaced-device', ['device:Switch full'], false],
    ['nested-device', ['device:Switch:full'], false],
    ['non-string', [184], false],
  ];
  const chats = cases.map(([id, commands]) => chat(id, commands));
  chats.push(chat('owner', undefined, { fork: 'owner' }), chat('unknown-position', undefined, { position: 'middle' }),
    chat('multiline', undefined, { comment: { body: `${body}\nこんにちは`, commands: ['device:Switch'] } }));
  const h = bridge(chats); t.after(h.dispose);
  assert.equal(h.rows.length, chats.length);
  for (const [id, , expected] of cases) assert.equal(h.rows.find(row => row.sourceId === id).translatable, expected, id);
  for (const id of ['owner', 'unknown-position', 'multiline']) assert.equal(h.rows.find(row => row.sourceId === id).translatable, false, id);
  const row = h.rows.find(row => row.sourceId === 'switch');
  assert.equal(row.mediaTimeMs, 7750); assert.equal(row.renderAtMs, 5750);
  assert.equal(row.originalText, body); assert.deepEqual(Array.from(row.style.commands), ['184', 'device:Switch']);
});

test('device comments use prepared text at staging while art and mismatched settings remain unchanged', t => {
  const normal = chat('normal'), art = chat('art', ['184', 'device:Switch', 'full', 'ender']);
  const h = bridge([normal, art]); t.after(h.dispose);
  h.prepare(normal); h.prepare(art);
  assert.equal(h.stage(normal).content, '初音未来十九周年快乐');
  const artSettings = { visible: true, content: body };
  assert.equal(h.stage(art, artSettings), artSettings);
  const hidden = { visible: false, content: body }, changed = { visible: true, content: 'native transformed content' };
  assert.equal(h.stage(normal, hidden), hidden); assert.equal(h.stage(normal, changed), changed);
});

test('late device translation cannot change an existing staging decision until seek', t => {
  const normal = chat('normal'); const h = bridge([normal]); t.after(h.dispose);
  assert.equal(h.stage(normal).content, body);
  h.prepare(normal);
  assert.equal(h.stage(normal).content, body);
  assert.equal(h.refreshes, 0);
  h.seek();
  assert.equal(h.stage(normal).content, '初音未来十九周年快乐');
  h.prepare(normal, '后到的新译文');
  assert.equal(h.stage(normal).content, '初音未来十九周年快乐');
  assert.equal(h.refreshes, 0);
});

test('an unplayed paused device comment can be remeasured after preparation', async t => {
  const normal = chat('normal'); const h = bridge([normal], { played: false }); t.after(h.dispose);
  assert.equal(h.stage(normal).content, body);
  h.prepare(normal); await Promise.resolve();
  assert.equal(h.refreshes, 1);
  assert.equal(h.stage(normal).content, '初音未来十九周年快乐');
});
