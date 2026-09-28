import type { PlaybackClock, Settings, SourceMessage } from '../core/types.ts';
import { VideoScheduler, type VideoUserFilterUpdate } from '../core/scheduler.ts';
import type { VideoEligibilityUpdate } from '../core/video-policy.ts';
import { TranslationEngine } from '../translation/engine.ts';
import { MemoryTranslationCache } from '../translation/cache.ts';

type Category = 'keyword' | 'regexp' | 'sender' | 'account';
export interface SimulationDecision {
  id: string;
  originalText: string;
  state: 'exclude' | 'retain' | 'unknown';
  category?: Category;
  legacyState?: 'exclude' | 'retain' | 'unknown';
}
export interface UserFilterSimulationInput {
  sources: SourceMessage[];
  settings: Settings;
  clock: PlaybackClock;
  epoch: number;
  decisions: SimulationDecision[];
  normalEligibility?: VideoEligibilityUpdate;
}
export interface SimulationRunCounts {
  effectiveSubscriptions: number;
  uniquePendingTexts: number;
  simulatedProviderCalls: number;
  simulatedProviderInputs: number;
  cacheHits: number;
}
export interface UserFilterSimulationSummary {
  candidateEvents: number;
  userRuleHitsByCategory: Record<Category | 'unattributed', number>;
  unknownEvents: number;
  disabled: SimulationRunCounts;
  enabled: SimulationRunCounts;
  sameTextGroupsStillNeeded: number;
  incrementalExcludedEvents: number;
  incrementalExcludedUniqueTexts: number;
  actualModelCalls: 0;
  evidence: 'memory-provider-only';
  context: { contentActive: boolean; commentsVisible: boolean | null; seeking: boolean; scope: string; mediaTimeMs: number };
  inputFingerprint: string;
  regexpIncremental?: { baseline: SimulationRunCounts; current: SimulationRunCounts; excludedEvents: number; excludedUniqueTexts: number };
}
interface RunResult extends SimulationRunCounts { requestedIds: Set<string>; requestedTexts: Set<string> }

const syntheticTranslation = (target: string): string => {
  const language = target.toLowerCase().split(/[-_]/)[0];
  if (language === 'zh') return '\u6a21\u62df\u8bd1\u6587';
  if (language === 'ja') return '\u30c6\u30b9\u30c8\u8a33\u6587';
  if (language === 'ko') return '\ubaa8\uc758\ubc88\uc5ed\ubb38';
  return 'Synthetic translation';
};

async function simulateRun(input: UserFilterSimulationInput, settings: Settings,
  update?: VideoUserFilterUpdate): Promise<RunResult> {
  const requestedIds = new Set<string>(), requestedTexts = new Set<string>();
  let simulatedProviderCalls = 0, simulatedProviderInputs = 0;
  const engine = new TranslationEngine({
    cache: new MemoryTranslationCache(),
    provider: { complete: async request => {
      simulatedProviderCalls++;
      simulatedProviderInputs += request.items.length;
      const translated = syntheticTranslation(settings.targetLanguage);
      return { items: new Map(request.items.map(item => [item.id, { text: translated }])) };
    } },
  });
  const scheduler = new VideoScheduler({ settings, now: () => 0, reset: () => {}, prepared: () => {},
    cancelItems: (signal, ids) => engine.cancelItems(signal, ids),
    request: (resourceId, items, signal, priority, onResult) => {
      for (const item of items) { requestedIds.add(item.id); requestedTexts.add(item.text); }
      return engine.translate({ resourceId, settings, apiKey: 'memory-provider-only', mode: 'vod', priority, signal, onResult,
        items: items.map(item => ({ id: item.id, text: item.text, deadlineAt: performance.now() + item.remainingMs })) })
        .then(response => response.items);
    },
  });
  try {
    const resourceId = input.sources[0]?.resourceId ?? 'empty-simulation';
    const scope = 'user-filter-simulation';
    scheduler.snapshot(resourceId, scope, { ...input.clock, seeking: true }, undefined, input.epoch);
    scheduler.updateSources(input.sources, [], true, true, update);
    if (input.normalEligibility) scheduler.updateEligibility(input.normalEligibility);
    scheduler.snapshot(resourceId, scope, input.clock, undefined, input.epoch);

    const inactive = !input.clock.contentActive || input.clock.seeking || input.clock.commentsVisible === false;
    const deadline = performance.now() + 10_000;
    let settled = false;
    while (performance.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const stats = scheduler.getStats(), engineStats = engine.stats();
      if (stats.inflight === 0 && engineStats.pendingItems === 0 && (inactive || stats.queued === 0)) {
        settled = true; break;
      }
    }
    if (!settled) throw new Error('user-filter-simulation-timeout');
    if (requestedIds.size && simulatedProviderCalls === 0 && engine.stats().cacheHits === 0)
      throw new Error('user-filter-simulation-provider-not-admitted');
    return { requestedIds, requestedTexts, effectiveSubscriptions: requestedIds.size,
      uniquePendingTexts: requestedTexts.size, simulatedProviderCalls, simulatedProviderInputs,
      cacheHits: engine.stats().cacheHits };
  } finally {
    scheduler.dispose(); engine.dispose();
  }
}

