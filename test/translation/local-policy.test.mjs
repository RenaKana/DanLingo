import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';
import { localPromptMode, localQualityIssue } from '../../src/translation/local-policy.ts';
import { ChatCompletionsProvider, ProviderError, buildProviderPayload, estimateProviderPayload } from '../../src/translation/provider.ts';
import { testModel, modelTestSource } from '../../src/translation/model-test.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { translationCacheKey } from '../../src/translation/cache.ts';
import { withLocalRuntime } from '../../src/local/provider-settings.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config.ts';
import { PerformanceTest } from '../../src/translation/performance-test.ts';

const settings = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', localModelId: 'uuid-model', model: 'uuid-model',
  localModelName: 'HY-MT1.5-1.8B-Q8_0.gguf', sourceLanguage: 'auto', liveSourceLanguage: 'auto', targetLanguage: 'ja',
  concurrency: 4, localCapacity: 4, localContextTokens: 2048, localPerformance: normalizeLocalConfig() };
const source = '今天的直播很有趣，期待下次再见。';
const translated = '今日の配信はとても面白かったです。またお会いできるのを楽しみにしています。';
const raw = (content, finish_reason = 'stop', metrics) => Response.json({ choices: [{ message: { content }, finish_reason }], danlingo_local: metrics });
const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };

test('HY-MT automatic mode uses trusted model name, one official-style target-language user prompt, no JSON contract', () => {
  assert.equal(localPromptMode(settings), 'hy-mt');
  assert.equal(localPromptMode({ ...settings, backend: 'online' }), 'json');
  assert.equal(localPromptMode({ ...settings, localPerformance: { promptMode: 'json' } }), 'json');
  const body = buildProviderPayload(settings, [{ id: 'a', text: source }], 'deadline');
  assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /翻译为日语/); assert.ok(body.messages[0].content.endsWith(source));
  assert.doesNotMatch(body.messages[0].content, /JSONL|integer_id|targetLanguage/);
  assert.throws(() => buildProviderPayload(settings, [{ id: 'a', text: source }, { id: 'b', text: 'hello' }], 'deadline'), /local-single-item-required/);
  const estimate = estimateProviderPayload(settings, [{ id: 'a', text: source }], 'deadline');
  assert.ok(estimate.fixedPromptBytes > 0 && estimate.requestBytes > estimate.protectedSourceBytes);
});

test('runtime stamp ignores stale saved model display name but preserves user per-request policy', () => {
  const state = { runtime: resolveLocalConfig(), model: { name: 'HY-MT1.5.gguf' } };
  const stamped = withLocalRuntime({ ...settings, localModelName: 'spoof', localPerformance: { promptMode: 'json', languageValidation: 'off' } }, state);
  assert.equal(stamped.localModelName, state.model.name); assert.equal(localPromptMode(stamped), 'json');
  assert.equal(stamped.localPerformance.languageValidation, 'off');
  assert.equal(normalizeSettings(settings).localModelName, undefined);
  assert.equal(normalizeSettings({ ...settings, concurrency: 65 }).concurrency, 65);
});

test('language guard rejects obvious wrong-language and untranslated sentences but preserves inconclusive names and symbols', () => {
  assert.equal(localQualityIssue(settings, source, 'This stream is interesting'), 'wrong-target-language');
  assert.equal(localQualityIssue(settings, source, source), 'untranslated-text');
  for (const text of ['初音未来', '東京', 'YouTube', 'GG', '123', '😂', 'ｗｗｗ', 'すごい！'])
    assert.equal(localQualityIssue(settings, text, text), undefined, text);
  assert.equal(localQualityIssue(settings, source, translated), undefined);
  assert.equal(localQualityIssue({ ...settings, localPerformance: { languageValidation: 'off' } }, source, source), undefined);
  assert.equal(localQualityIssue({ ...settings, backend: 'online' }, source, 'This stream is interesting'), undefined);
});

