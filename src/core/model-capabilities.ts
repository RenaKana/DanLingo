export interface ModelEffortMetadata {
  supportedLevels: string[];
  defaultLevel?: string;
}

const MAX_EFFORT_LEVELS = 16;
const MAX_EFFORT_NAME_LENGTH = 32;
const RESERVED_NAMES = new Set(['constructor', 'prototype', '__proto__', 'default', 'off', 'on']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function effortName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EFFORT_NAME_LENGTH
    && /^[a-z][a-z0-9_-]*$/.test(value) && !RESERVED_NAMES.has(value);
}

function metadata(levels: unknown, preferred: unknown): ModelEffortMetadata | undefined {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > MAX_EFFORT_LEVELS) return;
  if (!levels.every(effortName)) return;
  const supportedLevels = [...new Set<string>(levels)];
  if (!supportedLevels.length) return;
  return { supportedLevels,
    ...(effortName(preferred) && supportedLevels.includes(preferred) ? { defaultLevel: preferred } : {}) };
}

/** Read only the known effort fields from a GET /models row. */
export function parseModelEffortMetadata(row: unknown): ModelEffortMetadata | undefined {
  const model = record(row);
  if (!model || !Object.hasOwn(model, 'effort')) return;
  const effort = record(model.effort);
  if (!effort || !Object.hasOwn(effort, 'supported_levels')) return;
  return metadata(effort.supported_levels, Object.hasOwn(effort, 'default_level') ? effort.default_level : undefined);
}

/** Revalidate persisted or message-supplied metadata before using it. */
export function sanitizeModelEffortMetadata(value: unknown): ModelEffortMetadata | undefined {
  const raw = record(value);
  if (!raw || !Object.hasOwn(raw, 'supportedLevels')) return;
  return metadata(raw.supportedLevels, Object.hasOwn(raw, 'defaultLevel') ? raw.defaultLevel : undefined);
}
