import type { Usage } from '../core/types.ts';
import type { LocalRuntimeConfig } from '../local/types.ts';
import type { PerformanceConfig, PerformanceErrorSummary, PerformanceMeasurement, PerformanceReport, PerformanceTiming } from './performance-test.ts';

export const PERFORMANCE_HISTORY_KEY = 'performanceHistory.v1';
export const PERFORMANCE_HISTORY_LIMIT = 50;
export const PERFORMANCE_HISTORY_RECORD_INVALID = 'PERFORMANCE_HISTORY_RECORD_INVALID';
export const PERFORMANCE_HISTORY_DELETE_IDS_INVALID = 'PERFORMANCE_HISTORY_DELETE_IDS_INVALID';

export type PerformanceHistoryRuntime = Omit<LocalRuntimeConfig, 'autoRecommendation'>;
export type PerformanceHistoryMeasurement = Omit<PerformanceMeasurement, 'localRuntime'> & {
  localRuntime?: PerformanceHistoryRuntime;
};

export interface PerformanceRecord {
  schemaVersion: 1;
  id: string;
  state: 'completed' | 'stopped';
  wallStartedAt: number;
  durationMs: number;
  model: string;
  backend: string;
  config: PerformanceConfig;
  measurement: PerformanceHistoryMeasurement;
  timing: PerformanceTiming;
  actualRequests: number;
  successRequests: number;
  failed: number;
  timeout: number;
  cancelled: number;
  unsent: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  successRate: number | null;
  meanQueueMs: number | null;
  meanReadyMs: number | null;
  withinBudgetRate: number | null;
  throughput: number;
  firstRequestMs: number | null;
  stableMeanMs: number | null;
  usage?: Usage;
  usageReports: number;
  localInferenceCalls?: number | null;
  errorCategories?: PerformanceErrorSummary;
}

export interface PerformanceHistoryStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteAtLeast(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function isIntegerAtLeast(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && isFiniteAtLeast(value, minimum);
}

function isNullableNumber(value: unknown, minimum = 0, maximum = Number.POSITIVE_INFINITY): value is number | null {
  return value === null || isFiniteAtLeast(value, minimum) && value <= maximum;
}

function safeIdentifier(value: unknown, maximumLength = 100): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maximumLength || /[\\\u0000-\u001f]/.test(text)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(text)) return null;
  if (/(?:api[_ -]?key|token|secret|password|bearer|authorization)/i.test(text)) return null;
  return text;
}

function safeHistoryId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 128 && /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : null;
}

function safeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 512 || /[\\\u0000-\u001f\u007f]/.test(text)) return null;
  if (text.startsWith('/') || /^[a-z]:[\\/]/i.test(text) || /^\\\\/.test(text)) return null;
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:Bearer|Basic)\s+\S+/i.test(text)) return null;
  if (/^(?:sk|pk|rk)-[a-z0-9_-]{8,}$/i.test(text) ||
      /^(?:gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{10,})$/i.test(text) ||
      /^AIza[a-z0-9_-]{30,}$/i.test(text) ||
      /^eyj[a-z0-9_-]+\.eyj[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(text) ||
      /^[a-f0-9]{32,}$/i.test(text)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._+:/(){}\[\]#@,=+-]*$/u.test(text)) return null;
  return text;
}

function copyConfig(value: unknown): PerformanceConfig | null {
  if (!isRecord(value)) return null;
  if (!isIntegerAtLeast(value.count, 1) || !isIntegerAtLeast(value.concurrency, 1) ||
      !isIntegerAtLeast(value.batchSize, 1) || !isFiniteAtLeast(value.arrivalIntervalMs) ||
      (value.mode !== 'latency' && value.mode !== 'load') ||
      (value.strategy !== 'normal' && value.strategy !== 'superchat')) return null;
  const result: PerformanceConfig = {
    count: value.count,
    mode: value.mode,
    concurrency: value.concurrency,
    batchSize: value.batchSize,
    arrivalIntervalMs: value.arrivalIntervalMs,
    strategy: value.strategy,
  };
  if (value.budgetMs !== undefined) {
    if (!isFiniteAtLeast(value.budgetMs)) return null;
    result.budgetMs = value.budgetMs;
  }
  return result;
}

function copyRuntime(value: unknown): PerformanceHistoryRuntime | null {
  if (!isRecord(value)) return null;
  if (!['auto', 'low-memory', 'balanced', 'high-performance', 'custom'].includes(String(value.mode)) ||
      !isIntegerAtLeast(value.parallel, 1) || !isIntegerAtLeast(value.contextTokens, 1) ||
      !isIntegerAtLeast(value.estimatedTokensPerRequest) ||
      !['compatibility', 'balanced', 'throughput', 'custom'].includes(String(value.batchPreset)) ||
      !isIntegerAtLeast(value.batch, 1) || !isIntegerAtLeast(value.microBatch, 1) ||
      typeof value.warmup !== 'boolean' || !['auto', 'on', 'off'].includes(String(value.flashAttention)) ||
      !(value.cpuThreads === 'auto' || isIntegerAtLeast(value.cpuThreads, 1)) ||
      !isFiniteAtLeast(value.temperature) || value.temperature > 2 ||
      !isIntegerAtLeast(value.normalMaxTokens, 1) || !isIntegerAtLeast(value.superChatMaxTokens, 1) ||
      !isIntegerAtLeast(value.manualMaxTokens, 1) ||
      !['auto', 'off', 'on', 'low', 'medium', 'high', 'max'].includes(String(value.superChatReasoning)) ||
      typeof value.allowAutoFallback !== 'boolean' || typeof value.reusePromptCache !== 'boolean' ||
      !['auto', 'hy-mt', 'json'].includes(String(value.promptMode)) ||
      !['strict', 'off'].includes(String(value.languageValidation)) || typeof value.measureGpu !== 'boolean' ||
      value.kvUnified !== true || value.continuousBatching !== true) return null;
  if (value.cpuThreadsActual !== undefined && !isIntegerAtLeast(value.cpuThreadsActual, 1)) return null;

  const result: PerformanceHistoryRuntime = {
    mode: value.mode as LocalRuntimeConfig['mode'],
    parallel: value.parallel,
    contextTokens: value.contextTokens,
    estimatedTokensPerRequest: value.estimatedTokensPerRequest,
    batchPreset: value.batchPreset as LocalRuntimeConfig['batchPreset'],
    batch: value.batch,
    microBatch: value.microBatch,
    warmup: value.warmup,
    flashAttention: value.flashAttention as LocalRuntimeConfig['flashAttention'],
    cpuThreads: value.cpuThreads as LocalRuntimeConfig['cpuThreads'],
    temperature: value.temperature,
    normalMaxTokens: value.normalMaxTokens,
    superChatMaxTokens: value.superChatMaxTokens,
    manualMaxTokens: value.manualMaxTokens,
    superChatReasoning: value.superChatReasoning as LocalRuntimeConfig['superChatReasoning'],
    allowAutoFallback: value.allowAutoFallback,
    reusePromptCache: value.reusePromptCache,
    promptMode: value.promptMode as LocalRuntimeConfig['promptMode'],
    languageValidation: value.languageValidation as LocalRuntimeConfig['languageValidation'],
    measureGpu: value.measureGpu,
    kvUnified: true,
    continuousBatching: true,
  };
  if (value.cpuThreadsActual !== undefined) result.cpuThreadsActual = value.cpuThreadsActual as number;
  return result;
}

function copyMeasurement(value: unknown): PerformanceHistoryMeasurement | null {
  if (!isRecord(value) || value.corpus !== 'danlingo-fixed-v1') return null;
  const sourceLanguage = safeIdentifier(value.sourceLanguage, 32);
  const sampleLanguage = safeIdentifier(value.sampleLanguage, 32);
  const targetLanguage = safeIdentifier(value.targetLanguage, 32);
  const profile = safeIdentifier(value.profile, 64);
  const thinkingEffort = safeIdentifier(value.thinkingEffort, 32);
  if (!sourceLanguage || !sampleLanguage || !targetLanguage || !profile || !thinkingEffort ||
      !isIntegerAtLeast(value.requestTimeoutMs, 1) || !isIntegerAtLeast(value.budgetMs, 1) ||
      !isIntegerAtLeast(value.batchSize, 1) || !isIntegerAtLeast(value.maxBatchChars, 1) ||
      typeof value.translationStream !== 'boolean') return null;

  const result: PerformanceHistoryMeasurement = {
    corpus: 'danlingo-fixed-v1', sourceLanguage, sampleLanguage, targetLanguage, profile, thinkingEffort,
    requestTimeoutMs: value.requestTimeoutMs, budgetMs: value.budgetMs, batchSize: value.batchSize,
    maxBatchChars: value.maxBatchChars, translationStream: value.translationStream,
  };
  const optionalIntegers: Array<[keyof PerformanceHistoryMeasurement, unknown]> = [
    ['liveMaxBatchWaitMs', value.liveMaxBatchWaitMs], ['liveMaxInputTokens', value.liveMaxInputTokens],
    ['liveMaxOutputTokens', value.liveMaxOutputTokens], ['localCapacity', value.localCapacity],
    ['localContextTokens', value.localContextTokens],
  ];
  for (const [key, candidate] of optionalIntegers) {
    if (candidate === undefined) continue;
    if (!isIntegerAtLeast(candidate)) return null;
    (result as unknown as UnknownRecord)[key] = candidate;
  }
  if (value.liveAdaptiveConcurrency !== undefined) {
    if (typeof value.liveAdaptiveConcurrency !== 'boolean') return null;
    result.liveAdaptiveConcurrency = value.liveAdaptiveConcurrency;
  }
  if (value.localTranslationProfile !== undefined) {
    const localTranslationProfile = safeIdentifier(value.localTranslationProfile, 64);
    if (!localTranslationProfile) return null;
    result.localTranslationProfile = localTranslationProfile as PerformanceMeasurement['localTranslationProfile'];
  }
  if (value.extensionVersion !== undefined) {
    const extensionVersion = safeIdentifier(value.extensionVersion, 32);
    if (!extensionVersion) return null;
    result.extensionVersion = extensionVersion;
  }
  if (value.localRuntime !== undefined) {
    const localRuntime = copyRuntime(value.localRuntime);
    if (!localRuntime) return null;
    result.localRuntime = localRuntime;
  }
  if (value.capacityIdentity !== undefined) {
    if (typeof value.capacityIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.capacityIdentity)) return null;
    result.capacityIdentity = value.capacityIdentity;
  }
  return result;
}