for (const [output, finish, reason] of [[translated, 'stop', undefined], ['This stream is interesting', 'stop', 'wrong-target-language'],
  [source, 'stop', 'untranslated-text'], [translated, 'length', 'output-truncated']]) {
  test(`production HY parser: ${reason ?? 'valid target translation'}`, async () => {
    const result = await new ChatCompletionsProvider({ fetch: async () => raw(output, finish) }).complete({ settings, apiKey: 'local-inference', mode: 'deadline', budgetMs: 2000, items: [{ id: 'a', text: source }] });
    assert.equal(result.items.get('a').reason, reason);
    assert.equal(result.items.get('a').text, reason ? undefined : translated);
  });
}

test('HY placeholder restoration and forced correction retain fresh inference controls', async () => {
  let sent;
  const result = await new ChatCompletionsProvider({ fetch: async (_url, init) => {
    sent = JSON.parse(init.body); assert.equal(sent.cache_prompt, false);
    assert.match(sent.messages[0].content, /重新翻译/); assert.match(sent.messages[0].content, /\[\[DL:auto0_0\]\]/);
    assert.equal(sent.messages[0].content.split('\n\n')[0].split('\n').length, 1, 'all instructions stay in the header paragraph');
    return raw('とてもかわいいですね [[DL:auto0_0]]');
  } }).complete({ settings, apiKey: 'local-inference', force: true, budgetMs: 2000, mode: 'deadline', items: [{ id: 'emoji', text: '真的好可爱呀 😂' }] });
  assert.equal(result.items.get('emoji').text, 'とてもかわいいですね 😂');
  const broken = await new ChatCompletionsProvider({ fetch: async () => raw('とてもかわいいですね') }).complete({ settings, apiKey: 'local-inference', budgetMs: 2000, items: [{ id: 'emoji', text: '真的好可爱呀 😂' }] });
  assert.equal(broken.items.get('emoji').reason, 'placeholder-mismatch');
});

test('known placeholder instruction echoes fail closed without deleting legitimate source lines', async () => {
  const original='看了给你 🔒，包包，你解说很舒服';
  const leak='すべてのプレースホルダの内容、順序、および数を保持します。';
  // Both common Japanese spellings, including the screenshot spelling without ー.
  for (const line of [leak,leak.replace('プレースホルダ','プレースホルダー'),
    'Preserve every placeholder exactly, in order and count.', '保留所有占位符的内容、顺序和数量。']) {
    const response=await new ChatCompletionsProvider({fetch:async()=>raw(line+'\n\n[[DL:auto0_0]]を見ましたか？解説が心地よいです。')})
      .complete({settings,apiKey:'local-inference',items:[{id:'a',text:original}],mode:'deadline',budgetMs:2000});
    assert.equal(response.items.get('a').reason,'instruction-leak');
    assert.equal(response.items.get('a').text,undefined);
  }
  assert.equal(localQualityIssue(settings,'请保留所有占位符的内容、顺序和数量。',leak),undefined);
  assert.equal(localQualityIssue(settings,original,'翻訳について話します。\n\n解説が心地よいです。'),undefined);
});

test('instruction echo in a stored result or a fresh response never becomes a successful cache hit',async t=>{
  const text='すべてのプレースホルダの内容、順序、および数を保持します。\n\n今日の配信は面白いです。';
  let calls=0,writes=0;
  const engine=new TranslationEngine({cache:{get:async()=>text,set:async()=>writes++},provider:{complete:async request=>{
    calls++;return{items:new Map(request.items.map(item=>[item.id,{text}]))};}}});t.after(()=>engine.dispose());
  for(let n=0;n<2;n++){
    const result=await engine.translate({settings,resourceId:'room',apiKey:'',mode:'deadline',items:[{id:'a',text:source,deadlineAt:performance.now()+3000}]});
    assert.equal(result.items[0].reason,'instruction-leak');assert.equal(result.items[0].text,source);
  }
  assert.equal(calls,2);assert.equal(writes,0);assert.equal(engine.stats().cacheHits,0);
  assert.equal(engine.stats().localDiagnostics.qualityRejected,2);
});

