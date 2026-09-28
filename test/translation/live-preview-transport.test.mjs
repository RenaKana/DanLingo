import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ChatCompletionsProvider, ProviderError, setProviderTransportGuard } from '../../src/translation/provider.ts';
import { LOCAL_COMPLETION_ENDPOINT } from '../../src/core/connection.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const settings = onlineSettings({ backend: 'local', localModelId: 'fixture-model',
  sourceLanguage: 'auto', targetLanguage: 'ja', localPerformance: { promptMode: 'json', languageValidation: 'off' } });
const request = (extra = {}) => ({ settings, apiKey: 'fixture-only', mode: 'vod', budgetMs: 2000,
  items: [{ id: 'selected-1', text: 'fixture-original' }], ...extra });

test('default zero budget and an opaque permit both still pass through the global provider guard', async t => {
  t.after(() => setProviderTransportGuard());
  let sent = 0, payloads = 0, checks = 0;
  const permit = Object.freeze({ fixture: 'opaque' });
  setProviderTransportGuard(async context => {
    checks++; assert.equal(context.localPreviewPermit, undefined);
    throw new ProviderError('zero-model-budget');
  });
  const simulate = new ChatCompletionsProvider({ fetch: async () => { sent++; throw Error('unexpected'); },
    onLocalPayload: () => { payloads++; } });
  await assert.rejects(simulate.complete(request()), error => error.code === 'zero-model-budget');
  assert.deepEqual([checks, payloads, sent], [1, 0, 0]);

  setProviderTransportGuard(async context => {
    checks++; assert.equal(context.localPreviewPermit, permit);
    throw new ProviderError('permit-not-authorized');
  });
  const scoped = new ChatCompletionsProvider({ localPreviewPermit: permit,
    fetch: async () => { sent++; throw Error('unexpected'); }, onLocalPayload: () => { payloads++; } });
  await assert.rejects(scoped.complete(request()), error => error.code === 'permit-not-authorized');
  assert.deepEqual([checks, payloads, sent], [2, 0, 0]);
});

test('an item invalidated while the async guard waits cannot enter local payload or transport', async t => {
  t.after(() => setProviderTransportGuard());
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let current = true, sent = 0, payloads = 0;
  setProviderTransportGuard(async () => { entered(); await hold; });
  const provider = new ChatCompletionsProvider({ fetch: async () => { sent++; throw Error('unexpected'); },
    onLocalPayload: () => { payloads++; } });
  const completion = provider.complete(request({ isItemCurrent: () => current }));
  await waiting; current = false; release();
  await assert.rejects(completion, error => error.code === 'cancelled');
  assert.deepEqual([payloads, sent], [0, 0]);
});

test('the accepted exact local payload is emitted only after the guard and before internal transport', async t => {
  t.after(() => setProviderTransportGuard());
  const order = [], permit = {};
  setProviderTransportGuard(async context => {
    order.push('guard'); assert.equal(context.localPreviewPermit, permit);
    assert.equal(context.request.settings.backend, 'local');
  });
  const provider = new ChatCompletionsProvider({ localPreviewPermit: permit,
    onLocalPayload: items => { order.push('payload'); assert.deepEqual(items, [{ id: 'selected-1', text: 'fixture-original' }]); },
    fetch: async (url, init) => {
      order.push('transport'); assert.equal(url, LOCAL_COMPLETION_ENDPOINT);
      assert.equal(JSON.parse(init.body).messages[1].content.includes('fixture-original'), true);
      throw new ProviderError('fixture-complete');
    } });
  await assert.rejects(provider.complete(request()), error => error.code === 'fixture-complete');
  assert.deepEqual(order, ['guard', 'payload', 'transport']);
});

// Load the real bridge with only its browser IPC boundary replaced; no offscreen document or model exists.
function bridgeFixture(getContexts = async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }]) {
  const messages = [], events = [];
  const browser = { runtime: {
    getURL: path => `chrome-extension://fixture${path}`,
    getContexts: async args => { const value = await getContexts(args); events.push('offscreen-ready'); return value; },
    sendMessage: async message => {
      messages.push(message); events.push(message.action);
      return { ok: true, result: { choices: [{ message: { content: 'fixture output' } }] } };
    },
  }, offscreen: { createDocument: async () => { events.push('offscreen-created'); } } };
  const source = readFileSync(new URL('../../src/local/bridge.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports,
    require: id => id === 'wxt/browser' ? { browser }
      : id === './types.ts' ? { LOCAL_CHANNEL: 'danlingo-local-offscreen-v1' }
        : id === '../translation/provider.ts' ? { ProviderError } : assert.fail(`unexpected bridge import ${id}`),
    crypto: webcrypto, Response, DOMException, JSON, URL, Promise }, { filename: 'bridge.ts' });
  const body = JSON.stringify({ messages: [{ role: 'system', content: 'fixture-only' },
    { role: 'user', content: 'fixture payload' }], max_tokens: 20 });
  return { createLocalFetch: module.exports.createLocalFetch, body, messages, events };
}

test('IPC gate runs after offscreen readiness and immediately before the real complete message', async () => {
  const h = bridgeFixture();
  const controller = new AbortController();
  const fetch = h.createLocalFetch('fixture-model', {
    beforeSend: async (_id, signal) => { h.events.push('gate'); assert.equal(signal?.aborted, false); },
    sent: () => h.events.push('sent'),
  });
  const response = await fetch(LOCAL_COMPLETION_ENDPOINT, { body: h.body, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.deepEqual(h.events, ['offscreen-ready', 'gate', 'sent', 'complete']);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].action, 'complete');
  assert.equal(h.messages[0].modelId, 'fixture-model');
});

test('cancellation during asynchronous readiness or gate sends no complete IPC', async () => {
  let releaseReady, readinessEntered;
  const ready = new Promise(resolve => { readinessEntered = resolve; });
  const holdReady = new Promise(resolve => { releaseReady = resolve; });
  const before = bridgeFixture(async () => { readinessEntered(); await holdReady; return [{}]; });
  let earlyGate = 0;
  const controller = new AbortController();
  const first = before.createLocalFetch('fixture-model', { beforeSend: async () => { earlyGate++; } })(
    LOCAL_COMPLETION_ENDPOINT, { body: before.body, signal: controller.signal });
  await ready; controller.abort(); releaseReady();
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(earlyGate, 0);
  assert.equal(before.messages.some(message => message.action === 'complete'), false);

  const during = bridgeFixture();
  let releaseGate, gateEntered;
  const entered = new Promise(resolve => { gateEntered = resolve; });
  const holdGate = new Promise(resolve => { releaseGate = resolve; });
  const laterController = new AbortController();
  const second = during.createLocalFetch('fixture-model', {
    beforeSend: async () => { gateEntered(); await holdGate; }, sent: () => assert.fail('cancelled IPC was marked sent'),
  })(LOCAL_COMPLETION_ENDPOINT, { body: during.body, signal: laterController.signal });
  await entered; laterController.abort(); releaseGate();
  await assert.rejects(second, error => error.name === 'AbortError');
  assert.equal(during.messages.some(message => message.action === 'complete'), false);
});
