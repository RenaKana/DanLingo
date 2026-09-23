import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import * as configModule from '../../src/core/config.ts';
import * as resourceModule from '../../src/core/resource.ts';
import * as metricsModule from '../../src/core/live-metrics.ts';
import * as messageModule from '../../src/core/messages.ts';
import * as textModule from '../../src/translation/text.ts';
import * as timeoutRetryModule from '../../src/core/timeout-retry.ts';
import * as modelSummaryModule from '../../src/core/model-summary.ts';
import * as biliEmotes from '../../src/platforms/bilibili-live/emotes.ts';
import * as biliView from '../../src/platforms/bilibili-live/view.ts';
import { LiveScheduler } from '../../src/core/live-scheduler.ts';

const flush = () => new Promise(resolveFlush => setImmediate(resolveFlush));
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

const sourcePath = process.env.LIVE_CONTENT_SOURCE
  ? resolve(process.env.LIVE_CONTENT_SOURCE)
  : resolve('entrypoints/live.content.ts');
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadContentScript(dependencies, globals) {
  const exports = {};
  runInNewContext(compiled, {
    exports, URL, AbortController, performance, crypto, TextEncoder, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: key => {
      assert.ok(key in dependencies, `Unexpected import ${key}`);
      return dependencies[key];
    },
    ...globals,
  });
  return exports.default;
}

const PLATFORM = {
  youtube: { url: 'https://www.youtube.com/watch?v=abcdefghijk', resourceId: 'abcdefghijk' },
  bilibili: { url: 'https://live.bilibili.com/123', resourceId: 'room:123', urlResourceId: '123' },
  niconico: { url: 'https://live.nicovideo.jp/watch/lv123', resourceId: 'lv123' },
};

function runtime(phase, patch = {}) {
  return { phase, paused: false, modelId: 'model-1', ...patch };
}