test('local metrics only expose finite allowlisted numbers', async () => {
  for (const metrics of [{ queueMs: 12, inferenceMs: 25, promptMs: 4, outputTokens: 6, privateSource: 'secret' }, { queueMs: null, inferenceMs: 1 }]) {
    const result = await new ChatCompletionsProvider({ fetch: async () => raw(translated, 'stop', metrics) }).complete({ settings, apiKey: 'local-inference', budgetMs: 2000, items: [{ id: 'a', text: source }] });
    if (metrics.queueMs === null) assert.equal(result.local, undefined);
    else { assert.equal(result.local.queueMs, 12); assert.equal(result.local.inferenceMs, 25); assert.equal(result.local.privateSource, undefined); }
  }
});

test('target Japanese Auto test uses Chinese, supports exact user text and rejects unchanged output', async () => {
  assert.match(modelTestSource('auto', 'ja'), /这个视频/);
  assert.throws(() => modelTestSource('ja', 'ja'), /test-same-language/);
  assert.throws(() => modelTestSource('fr', 'ja'), /test-custom-text-required/);
  const result = await testModel({ settings, apiKey: 'local-inference', text: source }, { fetch: async () => raw(translated) });
  assert.equal(result.sourceText, source); assert.equal(result.targetLanguage, 'ja'); assert.equal(result.verification, 'basic-language-check');
  await assert.rejects(testModel({ settings, apiKey: 'local-inference', text: source }, { fetch: async () => raw(source) }), /untranslated-text/);
  const disabled = { ...settings, localPerformance: { languageValidation: 'off' } };
  await assert.rejects(testModel({ settings: disabled, apiKey: 'local-inference', text: source }, { fetch: async () => raw(source) }), /test-unchanged/);
});

test('HY live burst immediately dispatches single-source requests up to observed native capacity', async t => {
  const calls = [];
  const engine = new TranslationEngine({ provider: { complete: request => new Promise(resolve => calls.push({ request, reply: () => resolve({ items: new Map(request.items.map(item => [item.id, { text: translated }])) }) })) } });
  t.after(() => engine.dispose());
  const pending = engine.translate({ settings, resourceId: 'room', apiKey: '', mode: 'deadline',
    items: Array.from({ length: 8 }, (_, i) => ({ id: String(i), text: source + i, deadlineAt: performance.now() + 3000 })) });
  await flush(); assert.equal(calls.length, 4); assert.ok(calls.every(call => call.request.items.length === 1));
  calls.slice().forEach(call => call.reply()); await flush(); assert.equal(calls.length, 8);
  calls.slice(4).forEach(call => call.reply()); assert.ok((await pending).items.every(item => item.status === 'translated'));
});

