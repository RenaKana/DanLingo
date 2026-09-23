import type { LiveMetrics } from './types.ts';

/** Page-origin data is copied as bounded numerical aggregates only. */
export function nativeMetrics(value: any): LiveMetrics | undefined {
  const keys = ['received','submitted','presented','translated','original','timedOut','overloaded','removed','abandoned','pending','translatedChars','cachedTranslated','observationMs'] as const;
  if (!value || keys.some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1e9)) return;
  const result = Object.fromEntries(keys.map(key => [key,value[key]])) as unknown as LiveMetrics;
  for (const key of ['unconfirmed', 'repaired', 'repairApplied'] as const) if (value[key] !== undefined) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1e9) return;
    result[key] = value[key];
  }
  for (const name of ['readinessMs','releaseDelayMs'] as const) {
    const row = value[name];
    if (!row || !Number.isInteger(row.samples) || row.samples < 0 || row.samples > 1200 || ['p50','p95','p99'].some(k =>
      row[k] !== null && (typeof row[k] !== 'number' || !Number.isFinite(row[k]) || row[k] < 0 || row[k] > 86400000))) return;
    result[name] = { p50:row.p50, p95:row.p95, p99:row.p99, samples:row.samples };
  }
  return result;
}
