import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsProvider, HYBRID_JSONL_PROMPT_VERSION, ProviderError } from '../../src/translation/provider.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { normalizeLocalConfig } from '../../src/local/config.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const settings = onlineSettings({ profile: 'deepseek', model: 'deepseek-v4-pro', thinkingEffort: 'off', translationStream: true });
const items = [{ id: 'private-a', text: 'First source' }, { id: 'private-b', text: 'Second source' }];
const request = (extra = {}) => ({ settings, apiKey: 'fixture-key', budgetMs: 2000, items,
  responseProtocol: 'hybrid-jsonl-v1', ...extra });
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = content => event({ choices: [{ index: 0, delta: { content } }] });
const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 };
const flush = () => new Promise(setImmediate);

function streamHarness(extra = {}) {
  let controller, calls = 0, now = 100;
  const bodies = [];
  const provider = new ChatCompletionsProvider({ clock: () => now, ...extra, fetch: async (_url, init) => {
    calls++;
    bodies.push(JSON.parse(init.body));
    return new Response(new ReadableStream({ start(value) { controller = value; } }),
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  } });
  return { provider, bodies, get calls() { return calls; }, setTime(value) { now = value; },
    push(value, fragmented = false) {
      const bytes = new TextEncoder().encode(value);
      if (fragmented) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
    }, close() { controller.close(); }, fail() { controller.error(new Error('untrusted response')); } };
}

test('hybrid JSONL does not pretend to be live and observes only the dispatched, filtered online batch', async () => {
  assert.equal(HYBRID_JSONL_PROMPT_VERSION, 'danlingo-hybrid-jsonl-v1');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = streamHarness({ beforeOnlineRequest: () => gate });
  const observations = [], dispatches = [], delivered = [];
  const active = new Set(['private-a', 'private-b']);
  const pending = harness.provider.complete(request({
    isItemCurrent: id => active.has(id),
    onDispatch: (sent, backend) => dispatches.push({ sent, backend }),
    onObservation: snapshot => observations.push(snapshot),
    onItem: (id, output) => delivered.push([id, output]),
  }));
  assert.equal(harness.calls, 0);
  assert.equal(observations.length, 0);
  active.delete('private-b');
  harness.setTime(250);
  release();
  await flush();
  assert.equal(harness.calls, 1);
  assert.deepEqual(dispatches, [{ sent: [items[0]], backend: 'online' }]);
  const body = harness.bodies[0];
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.match(body.messages[0].content, /JSONL \[integer_id,text\]/);
  assert.deepEqual(JSON.parse(body.messages[1].content), [0, items[0].text]);
  assert.equal(body.messages[1].content.includes('private-a'), false);
  assert.deepEqual(observations[0], { dispatchedAt: 250, observedAt: 250, inputChars: items[0].text.length,
    items: 1, streaming: true, contentChunks: 0, outputChars: 0, validItems: 0 });

  harness.setTime(270);
  harness.push(': keepalive\r\n\r\n' + event({ choices: [{ index: 0, delta: { reasoning_content: 'hidden thought' } }] })
    + event({ choices: [{ index: 0, delta: { content: '' } }] }), true);
  await flush();
  assert.equal(observations.length, 1);

  harness.setTime(300);
  const first = '[0,"trans';
  harness.push(delta(first), true);
  await flush();
  assert.equal(observations.at(-1).firstContentAt, 300);
  assert.equal(observations.at(-1).firstChunkChars, first.length);
  assert.equal(observations.at(-1).outputChars, first.length);
  assert.equal(observations.at(-1).validItems, 0);

  harness.setTime(330);
  const second = 'lated"]\n';
  harness.push(delta(second), true);
  await flush();
  assert.deepEqual(delivered, [['private-a', { text: 'translated' }]]);
  assert.equal(observations.at(-1).lastItemAt, 330);
  assert.equal(observations.at(-1).lastContentAt, 330);
  assert.equal(observations.at(-1).contentChunks, 2);
  assert.equal(observations.at(-1).outputChars, first.length + second.length);
  assert.equal(observations.at(-1).validItems, 1);
  harness.setTime(350);
  harness.push(event({ choices: [], usage }) + 'data: [DONE]\r\n\r\n', true);
  harness.close();
  const result = await pending;
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  assert.deepEqual(result.items.get('private-a'), { text: 'translated' });
  assert.equal(observations.at(-1).observedAt, 350);
  assert.equal(JSON.stringify(observations).includes('First source'), false);
  assert.equal(JSON.stringify(observations).includes('translated'), false);
});

test('hybrid accepts a single JSON response to a streaming POST without a second request or fabricated first-token timing', async () => {
  let calls = 0, now = 500;
  const observations = [];
  const content = '[1,"second"]\n[0,"first"]';
  const provider = new ChatCompletionsProvider({ clock: () => now, fetch: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).stream, true);
    return Response.json({ choices: [{ message: { content } }], usage });
  } });
  const result = await provider.complete(request({ onObservation: snapshot => observations.push(snapshot) }));
  assert.equal(calls, 1);
  assert.deepEqual([...result.items], [['private-b', { text: 'second' }], ['private-a', { text: 'first' }]]);
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  const final = observations.at(-1);
  assert.equal(final.streaming, false);
  assert.equal(final.outputChars, content.length);
  assert.equal(final.contentChunks, 0);
  assert.equal(final.validItems, 2);
  assert.equal(final.dispatchedAt, 500);
  assert.equal(final.lastItemAt, 500);
  assert.equal(final.firstContentAt, undefined);
  assert.equal(final.firstChunkChars, undefined);
});