test('live diagnostics distinguish engine queue deadlines from dispatched deadlines', async t => {
  let now = 0, sequence = 0, calls = 0;
  const timers = new Map();
  const clock = { now: () => now, wallNow: () => now,
    setTimeout: (callback, ms) => { const id = ++sequence; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout: id => timers.delete(id) };
  const engine = new TranslationEngine({ clock, provider: { complete: request => new Promise((_resolve, reject) => {
    calls++; request.signal.addEventListener('abort', () => reject(new ProviderError('cancelled')), { once: true });
  }) } });
  t.after(() => engine.dispose());
  const pending = engine.translate({ settings: { ...settings, localCapacity: 1, liveAdaptiveConcurrency: false },
    resourceId: 'deadline-room', apiKey: '', mode: 'deadline',
    items: [0, 1].map(i => ({ id: String(i), text: source + i, deadlineAt: 1000 })) });
  await flush(); assert.equal(calls, 1);
  for (let guard = 0; guard < 100; guard++) {
    const next = [...timers].filter(([, value]) => value.at <= 1000).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
  }
  const response = await pending;
  assert.ok(response.items.every(item => item.status === 'expired' && item.text.startsWith(source)));
  assert.equal(engine.stats().localDiagnostics.queuedDeadline, 1);
  assert.equal(engine.stats().localDiagnostics.runningDeadline, 1);
  assert.equal(engine.stats().localDiagnostics.requestTimeout, 0);
});

test('transport timeout before arrival deadline has its own diagnostic and preserves source', async t => {
  const engine = new TranslationEngine({ provider: { complete: async () => { throw new ProviderError('timeout', { retryable: true }); } } });
  t.after(() => engine.dispose());
  const response = await engine.translate({ settings, resourceId: 'timeout-room', apiKey: '', mode: 'deadline',
    items: [{ id: 'a', text: source, deadlineAt: performance.now() + 3000 }] });
  assert.equal(response.items[0].reason, 'timeout'); assert.equal(response.items[0].text, source);
  assert.equal(engine.stats().localDiagnostics.requestTimeout, 1);
  assert.equal(engine.stats().localDiagnostics.runningDeadline, 0);
  assert.equal(engine.stats().localDiagnostics.queuedDeadline, 0);
});

test('bad local outputs and old suspect cache entries never become successful cache hits', async t => {
  let calls = 0, writes = 0;
  const cache = { get: async () => 'This stream is interesting', set: async () => writes++ };
  const engine = new TranslationEngine({ cache, provider: { complete: async request => { calls++; return { items: new Map(request.items.map(item => [item.id, { text: source }])) }; } } });
  t.after(() => engine.dispose());
  const request = () => engine.translate({ settings, resourceId: 'room', apiKey: '', mode: 'deadline', items: [{ id: 'a', text: source, deadlineAt: performance.now() + 3000 }] });
  assert.equal((await request()).items[0].reason, 'untranslated-text');
  assert.equal((await request()).items[0].reason, 'untranslated-text');
  assert.equal(calls, 2); assert.equal(writes, 0); assert.equal(engine.stats().cacheHits, 0); assert.equal(engine.stats().localDiagnostics.qualityRejected, 2);
  assert.notEqual(translationCacheKey('room', source, settings), translationCacheKey('room', source, { ...settings, localPerformance: { promptMode: 'json' } }));
  assert.notEqual(translationCacheKey('room', source, settings), translationCacheKey('room', source, { ...settings, localPerformance: { languageValidation: 'off' } }));
});

test('completed forced result waiting for disk write is not reused by the next force click', async t => {
  let release, calls = 0;
  const writes = [];
  const cache = { get: async () => undefined, set: async (_key, text) => { writes.push(text); if (writes.length === 1) await new Promise(resolve => release = resolve); } };
  const engine = new TranslationEngine({ cache, provider: { complete: async request => { assert.equal(request.force, true); calls++; return { items: new Map(request.items.map(item => [item.id, { text: translated + calls }])) }; } } });
  t.after(() => engine.dispose());
  const request = () => engine.translate({ settings, resourceId: 'room', apiKey: '', mode: 'deadline', force: true, items: [{ id: 'a', text: source, deadlineAt: performance.now() + 3000 }] });
  await request(); await flush(); assert.equal(writes.length, 1);
  const second = await request(); assert.ok(second.items[0].text.endsWith('2')); assert.equal(calls, 2);
  assert.equal(engine.stats().localDiagnostics.forcedCalls, 2); release(); await flush(); assert.equal(writes.length, 2);
});

test('HY latency and live-load performance tests share Chinese source, plain target parser and one-item dispatch', async () => {
  for (const mode of ['latency', 'load']) {
    let calls = 0;
    const runner = new PerformanceTest({ mode, count: 3, concurrency: 4, batchSize: 2, arrivalIntervalMs: 0, strategy: 'normal' }, settings, 'local-inference', { fetch: async (_url, init) => {
      const body = JSON.parse(init.body); calls++; assert.equal(body.messages.length, 1); assert.match(body.messages[0].content, /翻译为日语/);
      return raw(translated + (body.messages[0].content.match(/\[\[DL:[^\]]+\]\]/g) ?? []).join(''));
    } });
    const report = await runner.run(); assert.equal(calls, mode === 'load' ? 6 : 3); assert.equal(report.failed, 0); assert.equal(report.successRate, 1);
    if (mode === 'load') assert.equal(report.withinBudgetRate, 1);
  }
});
