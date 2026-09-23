import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRuntimeDiagnostics } from '../../src/ui/live-diagnostics.ts';
import { liveStatusText } from '../../src/ui/live-status.ts';

test('runtime diagnostics export keeps allowlisted page/live metrics and global engine aggregates', () => {
  const overview = {
    status: {
      state: 'ready', platform: 'youtube', scenario: 'live', connection: 'connected', coverage: 'top',
      resourceId: 'room-secret', note: 'private note', messages: 12, translated: 9, original: 3,
      cacheHits: 2, queued: 4, recentEligible: 10, recentTranslated: 8, timedOut: 1, overloaded: 2,
      dropped: 3, arbitrary: 'drop this',
      liveMetrics: {
        submitted: 12, presented: 11, translated: 9, original: 2, timedOut: 1, overloaded: 2,
        removed: 1, abandoned: 0, pending: 4, translatedChars: 320, received: 14, observationMs: 5000,
        readinessMs: { p50: 120, p95: 300, p99: 450, samples: 9, secret: 'drop this' },
        releaseDelayMs: { p50: 200, p95: 500, p99: 900, samples: 11 },
        text: 'must not export', nested: { resourceId: 'also-secret' },
      },
    },
    engine: {
      pendingItems: 4, queuedItems: 3, pendingBytes: 800, subscribers: 5, activeRequests: 2,
      providerCalls: 20, retries: 1, mergedInputs: 7, cacheHits: 6, translated: 17, failed: 2,
      expired: 1, original: 3, deferred: 2, cacheErrors: 0, usageReports: 18,
      usageUnavailableCalls: 2, rawInputs: 30, uniqueTasks: 22, duplicateOutputIds: 1,
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, reasoningTokens: 100,
        endpoint: 'https://secret.example', arbitrary: 99 },
      recentTrace: [
        { type: 'attempt', at: 1000, activeRequests: 3, taskIds: ['secret-task'], evil: 'drop this' },
        { type: 'attempt', at: 1100, activeRequests: 7, liveDispatch: { budgets: [{ taskId: 'secret-task' }] } },
        { type: 'settled', at: 1400, durationMs: 300, status: 'private provider status', usage: { promptTokens: 1 } },
        { type: 'settled', at: 1500, durationMs: 100, status: 'private provider status', duplicateIds: 0 },
        { type: 'ready', at: 1600, taskId: 'secret-task', reason: 'private reason', text: 'secret text' },
        { type: 'malicious', at: 9000, activeRequests: 999, endpoint: 'https://secret.example' },
      ],
      lastError: { reason: 'private provider error', status: 500 },
    },
  };

  const exported = sanitizeRuntimeDiagnostics(overview, '2026-09-13T12:34:56.000Z');

  assert.deepEqual(exported, {
    schema: 'danlingo-runtime-diagnostics', version: 1, capturedAt: '2026-09-13T12:34:56.000Z',
    page: {
      scope: 'browser-local-most-recent-live-tab',
      platform: 'youtube', scenario: 'live', connection: 'connected', coverage: 'top',
      counts: { messages: 12, translated: 9, original: 3, cacheHits: 2, queued: 4,
        recentEligible: 10, recentTranslated: 8, timedOut: 1, overloaded: 2, dropped: 3 },
      liveMetrics: {
        submitted: 12, presented: 11, translated: 9, original: 2, timedOut: 1, overloaded: 2,
        removed: 1, abandoned: 0, pending: 4, translatedChars: 320, received: 14, observationMs: 5000,
        readinessMs: { p50: 120, p95: 300, p99: 450, samples: 9 },
        releaseDelayMs: { p50: 200, p95: 500, p99: 900, samples: 11 },
      },
    },
    globalEngine: {
      scope: 'global-extension-engine',
      counts: { pendingItems: 4, queuedItems: 3, pendingBytes: 800, subscribers: 5, activeRequests: 2,
        providerCalls: 20, retries: 1, mergedInputs: 7, cacheHits: 6, translated: 17, failed: 2,
        expired: 1, original: 3, deferred: 2, cacheErrors: 0, usageReports: 18,
        usageUnavailableCalls: 2, rawInputs: 30, uniqueTasks: 22, duplicateOutputIds: 1 },
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, reasoningTokens: 100 },
      recentTrace: {
        scope: 'bounded-recent-engine-trace', sampleCount: 5, observationSpanMs: 600,
        requestStartActiveRequestsPeak: 7, settledDurationMs: { p50: 100, p95: 300, p99: 300, samples: 2 },
      },
    },
  });
  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes('room-secret'), false);
  assert.equal(serialized.includes('secret-task'), false);
  assert.equal(serialized.includes('secret.example'), false);
  assert.equal(serialized.includes('private provider status'), false);
  assert.equal(serialized.includes('private reason'), false);
});

test('invalid values and absent live metrics are omitted without changing the source object', () => {
  const status = {
    platform: 'twitch', scenario: 'live', connection: 'connected', coverage: 'all', messages: -1,
    translated: Number.POSITIVE_INFINITY, queued: '3', liveMetrics: {
      submitted: 1_000_000_001, pending: -4, observationMs: Number.NaN,
      readinessMs: { p50: -1, p95: Number.POSITIVE_INFINITY, samples: 1.5 },
    },
  };
  const overview = { status, engine: { pendingItems: 2_000_000_001, activeRequests: 2 } };
  const before = structuredClone(overview);

  const exported = sanitizeRuntimeDiagnostics(overview, 'captured');

  assert.deepEqual(exported.page, {
    scope: 'browser-local-most-recent-live-tab',
    scenario: 'live', connection: 'connected', coverage: 'all', counts: {},
    liveMetrics: { submitted: 1_000_000_000, readinessMs: { samples: 1 } },
  });
  assert.deepEqual(exported.globalEngine, { scope: 'global-extension-engine', counts: { pendingItems: 1_000_000_000, activeRequests: 2 } });
  assert.deepEqual(overview, before);
});

test('empty overview produces a stable schema with no untrusted runtime values', () => {
  assert.deepEqual(sanitizeRuntimeDiagnostics(null, '2026-09-13T00:00:00.000Z'), {
    schema: 'danlingo-runtime-diagnostics', version: 1, capturedAt: '2026-09-13T00:00:00.000Z',
    page: { scope: 'browser-local-most-recent-live-tab', counts: {} },
    globalEngine: { scope: 'global-extension-engine', counts: {} },
  });
});

test('live status removes obsolete overlay density and speed advice', () => {
  const text = liveStatusText({ state: 'degraded', connection: 'connected',
    note: '近期译文未达90%；超时可调整翻译配置，过载可调整弹幕密度或速度', messages: 0,
    translated: 0, original: 0, cacheHits: 0, queued: 0 });
  assert.equal(text.state, '已连接 · 近期译文未达90%；超时可调整翻译配置');
  assert.equal(text.state.includes('密度'), false);
  assert.equal(text.state.includes('速度'), false);
});
