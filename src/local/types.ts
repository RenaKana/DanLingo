import type { LocalTranslationProfile } from './translation-profile.ts';
export const LOCAL_CHANNEL = 'danlingo-local-offscreen-v1';
export const LOCAL_BACKEND = 'wllama 3.6.1 · WebGPU';
export type LocalPerformanceMode = 'auto' | 'low-memory' | 'balanced' | 'high-performance' | 'custom';
export type LocalReasoningChoice = 'auto' | 'off' | 'on' | 'low' | 'medium' | 'high' | 'max';
export type LocalReasoningValue = LocalReasoningChoice | boolean;
export type LocalTemplateCapability = {
  status: 'verified';
  mode: 'none';
  supported: readonly LocalReasoningChoice[];
  evidence: 'direct-translation-profile';
} | {
  status: 'unknown';
  mode: 'unknown';
  supported: readonly LocalReasoningChoice[];
  evidence: 'unverified-template';
} | {
  status: 'verified';
  mode: 'boolean';
  argument: 'enable_thinking';
  supported: readonly LocalReasoningChoice[];
  evidence: 'structured-enable-thinking-template';
} | {
  status: 'verified';
  mode: 'effort';
  argument: 'reasoning_effort' | 'thinking_level';
  booleanArgument?: 'enable_thinking';
  supported: readonly LocalReasoningChoice[];
  evidence: 'structured-reasoning-effort-template' | 'structured-thinking-level-template' | 'gpt-oss-reasoning-header';
};
export interface LocalAutoRecommendation {
  modelId: string;
  measuredAt: number;
  parallel: number;
  contextTokens: number;
  batch: number;
  microBatch: number;
  flashAttention: 'auto' | 'on' | 'off';
  cpuThreads: 'auto' | number;
}
export interface LocalPerformanceConfig {
  mode: LocalPerformanceMode;
  parallel: number;
  contextTokens: number | 'auto';
  estimatedTokensPerRequest: number;
  batchPreset: 'compatibility' | 'balanced' | 'throughput' | 'custom';
  batch: number; microBatch: number;
  warmup: boolean;
  flashAttention: 'auto' | 'on' | 'off';
  cpuThreads: 'auto' | number;
  temperature: number;
  normalMaxTokens: number; superChatMaxTokens: number; manualMaxTokens: number;
  superChatReasoning: LocalReasoningChoice;
  allowAutoFallback: boolean;
  reusePromptCache: boolean;
  promptMode: 'auto' | 'hy-mt' | 'json';
  languageValidation: 'strict' | 'off';
  measureGpu: boolean;
  autoRecommendation?: LocalAutoRecommendation;
}
export interface LocalRuntimeConfig extends Omit<LocalPerformanceConfig, 'contextTokens'> {
  contextTokens: number;
  kvUnified: true; continuousBatching: true;
  cpuThreadsActual?: number;
}
export interface LocalInferenceMetrics {
  queueMs: number; inferenceMs: number;
  promptTokens?: number; outputTokens?: number; cachedTokens?: number;
  promptMs?: number; decodeMs?: number;
  nativeSlot?: number; nativeTask?: number;
  /** Per-request attribution is unavailable under concurrent native generation. */
  gpuExecutionMs: number | null;
  gpuAllocatedBytes?: number; gpuPeakAllocatedBytes?: number;
  finishReason?: string; reasoning: LocalReasoningValue; maxTokens: number;
}
export interface LocalGpuInfo {
  vendor: string; architecture: string; deviceCreated: boolean;
  offloadedLayers: number; totalLayers: number; verified: boolean;
  nativeBackend?: string; modelBufferMiB?: number;
  kvBufferMiB?: number; computeBufferMiB?: number; flashAttention?: boolean;
  allocatedBytes?: number; peakAllocatedBytes?: number;
  /** Cumulative timestamped compute-pass sum, excluding transfers and other GPU work. */
  executionMs?: number; timestampQueries?: boolean;
  timedComputePasses?: number; missedComputePasses?: number;
  peakTimingRecords?: number; recordLimitMisses?: number; encoderLimitMisses?: number;
  timingReadFailures?: number; pendingTimingRecords?: number;
  pipelineCreationMs?: number; pipelineCreationCount?: number; pipelineCreationPending?: number;
  pipelineCreationMaxMs?: number; pipelineCreationFailures?: number;
  pipelineCreationAsyncMs?: number; pipelineCreationAsyncCount?: number; pipelineCreationAsyncMaxMs?: number;
  pipelineCreationSyncMs?: number; pipelineCreationSyncCount?: number; pipelineCreationSyncMaxMs?: number;
  pipelineLabels?: string[]; flashAttentionObserved?: boolean; flashAttentionKernel?: string;
}
export interface LocalModelInfo {
  id: string; name: string; files: string[]; bytes: number; architecture: string;
  quantization: string; tokenizer: string; template: boolean; importedAt: number;
  translationProfile?: LocalTranslationProfile;
  /** Versioned fixed-chunk content identity; filenames are intentionally excluded. */
  fingerprint?: string;
  /** Directory references contain metadata only; never serialized handles or model bytes. */
  source?: import('./directory-types.ts').DirectorySource | import('./directory-types.ts').FileSource;
  availability?: 'ready' | 'permission-required' | 'missing' | 'changed' | 'error';
  /** GGUF payload bytes after the bounded tensor-info header, not total VRAM. */
  weightBytes?: number;
  layerCount?: number; embeddingLength?: number; attentionHeads?: number; kvHeads?: number;
  keyLength?: number; valueLength?: number; kvKeyDimension?: number; kvValueDimension?: number;
  /** Combined K+V width per layer and token when both dimensions are known. */
  kvDimension?: number;
  contextLength?: number;
  metadataVersion?: 1;
  metadataComplete?: boolean;
  templateCapability?: LocalTemplateCapability;
}
export interface LocalState {
  phase: 'idle' | 'loading' | 'warming' | 'ready' | 'generating' | 'error';
  backend: string; model?: LocalModelInfo; stage?: string; error?: string;
  verificationProgress?: { bytesProcessed: number; totalBytes: number };
  generation: number; queued: number; loadMs?: number; inferenceCalls: number;
  contextTokens: number; verifiedTranslation: false;
  gpu?: LocalGpuInfo;
  active: number; completed: number; failed: number; cancelled: number; peakActive: number;
  requested?: LocalPerformanceConfig; runtime?: LocalRuntimeConfig; fallbackReasons?: string[]; warnings?: string[];
  nativeSlots?: number; nativePeakActive?: number; warmupMs?: number;
  lastMetrics?: LocalInferenceMetrics;
  nativeEvidence?: string[];
}
export type LocalControl = { action: 'state'; demand?: boolean }
  | { action: 'list' | 'cancel' | 'unload' | 'files-changed' }
  | { action: 'directory-status' | 'directory-cancel' }
  | { action: 'directory-scan'; directoryId?: string }
  | { action: 'directory-remove'; directoryId: string }
  | { action: 'benchmark-status' | 'benchmark-stop' }
  | { action: 'benchmark-start'; modelId: string; options?: import('./benchmark-runner.ts').LocalBenchmarkOptions }
  | { action: 'load'; modelId: string; config?: Partial<LocalPerformanceConfig> }
  | { action: 'ensure'; modelId: string; config?: Partial<LocalPerformanceConfig> }
  | { action: 'delete'; modelId: string };
export interface LocalReply { ok: boolean; state?: LocalState; models?: LocalModelInfo[]; error?: string; result?: unknown; report?: import('./benchmark-runner.ts').LocalBenchmarkReport | null;
  directories?: import('./directory-types.ts').DirectoryInfo[]; scan?: import('./directory-types.ts').DirectoryScanStatus; scanBusy?: boolean }
export const localError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^LOCAL_[A-Z0-9_]+$/.test(message) ? message : 'LOCAL_INFERENCE_FAILED';
};
