import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERFORMANCE_HISTORY_KEY,
  PERFORMANCE_HISTORY_LIMIT,
  PERFORMANCE_HISTORY_DELETE_IDS_INVALID,
  PERFORMANCE_HISTORY_RECORD_INVALID,
  PerformanceHistory,
  performanceRecord,
} from '../../src/translation/performance-history.ts';
import { hybridCapacityIdentity, recommendHybridCapacity } from '../../src/translation/hybrid-capacity.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';

const config = {
  count: 2, mode: 'load', concurrency: 2, batchSize: 2, arrivalIntervalMs: 10, strategy: 'normal', budgetMs: 800,
};
const measurement = {
  corpus: 'danlingo-fixed-v1', sourceLanguage: 'ja', sampleLanguage: 'ja', targetLanguage: 'zh-Hans',
  profile: 'deepseek', thinkingEffort: 'off', requestTimeoutMs: 12000, budgetMs: 800,
  batchSize: 2, maxBatchChars: 4000, translationStream: false,
};
const timing = {
  firstValidMs: 70, readyWithin1s: 2, readyWithin2s: 2, readyWithin5s: 2, validItems: 2, plannedItems: 2,
  itemsPerSecond: 4, meanItemReadyMs: 120, p95ItemReadyMs: 160, peakRequests: 2,
};

function makeReport(overrides = {}) {
  return {
    id: 'run-1', state: 'completed', config: { ...config }, model: 'deepseek-chat', backend: 'online',
    startedAt: 100, finishedAt: 600, wallStartedAt: 1000, measurement: { ...measurement }, timing: { ...timing },
    planned: 2, admitted: 2, completed: 2, actualRequests: 2, successRequests: 2, failed: 0, timeout: 0,
    cancelled: 0, unsent: 0, meanMs: 200, p50Ms: 180, p95Ms: 250, successRate: 1,
    meanQueueMs: 10, meanReadyMs: 300, withinBudgetRate: 1, throughput: 4,
    firstRequestMs: 200, stableMeanMs: 180, usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
    usageReports: 2, localInferenceCalls: 0, samples: [], jobs: [], notes: [],
    ...overrides,
  };
}

function memoryStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    getCalls: 0,
    setCalls: 0,
    async get(key) {
      this.getCalls++;
      return { [key]: state[key] };
    },
    async set(values) {
      this.setCalls++;
      Object.assign(state, values);
    },
  };
}

test('saves completed and stopped runs as terminal summaries', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);
  await history.save(makeReport());
  await history.save(makeReport({ id: 'run-2', state: 'stopped', wallStartedAt: 2000 }));

  const records = await history.list();
  assert.deepEqual(records.map(record => record.state), ['stopped', 'completed']);
  assert.equal(records[0].durationMs, 500);
  assert.equal(records[0].schemaVersion, 1);
  assert.equal(storage.state[PERFORMANCE_HISTORY_KEY].length, 2);
});

test('running reports do not access or write storage', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);
  const report = makeReport({ state: 'running', finishedAt: undefined });

  assert.equal(performanceRecord(report), null);
  await history.save(report);
  assert.equal(storage.getCalls, 0);
  assert.equal(storage.setCalls, 0);
});

test('an invalid terminal report rejects instead of silently reporting a successful save', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);

  await assert.rejects(
    history.save(makeReport({ model: 'https://provider.example/v1' })),
    { message: PERFORMANCE_HISTORY_RECORD_INVALID },
  );
  assert.equal(storage.getCalls, 0);
  assert.equal(storage.setCalls, 0);
});

test('local GGUF filenames and online namespace model tags are retained', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);
  const localName = 'Mixtral-8x7B Secret Token (Q4_K_M).gguf';
  const onlineName = 'deepseek-ai/DeepSeek-V3.2:latest';
  const longName = 'm'.repeat(80);

  await history.save(makeReport({ id: 'local-model', model: localName, wallStartedAt: 1000 }));
  await history.save(makeReport({ id: 'online-model', model: onlineName, wallStartedAt: 2000 }));
  await history.save(makeReport({ id: 'long-model', model: longName, wallStartedAt: 3000 }));

  assert.deepEqual((await history.list()).map(record => record.model), [longName, onlineName, localName]);
});