test('nonstream hybrid still uses compact JSONL and counts the complete raw response', async () => {
  let calls = 0;
  const content = '[0,"ok"]\n[1,"done"]';
  const observations = [];
  const provider = new ChatCompletionsProvider({ fetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false);
    assert.equal(body.messages[1].content.split('\n').length, 2);
    return Response.json({ choices: [{ message: { content } }] });
  } });
  const result = await provider.complete(request({ settings: { ...settings, translationStream: false },
    onObservation: snapshot => observations.push(snapshot) }));
  assert.equal(calls, 1);
  assert.equal(result.items.get('private-b').text, 'done');
  assert.equal(observations.at(-1).streaming, false);
  assert.equal(observations.at(-1).outputChars, content.length);
  assert.equal(observations.at(-1).validItems, 2);
  assert.equal(observations.at(-1).firstContentAt, undefined);
});

test('ordinary adaptive JSON and local requests expose raw output length without changing either wire format', async () => {
  const onlineContent = JSON.stringify({ items: items.map(item => ({ id: item.id, text: `translated ${item.id}` })) });
  const onlineObservations = [];
  const online = new ChatCompletionsProvider({ clock: () => 800, fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false);
    assert.deepEqual(JSON.parse(body.messages[1].content).items, items);
    return Response.json({ choices: [{ message: { content: onlineContent } }] });
  } });
  const onlineResult = await online.complete(request({ settings: { ...settings, translationStream: false },
    responseProtocol: undefined, onObservation: snapshot => onlineObservations.push(snapshot) }));
  assert.equal(onlineResult.items.get('private-a').text, 'translated private-a');
  assert.deepEqual(onlineObservations.at(-1), { dispatchedAt: 800, observedAt: 800,
    inputChars: items.reduce((sum, item) => sum + item.text.length, 0), items: 2,
    streaming: false, contentChunks: 0, outputChars: onlineContent.length, validItems: 2, lastItemAt: 800 });

  const localSettings = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', localModelId: 'fixture-model',
    model: 'fixture-model', localModelName: 'HY-MT1.5-1.8B-Q8_0.gguf', sourceLanguage: 'auto', targetLanguage: 'ja',
    localPerformance: { ...normalizeLocalConfig(), languageValidation: 'off' } };
  const localObservations = [];
  const localContent = 'translated local response';
  const local = new ChatCompletionsProvider({ clock: () => 900, fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, false);
    return Response.json({ choices: [{ message: { content: localContent } }] });
  } });
  const localResult = await local.complete({ settings: localSettings, apiKey: 'local-inference', budgetMs: 2000,
    items: [{ id: 'local', text: 'original local source' }],
    onObservation: snapshot => localObservations.push(snapshot) });
  assert.equal(localResult.items.get('local').text, localContent);
  assert.equal(localObservations.at(-1).streaming, false);
  assert.equal(localObservations.at(-1).inputChars, 'original local source'.length);
  assert.equal(localObservations.at(-1).outputChars, localContent.length);
  assert.equal(localObservations.at(-1).validItems, 1);
  assert.equal(localObservations.at(-1).lastItemAt, 900);
  assert.equal(localObservations.at(-1).firstContentAt, undefined);
});

