import { LIVE_PROMPT_VERSION } from '../core/config.ts';
import type { HybridCapacityProfile, Settings } from '../core/types.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../local/config.ts';
import type { LocalRuntimeConfig } from '../local/types.ts';
import { LOCAL_TRANSLATION_VERSION } from './local-policy.ts';
import type { PerformanceRecord } from './performance-history.ts';

/** Identify the saved local draft, before withLocalRuntime replaces localPerformance. */
export async function hybridCapacityIdentity(settings: Settings): Promise<string> {
  const configured = normalizeLocalConfig(settings.localPerformance);
  const loaded = settings.localPerformance as Partial<LocalRuntimeConfig> | undefined;
  const runtime = loaded?.kvUnified === true && loaded.continuousBatching === true &&
      typeof loaded.contextTokens === 'number'
    ? { ...configured, ...loaded } as LocalRuntimeConfig
    : resolveLocalConfig(configured, settings.localModelId);
  const payload = JSON.stringify({
    version: 'hybrid-capacity-v1', promptVersion: LIVE_PROMPT_VERSION,
    localTranslationVersion: LOCAL_TRANSLATION_VERSION,
    modelId: settings.localModelId ?? '', sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage, concurrency: settings.localConcurrency,
    requestTimeoutMs: settings.requestTimeoutMs, batchSize: settings.batchSize,
    maxBatchChars: settings.maxBatchChars, liveMaxBatchWaitMs: settings.liveMaxBatchWaitMs,
    liveMaxInputTokens: settings.liveMaxInputTokens, liveMaxOutputTokens: settings.liveMaxOutputTokens,
    liveAdaptiveConcurrency: settings.liveAdaptiveConcurrency, translationStream: settings.translationStream,
    runtime: {
      parallel: runtime.parallel, contextTokens: runtime.contextTokens,
      batch: runtime.batch, microBatch: runtime.microBatch, flashAttention: runtime.flashAttention,
      cpuThreads: runtime.cpuThreads, temperature: runtime.temperature,
      normalMaxTokens: runtime.normalMaxTokens, warmup: runtime.warmup,
      allowAutoFallback: runtime.allowAutoFallback, reusePromptCache: runtime.reusePromptCache,
      promptMode: runtime.promptMode, languageValidation: runtime.languageValidation,
      measureGpu: runtime.measureGpu,
    },
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Use the latest qualifying run; a newer runtime failure cannot replace measured capacity. */
export function recommendHybridCapacity(records: PerformanceRecord[], identity: string): HybridCapacityProfile | undefined {
  if (!/^[a-f0-9]{64}$/.test(identity)) return;
  const matching = records.filter(record => record.measurement.capacityIdentity === identity &&
    record.state === 'completed' && record.backend === 'local' && record.config.mode === 'load' &&
    record.config.arrivalIntervalMs === 0 && record.config.batchSize === 1 &&
    record.config.strategy === 'normal' && record.config.budgetMs === 5000 &&
    record.measurement.budgetMs === 5000 && record.measurement.corpus === 'danlingo-fixed-v1' &&
    record.localInferenceCalls !== undefined && record.localInferenceCalls !== null && record.localInferenceCalls > 0 &&
    record.timing.readySourceCharsWithin5s !== undefined && record.errorCategories !== undefined &&
    record.errorCategories.runtime === 0 &&
    record.failed <= record.errorCategories.deadline + record.errorCategories.capacity &&
    record.timing.readyWithin5s <= record.timing.validItems &&
    record.timing.validItems <= record.timing.plannedItems && record.actualRequests > 0);
  matching.sort((a, b) => b.wallStartedAt - a.wallStartedAt);
  const record = matching[0];
  if (!record) return;
  const maxItems = Math.min(1000, Math.floor(record.timing.readyWithin5s * 0.8));
  const maxChars = Math.min(60000, Math.floor(record.timing.readySourceCharsWithin5s! * 0.8));
  if (!maxItems || !maxChars) return;
  return { identity, maxItems, maxChars, ...(record.p95Ms !== null && record.p95Ms > 0 ? { p95Ms: record.p95Ms } : {}),
    sourceRecordId: record.id, manual: false };
}