test('history can be reconstructed from the same storage', async () => {
  const storage = memoryStorage();
  await new PerformanceHistory(storage).save(makeReport());

  const reopened = new PerformanceHistory(storage);
  assert.equal((await reopened.list())[0].id, 'run-1');
});

test('concurrent saves retain every unique id, deduplicate, and cap the newest records', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);
  await Promise.all(Array.from({ length: 55 }, (_, index) => history.save(makeReport({
    id: `run-${index}`, wallStartedAt: 1000 + index,
  }))));
  await history.save(makeReport({ id: 'run-54', wallStartedAt: 9000 }));

  const records = await history.list();
  assert.equal(records.length, PERFORMANCE_HISTORY_LIMIT);
  assert.equal(records[0].id, 'run-54');
  assert.equal(new Set(records.map(record => record.id)).size, records.length);
  assert.equal(records.at(-1).id, 'run-5');
});

test('a failed storage write rejects and a later save can recover', async () => {
  const storage = memoryStorage();
  const set = storage.set.bind(storage);
  let failOnce = true;
  storage.set = async values => {
    if (failOnce) {
      failOnce = false;
      throw new Error('storage unavailable');
    }
    return set(values);
  };
  const history = new PerformanceHistory(storage);

  await assert.rejects(history.save(makeReport()), /storage unavailable/);
  await history.save(makeReport({ id: 'run-2' }));
  assert.deepEqual((await history.list()).map(record => record.id), ['run-2']);
});

test('queued save followed by delete cannot resurrect the selected record', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);

  const saving = history.save(makeReport());
  const deleting = history.delete(['run-1']);
  await Promise.all([saving, deleting]);
  assert.deepEqual(await history.list(), []);

  await history.save(makeReport({ id: 'preserve-me' }));
  await history.delete(['valid-but-missing']);
  assert.deepEqual((await history.list()).map(record => record.id), ['preserve-me']);
});

test('delete validates a non-empty bounded list of known-format ids', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);

  await assert.rejects(history.delete([]), { message: PERFORMANCE_HISTORY_DELETE_IDS_INVALID });
  await assert.rejects(history.delete(['']), { message: PERFORMANCE_HISTORY_DELETE_IDS_INVALID });
  await assert.rejects(history.delete(['two words']), { message: PERFORMANCE_HISTORY_DELETE_IDS_INVALID });
  await assert.rejects(history.delete(['bad/id']), { message: PERFORMANCE_HISTORY_DELETE_IDS_INVALID });
  await assert.rejects(history.delete(Array(51).fill('valid-id')), { message: PERFORMANCE_HISTORY_DELETE_IDS_INVALID });
  assert.equal(storage.getCalls, 0);
});

test('a failed delete rejects, preserves unrelated rows, and a later delete recovers', async () => {
  const storage = memoryStorage();
  const history = new PerformanceHistory(storage);
  await history.save(makeReport({ id: 'remove-me', wallStartedAt: 1000 }));
  await history.save(makeReport({ id: 'keep-me', wallStartedAt: 2000 }));

  const set = storage.set.bind(storage);
  let failOnce = true;
  storage.set = async values => {
    if (failOnce) {
      failOnce = false;
      throw new Error('storage unavailable');
    }
    return set(values);
  };

  await assert.rejects(history.delete(['remove-me']), /storage unavailable/);
  assert.deepEqual((await history.list()).map(record => record.id), ['keep-me', 'remove-me']);
  await history.delete(['remove-me']);
  assert.deepEqual((await history.list()).map(record => record.id), ['keep-me']);
});