test('unsupported hybrid streaming fails once with a stable nonretryable reason and final observation', async () => {
  for (const makeResponse of [
    () => new Response('not an SSE response', { headers: { 'Content-Type': 'text/plain' } }),
    () => Response.json({ error: { param: 'stream', code: 'unsupported_parameter',
      message: 'stream is not supported; secret and echoed source' } }, { status: 400 }),
  ]) {
    let calls = 0;
    const observations = [];
    const provider = new ChatCompletionsProvider({ fetch: async () => { calls++; return makeResponse(); } });
    await assert.rejects(provider.complete(request({ onObservation: snapshot => {
      observations.push({ ...snapshot });
      snapshot.items = -100;
      throw new Error('observer must not change transport');
    } })), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'hybrid-stream-unsupported');
      assert.equal(error.retryable, false);
      assert.equal(error.category, 'configuration');
      assert.deepEqual(error.observation, observations.at(-1));
      assert.equal(JSON.stringify(error).includes('secret'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.ok(observations.length >= 2);
  }
});

test('ordinary hybrid HTTP 400 remains http-400; explicit SSE stream rejection retains usage and cannot retry', async () => {
  let calls = 0;
  const badModel = new ChatCompletionsProvider({ fetch: async () => {
    calls++;
    return Response.json({ error: { code: 'invalid_model', message: 'model not found; source echo' } }, { status: 400 });
  } });
  await assert.rejects(badModel.complete(request()), error => {
    assert.equal(error.code, 'http-400');
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    assert.equal(JSON.stringify(error).includes('source echo'), false);
    return true;
  });
  assert.equal(calls, 1);

  const harness = streamHarness();
  const observations = [];
  const pending = harness.provider.complete(request({ onObservation: snapshot => observations.push(snapshot) }));
  await flush();
  harness.setTime(300);
  harness.push(delta('[0,"ready"]\n'));
  harness.push(event({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 },
    error: { type: 'unsupported_streaming', message: 'streaming unsupported' } }));
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'hybrid-stream-unsupported');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.usage, { promptTokens: 9, completionTokens: 3 });
    assert.deepEqual([...error.partialItems], [['private-a', { text: 'ready' }]]);
    assert.deepEqual(error.observation, observations.at(-1));
    return true;
  });
  assert.equal(harness.calls, 1);
});

test('synchronous fetch failure after dispatch keeps its numeric final observation', async () => {
  const observations = [];
  let calls = 0;
  const provider = new ChatCompletionsProvider({ clock: () => 1000, fetch: () => {
    calls++;
    throw new Error('untrusted sync transport failure');
  } });
  await assert.rejects(provider.complete(request({ onObservation: snapshot => observations.push(snapshot) })), error => {
    assert.equal(error.code, 'network-error');
    assert.equal(error.observation.dispatchedAt, 1000);
    assert.equal(error.observation.outputChars, 0);
    assert.deepEqual(error.observation, observations.at(-1));
    return true;
  });
  assert.equal(calls, 1);
});

test('hybrid stream retains valid partial rows, cumulative usage and numeric progress on failure', async () => {
  const harness = streamHarness();
  const observations = [], delivered = [];
  const pending = harness.provider.complete(request({ onObservation: snapshot => observations.push(snapshot),
    onItem: (id, output) => delivered.push([id, output]) }));
  await flush();
  harness.setTime(200);
  harness.push(delta('[1,"second"]\n[1,"duplicate"]\n[0,"truncated'));
  harness.push(event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }));
  harness.push(event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  await flush();
  assert.deepEqual(delivered, [['private-b', { text: 'second' }]]);
  harness.setTime(225);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'network-error');
    assert.deepEqual([...error.partialItems], [['private-b', { text: 'second' }]]);
    assert.deepEqual(error.usage, { promptTokens: 12, completionTokens: 4 });
    assert.deepEqual(error.observation, observations.at(-1));
    assert.equal(error.observation.validItems, 1);
    assert.equal(error.observation.lastItemAt, 200);
    assert.equal(error.observation.outputChars, '[1,"second"]\n[1,"duplicate"]\n[0,"truncated'.length);
    return true;
  });
  harness.fail();
  await rejected;
  assert.equal(harness.calls, 1);
});

test('hybrid cancellation does not accept a truncated row or retry', async () => {
  const harness = streamHarness();
  const controller = new AbortController();
  const observations = [];
  const pending = harness.provider.complete(request({ signal: controller.signal,
    onObservation: snapshot => observations.push(snapshot) }));
  await flush();
  harness.setTime(150);
  harness.push(delta('[0,"ready"]\n[1,"unfinished'));
  await flush();
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'cancelled');
    assert.deepEqual([...error.partialItems], [['private-a', { text: 'ready' }]]);
    assert.equal(error.observation.validItems, 1);
    assert.deepEqual(error.observation, observations.at(-1));
    return true;
  });
  controller.abort();
  await rejected;
  assert.equal(harness.calls, 1);
});
