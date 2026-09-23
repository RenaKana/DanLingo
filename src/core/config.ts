import { modelsEndpointFromConnection, resolveConnection } from './connection.ts';
export { resolveConnection } from './connection.ts';
import type { ProviderSettings, ProviderProtocol, Settings, ThinkingEffort, TranslationStrategy } from './types.ts';
import { normalizeLocalConfig } from '../local/config.ts';
import type { LocalPerformanceConfig } from '../local/types.ts';
import { MAX_TIMEOUT_RETRY_EXTRA_MS } from './timeout-retry.ts';
import { validLiveBufferMs } from './live-budget.ts';

export const MAX_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_CONCURRENCY = 64;
export const MAX_LIVE_BATCH_WAIT_MS = 150;
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 3, enabled: false, displayMode: 'translated', translationScope: 'all',
  onlineRequestLimitPerDay: 3000,
  endpoint: 'https://api.minimax.cn/v1/chat/completions', model: 'MiniMax-M3', profile: 'minimax',
  protocol: 'chat-completions', backend: 'online',
  localPreloadOnEntry: true,
  thinkingEffort: 'off', superChatThinkingEffort: 'inherit', superChatTimeoutMs: 15000,
  allowLocalHttp: false, requestTimeoutMs: 12000, thinkingRequestTimeoutMs: 120000,
  concurrency: 2, batchSize: 100, maxBatchChars: 12000,
  sourceLanguage: 'auto', targetLanguage: 'zh-Hans',
  prefetchSeconds: 60, urgentSeconds: 5, cacheMaxEntries: 5000, cacheTtlDays: 30,
  liveBufferMs: 2000, liveSourceLanguage: 'auto', liveFontSize: 24, liveSpeed: 120, liveOpacity: 0.85, liveDensity: 6,
  bilibiliTimeoutRetryEnabled: false, bilibiliTimeoutRetryExtraMs: 1000, bilibiliTimeoutRetryMode: 'hold',
  youtubeTimeoutRetryEnabled: false, youtubeTimeoutRetryExtraMs: 1000, youtubeTimeoutRetryMode: 'hold',
  niconicoTimeoutRetryEnabled: false, niconicoTimeoutRetryExtraMs: 1000, niconicoTimeoutRetryMode: 'hold',
  liveMaxBatchWaitMs: MAX_LIVE_BATCH_WAIT_MS, liveMaxInputTokens: 4096, liveMaxOutputTokens: 4096,
  liveAdaptiveConcurrency: false, translationStream: false,
};
export const SETTINGS_KEY = 'settings.v1';
export const KEY_STORAGE_KEY = 'providerKey.v1';
export const PROMPT_VERSION = 'danlingo-text-v2';
export const LIVE_PROMPT_VERSION = 'danlingo-live-jsonl-v1';

const THINKING_EFFORTS: Record<ProviderSettings['profile'], readonly ThinkingEffort[]> = {
  minimax: ['default', 'off'],
  deepseek: ['default', 'off', 'low', 'high', 'max'],
  gemini: ['default', 'low', 'medium', 'high'],
  'chat-completions': ['default'],
};

export function thinkingEfforts(profile: ProviderSettings['profile']): readonly ThinkingEffort[] {
  return Object.hasOwn(THINKING_EFFORTS, profile) ? THINKING_EFFORTS[profile] : [];
}

export interface ReasoningCapabilities {
  profile: ProviderSettings['profile'];
  model: string;
  efforts: readonly ThinkingEffort[];
  defaultEffort: ThinkingEffort;
  supportsOff: boolean;
  sendsThinkingState: boolean;
  sendsReasoningEffort: boolean;
  verified?: boolean;
  offWireValue?: 'none';
}

/**
 * Resolve wire capabilities from the selected reasoning dialect and model.
 * Model names refine a dialect's capabilities; they never choose the URL protocol.
 */