test('only whitelisted summary fields and safe local runtime settings are exported', () => {
  const secret = 'sk-test-super-secret-value';
  const serviceUrl = 'https://private.example/v1';
  const localPath = 'C:\\Users\\private\\models\\secret.gguf';
  const localRuntime = {
    mode: 'balanced', parallel: 2, contextTokens: 2048, estimatedTokensPerRequest: 128,
    batchPreset: 'balanced', batch: 512, microBatch: 256, warmup: true, flashAttention: 'auto',
    cpuThreads: 'auto', temperature: 0.1, normalMaxTokens: 128, superChatMaxTokens: 256,
    manualMaxTokens: 512, superChatReasoning: 'auto', allowAutoFallback: false, reusePromptCache: true,
    promptMode: 'auto', languageValidation: 'strict', measureGpu: true, kvUnified: true,
    continuousBatching: true, cpuThreadsActual: 8,
    autoRecommendation: { modelId: localPath, endpoint: serviceUrl }, apiKey: secret, modelPath: localPath,
  };
  const report = makeReport({
    apiKey: secret, endpoint: serviceUrl, path: localPath,
    notes: [secret, serviceUrl, localPath], samples: [{ reason: secret, text: secret }], jobs: [{ input: secret }],
    config: { ...config, apiKey: secret, endpoint: serviceUrl, path: localPath },
    measurement: { ...measurement, apiKey: secret, endpoint: serviceUrl, path: localPath, localRuntime },
    timing: { ...timing, error: secret, path: localPath },
    usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32, apiKey: secret },
  });

  const record = performanceRecord(report);
  assert.ok(record);
  assert.deepEqual(Object.keys(record).sort(), [
    'schemaVersion', 'id', 'state', 'wallStartedAt', 'durationMs', 'model', 'backend', 'config', 'measurement',
    'timing', 'actualRequests', 'successRequests', 'failed', 'timeout', 'cancelled', 'unsent', 'meanMs', 'p50Ms',
    'p95Ms', 'successRate', 'meanQueueMs', 'meanReadyMs', 'withinBudgetRate', 'throughput', 'firstRequestMs',
    'stableMeanMs', 'usage', 'usageReports', 'localInferenceCalls',
  ].sort());
  assert.equal(record.measurement.localRuntime.apiKey, undefined);
  assert.equal(record.measurement.localRuntime.autoRecommendation, undefined);
  assert.equal(record.usage.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(record), /sk-test-super-secret-value|https:\/\/private\.example|Users\\private|secret\.gguf/);
  assert.equal(performanceRecord(makeReport({ model: secret })), null);
  assert.equal(performanceRecord(makeReport({ model: localPath })), null);
  assert.equal(performanceRecord(makeReport({ backend: serviceUrl })), null);
});

test('list skips malformed entries and strips injected fields from stored records', async () => {
  const secret = 'stored-secret-value';
  const valid = performanceRecord(makeReport());
  const storage = memoryStorage({
    [PERFORMANCE_HISTORY_KEY]: [
      { ...valid, apiKey: secret, notes: [secret], samples: [{ text: secret }],
        config: { ...valid.config, endpoint: 'https://private.example' },
        measurement: { ...valid.measurement, path: 'C:\\private\\model.gguf' },
        usage: { ...valid.usage, token: secret } },
      { ...valid, id: 'invalid-run', state: 'running' },
      null,
      'not a record',
    ],
  });
  const history = new PerformanceHistory(storage);

  const records = await history.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'run-1');
  assert.doesNotMatch(JSON.stringify(records), /stored-secret-value|private\.example|private\\model/);

  storage.state[PERFORMANCE_HISTORY_KEY] = { items: [valid] };
  assert.deepEqual(await history.list(), []);
});

test('capacity identity follows video source language and ignores online and live-only fields', async () => {
  const local = normalizeSettings({ ...DEFAULT_SETTINGS, backend: 'local', localModelId: 'model-one',
    localConcurrency: 4, liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans',
    localPerformance: { mode: 'custom', parallel: 4, temperature: 0.1 } });
  const identity = await hybridCapacityIdentity(local);
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(await hybridCapacityIdentity({ ...local, backend: 'online', endpoint: 'https://online.example/v1', model: 'online-model',
    apiKey: 'not-in-settings', onlineConcurrency: 12, onlineRequestLimitPerDay: 1 }), identity);
  assert.equal(await hybridCapacityIdentity(normalizeSettings(local)), identity);
  assert.notEqual(await hybridCapacityIdentity({ ...local, localConcurrency: 5 }), identity);
  assert.notEqual(await hybridCapacityIdentity({ ...local, sourceLanguage: 'ko' }), identity);
  assert.equal(await hybridCapacityIdentity({ ...local, liveSourceLanguage: 'ko' }), identity);
  assert.notEqual(await hybridCapacityIdentity({ ...local, localPerformance: { ...local.localPerformance, temperature: 0.2 } }), identity);
});

