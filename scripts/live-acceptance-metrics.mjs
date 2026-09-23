import assert from 'node:assert/strict';

const finite = Number.isFinite;
const round = n => Math.round(n * 1000) / 1000;
function distribution(values) {
  const rows = values.filter(finite).sort((a, b) => a - b);
  if (!rows.length) return { samples: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
  const percentile = p => round(rows[Math.min(rows.length - 1, Math.ceil(rows.length * p) - 1)]);
  return { samples: rows.length, meanMs: round(rows.reduce((a, b) => a + b, 0) / rows.length),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), minMs: round(rows[0]), maxMs: round(rows.at(-1)) };
}

/** Fixed receipt cohort. Never select only translated/displayed requests as the denominator. */
export function summarizeLiveWindow({ providerKind, bufferMs, window, sources, outcomes, requests = [], minimumEligible = 20, captureComplete = false, playbackHealthy = false }) {
  assert.ok(['real', 'mock'].includes(providerKind), 'Provider evidence must be explicitly real or mock');
  assert.ok([500, 1000, 2000, 3000].includes(bufferMs), 'Unsupported live buffer');
  assert.ok(window && [window.startAt, window.endAt, window.observedUntil].every(finite) && window.endAt > window.startAt, 'Fixed window required');
  assert.ok(Number.isSafeInteger(minimumEligible) && minimumEligible > 0, 'Positive minimum sample size required');
  assert.ok(Array.isArray(sources) && Array.isArray(outcomes) && Array.isArray(requests));
  const byId = new Map(), results = new Map();
  let repeatedSourceRows = 0, conflictingSources = 0;
  for (const source of sources) {
    assert.ok(typeof source.id === 'string' && source.id && finite(source.receivedAt) && typeof source.eligible === 'boolean', 'Invalid source evidence');
    if (source.receivedAt < window.startAt || source.receivedAt >= window.endAt) continue;
    if (byId.has(source.id)) {
      repeatedSourceRows++;
      const first = byId.get(source.id);
      if (first.receivedAt !== source.receivedAt || first.eligible !== source.eligible) conflictingSources++;
    } else byId.set(source.id, source);
  }
  for (const result of outcomes) {
    assert.ok(typeof result.id === 'string' && ['translated', 'original', 'dropped', 'removed', 'filtered'].includes(result.kind) && finite(result.at), 'Invalid outcome evidence');
    if (!byId.has(result.id) || result.at > window.observedUntil) continue;
    const rows = results.get(result.id) || []; rows.push(result); results.set(result.id, rows);
  }
  const counts = { received: byId.size, eligibleReceived: 0, nonEligible: 0, denominator: 0, translatedInTime: 0,
    originalFallback: 0, dropped: 0, missingOutcome: 0, removedBeforeDisplay: 0, filteredBySite: 0,
    duplicateDeliveries: 0, changedAfterDisplay: 0, preparedAfterDeadline: 0, missingPreparationEvidence: 0, conflictingTerminalOutcomes: 0, invalidChronology: 0,
    repeatedSourceRows, conflictingSources, negativeAcquisitionClockSamples: 0, invalidRequestClockSamples: 0 };
  const acquisition = [], display = [], preparation = [], releaseOverrun = [];
  for (const [id, source] of byId) {
    const deadline = finite(source.deadlineAt) ? source.deadlineAt : source.receivedAt + bufferMs;
    assert.ok(deadline >= source.receivedAt && deadline <= source.receivedAt + 6000, 'Invalid source deadline');
    const rows = (results.get(id) || []).sort((a, b) => a.at - b.at);
    const deliveries = rows.filter(r => r.kind === 'translated' || r.kind === 'original');
    const first = deliveries[0];
    if (deliveries.length > 1) counts.duplicateDeliveries += deliveries.length - 1;
    if (rows.some(r => r.textChangedAfterDisplay)) counts.changedAfterDisplay++;
    if (first && (first.at < source.receivedAt || finite(first.preparedAt) && (first.preparedAt > first.at || first.preparedAt < source.receivedAt))) counts.invalidChronology++;
    if (!source.eligible) { counts.nonEligible++; continue; }
    counts.eligibleReceived++;
    const removed = rows.find(r => r.kind === 'removed' && r.at >= source.receivedAt && r.at < deadline && (!first || r.at < first.at));
    const filtered = rows.find(r => r.kind === 'filtered' && r.at >= source.receivedAt && !first);
    if (removed) { counts.removedBeforeDisplay++; if (first) counts.conflictingTerminalOutcomes++; continue; }
    if (filtered) { counts.filteredBySite++; continue; }
    counts.denominator++;
    if (finite(source.sentAtEpochMs)) {
      const delay = source.receivedAt - source.sentAtEpochMs;
      if (delay < 0) counts.negativeAcquisitionClockSamples++; else acquisition.push(delay);
    }
    if (first) {
      if (rows.some(r => r.kind === 'dropped' || r.kind === 'filtered')) counts.conflictingTerminalOutcomes++;
      display.push(first.at - source.receivedAt); releaseOverrun.push(first.at - deadline);
      if (finite(first.preparedAt)) preparation.push(first.preparedAt - source.receivedAt);
      const late = finite(first.preparedAt) && first.preparedAt >= deadline;
      if (late) counts.preparedAfterDeadline++;
      if (first.kind === 'translated' && !finite(first.preparedAt)) counts.missingPreparationEvidence++;
      if (first.kind === 'translated' && finite(first.preparedAt) && !late) counts.translatedInTime++;
      else if (first.kind === 'original') counts.originalFallback++;
    } else if (rows.some(r => r.kind === 'dropped')) counts.dropped++;
    else counts.missingOutcome++;
  }
  const relevantRequests = requests.filter(r => finite(r.startedAt) && r.startedAt >= window.startAt && r.startedAt < window.endAt);
  const durations = [];
  for (const request of relevantRequests) if (finite(request.completedAt)) {
    if (request.completedAt < request.startedAt) counts.invalidRequestClockSamples++;
    else durations.push(request.completedAt - request.startedAt);
  }
  const translationRate = counts.denominator ? counts.translatedInTime / counts.denominator : null;
  const originalFallbackRate = counts.denominator ? counts.originalFallback / counts.denominator : null;
  const integrity = !counts.duplicateDeliveries && !counts.changedAfterDisplay && !counts.preparedAfterDeadline &&
    !counts.conflictingSources && !counts.conflictingTerminalOutcomes && !counts.invalidChronology;
  const fixedWindowComplete = window.observedUntil >= window.endAt + bufferMs + 1000;
  const enoughEvidence = captureComplete && playbackHealthy && fixedWindowComplete && integrity && counts.missingOutcome === 0 && counts.missingPreparationEvidence === 0 &&
    window.endAt - window.startAt >= 30000 && counts.denominator >= minimumEligible && durations.length > 0;
  const targetStatus = providerKind !== 'real' ? 'NOT_REAL_PROVIDER' : !enoughEvidence ? 'INCOMPLETE_EVIDENCE'
    : translationRate >= 0.9 ? 'MET' : 'NOT_MET';
  return { providerKind, bufferMs, window: { ...window, durationMs: window.endAt - window.startAt, fixedWindowComplete },
    captureComplete, playbackHealthy, minimumEligible, counts, translationRate, originalFallbackRate, target: { requiredRate: 0.9, status: targetStatus },
    latency: { messageAcquisition: distribution(acquisition), providerRequest: distribution(durations),
      preparation: distribution(preparation), extraDisplayDelay: distribution(display), releaseAfterDeadline: distribution(releaseOverrun) },
    requestCounts: { started: relevantRequests.length, completed: durations.length,
      unfinished: relevantRequests.filter(r => !finite(r.completedAt)).length,
      httpErrors: relevantRequests.filter(r => Number(r.status) >= 400).length },
    limitations: ['Message acquisition compares remote epoch stamps with local epoch-monotonic receipt; clock skew is counted separately.',
      'Display timestamps describe DOM insertion or native slot creation, not physical screen pixels.',
      'Translated outcome flags must come from the actual scheduler/native delivery; text matching or mock prefixes alone are insufficient.',
      'A translated numerator also requires the display-world preparation timestamp before the original deadline; later DOM/native scheduling is reported separately as display delay.',
      'Request latency is aggregate network timing; no source-to-provider ID mapping is inferred from unrelated provider task IDs.',
      'Only explicitly observed withdrawal between receipt and deadline before display, or native filtering, excludes an eligible message; later withdrawals, drops, timeouts and missing results remain in the denominator.'] };
}
