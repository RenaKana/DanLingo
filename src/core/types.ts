import type { LocalPerformanceConfig } from '../local/types.ts';
import type { LocalTranslationProfile } from '../local/translation-profile.ts';

export type ProviderProtocol = 'chat-completions';
export type ProviderProtocolSetting = 'auto' | ProviderProtocol;
export type ProviderBrand = 'minimax' | 'deepseek' | 'gemini' | 'unknown';
export type ReasoningProfile = 'auto' | 'minimax' | 'deepseek' | 'gemini' | 'chat-completions';
export type ProviderBackend = 'online' | 'local';
export type ConnectionEndpointMode = 'auto' | 'base' | 'completion';
export type TranslationStrategy = 'normal' | 'superchat' | 'manual';
export type ThinkingEffort = 'default' | 'off' | 'on' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';

export interface ConnectionOverride {
  /** The only supported protocol today; `auto` delegates to URL detection. */
  protocol?: ProviderProtocolSetting;
  /** Advanced path override for custom gateways whose base cannot be inferred. */
  endpointMode?: ConnectionEndpointMode;
}

export interface ProviderSettings {
  endpoint: string;
  /** Original user-entered URL when `endpoint` has been normalized to an operation endpoint. */
  endpointInput?: string;
  model: string;
  /** Legacy profile retained as the reasoning dialect, not the wire protocol or model brand. */
  profile: 'minimax' | 'deepseek' | 'gemini' | 'chat-completions';
  /** Advanced reasoning dialect override; auto uses explicit URL brand hints only. */
  reasoningProfileOverride?: ReasoningProfile;
  /** Effective protocol selected by connection detection. */
  protocol?: ProviderProtocol;
  /** Advanced manual protocol override; automatic detection remains the default. */
  protocolOverride?: ProviderProtocolSetting;
  /** Advanced manual path interpretation for custom gateways. */
  endpointMode?: ConnectionEndpointMode;
  connectionOverride?: ConnectionOverride;
  /** Best-effort brand hint for display; it never selects a protocol or model. */
  providerBrand?: ProviderBrand;
  thinkingEffort: ThinkingEffort;
  /** Keep the provider dispatcher independent from the online connection. */
  backend?: ProviderBackend;
  /** Local model identity used by a local dispatcher and cache namespace. */
  localModelId?: string;
  localPerformance?: Partial<LocalPerformanceConfig>;
  /** Runtime observations stamped by the trusted dispatcher; never persisted from input. */
  localCapacity?: number;
  localContextTokens?: number;
  /** Trusted loaded model name; used only for automatic translation-template selection. */
  localModelName?: string;
  localTranslationProfile?: LocalTranslationProfile;
  localGenerationStrategy?: TranslationStrategy;
  /** Explicit opt-in for localhost/127.0.0.1 or RFC1918 IPv4 HTTP services. */
  allowLocalHttp: boolean;
  requestTimeoutMs: number;
  /** Separate budget for enabled thinking or an unknown service-default thinking mode. */
  thinkingRequestTimeoutMs: number;
  /** Super Chat can inherit normal reasoning or choose a supported independent effort. */
  superChatThinkingEffort?: 'inherit' | ThinkingEffort;
  /** Independent Super Chat timeout budget, bounded during settings normalization. */
  superChatTimeoutMs?: number;
  concurrency: number;
  batchSize: number;
  maxBatchChars: number;
  sourceLanguage: string;
  targetLanguage: string;
  /** Enable only after verifying SSE and final usage support for this endpoint. */
  translationStream?: boolean;
}

export interface Settings extends ProviderSettings {
  schemaVersion: 3;
  /** Shared durable cap on online generation attempts per local calendar day. */
  onlineRequestLimitPerDay: number;
  /** Preload once on entering a supported viewing session; never on heartbeats. */
  localPreloadOnEntry?: boolean;
  enabled: boolean;
  displayMode: 'translated' | 'original';
  translationScope: 'all' | 'window';
  prefetchSeconds: number;
  urgentSeconds: number;
  cacheMaxEntries: number;
  cacheTtlDays: number;
  liveBufferMs: number;
  /** Opt-in, one extra attempt for timed-out Bilibili ordinary live messages. */
  bilibiliTimeoutRetryEnabled?: boolean;
  bilibiliTimeoutRetryExtraMs?: number;
  bilibiliTimeoutRetryMode?: 'hold' | 'release';
  youtubeTimeoutRetryEnabled?: boolean;
  youtubeTimeoutRetryExtraMs?: number;
  youtubeTimeoutRetryMode?: 'hold' | 'release';
  niconicoTimeoutRetryEnabled?: boolean;
  niconicoTimeoutRetryExtraMs?: number;
  niconicoTimeoutRetryMode?: 'hold' | 'release';
  liveSourceLanguage: string;
  liveFontSize: number;
  /** Pixels per second. */
  liveSpeed: number;
  liveOpacity: number;
  liveDensity: number;
  liveMaxBatchWaitMs?: number;
  liveMaxInputTokens?: number;
  liveMaxOutputTokens?: number;
  liveAdaptiveConcurrency?: boolean;
}

