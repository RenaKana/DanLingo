import type { LocalModelInfo, LocalRuntimeConfig } from './types.ts';

const FORMULA_ARCHITECTURES = /^(?:llama|qwen2|qwen3)$/i;
const KV_BYTES_PER_ELEMENT = 2;

export interface LocalMemoryObservation {
  modelId: string;
  runtimeKey: string;
  modelBytes?: number;
  kvBytes?: number;
  computeBytes?: number;
}

export interface LocalMemoryEstimate {
  status: 'estimated' | 'lower-bound' | 'missing';
  source: 'formula' | 'native' | 'mixed';
  lowerBound: boolean;
  runtimeKey: string;
  modelBytes?: number;
  kvBytes?: number;
  computeBytes?: number;
  totalBytes?: number;
  missing: string[];
  notes: string[];
}

const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Runtime identity prevents observations from a different load configuration being mixed in. */
export function localMemoryRuntimeKey(runtime: LocalRuntimeConfig): string {
  return JSON.stringify({ contextTokens: runtime.contextTokens, parallel: runtime.parallel, batch: runtime.batch,
    microBatch: runtime.microBatch, flashAttention: runtime.flashAttention, cpuThreads: runtime.cpuThreads,
    kvUnified: runtime.kvUnified, continuousBatching: runtime.continuousBatching });
}

function knownFormulaModel(model: LocalModelInfo): boolean {
  return FORMULA_ARCHITECTURES.test(model.architecture.trim());
}

/**
 * Estimate only model, unified-KV, and compute buffers. GGUF file bytes are
 * used as a weight-payload component when available, never as total VRAM.
 */
export function estimateLocalMemory(model: LocalModelInfo, runtime: LocalRuntimeConfig, observation?: LocalMemoryObservation): LocalMemoryEstimate {
  const runtimeKey = localMemoryRuntimeKey(runtime);
  const missing: string[] = [];
  const notes: string[] = [];
  const matchingObservation = observation?.modelId === model.id && observation.runtimeKey === runtimeKey ? observation : undefined;
  if (observation && !matchingObservation) notes.push('LOCAL_MEMORY_OBSERVATION_SCOPE_MISMATCH');
  const formulaAllowed = knownFormulaModel(model);
  if (!formulaAllowed) notes.push('LOCAL_MEMORY_ARCHITECTURE_UNKNOWN');

  let modelBytes = matchingObservation?.modelBytes;
  if (!finitePositive(modelBytes)) modelBytes = finitePositive(model.weightBytes) ? model.weightBytes : undefined;
  if (modelBytes === undefined) missing.push('modelBytes');

  let kvBytes = matchingObservation?.kvBytes;
  if (!finitePositive(kvBytes) && formulaAllowed) {
    const kvDimension = model.kvDimension ?? (model.kvKeyDimension !== undefined && model.kvValueDimension !== undefined
      ? model.kvKeyDimension + model.kvValueDimension : undefined);
    if (finitePositive(model.layerCount) && finitePositive(runtime.contextTokens) && finitePositive(kvDimension)) {
      // kvUnified shares one cache of total n_ctx tokens; parallel is not a multiplier.
      kvBytes = runtime.contextTokens * model.layerCount * kvDimension * KV_BYTES_PER_ELEMENT;
    }
  }
  if (kvBytes === undefined) missing.push('kvBytes');

  const computeBytes = finitePositive(matchingObservation?.computeBytes) ? matchingObservation!.computeBytes : undefined;
  if (computeBytes === undefined) missing.push('computeBytes');

  const components = [modelBytes, kvBytes, computeBytes].filter((value): value is number => value !== undefined);
  const totalBytes = components.length ? components.reduce((sum, value) => sum + value, 0) : undefined;
  const observedCount = matchingObservation ? [matchingObservation.modelBytes, matchingObservation.kvBytes, matchingObservation.computeBytes].filter(finitePositive).length : 0;
  const formulaCount = [modelBytes, kvBytes, computeBytes].filter((value, index) => value !== undefined && (observedCount === 0 || !matchingObservation || [matchingObservation.modelBytes, matchingObservation.kvBytes, matchingObservation.computeBytes][index] === undefined)).length;
  const source = observedCount && formulaCount ? 'mixed' : observedCount ? 'native' : 'formula';
  const lowerBound = source !== 'native' || missing.length > 0;
  const status = totalBytes === undefined ? 'missing' : lowerBound ? 'lower-bound' : 'estimated';
  if (source === 'formula') notes.push('LOCAL_MEMORY_FORMULA_LOWER_BOUND', 'LOCAL_MEMORY_KV_F16_ASSUMPTION');
  if (source === 'mixed') notes.push('LOCAL_MEMORY_NATIVE_CALIBRATION_PARTIAL');
  return { status, source, lowerBound, runtimeKey, ...(modelBytes !== undefined ? { modelBytes } : {}),
    ...(kvBytes !== undefined ? { kvBytes } : {}), ...(computeBytes !== undefined ? { computeBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}), missing, notes };
}
