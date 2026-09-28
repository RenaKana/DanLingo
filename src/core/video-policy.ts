import type { Settings } from './types.ts';

export type VideoDisplayState = 'visible' | 'hidden' | 'unknown';
export type VideoEligibilityState = 'eligible' | 'filtered' | 'unknown';
/** Native observations apply only to this playback epoch and exact original. */
export interface VideoEligibilityUpdate {
  revision: number;
  epoch: number;
  reset: boolean;
  capability: 'unknown' | 'filtered-pool';
  display: VideoDisplayState;
  items: { id: string; originalText: string; state: VideoEligibilityState }[];
}

export function videoBatchLimit(settings: Settings): number {
  if (settings.backend === 'local') return settings.batchSize;
  const value = settings.videoBatchSize ?? Math.min(20, settings.batchSize);
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : 20;
}

/** Native bridge data is untrusted; no rules, authors or native objects cross it. */
export function parseVideoEligibility(value: unknown): VideoEligibilityUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 0 ||
      typeof v.reset !== 'boolean' || !['unknown', 'filtered-pool'].includes(v.capability as string) ||
      !['visible', 'hidden', 'unknown'].includes(v.display as string) || !Array.isArray(v.items) || v.items.length > 200) return null;
  const seen = new Set<string>();
  const items: VideoEligibilityUpdate['items'] = [];
  for (const item of v.items) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 400 || seen.has(item.id) ||
        typeof item.originalText !== 'string' || !item.originalText || item.originalText.length > 1000 ||
        !['eligible', 'filtered', 'unknown'].includes(item.state)) return null;
    seen.add(item.id); items.push({ id: item.id, originalText: item.originalText, state: item.state });
  }
  return { revision: v.revision as number, epoch: v.epoch as number, reset: v.reset,
    capability: v.capability as VideoEligibilityUpdate['capability'], display: v.display as VideoDisplayState, items };
}