export function reasoningCapabilities(settings: Pick<ProviderSettings, 'profile' | 'model'>): ReasoningCapabilities {
  const profile = settings.profile;
  const model = settings.model.trim();
  const result = (efforts: readonly ThinkingEffort[], defaultEffort: ThinkingEffort = 'default', state = false, effort = false, offWireValue?: 'none'): ReasoningCapabilities =>
    ({ profile, model, efforts, defaultEffort, supportsOff: efforts.includes('off'), sendsThinkingState: state, sendsReasoningEffort: effort, verified: true, offWireValue });
  // Model-specific documented contracts. An unknown model is never granted a family-wide effort list.
  if (profile === 'minimax' && /^MiniMax-M3(?:-|$)/i.test(model)) return result(['default','off','on'], 'off', true);
  if (profile === 'minimax' && /^MiniMax-M2(?:[.-]|$)/i.test(model)) return result(['default']);
  if (profile === 'deepseek' && /^deepseek-v4-(?:flash|pro)(?:-|$)/i.test(model)) return result(['default','off','high','max'], 'off', true, true);
  if (profile === 'deepseek' && /^deepseek-v3[.-]2(?:-|$)/i.test(model)) return result(['default','off','on'], 'off', true);
  if (profile === 'deepseek' && /^(?:deepseek-reasoner|deepseek-r1)(?:-|$)/i.test(model)) return result(['default']);
  if (profile === 'deepseek' && /^deepseek-chat$/i.test(model)) return result(['default']);
  if (profile === 'gemini') {
    if (/^gemini-3(?:\.1)?-pro(?:-|$)/i.test(model)) return result(['default','low','high'], 'low', false, true);
    if (/^gemini-3(?:\.1)?-flash(?:-|$)/i.test(model)) return result(['default','minimal','low','medium','high'], 'low', false, true);
    if (/^gemini-2\.5-flash(?:-|$)/i.test(model)) return result(['default','off','low','medium','high'], 'low', false, true, 'none');
    if (/^gemini-2\.5-pro(?:-|$)/i.test(model)) return result(['default','low','medium','high'], 'low', false, true);
  }
  if (profile === 'chat-completions') {
    if (/^(?:o3|o4-mini)(?:-|$)/i.test(model)) return result(['default','low','medium','high'], 'default', false, true);
    if (/^gpt-5(?:-mini|-nano)?(?:$|-\d)/i.test(model)) return result(['default','minimal','low','medium','high'], 'default', false, true);
    if (/^gpt-5\.1(?:$|-\d)/i.test(model)) return result(['default','off','low','medium','high'], 'default', false, true, 'none');
    if (/^gpt-5\.[24](?:$|-\d)/i.test(model)) return result(['default','off','low','medium','high','xhigh'], 'default', false, true, 'none');
  }
  return { ...result(['default']), verified: false };
}

export function supportedReasoningEfforts(settings: Pick<ProviderSettings, 'profile' | 'model'>): readonly ThinkingEffort[] {
  return reasoningCapabilities(settings).efforts;
}

/** Model-aware normalization; the legacy profile-only helper remains stable for old callers. */
export function normalizeReasoningEffort(settings: Pick<ProviderSettings, 'profile' | 'model'>, value: unknown): ThinkingEffort {
  const capabilities = reasoningCapabilities(settings);
  const effort = value === undefined ? capabilities.defaultEffort : value;
  if (!capabilities.efforts.includes(effort as ThinkingEffort)) throw new Error('unsupported-thinking-effort');
  return effort as ThinkingEffort;
}

/** Only an absent value receives a compatible default; invalid explicit choices must be surfaced. */
export function normalizeThinkingEffort(profile: ProviderSettings['profile'], value: unknown): ThinkingEffort {
  const effort = value === undefined
    ? profile === 'minimax' || profile === 'deepseek' ? 'off' : profile === 'gemini' ? 'low' : 'default'
    : value;
  if (!thinkingEfforts(profile).includes(effort as ThinkingEffort)) throw new Error('unsupported-thinking-effort');
  return effort as ThinkingEffort;
}

export interface EffectiveStrategy {
  strategy: TranslationStrategy;
  thinkingEffort: ThinkingEffort;
  timeoutMs: number;
  capabilities: ReasoningCapabilities;
}

function timeoutForEffort(settings: ProviderSettings, effort: ThinkingEffort): number {
  return effort === 'off' ? settings.requestTimeoutMs : settings.thinkingRequestTimeoutMs ?? DEFAULT_SETTINGS.thinkingRequestTimeoutMs;
}

