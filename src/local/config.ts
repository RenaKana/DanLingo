import type { LocalAutoRecommendation, LocalPerformanceConfig, LocalRuntimeConfig, LocalReasoningChoice } from './types.ts';

// Packaged RAM-cache fix: sustained HY-MT Q8 / RTX 5090 measurements favor four
// slots (run-5ySKT8; 32-slot supplement run-F4YeOr). Model-specific advice can override.
export const LOCAL_AUTO_PARALLEL = 4;
export const LOCAL_DEFAULT_CONFIG: LocalPerformanceConfig = {
  mode: 'auto', parallel: LOCAL_AUTO_PARALLEL, contextTokens: 'auto', estimatedTokensPerRequest: 256,
  batchPreset: 'balanced', batch: 512, microBatch: 256, warmup: true, flashAttention: 'auto',
  cpuThreads: 'auto', temperature: 0.1, normalMaxTokens: 128, superChatMaxTokens: 256,
  manualMaxTokens: 512, superChatReasoning: 'auto', allowAutoFallback: true,
  promptMode: 'auto', languageValidation: 'strict', reusePromptCache: false, measureGpu: false,
};

const invalidConfig = () => new Error('LOCAL_CONFIG_INVALID');
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// wllama forwards these controls to llama.cpp int32 parameters. This keeps
// validation tied to the native ABI rather than product-specific UI presets.
export const LOCAL_NATIVE_MAX_INTEGER = 0x7fffffff;
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= LOCAL_NATIVE_MAX_INTEGER;
const positiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonNegativeFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function normalizeAutoRecommendation(value: unknown): LocalAutoRecommendation | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw invalidConfig();
  const modelId = value.modelId;
  const measuredAt = value.measuredAt;
  const parallel = typeof value.parallel === 'number' ? value.parallel : Number.NaN;
  const contextTokens = typeof value.contextTokens === 'number' ? value.contextTokens : Number.NaN;
  const batch = typeof value.batch === 'number' ? value.batch : Number.NaN;
  const microBatch = typeof value.microBatch === 'number' ? value.microBatch : Number.NaN;
  const flashAttention = value.flashAttention;
  const cpuThreads = value.cpuThreads;
  if (typeof modelId !== 'string' || !modelId.trim()
    || typeof measuredAt !== 'number' || !Number.isFinite(measuredAt) || measuredAt < 0
    || !positiveInteger(parallel)
    || !positiveInteger(contextTokens)
    || !positiveInteger(batch)
    || !positiveInteger(microBatch)
    || microBatch > batch
    || !['auto', 'on', 'off'].includes(flashAttention as string)
    || !(cpuThreads === 'auto' || positiveInteger(cpuThreads))) throw invalidConfig();
  return {
    modelId,
    measuredAt,
    parallel,
    contextTokens,
    batch,
    microBatch,
    flashAttention: flashAttention as LocalAutoRecommendation['flashAttention'],
    cpuThreads: cpuThreads as LocalAutoRecommendation['cpuThreads'],
  };
}

