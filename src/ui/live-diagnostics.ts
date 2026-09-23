const RUNTIME_DIAGNOSTICS_SCHEMA = 'danlingo-runtime-diagnostics';
const RUNTIME_DIAGNOSTICS_VERSION = 1 as const;
const PAGE_SCOPE = 'browser-local-most-recent-live-tab' as const;
const ENGINE_SCOPE = 'global-extension-engine' as const;
const TRACE_SCOPE = 'bounded-recent-engine-trace' as const;

const platforms = new Set(['niconico', 'youtube', 'bilibili']);
const scenarios = new Set(['video', 'live']);
const connections = new Set(['connecting', 'connected', 'reconnecting', 'disconnected', 'ended']);
const coverages = new Set(['all', 'top', 'unknown']);

const pageCountFields = [
  'messages', 'translated', 'original', 'cacheHits', 'queued', 'prepared', 'failed',
  'nearTotal', 'nearPrepared', 'inflight', 'recentEligible', 'recentTranslated',
  'timedOut', 'overloaded', 'dropped',
] as const;
const liveCountFields = [
  'submitted', 'presented', 'translated', 'original', 'timedOut', 'overloaded',
  'removed', 'abandoned', 'pending', 'translatedChars', 'cachedTranslated', 'received', 'observationMs',
  'unconfirmed', 'repaired', 'repairApplied',
] as const;
const engineCountFields = [
  'pendingItems', 'queuedItems', 'pendingBytes', 'subscribers', 'activeRequests',
  'providerCalls', 'retries', 'mergedInputs', 'cacheHits', 'translated', 'failed',
  'expired', 'original', 'deferred', 'cacheErrors', 'usageReports',
  'usageUnavailableCalls', 'rawInputs', 'uniqueTasks', 'duplicateOutputIds',
] as const;
const usageFields = [
  'promptTokens', 'completionTokens', 'totalTokens', 'cachedInputTokens',
  'cacheWriteTokens', 'reasoningTokens',
] as const;
const latencyFields = ['p50', 'p95', 'p99', 'samples'] as const;
const traceTypes = new Set(['arrival', 'bind', 'queued', 'ready', 'attempt', 'settled']);

const MAX_COUNT = 1_000_000_000;
const MAX_LATENCY_MS = 86_400_000;

type RecordValue = Record<string, unknown>;
type SafeCounts = Record<string, number>;
type SafePlatform = 'niconico' | 'youtube' | 'bilibili';
type SafeScenario = 'video' | 'live';
type SafeConnection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'ended';
type SafeCoverage = 'all' | 'top' | 'unknown';
type LiveCountField = (typeof liveCountFields)[number];

interface SafeLatency {
  p50?: number;
  p95?: number;
  p99?: number;
  samples?: number;
}

interface SafeRecentTrace {
  scope: typeof TRACE_SCOPE;
  sampleCount: number;
  observationSpanMs?: number;
  requestStartActiveRequestsPeak?: number;
  settledDurationMs?: SafeLatency;
}

export interface SafeRuntimeDiagnostics {
  schema: typeof RUNTIME_DIAGNOSTICS_SCHEMA;
  version: typeof RUNTIME_DIAGNOSTICS_VERSION;
  capturedAt: string;
  page: {
    scope: typeof PAGE_SCOPE;
    platform?: SafePlatform;
    scenario?: SafeScenario;
    connection?: SafeConnection;
    coverage?: SafeCoverage;
    counts: SafeCounts;
    liveMetrics?: SafeLiveMetrics;
  };
  globalEngine: {
    scope: typeof ENGINE_SCOPE;
    counts: SafeCounts;
    usage?: SafeCounts;
    recentTrace?: SafeRecentTrace;
    local?: { counts: SafeCounts; last: SafeCounts; reasoning?: string };
  };
}

export type SafeLiveMetrics = Partial<Record<LiveCountField, number>> & {
  readinessMs?: SafeLatency;
  releaseDelayMs?: SafeLatency;
};

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_COUNT, Math.floor(value)) : undefined;
}

function safeLatencyValue(value: unknown, field: (typeof latencyFields)[number]): number | undefined {
  if (field === 'samples') return safeCount(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_LATENCY_MS, value) : undefined;
}