function copyTiming(value: unknown): PerformanceTiming | null {
  if (!isRecord(value) || !isNullableNumber(value.firstValidMs) ||
      !isIntegerAtLeast(value.readyWithin1s) || !isIntegerAtLeast(value.readyWithin2s) ||
      !isIntegerAtLeast(value.readyWithin5s) || !isIntegerAtLeast(value.validItems) ||
      !isIntegerAtLeast(value.plannedItems) || !isFiniteAtLeast(value.itemsPerSecond) ||
      !isNullableNumber(value.meanItemReadyMs) || !isNullableNumber(value.p95ItemReadyMs) ||
      !isIntegerAtLeast(value.peakRequests)) return null;
  if (value.readySourceCharsWithin5s !== undefined && !isIntegerAtLeast(value.readySourceCharsWithin5s)) return null;
  return {
    firstValidMs: value.firstValidMs,
    readyWithin1s: value.readyWithin1s,
    readyWithin2s: value.readyWithin2s,
    readyWithin5s: value.readyWithin5s,
    validItems: value.validItems,
    plannedItems: value.plannedItems,
    itemsPerSecond: value.itemsPerSecond,
    meanItemReadyMs: value.meanItemReadyMs,
    p95ItemReadyMs: value.p95ItemReadyMs,
    peakRequests: value.peakRequests,
    ...(value.readySourceCharsWithin5s === undefined ? {} : { readySourceCharsWithin5s: value.readySourceCharsWithin5s as number }),
  };
}