export function normalizeLocalConfig(value: Partial<LocalPerformanceConfig> = {}): LocalPerformanceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidConfig();
  const c = { ...LOCAL_DEFAULT_CONFIG, ...value };
  if (!['auto', 'low-memory', 'balanced', 'high-performance', 'custom'].includes(c.mode)
    || !['compatibility', 'balanced', 'throughput', 'custom'].includes(c.batchPreset)
    || !['auto', 'on', 'off'].includes(c.flashAttention)
    || !['auto', 'on', 'off', 'low', 'medium', 'high', 'max'].includes(c.superChatReasoning)
    || !(c.cpuThreads === 'auto' || positiveInteger(c.cpuThreads))
    || !['auto', 'hy-mt', 'json'].includes(c.promptMode)
    || !['strict', 'off'].includes(c.languageValidation)
    || typeof c.allowAutoFallback !== 'boolean'
    || typeof c.reusePromptCache !== 'boolean'
    || typeof c.warmup !== 'boolean' || typeof c.measureGpu !== 'boolean') throw invalidConfig();
  for (const key of ['parallel', 'batch', 'microBatch', 'normalMaxTokens',
    'superChatMaxTokens', 'manualMaxTokens'] as const) if (!positiveInteger(c[key])) throw invalidConfig();
  if (!positiveSafeInteger(c.estimatedTokensPerRequest)) throw invalidConfig();
  if (c.contextTokens !== 'auto' && !positiveInteger(c.contextTokens)) throw invalidConfig();
  if (!nonNegativeFinite(c.temperature) || c.microBatch > c.batch) throw invalidConfig();
  const autoRecommendation = normalizeAutoRecommendation(c.autoRecommendation);
  return autoRecommendation ? { ...c, autoRecommendation } : c;
}
export function resolveLocalConfig(value: Partial<LocalPerformanceConfig> = {}, modelId?: string): LocalRuntimeConfig {
  const c = normalizeLocalConfig(value);
  const recommendation = c.mode === 'auto' && modelId !== undefined && c.autoRecommendation?.modelId === modelId
    ? c.autoRecommendation : undefined;
  const presets = { 'low-memory': { parallel: 2, contextTokens: 2048, batch: 256, microBatch: 128 },
    balanced: { parallel: 4, contextTokens: 4096, batch: 512, microBatch: 256 },
    'high-performance': { parallel: 8, contextTokens: 4096, batch: 512, microBatch: 256 } };
  const preset = c.mode in presets ? presets[c.mode as keyof typeof presets] : undefined;
  const parallel = recommendation?.parallel ?? preset?.parallel ?? (c.mode === 'auto' ? LOCAL_AUTO_PARALLEL : c.parallel);
  const batchModes = { compatibility: [128, 128], balanced: [512, 256], throughput: [512, 512] };
  const batch = batchModes[c.batchPreset as keyof typeof batchModes] ?? [c.batch, c.microBatch];
  let autoContext = 2048;
  if (c.contextTokens === 'auto' && !recommendation?.contextTokens && !preset?.contextTokens) {
    const estimatedContext = c.estimatedTokensPerRequest * parallel * 1.5;
    if (!Number.isSafeInteger(Math.ceil(estimatedContext)) || !Number.isFinite(estimatedContext)) throw new Error('LOCAL_CONTEXT_CAPACITY_EXCEEDED');
    const needed = Math.max(parallel <= 4 ? 2048 : parallel <= 8 ? 4096 : 8192, Math.ceil(estimatedContext));
    while (autoContext < needed) {
      if (autoContext > LOCAL_NATIVE_MAX_INTEGER / 2) {
        if (needed > LOCAL_NATIVE_MAX_INTEGER) throw new Error('LOCAL_CONTEXT_CAPACITY_EXCEEDED');
        autoContext = needed; break;
      }
      autoContext *= 2;
    }
  }
  const contextTokens = recommendation?.contextTokens ?? preset?.contextTokens ?? (c.contextTokens === 'auto' ? autoContext : c.contextTokens);
  if (contextTokens === undefined || !positiveInteger(contextTokens)) throw new Error('LOCAL_CONTEXT_CAPACITY_EXCEEDED');
  return { ...c,
    parallel,
    contextTokens,
    batch: recommendation?.batch ?? preset?.batch ?? batch[0]!,
    microBatch: recommendation?.microBatch ?? preset?.microBatch ?? batch[1]!,
    flashAttention: recommendation?.flashAttention ?? c.flashAttention,
    cpuThreads: recommendation?.cpuThreads ?? c.cpuThreads,
    kvUnified: true, continuousBatching: true };
}

export type LocalRecommendationConfig = LocalPerformanceConfig | Pick<LocalAutoRecommendation, 'parallel' | 'contextTokens' | 'batch' | 'microBatch' | 'flashAttention' | 'cpuThreads'>;

export function applyLocalRecommendation(
  current: Partial<LocalPerformanceConfig>,
  modelId: string,
  recommendedConfig: LocalRecommendationConfig,
  measuredAt = Date.now(),
): LocalPerformanceConfig {
  if (!isObject(recommendedConfig) || typeof modelId !== 'string' || !modelId.trim()) throw invalidConfig();
  const candidate = normalizeLocalConfig({ ...recommendedConfig,
    mode: 'mode' in recommendedConfig ? recommendedConfig.mode as LocalPerformanceConfig['mode'] : 'custom',
    batchPreset: 'batchPreset' in recommendedConfig ? recommendedConfig.batchPreset as LocalPerformanceConfig['batchPreset'] : 'custom' });
  const resolved = resolveLocalConfig(candidate, modelId);
  const autoRecommendation = normalizeAutoRecommendation({
    modelId,
    measuredAt,
    parallel: resolved.parallel,
    contextTokens: resolved.contextTokens,
    batch: resolved.batch,
    microBatch: resolved.microBatch,
    flashAttention: resolved.flashAttention,
    cpuThreads: resolved.cpuThreads,
  })!;
  return normalizeLocalConfig({ ...normalizeLocalConfig(current), mode: 'auto', autoRecommendation });
}

export const LOCAL_REASONING_CHOICES: readonly LocalReasoningChoice[] = ['auto', 'off', 'on', 'low', 'medium', 'high', 'max'];