test('capacity recommendation uses the latest eligible local run with real inference and no runtime failure', () => {
  const identity = 'b'.repeat(64);
  const capacityReport = (id, wallStartedAt, overrides = {}) => makeReport({
    id, wallStartedAt, backend: 'local', model: 'local-model', localInferenceCalls: 4,
    config: { count: 10, mode: 'load', concurrency: 4, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal', budgetMs: 5000 },
    measurement: { ...measurement, budgetMs: 5000, capacityIdentity: identity },
    timing: { ...timing, readyWithin5s: 8, validItems: 8, plannedItems: 10, readySourceCharsWithin5s: 101 },
    errorCategories: { deadline: 1, capacity: 1, runtime: 0 }, failed: 2, timeout: 1, unsent: 1,
    ...overrides,
  });
  const older = performanceRecord(capacityReport('old', 1000));
  const newer = performanceRecord(capacityReport('new', 2000, { timing: { ...timing, readyWithin5s: 6,
    validItems: 6, plannedItems: 10, readySourceCharsWithin5s: 80 } }));
  assert.deepEqual(recommendHybridCapacity([older, newer], identity), {
    identity, maxItems: 4, maxChars: 64, p95Ms: 250, sourceRecordId: 'new', manual: false,
  });
  assert.deepEqual(recommendHybridCapacity([older, performanceRecord(capacityReport('protocol-failed', 3000,
    { errorCategories: { deadline: 0, capacity: 0, runtime: 1 }, failed: 1 }))], identity), {
    identity, maxItems: 6, maxChars: 80, p95Ms: 250, sourceRecordId: 'old', manual: false,
  });
  assert.equal(recommendHybridCapacity([older, performanceRecord(capacityReport('zero-capacity', 3500, {
    timing: { ...timing, readyWithin5s: 0, validItems: 0, plannedItems: 10, readySourceCharsWithin5s: 0 },
    errorCategories: { deadline: 0, capacity: 0, runtime: 0 }, failed: 0,
  }))], identity), undefined);
  assert.equal(recommendHybridCapacity([performanceRecord(capacityReport('stopped', 4000, { state: 'stopped' }))], identity), undefined);
  assert.equal(recommendHybridCapacity([performanceRecord(capacityReport('not-inferred', 4000, { localInferenceCalls: 0 }))], identity), undefined);
  assert.equal(recommendHybridCapacity([performanceRecord(capacityReport('old-format', 4000,
    { timing: { ...timing }, errorCategories: undefined }))], identity), undefined);
  assert.equal(recommendHybridCapacity([performanceRecord(capacityReport('no-char-capacity', 4000,
    { timing: { ...timing, readyWithin5s: 1, validItems: 1, readySourceCharsWithin5s: 1 } }))], identity), undefined);
});

test('capacity summary round trips through history without source strings or unlisted error reasons', async () => {
  const storage = memoryStorage();
  const identity = 'f'.repeat(64);
  await new PerformanceHistory(storage).save(makeReport({ measurement: { ...measurement, capacityIdentity: identity },
    timing: { ...timing, readySourceCharsWithin5s: 42 },
    errorCategories: { deadline: 2, capacity: 1, runtime: 0, reason: 'private-error-text' } }));
  const [record] = await new PerformanceHistory(storage).list();
  assert.equal(record.measurement.capacityIdentity, identity);
  assert.equal(record.timing.readySourceCharsWithin5s, 42);
  assert.deepEqual(record.errorCategories, { deadline: 2, capacity: 1, runtime: 0 });
  assert.equal(JSON.stringify(record).includes('private-error-text'), false);
  assert.equal(performanceRecord(makeReport({ measurement: { ...measurement, capacityIdentity: '../secret' } })), null);
});