/** Resolve normal, Super Chat and explicit manual strategy without mutating saved settings. */
export function effectiveStrategy(settings: ProviderSettings, strategy: TranslationStrategy = 'normal'): EffectiveStrategy {
  const capabilities = reasoningCapabilities(settings);
  let thinkingEffort = normalizeReasoningEffort(settings, settings.thinkingEffort);
  let timeoutMs = timeoutForEffort(settings, thinkingEffort);
  if (strategy === 'superchat') {
    const selected = settings.superChatThinkingEffort;
    if (selected !== undefined && selected !== 'inherit') thinkingEffort = normalizeReasoningEffort(settings, selected);
    timeoutMs = settings.superChatTimeoutMs ?? 15000;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid-timeout');
  return { strategy, thinkingEffort, timeoutMs, capabilities };
}

/**
 * Create a provider-settings view for a strategy without mutating saved settings.
 * Super Chat receives one resolved timeout in both timeout slots so legacy callers
 * that only know ProviderSettings still honor its independent budget.
 */
export function strategySettings<T extends ProviderSettings>(settings: T, strategy: TranslationStrategy = 'normal'): T {
  if (settings.backend === 'local') {
    const timeoutMs = providerTimeoutMs(settings, strategy);
    return { ...settings, localGenerationStrategy: strategy, thinkingEffort: 'off', requestTimeoutMs: timeoutMs, thinkingRequestTimeoutMs: timeoutMs } as T;
  }
  const effective = effectiveStrategy(settings, strategy);
  if (strategy === 'normal') return { ...settings, thinkingEffort: effective.thinkingEffort } as T;
  return {
    ...settings,
    thinkingEffort: effective.thinkingEffort,
    requestTimeoutMs: effective.timeoutMs,
    thinkingRequestTimeoutMs: effective.timeoutMs,
  } as T;
}

/** Only generation-affecting local fields belong in persistent cache identity. */
export function localGenerationProfile(settings: ProviderSettings, strategy: TranslationStrategy = settings.localGenerationStrategy ?? 'normal') {
  const config = normalizeLocalConfig(settings.localPerformance);
  return { temperature: config.temperature,
    maxTokens: strategy === 'superchat' ? config.superChatMaxTokens : strategy === 'manual' ? config.manualMaxTokens : config.normalMaxTokens,
    reasoning: strategy === 'superchat' ? config.superChatReasoning : 'off' as const };
}

/** Wire fields for the selected model and dialect; unsupported overrides fail before transport. */
export function reasoningRequestFields(settings: ProviderSettings, strategy: TranslationStrategy = 'normal'): Record<string, unknown> {
  const effective = effectiveStrategy(settings, strategy);
  const fields: Record<string, unknown> = {};
  if (effective.thinkingEffort === 'off') {
    if (!effective.capabilities.supportsOff) throw new Error('unsupported-thinking-effort');
    if (effective.capabilities.sendsThinkingState) fields.thinking = { type: 'disabled' };
    if (effective.capabilities.offWireValue) fields.reasoning_effort = effective.capabilities.offWireValue;
  }
  else if (effective.thinkingEffort !== 'default') {
    if (effective.capabilities.sendsThinkingState) fields.thinking = { type: 'enabled' };
    if (effective.capabilities.sendsReasoningEffort && effective.thinkingEffort !== 'on') fields.reasoning_effort = effective.thinkingEffort;
  }
  return fields;
}

/** Service-default may include thinking. Never infer the budget from a model name. */
export function providerTimeoutMs(settings: ProviderSettings, strategy: TranslationStrategy = 'normal'): number {
  if (settings.backend === 'local') {
    const timeoutMs = strategy === 'superchat' ? settings.superChatTimeoutMs ?? 15000 : settings.requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid-timeout');
    return timeoutMs;
  }
  return effectiveStrategy(settings, strategy).timeoutMs;
}

export function endpointOrigin(endpoint: string, allowLocalHttp = false): string {
  return resolveConnection({ endpoint, allowLocalHttp, endpointMode: 'completion' }).origin;
}

/** Accept a root, versioned API base or a full endpoint; preserve custom full paths. */
export function completionEndpoint(value: string, allowLocalHttp = false, options: {
  protocolOverride?: ProviderSettings['protocolOverride'];
  endpointMode?: ProviderSettings['endpointMode'];
} = {}): string {
  return resolveConnection({ endpoint: value, allowLocalHttp, ...options }).configuredCompletionEndpoint;
}

/** Model discovery uses the same API prefix and origin, never an independently supplied URL. */
export function modelsEndpoint(endpoint: string, allowLocalHttp = false, options: {
  protocolOverride?: ProviderSettings['protocolOverride'];
  endpointMode?: ProviderSettings['endpointMode'];
} = {}): string {
  return modelsEndpointFromConnection(resolveConnection({ endpoint, allowLocalHttp, ...options }));
}

export function normalizeSettings(input: unknown, options: { stored?: boolean } = {}): Settings {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const result = { ...DEFAULT_SETTINGS };
  if (value.onlineRequestLimitPerDay !== undefined) {
    if (!Number.isSafeInteger(value.onlineRequestLimitPerDay) || (value.onlineRequestLimitPerDay as number) <= 0) throw new Error('invalid-online-request-limit');
    result.onlineRequestLimitPerDay = value.onlineRequestLimitPerDay as number;
  }
  for (const key of ['endpoint', 'model', 'sourceLanguage', 'targetLanguage', 'liveSourceLanguage'] as const) {
    if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim().slice(0, key === 'endpoint' ? 1000 : 100);
  }
  for (const key of ['enabled', 'allowLocalHttp', 'localPreloadOnEntry'] as const) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['translationStream', 'liveAdaptiveConcurrency', 'bilibiliTimeoutRetryEnabled', 'youtubeTimeoutRetryEnabled', 'niconicoTimeoutRetryEnabled'] as const) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['bilibiliTimeoutRetryMode', 'youtubeTimeoutRetryMode', 'niconicoTimeoutRetryMode'] as const) if (value[key] === 'hold' || value[key] === 'release') result[key] = value[key];
  if (value.displayMode === 'original' || value.displayMode === 'translated') result.displayMode = value.displayMode;
  if (value.translationScope === 'all' || value.translationScope === 'window') result.translationScope = value.translationScope;
  if (value.backend === 'online' || value.backend === 'local') result.backend = value.backend;
  if (typeof value.localModelId === 'string' && value.localModelId.trim()) result.localModelId = value.localModelId.trim().slice(0, 200);
  if (value.localPerformance !== undefined) result.localPerformance = normalizeLocalConfig(value.localPerformance as Partial<LocalPerformanceConfig>);
  if (value.protocol === 'chat-completions') result.protocol = value.protocol;
  if (value.protocolOverride === 'auto' || value.protocolOverride === 'chat-completions') result.protocolOverride = value.protocolOverride;
  else if (value.protocolOverride !== undefined) throw new Error('unsupported-connection-protocol');
  if (value.endpointMode === 'auto' || value.endpointMode === 'base' || value.endpointMode === 'completion') result.endpointMode = value.endpointMode;
  else if (value.endpointMode !== undefined) throw new Error('invalid-endpoint-mode');
  if (value.connectionOverride && typeof value.connectionOverride === 'object' && !Array.isArray(value.connectionOverride)) {
    const override = value.connectionOverride as Record<string, unknown>;
    if (override.protocol !== undefined && override.protocol !== 'auto' && override.protocol !== 'chat-completions') throw new Error('unsupported-connection-protocol');
    if (override.endpointMode !== undefined && !['auto', 'base', 'completion'].includes(String(override.endpointMode))) throw new Error('invalid-endpoint-mode');
    result.connectionOverride = {
      ...(override.protocol === 'auto' || override.protocol === 'chat-completions' ? { protocol: override.protocol } : {}),
      ...(override.endpointMode === 'auto' || override.endpointMode === 'base' || override.endpointMode === 'completion' ? { endpointMode: override.endpointMode } : {}),
    };
  }
  const profiles = ['chat-completions', 'minimax', 'deepseek', 'gemini'] as const;
  const hasProfile = profiles.includes(value.profile as typeof profiles[number]);
  if (hasProfile) result.profile = value.profile as Settings['profile'];
  if (value.reasoningProfileOverride === 'auto' || profiles.includes(value.reasoningProfileOverride as typeof profiles[number])) {
    result.reasoningProfileOverride = value.reasoningProfileOverride as Settings['reasoningProfileOverride'];
  }
  else if (value.reasoningProfileOverride !== undefined) throw new Error('unsupported-reasoning-profile');
  const ranges = {
    requestTimeoutMs: [1000, MAX_REQUEST_TIMEOUT_MS], thinkingRequestTimeoutMs: [1000, MAX_REQUEST_TIMEOUT_MS],
    concurrency: [1, result.backend === 'local' ? 2_147_483_647 : MAX_CONCURRENCY], batchSize: [1, 200], maxBatchChars: [500, 24000],
    prefetchSeconds: [5, 3600], urgentSeconds: [1, 30], cacheMaxEntries: [100, 20000], cacheTtlDays: [1, 90],
    liveFontSize: [16, 48], liveSpeed: [60, 240], liveDensity: [1, 12],
    liveMaxBatchWaitMs: [0, MAX_LIVE_BATCH_WAIT_MS], liveMaxInputTokens: [256, 24000], liveMaxOutputTokens: [256, 24000],
    superChatTimeoutMs: [1000, MAX_REQUEST_TIMEOUT_MS],
    bilibiliTimeoutRetryExtraMs: [0, MAX_TIMEOUT_RETRY_EXTRA_MS],
    youtubeTimeoutRetryExtraMs: [0, MAX_TIMEOUT_RETRY_EXTRA_MS],
    niconicoTimeoutRetryExtraMs: [0, MAX_TIMEOUT_RETRY_EXTRA_MS],
  } as const;
  const legacyDefaults: Partial<Record<keyof typeof ranges, number>> = {
    batchSize: 20, maxBatchChars: 6000, prefetchSeconds: 30, urgentSeconds: 8,
  };
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const n = value[key];
    if (value.schemaVersion !== 2 && value.schemaVersion !== 3 && n === legacyDefaults[key]) continue;
    if (typeof n === 'number' && Number.isFinite(n)) result[key] = Math.max(ranges[key][0], Math.min(ranges[key][1], Math.floor(n)));
  }
  if (validLiveBufferMs(value.liveBufferMs)) result.liveBufferMs = value.liveBufferMs;
  if (typeof value.liveOpacity === 'number' && Number.isFinite(value.liveOpacity)) result.liveOpacity = Math.max(0.2, Math.min(1, value.liveOpacity));
  if (result.translationScope === 'window') result.urgentSeconds = Math.min(result.urgentSeconds, result.prefetchSeconds);

  const endpointValue = typeof value.endpoint === 'string' && value.endpoint.trim() ? value.endpoint.trim() : undefined;
  const endpointInputValue = typeof value.endpointInput === 'string' && value.endpointInput.trim() ? value.endpointInput.trim() : undefined;
  let suppliedEndpoint = endpointValue ?? result.endpoint;
  if (endpointInputValue && (!endpointValue || (() => {
    try { return completionEndpoint(endpointInputValue, result.allowLocalHttp) === completionEndpoint(endpointValue, result.allowLocalHttp); }
    catch { return false; }
  })())) suppliedEndpoint = endpointInputValue;
  const connection = resolveConnection({ endpoint: suppliedEndpoint, allowLocalHttp: result.allowLocalHttp,
    backend: result.backend, protocol: result.protocol, protocolOverride: result.protocolOverride,
    endpointMode: result.endpointMode, connectionOverride: result.connectionOverride });
  result.endpoint = connection.configuredCompletionEndpoint;
  result.protocol = connection.protocol;
  if (value.endpointInput !== undefined || suppliedEndpoint !== connection.configuredCompletionEndpoint) result.endpointInput = suppliedEndpoint.slice(0, 1000);
  const inferredProfile = connection.brand === 'minimax' || connection.brand === 'deepseek' || connection.brand === 'gemini'
    ? connection.brand : 'chat-completions';
  if (result.reasoningProfileOverride && result.reasoningProfileOverride !== 'auto') result.profile = result.reasoningProfileOverride;
  else if (result.reasoningProfileOverride === 'auto' || (!hasProfile && value.endpoint !== undefined)) result.profile = inferredProfile;
  const reasoningSettings = { profile: result.profile, model: result.model };
  // Keep old saved choices visible for correction, but validate every outgoing/save request.
  const normalizeEffort = (effort: unknown) => (options.stored || result.backend === 'local') && typeof effort === 'string' && ['default','off','on','minimal','low','medium','high','max','xhigh'].includes(effort)
    ? effort as ThinkingEffort : normalizeReasoningEffort(reasoningSettings, effort);
  result.thinkingEffort = normalizeEffort(value.thinkingEffort);
  if (value.superChatThinkingEffort === 'inherit') result.superChatThinkingEffort = 'inherit';
  else if (value.superChatThinkingEffort !== undefined) result.superChatThinkingEffort = normalizeEffort(value.superChatThinkingEffort);
  if (value.providerBrand === 'minimax' || value.providerBrand === 'deepseek' || value.providerBrand === 'gemini' || value.providerBrand === 'unknown') result.providerBrand = value.providerBrand;
  return result;
}