function copyErrorCategories(value: unknown): PerformanceErrorSummary | null {
  if (!isRecord(value) || !isIntegerAtLeast(value.deadline) || !isIntegerAtLeast(value.capacity) ||
      !isIntegerAtLeast(value.runtime)) return null;
  return { deadline: value.deadline, capacity: value.capacity, runtime: value.runtime };
}

function copyUsage(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  const result: Usage = {};
  const fields: Array<keyof Usage> = [
    'promptTokens', 'completionTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens',
  ];
  for (const field of fields) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (!isIntegerAtLeast(candidate)) return null;
    result[field] = candidate;
  }
  return result;
}

function copyStoredRecord(value: unknown): PerformanceRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      (value.state !== 'completed' && value.state !== 'stopped')) return null;
  const id = safeHistoryId(value.id);
  const model = safeModel(value.model);
  const backend = safeIdentifier(value.backend, 80);
  const config = copyConfig(value.config);
  const measurement = copyMeasurement(value.measurement);
  const timing = copyTiming(value.timing);
  if (!id || !model || !backend || !config || !measurement || !timing ||
      !isFiniteAtLeast(value.wallStartedAt) || !isFiniteAtLeast(value.durationMs) ||
      !isIntegerAtLeast(value.actualRequests) || !isIntegerAtLeast(value.successRequests) ||
      !isIntegerAtLeast(value.failed) || !isIntegerAtLeast(value.timeout) ||
      !isIntegerAtLeast(value.cancelled) || !isIntegerAtLeast(value.unsent) ||
      !isNullableNumber(value.meanMs) || !isNullableNumber(value.p50Ms) || !isNullableNumber(value.p95Ms) ||
      !isNullableNumber(value.successRate, 0, 1) || !isNullableNumber(value.meanQueueMs) ||
      !isNullableNumber(value.meanReadyMs) || !isNullableNumber(value.withinBudgetRate, 0, 1) ||
      !isFiniteAtLeast(value.throughput) || !isNullableNumber(value.firstRequestMs) ||
      !isNullableNumber(value.stableMeanMs) || !isIntegerAtLeast(value.usageReports)) return null;
  if (value.usage !== undefined && !copyUsage(value.usage)) return null;
  if (value.localInferenceCalls !== undefined && value.localInferenceCalls !== null &&
      !isIntegerAtLeast(value.localInferenceCalls)) return null;
  const errorCategories = value.errorCategories === undefined ? undefined : copyErrorCategories(value.errorCategories);
  if (value.errorCategories !== undefined && !errorCategories) return null;

  const result: PerformanceRecord = {
    schemaVersion: 1, id, state: value.state, wallStartedAt: value.wallStartedAt,
    durationMs: value.durationMs, model, backend, config, measurement, timing,
    actualRequests: value.actualRequests, successRequests: value.successRequests, failed: value.failed,
    timeout: value.timeout, cancelled: value.cancelled, unsent: value.unsent,
    meanMs: value.meanMs, p50Ms: value.p50Ms, p95Ms: value.p95Ms, successRate: value.successRate,
    meanQueueMs: value.meanQueueMs, meanReadyMs: value.meanReadyMs,
    withinBudgetRate: value.withinBudgetRate, throughput: value.throughput,
    firstRequestMs: value.firstRequestMs, stableMeanMs: value.stableMeanMs, usageReports: value.usageReports,
  };
  if (value.usage !== undefined) result.usage = copyUsage(value.usage)!;
  if (value.localInferenceCalls !== undefined) result.localInferenceCalls = value.localInferenceCalls as number | null;
  if (errorCategories) result.errorCategories = errorCategories;
  return result;
}

