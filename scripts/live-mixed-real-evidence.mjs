// Pure analysis of observed source fingerprints and actual Provider request times.
// A text shared by LIVE and VOD is ambiguous; it never proves either workload's share.
import { createHash } from 'node:crypto';
import { decodeTranslationFixtureRequest } from './translation-protocol-fixture.mjs';

export function observeMixedRequestMetadata(body) {
  try {
    const payload = decodeTranslationFixtureRequest(body);
    const string = value => typeof value === 'string' ? value : undefined;
    return {
      model: string(body.model), protocol: payload.protocol, stream: payload.stream,
      sourceLanguage: string(payload.sourceLanguage), targetLanguage: string(payload.targetLanguage),
      thinking: string(body.thinking?.type) ?? null, reasoningEffort: string(body.reasoning_effort) ?? null,
      // IDs are local to this HTTP request; only the transmitted protected text correlates sources.
      items: payload.items.map(item => ({ engineId: String(item.id).slice(0, 100),
        textSha256: createHash('sha256').update(item.text).digest('hex') })),
    };
  } catch {
    return { items: [], metadataUnavailable: true };
  }
}

export function summarizeMixedRequests({ requests, sources, window, concurrency = 2 }) {
  const index = new Map();
  for (const source of sources) {
    if (!['live', 'vod'].includes(source.kind) || typeof source.textSha256 !== 'string' || !Number.isFinite(source.observedAt)) continue;
    const rows = index.get(source.textSha256) || [];
    rows.push(source); index.set(source.textSha256, rows);
  }
  const classified = requests.map(request => {
    const items = (request.items || []).map(item => {
      const kinds = new Set((index.get(item.textSha256) || []).filter(source => source.observedAt <= request.startedAt + 10).map(source => source.kind));
      return { ...item, kind: kinds.size === 0 ? 'unknown' : kinds.size > 1 ? 'ambiguous' : [...kinds][0] };
    });
    const kinds = new Set(items.map(item => item.kind));
    const kind = items.length === 0 || kinds.has('unknown') ? 'unknown'
      : kinds.has('ambiguous') || kinds.size > 1 ? 'ambiguous' : [...kinds][0];
    return { ...request, items, kind };
  });
  const inWindow = classified.filter(request => request.startedAt >= window.startAt && request.startedAt < window.endAt);
  const activeAt = at => classified.filter(request => request.startedAt <= at && (!Number.isFinite(request.completedAt) || request.completedAt > at));
  const sampleTimes = [window.startAt, ...inWindow.map(request => request.startedAt)];
  const peak = Math.max(0, ...sampleTimes.map(at => activeAt(at).length));
  const admissions = inWindow.filter(request => request.kind === 'vod').map(request => {
    const active = activeAt(request.startedAt);
    const vodCount = active.filter(row => row.kind === 'vod').length;
    const unknownCount = active.filter(row => !['vod', 'live'].includes(row.kind)).length;
    return { id: request.id, startedAt: request.startedAt, activeTotal: active.length, activeVod: vodCount,
      activeUnknown: unknownCount, reservation: unknownCount ? 'INCOMPLETE' : vodCount <= concurrency - 1 ? 'OBSERVED_WITHIN_LIMIT' : 'VIOLATION' };
  });
  return { requests: classified, windowRequestIds: inWindow.map(row => row.id), peakTotal: peak,
    shares: Object.fromEntries(['live', 'vod', 'ambiguous', 'unknown'].map(kind => [kind, inWindow.filter(row => row.kind === kind).length])),
    admissions, unresolvedRequests: classified.filter(row => row.startedAt < window.endAt &&
      (!Number.isFinite(row.completedAt) || row.completedAt > window.startAt) && !['live', 'vod'].includes(row.kind)).map(row => row.id),
    limitation: 'Protected-text/time correlation only. HTTP item IDs are not source IDs; cross-workload identical text stays ambiguous. Observed concurrency is not forced saturation.' };
}