function pickCounts(source: RecordValue | undefined, fields: readonly string[]): SafeCounts {
  const result: SafeCounts = {};
  if (!source) return result;
  for (const field of fields) {
    const value = safeCount(source[field]);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function pickLatency(source: unknown): SafeLatency | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const result: SafeLatency = {};
  for (const field of latencyFields) {
    const value = safeLatencyValue(record[field], field);
    if (value !== undefined) result[field] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function pickLiveMetrics(source: unknown): SafeLiveMetrics | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const result: SafeLiveMetrics = {};
  for (const field of liveCountFields) {
    const value = safeCount(record[field]);
    if (value !== undefined) result[field] = value;
  }
  const readinessMs = pickLatency(record.readinessMs);
  const releaseDelayMs = pickLatency(record.releaseDelayMs);
  if (readinessMs) result.readinessMs = readinessMs;
  if (releaseDelayMs) result.releaseDelayMs = releaseDelayMs;
  return Object.keys(result).length ? result : undefined;
}

function percentile(values: number[], ratio: number): number {
  return values[Math.max(0, Math.ceil(values.length * ratio) - 1)]!;
}

function pickRecentTrace(source: unknown): SafeRecentTrace | undefined {
  if (!Array.isArray(source)) return undefined;
  const timestamps: number[] = [];
  const activeRequests: number[] = [];
  const settledDurations: number[] = [];
  for (const value of source.slice(-256)) {
    const trace = asRecord(value);
    if (!trace || typeof trace.type !== 'string' || !traceTypes.has(trace.type)) continue;
    if (typeof trace.at !== 'number' || !Number.isFinite(trace.at) || trace.at < 0) continue;
    timestamps.push(trace.at);
    if (trace.type === 'attempt') {
      const active = safeCount(trace.activeRequests);
      if (active !== undefined) activeRequests.push(active);
    }
    if (trace.type === 'settled') {
      const duration = safeLatencyValue(trace.durationMs, 'p50');
      if (duration !== undefined) settledDurations.push(duration);
    }
  }
  if (!timestamps.length) return { scope: TRACE_SCOPE, sampleCount: 0 };
  let minimum = timestamps[0]!;
  let maximum = timestamps[0]!;
  for (const timestamp of timestamps.slice(1)) {
    minimum = Math.min(minimum, timestamp);
    maximum = Math.max(maximum, timestamp);
  }
  const result: SafeRecentTrace = {
    scope: TRACE_SCOPE,
    sampleCount: Math.min(MAX_COUNT, timestamps.length),
    observationSpanMs: Math.min(MAX_LATENCY_MS, Math.max(0, maximum - minimum)),
  };
  if (activeRequests.length) {
    let peak = activeRequests[0]!;
    for (const active of activeRequests.slice(1)) peak = Math.max(peak, active);
    result.requestStartActiveRequestsPeak = peak;
  }
  if (settledDurations.length) {
    const sorted = [...settledDurations].sort((a, b) => a - b);
    result.settledDurationMs = {
      p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99),
      samples: Math.min(MAX_COUNT, sorted.length),
    };
  }
  return result;
}

function pickAllowed<T extends string>(source: RecordValue | undefined, field: string, allowed: Set<string>): T | undefined {
  const value = source?.[field];
  return typeof value === 'string' && allowed.has(value) ? value as T : undefined;
}

/**
 * Create a bounded diagnostics document from the runtime overview.
 * Only fields in the allowlists above are copied; page and global engine data stay separate.
 */
export function sanitizeRuntimeDiagnostics(
  overview: unknown,
  capturedAt = new Date().toISOString(),
): SafeRuntimeDiagnostics {
  const root = asRecord(overview);
  const status = asRecord(root?.status);
  const engine = asRecord(root?.engine);
  const page: SafeRuntimeDiagnostics['page'] = {
    scope: PAGE_SCOPE,
    counts: pickCounts(status, pageCountFields),
  };
  const platform = pickAllowed<SafePlatform>(status, 'platform', platforms);
  const scenario = pickAllowed<SafeScenario>(status, 'scenario', scenarios);
  const connection = pickAllowed<SafeConnection>(status, 'connection', connections);
  const coverage = pickAllowed<SafeCoverage>(status, 'coverage', coverages);
  if (platform) page.platform = platform;
  if (scenario) page.scenario = scenario;
  if (connection) page.connection = connection;
  if (coverage) page.coverage = coverage;
  const liveMetrics = pickLiveMetrics(status?.liveMetrics);
  if (liveMetrics) page.liveMetrics = liveMetrics;
  const globalEngine: SafeRuntimeDiagnostics['globalEngine'] = {
    scope: ENGINE_SCOPE,
    counts: pickCounts(engine, engineCountFields),
  };
  const usage = pickCounts(asRecord(engine?.usage), usageFields);
  if (Object.keys(usage).length) globalEngine.usage = usage;
  const recentTrace = pickRecentTrace(engine?.recentTrace);
  if (recentTrace) globalEngine.recentTrace = recentTrace;
  const local = asRecord(engine?.localDiagnostics);
  if (local) {
    const last: SafeCounts = {}, source = asRecord(local.last);
    for (const key of ['queueMs', 'inferenceMs', 'promptMs', 'decodeMs', 'promptTokens', 'outputTokens', 'cachedTokens', 'maxTokens'] as const) {
      const value = key.endsWith('Ms') ? safeLatencyValue(source?.[key], 'p50') : safeCount(source?.[key]);
      if (value !== undefined) last[key] = value;
    }
    globalEngine.local = { counts: pickCounts(local, ['queuedDeadline', 'runningDeadline', 'requestTimeout', 'qualityRejected', 'forcedCalls']), last };
    const reasoning = source?.reasoning === true ? 'on' : source?.reasoning === false ? 'off' : source?.reasoning;
    if (typeof reasoning === 'string' && ['auto','off','on','low','medium','high','max'].includes(reasoning)) globalEngine.local.reasoning = reasoning;
  }
  return {
    schema: RUNTIME_DIAGNOSTICS_SCHEMA,
    version: RUNTIME_DIAGNOSTICS_VERSION,
    capturedAt,
    page,
    globalEngine,
  };
}