/** Counts only an isolated, in-memory provider boundary; it never constructs a real transport. */
export async function simulateUserFilterDemand(input: UserFilterSimulationInput): Promise<UserFilterSimulationSummary> {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0 || input.sources.length > 20_000 ||
      input.decisions.length > input.sources.length ||
      input.normalEligibility && input.normalEligibility.epoch !== input.epoch)
    throw new Error('invalid-user-filter-simulation-input');
  const sourceById = new Map<string, SourceMessage>();
  for (const source of input.sources) {
    if (!source.id || sourceById.has(source.id) || source.platform !== 'bilibili' ||
        (sourceById.size && source.resourceId !== input.sources[0]!.resourceId))
      throw new Error('invalid-user-filter-simulation-sources');
    sourceById.set(source.id, source);
  }
  const matched = new Map<string, SimulationDecision>();
  for (const decision of input.decisions) {
    if (matched.has(decision.id) || decision.category && !['keyword', 'regexp', 'sender', 'account'].includes(decision.category) ||
        !['exclude', 'retain', 'unknown'].includes(decision.state))
      throw new Error('invalid-user-filter-simulation-decision');
    if (sourceById.get(decision.id)?.originalText === decision.originalText) matched.set(decision.id, decision);
  }
  const hits: UserFilterSimulationSummary['userRuleHitsByCategory'] =
    { keyword: 0, regexp: 0, sender: 0, account: 0, unattributed: 0 };
  let unknownEvents = 0;
  for (const source of input.sources) {
    const decision = matched.get(source.id);
    if (!decision || decision.state === 'unknown') unknownEvents++;
    else if (decision.state === 'exclude') hits[decision.category ?? 'unattributed']++;
  }
  const settings = { ...input.settings, enabled: true, displayMode: 'translated' as const };
  // Fingerprint the frozen replay input, never private rule values or author IDs.
  const fingerprintBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    sources: input.sources.map(row => [row.id, row.originalText, row.mediaTimeMs, row.translatable]),
    decisions: [...matched.values()].map(row => [row.id, row.state, row.legacyState ?? null]),
    normalEligibility: input.normalEligibility, clock: input.clock,
    settings: { sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage,
      translationScope: settings.translationScope, prefetchSeconds: settings.prefetchSeconds },
  })));
  const inputFingerprint = [...new Uint8Array(fingerprintBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const disabled = await simulateRun(input, settings);
  const enabled = await simulateRun(input, settings, { epoch: input.epoch, revision: 0, reset: true,
    items: [...matched.values()].map(({ id, originalText, state }) => ({ id, originalText, state })) });
  const legacy = matched.size === input.sources.length && [...matched.values()].every(row => row.legacyState !== undefined)
    ? await simulateRun(input, settings, { epoch: input.epoch, revision: 0, reset: true,
      items: [...matched.values()].map(({ id, originalText, legacyState }) => ({ id, originalText, state: legacyState! })) }) : null;
  const excludedTexts = new Set(input.sources.filter(source => disabled.requestedIds.has(source.id) &&
    matched.get(source.id)?.state === 'exclude').map(source => source.originalText));
  const counts = ({ requestedIds: _ids, requestedTexts: _texts, ...value }: RunResult): SimulationRunCounts => value;
  return { candidateEvents: input.sources.length, userRuleHitsByCategory: hits, unknownEvents,
    disabled: counts(disabled), enabled: counts(enabled),
    sameTextGroupsStillNeeded: [...excludedTexts].filter(text => enabled.requestedTexts.has(text)).length,
    incrementalExcludedEvents: [...disabled.requestedIds].filter(id => !enabled.requestedIds.has(id)).length,
    incrementalExcludedUniqueTexts: [...disabled.requestedTexts].filter(text => !enabled.requestedTexts.has(text)).length,
    actualModelCalls: 0, evidence: 'memory-provider-only', inputFingerprint, context: { contentActive: input.clock.contentActive,
      commentsVisible: input.clock.commentsVisible ?? null, seeking: input.clock.seeking,
      scope: settings.translationScope, mediaTimeMs: input.clock.mediaTimeMs }, ...(legacy ? { regexpIncremental: {
      baseline: counts(legacy), current: counts(enabled),
      excludedEvents: [...legacy.requestedIds].filter(id => !enabled.requestedIds.has(id)).length,
      excludedUniqueTexts: [...legacy.requestedTexts].filter(text => !enabled.requestedTexts.has(text)).length,
    } } : {}) };
}