export function performanceRecord(report: PerformanceReport): PerformanceRecord | null {
  if (report.state === 'running') return null;
  if (report.state !== 'completed' && report.state !== 'stopped' ||
      !isFiniteAtLeast(report.startedAt) || !isFiniteAtLeast(report.finishedAt) || report.finishedAt < report.startedAt) return null;
  const candidate: UnknownRecord = {
    schemaVersion: 1,
    id: report.id,
    state: report.state,
    wallStartedAt: report.wallStartedAt,
    durationMs: report.finishedAt - report.startedAt,
    model: report.model,
    backend: report.backend,
    config: report.config,
    measurement: report.measurement,
    timing: report.timing,
    actualRequests: report.actualRequests,
    successRequests: report.successRequests,
    failed: report.failed,
    timeout: report.timeout,
    cancelled: report.cancelled,
    unsent: report.unsent,
    meanMs: report.meanMs,
    p50Ms: report.p50Ms,
    p95Ms: report.p95Ms,
    successRate: report.successRate,
    meanQueueMs: report.meanQueueMs,
    meanReadyMs: report.meanReadyMs,
    withinBudgetRate: report.withinBudgetRate,
    throughput: report.throughput,
    firstRequestMs: report.firstRequestMs,
    stableMeanMs: report.stableMeanMs,
    usageReports: report.usageReports,
  };
  if (report.usage !== undefined) candidate.usage = report.usage;
  if (report.localInferenceCalls !== undefined) candidate.localInferenceCalls = report.localInferenceCalls;
  if (report.errorCategories !== undefined) candidate.errorCategories = report.errorCategories;
  return copyStoredRecord(candidate);
}

function storedItems(storageValue: unknown): PerformanceRecord[] {
  if (!isRecord(storageValue)) return [];
  const entries = storageValue[PERFORMANCE_HISTORY_KEY];
  if (!Array.isArray(entries)) return [];
  const result: PerformanceRecord[] = [];
  for (const item of entries) {
    const record = copyStoredRecord(item);
    if (record) result.push(record);
  }
  return result;
}

export class PerformanceHistory {
  private writes: Promise<void> = Promise.resolve();
  private readonly storage: PerformanceHistoryStorage;

  constructor(storage: PerformanceHistoryStorage) {
    this.storage = storage;
  }

  async list(): Promise<PerformanceRecord[]> {
    await this.writes;
    const value = await this.storage.get(PERFORMANCE_HISTORY_KEY);
    return storedItems(value).sort((left, right) => right.wallStartedAt - left.wallStartedAt)
      .slice(0, PERFORMANCE_HISTORY_LIMIT);
  }

  save(report: PerformanceReport): Promise<void> {
    if (report.state === 'running') return Promise.resolve();
    const record = performanceRecord(report);
    if (!record) return Promise.reject(new Error(PERFORMANCE_HISTORY_RECORD_INVALID));

    const operation = this.writes.then(async () => {
      const value = await this.storage.get(PERFORMANCE_HISTORY_KEY);
      const records = storedItems(value).filter(item => item.id !== record.id);
      records.push(record);
      records.sort((left, right) => right.wallStartedAt - left.wallStartedAt);
      await this.storage.set({ [PERFORMANCE_HISTORY_KEY]: records.slice(0, PERFORMANCE_HISTORY_LIMIT) });
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  delete(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > PERFORMANCE_HISTORY_LIMIT) {
      return Promise.reject(new Error(PERFORMANCE_HISTORY_DELETE_IDS_INVALID));
    }
    const normalizedIds: string[] = [];
    for (const id of ids) {
      const normalized = safeHistoryId(id);
      if (!normalized) return Promise.reject(new Error(PERFORMANCE_HISTORY_DELETE_IDS_INVALID));
      normalizedIds.push(normalized);
    }
    const selected = new Set(normalizedIds);
    const operation = this.writes.then(async () => {
      const value = await this.storage.get(PERFORMANCE_HISTORY_KEY);
      const records = storedItems(value).filter(record => !selected.has(record.id));
      await this.storage.set({ [PERFORMANCE_HISTORY_KEY]: records.slice(0, PERFORMANCE_HISTORY_LIMIT) });
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}