function liveContentHarness(platform, options = {}) {
  const platformInfo = PLATFORM[platform];
  const handlers = new Map();
  const h = {
    platform,
    calls: [],
    sent: [],
    posts: [],
    statuses: [],
    runtime: options.initialRuntime ?? runtime('ready'),
    configVersion: 1,
    location: { href: platformInfo.url, origin: new URL(platformInfo.url).origin },
  };
  const localSettings = {
    ...DEFAULT_SETTINGS,
    enabled: true,
    backend: 'local',
    localModelId: 'model-1',
    liveBufferMs: 25,
    liveSourceLanguage: 'auto',
    targetLanguage: 'zh',
    ...options.settings,
  };
  const settingsResponse = () => ({
    ok: true,
    settings: { ...localSettings },
    hasKey: true,
    configVersion: h.configVersion,
    localRuntime: { ...h.runtime },
  });
  const browser = {
    runtime: {
      id: 'test-extension',
      sendMessage: async message => {
        h.sent.push(message);
        if (message.type === 'settings') return settingsResponse();
        if (message.type === 'session-open') return { ok: true, configVersion: h.configVersion };
        if (message.type === 'translate') {
          const call = { ...message, resolve: undefined, reject: undefined };
          const pending = new Promise((resolvePending, rejectPending) => {
            call.resolve = resolvePending;
            call.reject = rejectPending;
          });
          h.calls.push(call);
          return pending;
        }
        return { ok: true, configVersion: h.configVersion };
      },
      onMessage: {
        addListener: listener => { h.runtimeListener = listener; },
        removeListener: () => {},
      },
    },
  };
  const statusView = {
    attach: () => {},
    update: (state, model) => h.statuses.push({ state, model }),
    repairControl: () => {},
    dispose: () => {},
  };
  const repairView = {
    host: {}, capture: () => {}, prepared: () => {}, delivered: () => {}, failed: () => {},
    scanStatus: () => {}, scanChunk: () => {}, clear: () => {}, cancelPending: () => {},
    invalidate: () => {}, dispose: () => {},
  };
  const window = {
    postMessage: message => h.posts.push(message),
    addEventListener: (type, listener) => handlers.set(type, listener),
    removeEventListener: () => {},
  };
  const document = { querySelector: () => null };
  const contentScript = loadContentScript({
    'wxt/browser': { browser },
    'wxt/utils/define-content-script': { defineContentScript: optionsValue => optionsValue },
    '../src/core/config': configModule,
    '../src/core/model-summary': modelSummaryModule,
    '../src/core/resource': resourceModule,
    '../src/core/live-scheduler': { LiveScheduler },
    '../src/core/live-metrics': metricsModule,
    '../src/core/messages': messageModule,
    '../src/translation/text': textModule,
    '../src/core/timeout-retry': timeoutRetryModule,
    '../src/platforms/bilibili-live/emotes': biliEmotes,
    '../src/platforms/bilibili-live/view': biliView,
    '../src/ui/live-status': { createLiveStatus: () => statusView },
    '../src/ui/live-repairs': { createLiveRepairs: () => repairView },
  }, {
    location: h.location,
    document,
    window,
    clearInterval: () => {},
  });
  const ctx = {
    setInterval: () => 1,
    onInvalidated: callback => { h.invalidated = callback; },
  };
  contentScript.main(ctx);
  h.window = window;
  h.handlers = handlers;
  h.start = async () => {
    await flush();
    const snapshot = {
      bridge: 'danlingo-live-v1', from: 'adapter', type: 'snapshot', platform,
      resourceId: platformInfo.resourceId, ...(platformInfo.urlResourceId ? { urlResourceId: platformInfo.urlResourceId } : {}),
      adapterSession: 'adapter-session', stamp: resourceModule.clockStamp(), connection: 'connected', coverage: 'top',
      playback: { paused: false, seeking: false, contentActive: true, atLiveEdge: true },
      ...(platform === 'youtube' || platform === 'bilibili' ? { presentationActive: true } : {}),
    };
    handlers.get('message')({ source: window, origin: h.location.origin, data: snapshot });
    await flush();
  };
  h.updateRuntime = async next => {
    h.runtime = { ...next };
    h.runtimeListener({ type: 'local-runtime-updated', localRuntime: h.runtime }, { id: 'test-extension' });
    await flush();
  };
  h.updateSettings = async (patch, extra = {}) => {
    Object.assign(localSettings, patch);
    h.runtimeListener({ type: 'settings-updated', ok: true, settings: { ...localSettings }, hasKey: true,
      configVersion: h.configVersion, ...extra }, { id: 'test-extension' });
    await flush();
  };
  h.event = async (sourceId, originalText = 'これはテストです', translatable = true) => {
    handlers.get('message')({ source: window, origin: h.location.origin, data: {
      bridge: 'danlingo-live-v1', from: 'adapter', type: 'events', platform,
      resourceId: platformInfo.resourceId, ...(platformInfo.urlResourceId ? { urlResourceId: platformInfo.urlResourceId } : {}),
      adapterSession: 'adapter-session', events: [{ sourceId, originalText, receivedAt: resourceModule.clockStamp(), translatable }],
    } });
    await flush();
  };
  h.repair = async (patch = {}) => {
    handlers.get('message')({ source: window, origin: h.location.origin, data: {
      bridge: 'danlingo-live-v1', from: 'adapter', type: 'repair-request', platform,
      resourceId: platformInfo.resourceId, ...(platformInfo.urlResourceId ? { urlResourceId: platformInfo.urlResourceId } : {}),
      adapterSession: 'adapter-session', requestId: crypto.randomUUID(),
      sourceId: 'manual-row', originalText: 'これは手動修復です', strategy: 'manual', manual: true, force: true, ...patch,
    } });
    await flush();
  };
  h.resolveCall = async (index = h.calls.length - 1) => {
    const call = h.calls[index];
    assert.ok(call, `missing translate call ${index}`);
    call.resolve({ ok: true, items: call.items.map(item => ({ id: item.id, text: `译文:${item.id}`, status: 'translated' })) });
    await flush();
  };
  h.prepared = sourceId => h.posts.find(message => message.type === 'prepared' && message.sourceId === sourceId);
  h.control = () => h.posts.filter(message => message.type === 'control').at(-1);
  h.status = () => h.statuses.at(-1)?.state;
  h.dispose = () => h.invalidated?.();
  return h;
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await wait(5);
  }
}