export interface PlatformResource {
  platform: 'niconico' | 'youtube' | 'bilibili';
  scenario: 'video' | 'live';
  resourceId: string;
  /** Bilibili URL candidate bound to a verified native CID/room, never a cache key. */
  urlResourceId?: string;
}
export interface ResourceSession extends PlatformResource {
  sessionId: string;
  generation: number;
}
export type LiveConnection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'ended';
export type ChatCoverage = 'all' | 'top' | 'unknown';
/** Live events have no fabricated finite duration or video playback time. */
export interface LiveSourceMessage {
  id: string;
  sourceId: string;
  originalText: string;
  /** Validated native inline-image aliases; only their surrounding prose is translated. */
  emoteTokens?: string[];
  receivedAt: number;
  sentAtEpochMs?: number;
  translatable: boolean;
  authorId?: string;
  /** Only an adapter with a verified native clock may supply this local monotonic time. */
  scheduledAt?: number;
}
export interface LivePlaybackState {
  paused: boolean;
  seeking: boolean;
  contentActive: boolean;
  atLiveEdge: boolean;
}

export interface SourceMessage {
  id: string;
  sourceId: string;
  platform: 'niconico' | 'bilibili';
  resourceId: string;
  threadId: string;
  fork: string;
  originalText: string;
  mediaTimeMs: number;
  /** Derived native staging deadline, distinct from platform vposMs. */
  renderAtMs: number;
  sentAtEpochMs?: number;
  translatable: boolean;
  style: { position: string; size: string; color: string; font: string; commands: string[] };
}

export interface PlaybackClock {
  mediaTimeMs: number;
  playbackRate: number;
  paused: boolean;
  seeking: boolean;
  contentActive: boolean;
  durationMs: number;
  buffered?: { startMs: number; endMs: number }[];
}

export interface TranslationInput { id: string; text: string; deadlineAt: number; strategy?: TranslationStrategy }
export interface TranslationOutput {
  id: string;
  text?: string;
  status: 'translated' | 'cached' | 'original' | 'failed' | 'expired' | 'deferred';
  reason?: string;
  retryAfterMs?: number;
}
export interface Usage {
  promptTokens?: number; completionTokens?: number; totalTokens?: number;
  /** Subsets of prompt/completion totals; never add these to those totals. */
  cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
}
export interface TranslationRequest {
  resourceId: string;
  items: TranslationInput[];
  settings: Settings;
  apiKey: string;
  signal?: AbortSignal;
  /** VOD queue time is independent of the actual provider request timeout. */
  mode?: 'vod' | 'deadline';
  priority?: 'near' | 'buffered' | 'background';
  /** Set only by trusted background code, never used as provider data. */
  quotaScope?: string;
  /** Trusted local delivery hook; each original occurrence completes independently. */
  onResult?: (output: TranslationOutput) => void;
  /** Benchmark namespace; trusted callers use it to isolate cache and in-flight joins. */
  namespace?: string;
  /** Benchmark-only cache bypass; does not imply a user-visible forced retry. */
  bypassCache?: boolean;
  /** Trusted manual retry request that may reevaluate a previous no-translation result. */
  forceTranslate?: boolean;
  /** Explicit force marker used by the manual retry integration. */
  force?: boolean;
}
export interface TranslationResponse {
  items: TranslationOutput[];
  usage?: Usage;
}

export interface LiveMetrics {
  unconfirmed?: number;
  repaired?: number;
  repairApplied?: number;
  received: number; submitted: number; presented: number; translated: number; original: number;
  timedOut: number; overloaded: number; removed: number; abandoned: number; pending: number;
  translatedChars: number; cachedTranslated: number; observationMs: number;
  readinessMs: { p50: number | null; p95: number | null; p99: number | null; samples: number };
  releaseDelayMs: { p50: number | null; p95: number | null; p99: number | null; samples: number };
}
/** Read-only URL-scoped observation, never proof of a CID or a translation session. */
export interface AdapterDiagnostic {
  platform: 'bilibili';
  scenario: 'video';
  urlResourceId: string;
  code: 'waiting-player' | 'unsupported-version' | 'identity-mismatch' | 'native-entry-unavailable' |
    'invalid-clock' | 'waiting-status' | 'native-unresponsive' | 'content-unresponsive';
  nativeVersion?: string;
  nativeCompiled?: string;
}

export interface RuntimeStatus {
  state: 'unsupported' | 'finding-player' | 'ready' | 'disabled' | 'configuration-needed' | 'translating' | 'degraded';
  resourceId?: string;
  platform?: PlatformResource['platform'];
  scenario?: PlatformResource['scenario'];
  connection?: LiveConnection;
  coverage?: ChatCoverage;
  liveMetrics?: LiveMetrics;
  recentEligible?: number;
  recentTranslated?: number;
  timedOut?: number;
  overloaded?: number;
  dropped?: number;
  messages: number;
  translated: number;
  original: number;
  cacheHits: number;
  queued: number;
  prepared?: number;
  failed?: number;
  nearTotal?: number;
  nearPrepared?: number;
  inflight?: number;
  sourceComplete?: boolean;
  note?: string;
}
