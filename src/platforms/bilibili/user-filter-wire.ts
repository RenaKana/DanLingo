import type { UserFilterRow } from './user-filter-session.ts';

export function parseUserFilterRows(value: unknown, limit = 200): UserFilterRow[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const ids = new Set<string>(), rows: UserFilterRow[] = [];
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 400 || ids.has(item.id) ||
      typeof item.originalText !== 'string' || !item.originalText || item.originalText.length > 1000 ||
      !['exclude', 'retain', 'unknown'].includes(item.state) || item.category !== undefined &&
      !['keyword', 'regexp', 'sender', 'account'].includes(item.category) ||
      item.legacyState !== undefined && !['exclude', 'retain', 'unknown'].includes(item.legacyState)) return null;
    ids.add(item.id); rows.push({ id: item.id, originalText: item.originalText, state: item.state,
      ...(item.category ? { category: item.category } : {}), ...(item.legacyState ? { legacyState: item.legacyState } : {}) });
  }
  return rows;
}

/** Only summaries cross into content/diagnostic output, never rule values. */
export function parseUserFilterSummary(value: any): Record<string, any> | null {
  if (!value || typeof value.contract !== 'string' || value.contract.length > 100 ||
      typeof value.featureEnabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  const categories: Record<string, unknown> = {};
  for (const key of ['keyword', 'regexp', 'sender', 'account']) {
    const row = value.categories?.[key];
    if (!row || !['ready', 'disabled', 'partial', 'unknown'].includes(row.status) ||
        !['total', 'enabled', 'supported'].every(field => Number.isSafeInteger(row[field]) && row[field] >= 0 && row[field] <= 2000)) return null;
    categories[key] = { status: row.status, total: row.total, enabled: row.enabled, supported: row.supported,
      ...(typeof row.reason === 'string' && /^[a-z-]{1,100}$/.test(row.reason) ? { reason: row.reason } : {}) };
    if (key === 'regexp') {
      if (row.details !== undefined && (!Array.isArray(row.details) || row.details.length > 32)) return null;
      const details = [];
      for (const detail of row.details ?? []) {
        if (!detail || !/^R[1-9][0-9]{0,3}$/.test(detail.id) || typeof detail.supported !== 'boolean' ||
          !/^[a-z-]{1,60}$/.test(detail.reason) || !/^[a-z-]{1,60}$/.test(detail.oldReason) ||
          !Array.isArray(detail.features) || detail.features.length > 16 ||
          detail.features.some((v: unknown) => !['backreference', 'extended-escape', 'escape', 'character-class', 'lookaround', 'group', 'alternation', 'quantifier', 'anchor', 'wildcard', 'unbounded-quantifier', 'bounded-quantifier', 'repeated-group'].includes(v as string)) ||
          typeof detail.flags !== 'string' || !/^[img]{0,3}$/.test(detail.flags) || typeof detail.nativeValid !== 'boolean') return null;
        details.push({ id: detail.id, supported: detail.supported, reason: detail.reason, oldReason: detail.oldReason,
          features: [...detail.features], flags: detail.flags, nativeValid: detail.nativeValid });
      }
      const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2000 ? Number(value) : 0;
      Object.assign(categories[key]!, { details, detailsTruncated: count(row.detailsTruncated), degraded: count(row.degraded) });
    }
  }
  const natural: Record<string, number> = {};
  for (const key of ['calls', 'predictedExcludes', 'matchedUserBranch', 'conflicts', 'changedSnapshot', 'regexpPredictions', 'regexpPredictionsMatchedUserBranch']) {
    const n = value.natural?.[key]; if (Number.isSafeInteger(n) && n >= 0) natural[key] = n;
  }
  const readEvidence: Record<string, boolean> = {}, authorInputs: Record<string, number> = {};
  const sampledHits: Record<string, number> = {};
  const matchingMetrics: Record<string, number> = {};
  for (const key of ['lastRefreshMs', 'maxRefreshMs', 'currentMatchMs', 'legacyMatchMs', 'judgments']) {
    const n = value.matchingMetrics?.[key]; if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12) matchingMetrics[key] = n;
  }
  const parseAudit = (input: any) => {
    const rows: { id: string; checked: number; positive: number; negative: number; differences: number; limited: number }[] = [];
    if (!Array.isArray(input) || input.length > 32) return rows;
    for (const row of input) {
    if (!row || !/^R[1-9][0-9]{0,3}$/.test(row.id) || !['checked', 'positive', 'negative', 'differences', 'limited']
      .every(key => Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 20000)) return null;
    rows.push({ id: row.id, checked: row.checked, positive: row.positive, negative: row.negative,
      differences: row.differences, limited: row.limited });
    }
    return rows;
  };
  const semanticAudit = parseAudit(value.semanticAudit), semanticFixtures = parseAudit(value.semanticFixtures);
  if (!semanticAudit || !semanticFixtures) return null;
  for (const key of ['keyword', 'regexp', 'sender']) {
    const n = value.sampledHits?.[key]; if (Number.isSafeInteger(n) && n >= 0 && n <= 20000) sampledHits[key] = n;
  }
  for (const key of ['storeFound', 'methodsMatch', 'callbackMatches', 'listComplete', 'switchKnown', 'accountScopeKnown'])
    readEvidence[key] = value.readEvidence?.[key] === true;
  for (const key of ['uhashStrings', 'uidStrings', 'uidNumbers', 'missing']) {
    const n = value.authorInputs?.[key]; if (Number.isSafeInteger(n) && n >= 0) authorInputs[key] = n;
  }
  return { contract: value.contract, featureEnabled: value.featureEnabled, revision: value.revision,
    compileMs: typeof value.compileMs === 'number' && Number.isFinite(value.compileMs) && value.compileMs >= 0 && value.compileMs <= 1e6 ? value.compileMs : null,
    mainBuildId: typeof value.mainBuildId === 'string' && value.mainBuildId.length <= 200 ? value.mainBuildId : null,
    nativeEnabled: typeof value.enabled === 'boolean' ? value.enabled : null, categories, natural, readEvidence, authorInputs, sampledHits, matchingMetrics, semanticAudit, semanticFixtures,
    pollingMs: 2000, restored: value.restored === true,
    observation: value.observation && typeof value.observation === 'object' ? {
      started: value.observation.started === true, playing: value.observation.playing === true,
      restored: value.observation.restored === true, selectedRuleHit: value.observation.selectedRuleHit === true,
    } : null,
    suppressedCategories: Array.isArray(value.suppressedCategories) ? value.suppressedCategories.filter((v: unknown) =>
      ['keyword', 'regexp', 'sender', 'account'].includes(v as string)) : [] };
}