for (const platform of Object.keys(PLATFORM)) test(`local idle re-admits eligible live events on ${platform} across repeated ready/idle cycles`, async t => {
  const h = liveContentHarness(platform);
  t.after(() => h.dispose());
  await h.start();
  for (const [index, phase] of ['ready', 'idle', 'ready', 'idle'].entries()) {
    await h.updateRuntime(runtime(phase));
    const sourceId = `eligible-${index}`;
    await h.event(sourceId);
    await waitFor(() => h.calls.length === index + 1, `${platform} translate ${sourceId}`);
    assert.equal(h.calls.at(-1).items[0].text, 'これはテストです');
    await h.resolveCall();
    await waitFor(() => !!h.prepared(sourceId), `${platform} prepared ${sourceId}`);
    assert.equal(h.prepared(sourceId).text, `译文:${JSON.stringify([platform, 'live', PLATFORM[platform].resourceId, sourceId])}`);
  }
});

test('idle status says the local model is unloaded and the next eligible event reaches translation', async t => {
  const h = liveContentHarness('youtube');
  t.after(() => h.dispose());
  await h.start();
  await h.updateRuntime(runtime('idle'));
  assert.equal(h.control().enabled, true);
  assert.match(h.status().note, /本地模型未加载/);
  assert.doesNotMatch(h.status().note, /加载中/);
  await h.event('idle-eligible');
  await waitFor(() => h.calls.length === 1, 'idle eligible translation');
  await h.resolveCall();
  await waitFor(() => !!h.prepared('idle-eligible'), 'idle prepared translation');
});

test('idle admits an eligible Bilibili manual repair to the background translator', async t => {
  const h = liveContentHarness('bilibili');
  t.after(() => h.dispose());
  await h.start();
  await h.updateRuntime(runtime('idle'));
  await h.repair();
  await waitFor(() => h.calls.length === 1, 'idle manual repair translation');
  assert.equal(h.calls[0].forceTranslate, true);
  assert.equal(h.calls[0].force, true);
  await h.resolveCall();
  await waitFor(() => h.posts.some(message => message.type === 'repair-result' && message.status === 'translated'), 'idle manual repair result');
});

for (const [label, state] of [
  ['manual pause', runtime('idle', { paused: true })],
  ['error', runtime('error', { error: 'load failed' })],
  ['idle with a latched error', runtime('idle', { error: 'previous load failed' })],
  ['loading', runtime('loading')],
]) test(`local ${label} keeps live intake on original/no-request path`, async t => {
  const h = liveContentHarness('youtube');
  t.after(() => h.dispose());
  await h.start();
  await h.updateRuntime(state);
  assert.equal(h.control().enabled, false);
  await h.event(`blocked-${label}`);
  await wait(50);
  assert.equal(h.calls.length, 0);
  assert.equal(h.posts.some(message => message.type === 'prepared' && message.sourceId === `blocked-${label}`), false);
  if (label === 'loading') assert.match(h.status().note, /加载中/);
  if (label === 'idle with a latched error') assert.match(h.status().note, /加载失败/);
});

test('idle same-language and symbol messages do not wake local autoload', async t => {
  const h = liveContentHarness('niconico');
  t.after(() => h.dispose());
  await h.start();
  await h.updateRuntime(runtime('idle'));
  await h.event('same-language', '你好');
  await h.event('symbols', '!!!');
  await wait(50);
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.filter(message => message.type === 'translate').length, 0);
});

test('disabled and performance-paused settings do not wake a ready local model', async t => {
  for (const [label, extra] of [['disabled', {}], ['performance pause', { performancePaused: true }]]) {
    const h = liveContentHarness('bilibili');
    await h.start();
    await h.updateSettings({ enabled: label === 'disabled' ? false : true }, extra);
    assert.equal(h.control().enabled, false);
    await h.event(`blocked-${label}`);
    await wait(50);
    assert.equal(h.calls.length, 0, label);
    h.dispose();
  }
});
