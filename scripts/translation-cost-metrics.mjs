/** Currency is supplied by the caller; these helpers never infer a provider's prices or cache semantics. */
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = value => Number.isSafeInteger(value) && value >= 0;

/** OpenAI-compatible totals include cached input and reasoning output as subsets, not additions. */
export function normalizeCostUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result = {};
  for (const [local, value] of Object.entries({
    promptTokens: raw.promptTokens ?? raw.prompt_tokens,
    completionTokens: raw.completionTokens ?? raw.completion_tokens,
    totalTokens: raw.totalTokens ?? raw.total_tokens,
    cachedInputTokens: raw.cachedInputTokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens,
    cacheWriteTokens: raw.cacheWriteTokens ?? raw.cache_creation_input_tokens,
    reasoningTokens: raw.reasoningTokens ?? raw.completion_tokens_details?.reasoning_tokens,
  })) {
    // Preserve invalid supplied fields so accounting rejects them instead of mistaking them for zero.
    if (value !== undefined) result[local] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Each entry represents ONE actual transport attempt, including failures and cancellations.
 * cacheWriteAccounting is 'included-in-prompt' (disjoint from cached reads) or 'additional'.
 * A provider/gateway must establish that rule. Unspecified writes make the whole attempt unknown.
 */
export function calculateAttemptCost(attempt, rates) {
  const unknown = reason => ({ known: false, amount: null, currency: rates?.currency ?? null, reason });
  if (!rates || typeof rates.currency !== 'string' || !rates.currency.trim()
      || !nonnegative(rates.inputPerMillion) || !nonnegative(rates.outputPerMillion)) return unknown('unconfigured-rates');
  const usage = normalizeCostUsage(attempt.usage);
  if (!usage) return unknown('missing-usage');
  if (attempt.usageComplete === false) return unknown('incomplete-usage');
  if (!tokens(usage.promptTokens) || !tokens(usage.completionTokens)) return unknown('incomplete-usage');
  for (const value of Object.values(usage)) if (!tokens(value)) return unknown('invalid-usage');
  if (usage.totalTokens !== undefined && usage.totalTokens !== usage.promptTokens + usage.completionTokens) return unknown('inconsistent-totals');
  const cached = usage.cachedInputTokens;
  // If a distinct cache rate is configured, a missing cache breakdown is not a confirmed zero hit.
  if (cached === undefined && rates.cacheReadPerMillion !== undefined
      && rates.cacheReadPerMillion !== rates.inputPerMillion && rates.missingCacheRead !== 'uncached') return unknown('missing-cache-breakdown');
  const reads = cached ?? 0, writes = usage.cacheWriteTokens ?? 0;
  if (reads > usage.promptTokens || (usage.reasoningTokens ?? 0) > usage.completionTokens) return unknown('invalid-subset');
  if (reads > 0 && !nonnegative(rates.cacheReadPerMillion)) return unknown('missing-cache-read-rate');
  if (writes > 0 && !['included-in-prompt', 'additional'].includes(rates.cacheWriteAccounting)) return unknown('unverified-cache-write-accounting');
  if (writes > 0 && !nonnegative(rates.cacheWritePerMillion)) return unknown('missing-cache-write-rate');
  const includedWrites = rates.cacheWriteAccounting === 'included-in-prompt' ? writes : 0;
  const uncached = usage.promptTokens - reads - includedWrites;
  if (uncached < 0) return unknown('overlapping-input-subsets');
  const components = {
    uncachedInput: uncached * rates.inputPerMillion / 1e6,
    cacheRead: reads * (rates.cacheReadPerMillion ?? rates.inputPerMillion) / 1e6,
    cacheWrite: writes * (rates.cacheWritePerMillion ?? 0) / 1e6,
    // Completion already includes reasoning. No separate reasoning charge is added here.
    output: usage.completionTokens * rates.outputPerMillion / 1e6,
  };
  return { known: true, currency: rates.currency, amount: Object.values(components).reduce((a, b) => a + b, 0), components };
}

export function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue / 100 * sorted.length) - 1)];
}

/** No deduplication of occurrences: repeated comments retain independent IDs and deadlines. */
export function summarizeCostReplay({ occurrences, attempts, rates }) {
  const raw = occurrences.length, eligible = occurrences.filter(row => row.eligible);
  const onTimeRows = eligible.filter(row => row.validTranslation === true && Number.isFinite(row.readyAt) && row.readyAt < row.displayAt);
  const readiness = onTimeRows.map(row => row.readyAt - row.receivedAt);
  const costs = attempts.map(attempt => calculateAttemptCost(attempt, rates));
  const knownSubtotal = costs.filter(cost => cost.known).reduce((sum, cost) => sum + cost.amount, 0);
  const unknownCostAttempts = costs.filter(cost => !cost.known).length;
  const total = unknownCostAttempts ? null : knownSubtotal;
  const per1000 = (amount, denominator) => amount === null || !denominator ? null : amount / denominator * 1000;
  const reasons = {};
  costs.filter(cost => !cost.known).forEach(cost => { reasons[cost.reason] = (reasons[cost.reason] ?? 0) + 1; });
  const formatFailures = attempts.filter(attempt => (attempt.formatFailures ?? 0) > 0).length;
  return {
    rawOccurrences: raw, eligibleOccurrences: eligible.length, skippedOccurrences: raw - eligible.length,
    uniqueEligibleTexts: new Set(eligible.map(row => row.uniqueId)).size,
    repeatedEligibleOccurrences: eligible.length - new Set(eligible.map(row => row.uniqueId)).size,
    onTimeTranslated: onTimeRows.length, onTimeCoverage: eligible.length ? onTimeRows.length / eligible.length : null,
    deadlineUncompletedRate: eligible.length ? (eligible.length - onTimeRows.length) / eligible.length : null,
    releasedOccurrences: occurrences.filter(row => Number.isFinite(row.releasedAt)).length,
    originalFallbacks: occurrences.filter(row => row.eligible && row.releasedTranslated === false).length,
    localCacheOccurrences: onTimeRows.filter(row => row.cached).length,
    readinessMs: { population: 'valid on-time results only; failed and censored occurrences remain in the coverage denominator',
      count: readiness.length, p50: percentile(readiness, 50), p95: percentile(readiness, 95), p99: percentile(readiness, 99) },
    requestAttempts: attempts.length, retryAttempts: attempts.filter(attempt => attempt.retry).length,
    requestsWithFormatFailures: formatFailures, formatFailureRate: attempts.length ? formatFailures / attempts.length : null,
    knownCostAttempts: costs.length - unknownCostAttempts, unknownCostAttempts, unknownCostReasons: reasons,
    cost: { currency: rates.currency, knownSubtotal, total,
      per1000Raw: per1000(total, raw), per1000OnTime: per1000(total, onTimeRows.length),
      knownSubtotalPer1000Raw: per1000(knownSubtotal, raw), knownSubtotalPer1000OnTime: per1000(knownSubtotal, onTimeRows.length) },
  };
}
