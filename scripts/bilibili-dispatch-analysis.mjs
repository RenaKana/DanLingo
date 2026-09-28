import { createHash } from 'node:crypto';

const finite = Number.isFinite;
const arr = value => Array.isArray(value) ? value : [];
const eligible = row => row?.translatable === true && row?.needsTranslation === true && row?.textAllowed === true;
const sourceId = (resourceId, dmid) => JSON.stringify(['bilibili', resourceId, dmid]);
const add = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function countBy(values) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = String(value ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function equalKnown(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return null;
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function explicitIdentity(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function equalExplicitIdentity(a, b) {
  const left = explicitIdentity(a), right = explicitIdentity(b);
  return left === null || right === null ? null : equalKnown(left, right);
}

function numericSummary(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, minMs: null, medianMs: null, maxMs: null };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, minMs: sorted[0],
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    maxMs: sorted.at(-1) };
}

function activityPeak(intervals) {
  const points = intervals.flatMap(interval => [
    { at: interval.start, delta: 1, order: 1 },
    { at: interval.end, delta: -1, order: 0 },
  ]).sort((a, b) => a.at - b.at || a.order - b.order);
  let active = 0, peak = 0;
  for (const point of points) { active += point.delta; peak = Math.max(peak, active); }
  return peak;
}

function watchDispatch(events, watchComplete) {
  const starts = arr(events).filter(event => event.event === 'request-start');
  const ends = arr(events).filter(event => event.event === 'request-end');
  const startsById = new Map(), endsById = new Map(), itemOccurrences = new Map();
  const itemEntries = [];
  for (const event of starts) {
    const requestId = event.requestId;
    if (requestId !== undefined && requestId !== null) add(startsById, String(requestId), event);
    for (const item of arr(event.items)) {
      const entry = { ...item, requestId, atMs: event.atMs };
      itemEntries.push(entry);
      if (typeof item?.id === 'string') add(itemOccurrences, item.id, entry);
    }
  }
  for (const event of ends) if (event.requestId !== undefined && event.requestId !== null)
    add(endsById, String(event.requestId), event);

  const paired = [], unresolved = [], ambiguous = [], invalidPairs = [];
  let orphanEnds = 0;
  for (const requestId of new Set([...startsById.keys(), ...endsById.keys()])) {
    const requestStarts = startsById.get(requestId) ?? [], requestEnds = endsById.get(requestId) ?? [];
    if (requestStarts.length === 1 && requestEnds.length === 1) {
      const start = requestStarts[0], end = requestEnds[0];
      if (finite(start.atMs) && finite(end.atMs) && end.atMs >= start.atMs) {
        paired.push({ requestId, startAtMs: start.atMs, endAtMs: end.atMs,
          durationMs: end.atMs - start.atMs, itemCount: arr(start.items).length });
      } else invalidPairs.push({ requestId, startAtMs: start.atMs ?? null, endAtMs: end.atMs ?? null,
        reason: !finite(start.atMs) || !finite(end.atMs) ? 'missing-or-invalid-time' : 'end-before-start' });
    } else if (requestStarts.length > 1 || requestEnds.length > 1) {
      const definitelyUnresolved = Math.max(0, requestStarts.length - requestEnds.length);
      ambiguous.push({ requestId, starts: requestStarts.length, ends: requestEnds.length,
        unresolvedStarts: definitelyUnresolved });
      for (const start of requestStarts.slice(requestEnds.length)) unresolved.push({ requestId,
        atMs: start.atMs ?? null, itemCount: arr(start.items).length, reason: 'duplicate-request-id-without-matching-end' });
      orphanEnds += Math.max(0, requestEnds.length - requestStarts.length);
    } else if (requestStarts.length && !requestEnds.length) {
      for (const start of requestStarts) unresolved.push({ requestId, atMs: start.atMs ?? null,
        itemCount: arr(start.items).length, reason: 'no-request-end-recorded' });
    } else if (requestEnds.length && !requestStarts.length) orphanEnds += requestEnds.length;
  }
  for (const event of starts.filter(item => item.requestId === undefined || item.requestId === null))
    unresolved.push({ requestId: null, atMs: event.atMs ?? null, itemCount: arr(event.items).length, reason: 'request-id-missing' });
  orphanEnds += ends.filter(item => item.requestId === undefined || item.requestId === null).length;

  const startsPerId = new Map();
  for (const event of starts) if (event.requestId !== undefined && event.requestId !== null)
    add(startsPerId, String(event.requestId), event);
  const duplicateRequestIds = [...startsPerId].filter(([, rows]) => rows.length > 1)
    .map(([requestId, rows]) => ({ requestId, count: rows.length }));
  const duplicateItemIds = [...itemOccurrences].filter(([, rows]) => rows.length > 1)
    .map(([id, rows]) => ({ id, count: rows.length, requestIds: [...new Set(rows.map(item => item.requestId ?? null))] }));
  const duplicateWithinRequestIds = [...itemOccurrences].flatMap(([id, rows]) => {
    const perRequest = new Map();
    for (const item of rows) add(perRequest, item.requestId ?? null, item);
    return [...perRequest].filter(([, items]) => items.length > 1)
      .map(([requestId, items]) => ({ id, requestId, count: items.length }));
  });
  const packetSizes = starts.map(event => arr(event.items).length);
  const observedOneItem = starts.length > 0 && packetSizes.every(size => size === 1);
  const logComplete = watchComplete === true;
  return {
    requestStarts: starts.length, rawItemEntries: itemEntries.length, rawItemsPerRequest: packetSizes,
    packetSizeCounts: countBy(packetSizes), maxItemsPerRequest: packetSizes.length ? Math.max(...packetSizes) : null,
    everyObservedRequestHasOneItem: observedOneItem,
    startsWithNonSingleCardinality: starts.filter(event => arr(event.items).length !== 1).map(event => ({
      requestId: event.requestId ?? null, atMs: event.atMs ?? null, itemCount: arr(event.items).length })),
    uniqueRequestedIds: new Set(itemEntries.map(item => item.id).filter(value => typeof value === 'string')).size,
    duplicateRequestIds, duplicateItemIds, duplicateWithinRequestIds,
    pairedRequestCount: paired.length, pairedIntervals: paired, pairedActiveSlotPeak: activityPeak(paired.map(row => ({
      start: row.startAtMs, end: row.endAtMs }))),
    unresolvedAtEnd: unresolved.length, unresolvedRequests: unresolved,
    ambiguousPairingCount: ambiguous.length, ambiguousPairings: ambiguous,
    invalidPairingCount: invalidPairs.length, invalidPairs, orphanRequestEnds: orphanEnds,
    proofComplete: logComplete,
    singleItemProof: starts.length === 0 ? 'no-request-starts' : !observedOneItem ? 'failed-observed-multi-or-empty-packet'
      : !logComplete ? 'incomplete-log' : 'all-observed-request-starts-single-item',
    _starts: starts, _ends: ends, _itemEntries: itemEntries,
  };
}

function providerActivity(attempts) {
  const list = arr(attempts), intervals = [], unresolved = [], invalid = [];
  for (const [index, attempt] of list.entries()) {
    if (finite(attempt.startedAt) && finite(attempt.finishedAt) && attempt.finishedAt >= attempt.startedAt)
      intervals.push({ start: attempt.startedAt, end: attempt.finishedAt, index,
        durationMs: attempt.finishedAt - attempt.startedAt, status: attempt.status ?? null });
    else if (finite(attempt.startedAt)) unresolved.push({ index, startedAt: attempt.startedAt,
      finishedAt: finite(attempt.finishedAt) ? attempt.finishedAt : null, status: attempt.status ?? null,
      reason: finite(attempt.finishedAt) ? 'finished-before-start' : 'no-finish-time' });
    else invalid.push({ index, status: attempt.status ?? null, reason: 'no-start-time' });
  }
  return { attempts: list.length, statusCounts: countBy(list.map(attempt => attempt.status)),
    reasons: countBy(list.map(attempt => attempt.reason).filter(Boolean)), timedClosedAttempts: intervals.length,
    activityPeak: activityPeak(intervals), durations: numericSummary(intervals.map(interval => interval.durationMs)),
    unresolvedAttempts: unresolved.length, unresolved, invalidTimeAttempts: invalid.length, invalid,
    clock: 'provider attempt wall-clock values are separate from document monotonicMs' };
}

function dispatchPolicy(input, observed, expectedSingle) {
  const snapshot = input.localExperiment?.dispatch ?? input.background?.snapshot?.dispatch ?? input.result?.dispatch ?? null;
  const rawSizes = snapshot?.rawPacketSizes && typeof snapshot.rawPacketSizes === 'object'
    ? Object.fromEntries(Object.entries(snapshot.rawPacketSizes).filter(([size, count]) =>
      /^\d+$/.test(size) && Number.isFinite(count) && count >= 0).sort(([a], [b]) => Number(a) - Number(b))) : null;
  const snapshotCount = rawSizes ? Object.values(rawSizes).reduce((sum, count) => sum + count, 0) : null;
  const snapshotMax = rawSizes ? Math.max(0, ...Object.entries(rawSizes).filter(([, count]) => count > 0).map(([size]) => Number(size))) : null;
  const snapshotHasMulti = rawSizes ? Object.entries(rawSizes).some(([size, count]) => Number(size) !== 1 && count > 0) : false;
  const snapshotAllOne = rawSizes !== null && snapshotCount > 0 && !snapshotHasMulti && (rawSizes['1'] ?? 0) === snapshotCount;
  const violationReason = typeof snapshot?.violationReason === 'string' && snapshot.violationReason.length
    ? snapshot.violationReason : null;
  const checked = Number.isInteger(snapshot?.checkedPackets) ? snapshot.checkedPackets : null;
  const admitted = Number.isInteger(snapshot?.admittedPackets) ? snapshot.admittedPackets : null;
  const snapshotComplete = !!snapshot && checked !== null && checked > 0 && admitted === checked &&
    snapshotCount === checked && violationReason === null;
  const observedMulti = observed.startsWithNonSingleCardinality.length > 0;
  const anyMultiItemPacket = observedMulti || snapshotHasMulti;
  const allObservedStartsSingle = observed.everyObservedRequestHasOneItem;
  const eventSnapshotAgreement = rawSizes === null || !observed.proofComplete ? null
    : JSON.stringify(rawSizes) === JSON.stringify(observed.packetSizeCounts);
  const snapshotMismatch = eventSnapshotAgreement === false ||
    (checked !== null && admitted !== null && checked !== admitted) ||
    (rawSizes !== null && checked !== null && snapshotCount !== checked);
  let proof = 'not-applicable-existing-dispatch';
  if (expectedSingle === true) {
    if (violationReason) proof = `failed-policy-violation:${violationReason}`;
    else if (anyMultiItemPacket) proof = 'failed-observed-multi-or-empty-packet';
    else if (snapshotMismatch) proof = 'incomplete-inconsistent-dispatch-evidence';
    else if (snapshotComplete && snapshotAllOne && (observed.requestStarts === admitted || !observed.proofComplete))
      proof = 'all-packets-dispatch-snapshot-verified';
    else if (allObservedStartsSingle && observed.proofComplete) proof = 'all-observed-request-starts-single-item';
    else if (!observed.requestStarts) proof = 'no-request-starts';
    else proof = 'incomplete-packet-proof';
  } else if (expectedSingle === null) proof = 'unknown-dispatch-condition';
  const completePacketEvidence = snapshotComplete || (allObservedStartsSingle && observed.proofComplete && observed.requestStarts > 0);
  return {
    snapshot,
    backgroundVersion: snapshot?.backgroundVersion ?? null, watchVersion: snapshot?.watchVersion ?? null,
    savedBatchLimit: snapshot?.savedBatchLimit ?? null, effectiveBatchLimit: snapshot?.effectiveBatchLimit ?? null,
    concurrency: snapshot?.concurrency ?? null, configuredSingleDispatch: snapshot?.singleDispatch ?? null,
    checkedPackets: checked, admittedPackets: admitted, snapshotRawPacketSizes: rawSizes,
    snapshotMultiItemPacketCounts: rawSizes ? Object.fromEntries(Object.entries(rawSizes)
      .filter(([size, count]) => Number(size) !== 1 && count > 0)) : null,
    snapshotPacketCount: snapshotCount, snapshotMaxItemsPerPacket: snapshotMax,
    snapshotPeakRequests: snapshot?.peakRequests ?? null, violationReason, snapshotComplete,
    snapshotAllOneItem: snapshotAllOne, eventSnapshotAgreement, snapshotMismatch,
    anyMultiItemPacket, everyObservedRequestHasOneItem: observed.everyObservedRequestHasOneItem,
    allPacketsOneItem: snapshotComplete ? snapshotAllOne
      : observed.proofComplete && observed.requestStarts > 0 ? allObservedStartsSingle : null,
    allPacketEvidenceComplete: completePacketEvidence,
    singleItemProof: proof, observedEventProof: observed.singleItemProof,
  };
}

function adapterEvidence(record) {
  const native = record.initRenderFirst ?? {};
  const raw = native.adapterEvidence ?? native.adapterSelection ?? record.adapterEvidence ??
    record.adapterSelectionAtInitRender ?? record.adapterSelection ?? null;
  if (raw === null || raw === undefined) return { status: 'unknown', selectedTranslation: null, source: null };
  const value = raw && typeof raw === 'object' && raw.selection && typeof raw.selection === 'object' ? raw.selection : raw;
  let selected = typeof value === 'boolean' ? value
    : typeof value.selectedTranslation === 'boolean' ? value.selectedTranslation
      : typeof value.selectedTranslatedText === 'boolean' ? value.selectedTranslatedText
        : typeof value.translationSelected === 'boolean' ? value.translationSelected
          : typeof value.choice === 'string' && ['translated', 'original'].includes(value.choice) ? value.choice === 'translated'
            : null;
  if (typeof value === 'string' && ['translated', 'original'].includes(value)) selected = value === 'translated';
  return { status: selected === null ? value.status ?? 'reported-without-explicit-selection' : 'observed',
    selectedTranslation: selected, source: value.source ?? 'initRender-bound adapter evidence',
    choice: value.choice ?? (selected === null ? null : selected ? 'translated' : 'original'),
    selectedAtMs: finite(value.selectedAtMs) ? value.selectedAtMs : null,
    preparedIdentity: value.preparedIdentity ?? null };
}

function admissionEvidence(record) {
  const native = record.initRenderFirst ?? {};
  const decision = native.shadowPredictionDecision ?? 'unknown';
  const validAtCall = typeof native.shadowPredictionValidAtCall === 'boolean' ? native.shadowPredictionValidAtCall : null;
  const validAtAdmission = typeof native.shadowPredictionValidAtAdmission === 'boolean' ? native.shadowPredictionValidAtAdmission : null;
  const nativeReturn = typeof native.shadowValidationNativeReturn === 'boolean' ? native.shadowValidationNativeReturn : null;
  const predictionIndex = Number.isInteger(native.shadowPredictionIndex) ? native.shadowPredictionIndex : null;
  const bound = predictionIndex !== null || decision !== 'unknown' || validAtCall !== null ||
    validAtAdmission !== null || nativeReturn !== null || typeof native.shadowRuleConflict === 'boolean';
  return { bound, decision, validAtCall, validAtAdmission, nativeReturn, predictionIndex,
    ruleConflict: native.shadowRuleConflict === true };
}

function outcomeRows(input, naturalRecords) {
  const experiment = input.localExperiment ?? {};
  const resourceId = experiment.report?.resourceId ?? input.identity?.resourceId;
  const events = arr(experiment.watchEvents);
  const starts = events.filter(event => event.event === 'request-start');
  const ends = events.filter(event => event.event === 'request-end');
  const results = events.filter(event => event.event === 'item-result');
  const preparedEvents = events.filter(event => event.event === 'prepared');
  const sourceOccurrences = new Map();
  for (const source of arr(input.cacheRows)) add(sourceOccurrences, source.id, source);
  const requestEntries = starts.flatMap(event => arr(event.items).map(item => ({ ...item,
    requestId: event.requestId, atMs: event.atMs })));
  const preparedEntries = preparedEvents.flatMap(event => arr(event.items).map(item => ({ ...item, atMs: event.atMs })));
  const rows = [], unknown = [], genericRuleRejected = [];
  for (const record of naturalRecords) {
    const native = record.initRenderFirst, planned = record.plannedVideoTimeMs;
    const id = sourceId(resourceId, record.dmid), sources = sourceOccurrences.get(id) ?? [];
    if (sources.length !== 1) {
      unknown.push({ id, dmid: record.dmid, reason: sources.length ? 'ambiguous source mapping' : 'no exact source mapping',
        nativeAtMs: native.monotonicMs });
      continue;
    }
    const source = sources[0];
    if (!eligible(source)) {
      genericRuleRejected.push({ id, dmid: record.dmid, nativeAtMs: native.monotonicMs,
        reason: 'source fails the existing generic translation eligibility fields' });
      continue;
    }
    const matchingRequests = requestEntries.filter(item => item.id === id && item.text === source.originalText);
    const preparedMatches = preparedEntries.filter(item => item.id === id && item.originalText === source.originalText)
      .sort((a, b) => (finite(a.atMs) ? a.atMs : Infinity) - (finite(b.atMs) ? b.atMs : Infinity));
    const prepared = preparedMatches[0] ?? null;
    const preparedAtMs = finite(prepared?.atMs) ? prepared.atMs : null;
    const nativeAtMs = native.monotonicMs;
    const preparation = !prepared ? 'missing' : preparedAtMs === null ? 'time-unknown'
      : preparedAtMs <= nativeAtMs ? 'timely' : 'late';
    const requestIds = [...new Set(matchingRequests.map(item => item.requestId).filter(value => value !== undefined))];
    const requestTimes = matchingRequests.map(item => item.atMs).filter(finite);
    const statusValues = [];
    for (const requestId of requestIds) {
      for (const result of results.filter(event => event.requestId === requestId && event.id === id))
        if (typeof result.status === 'string') statusValues.push(result.status);
      for (const end of ends.filter(event => event.requestId === requestId))
        for (const item of arr(end.items).filter(value => value.id === id))
          if (typeof item.status === 'string') statusValues.push(item.status);
    }
    const statuses = [...new Set(statusValues)];
    const samples = arr(input.visibleEvents).filter(event => event.dmid === record.dmid && event.presentAtStart !== true &&
      finite(event.monotonicMs) && event.monotonicMs >= nativeAtMs && event.monotonicMs <= input.ended.monotonicMs);
    const exactTranslation = typeof prepared?.text === 'string' && prepared.text !== source.originalText ? prepared.text : null;
    const translatedVisible = exactTranslation !== null && samples.some(event => event.text === exactTranslation);
    const originalVisible = samples.some(event => event.text === source.originalText);
    const requestOutcome = !matchingRequests.length
      ? record.cacheHit === true || record.inflightHit === true ? 'reused-without-watch-request' : 'not-requested'
      : statuses.includes('cancelled') ? 'cancelled'
        : statuses.includes('failed') ? 'failed'
          : statuses.includes('translated') ? 'translated'
            : statuses.includes('cached') ? 'cached'
              : ends.some(event => matchingRequests.some(item => item.requestId === event.requestId))
                ? 'ended-without-item-result' : 'unresolved-at-export';
    rows.push({ id, dmid: record.dmid, originalText: source.originalText, plannedVideoTimeMs: planned,
      nativeAtMs, nativeVideoTimeMs: native.videoTimeMs ?? null, nativePlaybackRate: native.playbackRate ?? null,
      nativeInitCount: record.initRenderCalls ?? null, requested: matchingRequests.length > 0,
      requestCount: matchingRequests.length, requestAtMs: requestTimes.length ? Math.min(...requestTimes) : null,
      requestOutcome, requestStatuses: statuses,
      preparedAtMs, preparedText: prepared?.text ?? null, preparation,
      preparationLeadMs: preparedAtMs === null ? null : nativeAtMs - preparedAtMs,
      preparedMatchCount: preparedMatches.length, adapterSelection: adapterEvidence(record),
      cacheHit: typeof record.cacheHit === 'boolean' ? record.cacheHit : null,
      inflightHit: typeof record.inflightHit === 'boolean' ? record.inflightHit : null,
      wouldCreateNewTask: typeof record.wouldCreateNewTask === 'boolean' ? record.wouldCreateNewTask : null,
      shadowAdmission: admissionEvidence(record), translatedVisible, originalVisible,
      visibilityUnknown: !translatedVisible && !originalVisible,
      timelyAndTranslatedVisible: preparation === 'timely' && translatedVisible,
      visibleSamples: samples.map(event => ({ text: event.text ?? null, atMs: event.monotonicMs,
        videoTimeMs: event.videoTimeMs ?? null, geometry: event.geometry ?? null })) });
  }
  return { rows, unknown, genericRuleRejected };
}

function summarize(rows) {
  const leads = rows.map(row => row.preparationLeadMs).filter(finite);
  const selected = rows.filter(row => row.adapterSelection.selectedTranslation !== null);
  const conflicts = rows.filter(row => row.shadowAdmission.ruleConflict && row.nativeInitCount !== null);
  return {
    eligibleNaturalInitRenderEvents: rows.length,
    requested: rows.filter(row => row.requested).length,
    neverRequested: rows.filter(row => !row.requested).length,
    requestOutcomes: countBy(rows.map(row => row.requestOutcome)),
    requestStatuses: countBy(rows.flatMap(row => row.requestStatuses)),
    timelyPrepared: rows.filter(row => row.preparation === 'timely').length,
    latePrepared: rows.filter(row => row.preparation === 'late').length,
    missingPrepared: rows.filter(row => row.preparation === 'missing').length,
    preparedTimeUnknown: rows.filter(row => row.preparation === 'time-unknown').length,
    preparationLeadTimeMs: leads, preparationLeadTimeSummary: numericSummary(leads),
    adapterSelection: { explicitSelectionKnown: selected.length,
      explicitTranslatedSelection: selected.filter(row => row.adapterSelection.selectedTranslation === true).length,
      explicitNonTranslatedSelection: selected.filter(row => row.adapterSelection.selectedTranslation === false).length,
      unknown: rows.length - selected.length },
    cacheHits: rows.filter(row => row.cacheHit === true).length,
    sharedTaskHits: rows.filter(row => row.inflightHit === true).length,
    newTaskEvidence: rows.filter(row => row.wouldCreateNewTask === true).length,
    exactTranslatedVisible: rows.filter(row => row.translatedVisible).length,
    originalVisible: rows.filter(row => row.originalVisible).length,
    visibilityUnknown: rows.filter(row => row.visibilityUnknown).length,
    timelyAndTranslatedVisible: rows.filter(row => row.timelyAndTranslatedVisible).length,
    shadowAdmission: { bound: rows.filter(row => row.shadowAdmission.bound).length,
      excludeNaturalConflicts: conflicts.length,
      unknown: rows.filter(row => !row.shadowAdmission.bound || row.shadowAdmission.validAtAdmission === null ||
        row.shadowAdmission.decision === 'unknown').length,
      conflictIds: conflicts.map(row => row.id) },
  };
}

function classifyBoundary(input) {
  const nativeEndReason = input.ended?.reason ?? null;
  const normalIntervalEnd = nativeEndReason === 'interval-complete';
  const watchStopReason = arr(input.localExperiment?.watchEvents).filter(event => event.event === 'stop').at(-1)?.reason ?? null;
  const localReportStopReason = input.localExperiment?.report?.stopReason ?? null;
  const ruleConflict = nativeEndReason === 'rule-conflict' || watchStopReason === 'rule-conflict' || localReportStopReason === 'rule-conflict';
  const dispatchPolicyViolation = nativeEndReason === 'dispatch-assertion-failed' ||
    localReportStopReason === 'dispatch-policy-violation' || !!input.localExperiment?.dispatch?.violationReason;
  const interruptions = new Set(['paused', 'seek', 'configuration-changed', 'manual-stop', 'player-error']);
  const classification = normalIntervalEnd ? 'normal-interval-end' : ruleConflict ? 'rule-conflict'
    : dispatchPolicyViolation ? 'dispatch-policy-violation'
      : interruptions.has(nativeEndReason) ? 'mid-run-interruption' : 'unknown-end-condition';
  const attempts = arr(input.localExperiment?.report?.providerAttempts);
  const cancellations = attempts.filter(attempt => attempt.reason === 'cancelled').length;
  return { nativeEndReason, normalIntervalEnd, classification, ruleConflict, dispatchPolicyViolation,
    watchStopReason, localReportStopReason, cancellationAttempts: cancellations,
    cancellationInterpretation: cancellations && normalIntervalEnd
      ? 'cancellations are recorded alongside a normal interval endpoint; request-level cause is not linked to document-clock endpoint'
      : cancellations ? 'cancellations are present; timing/cause is not inferred across clocks' : 'none recorded' };
}

function runnerEnvironment(raw) {
  const runner = raw?.runnerEvidence;
  const environment = runner?.environment ?? runner;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment))
    return { status: 'unknown', signature: null, changedEvents: [], reason: 'runner environment evidence is missing' };
  const changes = arr(environment.changes ?? runner.environmentChanges);
  const changedEvents = changes.filter(change => change?.changed !== false).map(change => ({
    kind: change?.kind ?? change?.type ?? change?.event ?? 'environment-change',
    reason: change?.reason ?? null,
    at: change?.at ?? change?.atMs ?? null,
  }));
  const declaredChanged = environment.status === 'changed' || environment.stable === false || runner.environmentStable === false;
  const declaredStable = environment.status === 'stable' || environment.stable === true || runner.environmentStable === true;
  const status = declaredChanged || changedEvents.length ? 'changed' : declaredStable ? 'stable' : 'unknown';
  const signature = environment.signature ?? environment.environmentSignature ?? runner.environmentSignature ?? null;
  return { status, signature, changedEvents,
    reason: status === 'changed' ? 'runner observed an environment change'
      : status === 'stable' ? signature === null ? 'stable interval lacks a cross-run environment signature' : null
        : 'runner evidence does not establish interval stability' };
}

function projectedConfiguration(configuration = {}) {
  // Each capture has its own run ID; it identifies the sample, not a test condition.
  const intentionalDifferences = new Set(['singleDispatch', 'dispatchComparison', 'batchSize', 'videoBatchSize',
    'rawBatchSize', 'effectiveBatchLimit', 'runId']);
  return Object.fromEntries(Object.entries(configuration).filter(([key]) => !intentionalDifferences.has(key)));
}

function poolEvidence(input, configuration) {
  const pool = arr(input.cacheRows).map(row => [row.id, row.originalText, row.mediaTimeMs, eligible(row)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const fromMs = configuration.fromMs, toMs = configuration.toMs;
  const inInterval = finite(fromMs) && finite(toMs) ? pool.filter(row => finite(row[2]) && row[2] >= fromMs && row[2] <= toMs) : null;
  return { poolSources: pool.length, poolHash: digest(pool),
    intervalPoolSources: inInterval?.length ?? null, intervalPoolHash: inInterval ? digest(inInterval) : null };
}

function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('raw must be an object');
  const start = input.playingStart?.monotonicMs, end = input.ended?.monotonicMs;
  if (!finite(start) || !finite(end) || start >= end) throw new TypeError('raw must include a valid monotonic playback interval');
  if (!Array.isArray(input.records) || !Array.isArray(input.cacheRows) || !Array.isArray(input.visibleEvents) ||
      !Array.isArray(input.localExperiment?.watchEvents)) throw new TypeError('raw is missing records, cacheRows, visibleEvents, or watchEvents');
  return { start, end };
}

/** Pure per-run analysis. runnerEvidence.environment uses status, signature and optional changes. */
export function analyzeRun(raw, { rawSha256 } = {}) {
  const { start, end } = validInput(raw);
  const experiment = raw.localExperiment;
  const configuration = experiment.configuration ?? {};
  const resourceId = experiment.report?.resourceId ?? raw.identity?.resourceId;
  const cid = raw.identity?.cid;
  const nativeInPlayback = raw.records.filter(record => record.cid === cid &&
    finite(record.initRenderFirst?.monotonicMs) && record.initRenderFirst.monotonicMs >= start &&
    record.initRenderFirst.monotonicMs <= end);
  const naturalOnEntry = nativeInPlayback.filter(record => record.initRenderFirst.onAtEntry === true);
  const naturalInPlannedRange = naturalOnEntry.filter(record => finite(record.plannedVideoTimeMs) &&
    finite(configuration.fromMs) && finite(configuration.toMs) &&
    record.plannedVideoTimeMs >= configuration.fromMs && record.plannedVideoTimeMs <= configuration.toMs);
  const outcomes = outcomeRows(raw, naturalOnEntry);
  const rows = outcomes.rows, summary = summarize(rows);
  const watchComplete = experiment.watchEventsTruncated !== true && raw.truncated !== true;
  const dispatchObserved = watchDispatch(experiment.watchEvents, watchComplete);
  const expectedSingle = typeof configuration.singleDispatch === 'boolean' ? configuration.singleDispatch : null;
  const policy = dispatchPolicy(raw, dispatchObserved, expectedSingle);
  const boundary = classifyBoundary(raw);
  const env = runnerEnvironment(raw);
  const conflicts = summary.shadowAdmission.excludeNaturalConflicts > 0 || boundary.ruleConflict;
  const packetInvalid = expectedSingle === true && (policy.anyMultiItemPacket || !!policy.violationReason);
  const packetPolicy = expectedSingle === null ? 'unknown-dispatch-condition'
    : packetInvalid ? policy.violationReason ? 'invalid-dispatch-policy-violation' : 'invalid-multi-item-watch-packet'
      : expectedSingle && policy.snapshotMismatch ? 'inconsistent-dispatch-evidence'
        : expectedSingle && policy.allPacketEvidenceComplete ? 'single-item-proof-complete'
          : expectedSingle ? 'single-item-proof-incomplete' : 'not-applicable';
  const accounted = rows.length + outcomes.unknown.length + outcomes.genericRuleRejected.length;
  const accountedIds = new Set([...rows, ...outcomes.unknown, ...outcomes.genericRuleRejected].map(row => row.id));
  const pools = poolEvidence(raw, configuration);
  const rawDigest = rawSha256 ?? raw.rawSha256 ?? raw.sourceSha256 ?? null;
  if (rawDigest !== null && (typeof rawDigest !== 'string' || !/^[a-f\d]{64}$/i.test(rawDigest)))
    throw new TypeError('rawSha256 must be a 64-character SHA-256 digest');
  const group = expectedSingle === true ? 'B' : expectedSingle === false ? 'A' : 'unknown';
  return {
    runId: experiment.report?.runId ?? raw.runnerEvidence?.runId ?? raw.runId ?? null,
    group, rawSha256: rawDigest?.toLowerCase() ?? null,
    configuration: { dispatchComparison: configuration.dispatchComparison ?? null,
      singleDispatch: expectedSingle, filterEnabled: configuration.filterEnabled ?? null,
      fromMs: configuration.fromMs ?? null, toMs: configuration.toMs ?? null,
      prefetchSeconds: configuration.prefetchSeconds ?? null,
      playbackRate: configuration.playbackRate ?? raw.playingStart.playbackRate ?? null,
      engineConcurrency: configuration.engineConcurrency ?? null,
      budget: configuration.budget ?? null },
    summary, rows,
    unknownNaturalEvents: outcomes.unknown,
    genericRuleRejectedEvents: outcomes.genericRuleRejected,
    denominatorAccounting: { naturalInitRenderInPlaybackInterval: nativeInPlayback.length,
      onAtEntryTrue: naturalOnEntry.length,
      onAtEntryWithinPlannedSourceRange: naturalInPlannedRange.length,
      eligibleNaturalInitRenderDenominator: rows.length,
      unknownSourceMapping: outcomes.unknown.length,
      excludedByExistingGenericEligibility: outcomes.genericRuleRejected.length,
      outsidePlannedSourceRange: naturalOnEntry.length - naturalInPlannedRange.length,
      unaccountedNaturalInPlayback: nativeInPlayback.length - accounted,
      unaccountedWithinPlannedRange: naturalInPlannedRange.filter(record =>
        !accountedIds.has(sourceId(resourceId, record.dmid))).length,
      source: 'natural on-entry initRender events in the captured monotonic interval; existing three-field translation eligibility only. Planned source time does not exclude an actual event.' },
    dispatch: { requestStarts: dispatchObserved.requestStarts, rawItemEntries: dispatchObserved.rawItemEntries,
      itemsPerRequest: dispatchObserved.rawItemsPerRequest, packetSizeCounts: dispatchObserved.packetSizeCounts,
      maxItemsPerRequest: dispatchObserved.maxItemsPerRequest, uniqueRequestedIds: dispatchObserved.uniqueRequestedIds,
      everyObservedRequestHasOneItem: dispatchObserved.everyObservedRequestHasOneItem,
      duplicateRequestIds: dispatchObserved.duplicateRequestIds, duplicateItemIds: dispatchObserved.duplicateItemIds,
      duplicateWithinRequestIds: dispatchObserved.duplicateWithinRequestIds,
      allPacketPolicyEvidence: policy, singleItemProof: policy.singleItemProof,
      singleItemViolations: expectedSingle ? [
        ...dispatchObserved.startsWithNonSingleCardinality,
        ...(policy.violationReason ? [{ source: 'dispatch-snapshot', reason: policy.violationReason }] : []),
        ...(policy.snapshotMismatch ? [{ source: 'dispatch-snapshot', reason: 'inconsistent-with-request-start-events' }] : []),
      ] : [] },
    watchActivity: { pairedRequestCount: dispatchObserved.pairedRequestCount,
      pairedActiveSlotPeak: dispatchObserved.pairedActiveSlotPeak, pairedIntervals: dispatchObserved.pairedIntervals,
      unresolvedAtEnd: dispatchObserved.unresolvedAtEnd, unresolvedRequests: dispatchObserved.unresolvedRequests,
      ambiguousPairings: dispatchObserved.ambiguousPairings, invalidPairs: dispatchObserved.invalidPairs,
      orphanRequestEnds: dispatchObserved.orphanRequestEnds },
    providerActivity: providerActivity(experiment.report?.providerAttempts),
    boundary,
    runnerEnvironment: env,
    validity: { packetPolicy, midRunInterruption: boundary.classification === 'mid-run-interruption',
      shadowRuleConflict: conflicts,
      shouldStopFurtherExperiment: packetInvalid || conflicts || boundary.classification === 'mid-run-interruption' },
    ...pools,
    poolSources: pools.poolSources,
    modelFingerprint: raw.runnerEvidence?.modelFingerprint ?? raw.modelFingerprint ?? null,
    buildId: raw.runnerEvidence?.buildId ?? raw.buildId ?? null,
    contract: raw.shadowContract?.sha256 ?? null,
    currentSettings: raw.currentSettings ?? null,
    safety: experiment.report?.safety ?? null,
    integrity: { rootTruncated: raw.truncated === true, watchTruncated: experiment.watchEventsTruncated === true,
      observationErrors: raw.observationErrors ?? null, diagnosticError: raw.diagnosticError ?? null,
      restoration: raw.restoration ?? null, nativeEndReason: raw.ended.reason ?? null },
    visibilitySampling: { visibleEvents: arr(raw.visibleEvents).length,
      sampledFirstVisibilityIsUpperBound: true,
      note: 'Absence from sampled visibility is unknown; brief visibility may be missed.' },
  };
}

function comparableEvent(a, b) {
  return typeof a?.id === 'string' && a.id.trim().length > 0 && a.id === b?.id &&
    typeof a.originalText === 'string' && a.originalText.trim().length > 0 && a.originalText === b.originalText &&
    finite(a.plannedVideoTimeMs) && finite(b.plannedVideoTimeMs) && a.plannedVideoTimeMs === b.plannedVideoTimeMs &&
    finite(a.nativePlaybackRate) && finite(b.nativePlaybackRate) && a.nativePlaybackRate === b.nativePlaybackRate;
}

function groupRows(rows, ids) {
  const selected = rows.filter(row => ids.has(row.id));
  return { count: selected.length, summary: summarize(selected), rows: selected };
}

function startTime(raw) {
  const value = raw.runnerEvidence?.startedAt ?? raw.runnerEvidence?.startedAtMs ?? raw.startedAt ?? null;
  if (finite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

/** aRaw is the existing A condition and bRaw is the single-dispatch B condition. */
export function compare(aRaw, bRaw) {
  const a = analyzeRun(aRaw), b = analyzeRun(bRaw);
  const bById = new Map(b.rows.map(row => [row.id, row]));
  const common = a.rows.filter(row => comparableEvent(row, bById.get(row.id) ?? {}))
    .map(row => ({ id: row.id, originalText: row.originalText, existing: row, single: bById.get(row.id) }));
  const commonIds = new Set(common.map(row => row.id));
  const aPolicy = a.dispatch.allPacketPolicyEvidence, bPolicy = b.dispatch.allPacketPolicyEvidence;
  const aAnyMulti = aPolicy.anyMultiItemPacket;
  const bObservedSingle = bPolicy.allPacketsOneItem === true;
  const bInvalid = ['invalid-multi-item-watch-packet', 'invalid-dispatch-policy-violation',
    'inconsistent-dispatch-evidence'].includes(b.validity.packetPolicy);
  const observedDifference = aAnyMulti && bObservedSingle && bPolicy.allPacketEvidenceComplete;
  const strategyFinding = bInvalid ? 'B-single-dispatch-invalid'
    : aPolicy.allPacketsOneItem === true && aPolicy.allPacketEvidenceComplete
      ? 'no-observed-strategy-difference-A-was-already-single-item'
      : observedDifference ? 'watch-packet-strategy-difference-observed' : 'strategy-difference-not-proven';
  const aEnvironment = a.runnerEnvironment, bEnvironment = b.runnerEnvironment;
  const environmentSignatureEqual = aEnvironment.signature === null || bEnvironment.signature === null
    ? null : equalKnown(aEnvironment.signature, bEnvironment.signature);
  const environmentComparable = aEnvironment.status === 'changed' || bEnvironment.status === 'changed'
    ? false : aEnvironment.status === 'stable' && bEnvironment.status === 'stable' && environmentSignatureEqual === true
      ? true : null;
  const settingEquality = equalKnown(a.currentSettings, b.currentSettings);
  const configurationEquality = equalKnown(projectedConfiguration(aRaw.localExperiment?.configuration),
    projectedConfiguration(bRaw.localExperiment?.configuration));
  const budgetEquality = equalKnown(a.configuration.budget, b.configuration.budget);
  const contractEquality = equalKnown(a.contract, b.contract);
  const buildEquality = equalKnown(a.buildId, b.buildId);
  const modelEquality = equalKnown(a.modelFingerprint, b.modelFingerprint);
  const rangeEquality = [a.configuration.fromMs, a.configuration.toMs, b.configuration.fromMs, b.configuration.toMs]
    .some(value => value === null || value === undefined) ? null
    : equalKnown([a.configuration.fromMs, a.configuration.toMs], [b.configuration.fromMs, b.configuration.toMs]);
  const rateEquality = equalKnown(a.configuration.playbackRate, b.configuration.playbackRate);
  const dispatchComparisonEnabled = a.configuration.dispatchComparison === true && b.configuration.dispatchComparison === true;
  const filteringEnabled = a.configuration.filterEnabled === true && b.configuration.filterEnabled === true;
  const aStartedAt = startTime(aRaw), bStartedAt = startTime(bRaw);
  const executionOrderBThenA = aStartedAt !== null && bStartedAt !== null && bStartedAt < aStartedAt;
  const resourceIdEquality = equalExplicitIdentity(aRaw.identity?.resourceId, bRaw.identity?.resourceId);
  const cidEquality = equalExplicitIdentity(aRaw.identity?.cid, bRaw.identity?.cid);
  const sameVideoIdentity = resourceIdEquality === false || cidEquality === false ? false
    : resourceIdEquality === true && cidEquality === true ? true : null;
  const aPacketEvidenceComplete = aPolicy.snapshotComplete === true ||
    (a.integrity.rootTruncated !== true && a.integrity.watchTruncated !== true && a.dispatch.requestStarts > 0);
  const aPacketEvidenceConflictFree = !aPolicy.violationReason && aPolicy.snapshotMismatch !== true &&
    !a.boundary.dispatchPolicyViolation;
  const exactCommonEventPresent = common.length > 0;
  const coreChecks = [settingEquality, configurationEquality, budgetEquality, contractEquality,
    buildEquality, modelEquality, rangeEquality, rateEquality, environmentComparable,
    dispatchComparisonEnabled, filteringEnabled, resourceIdEquality, cidEquality, executionOrderBThenA,
    aPacketEvidenceComplete, aPacketEvidenceConflictFree, exactCommonEventPresent];
  const strategyValid = a.group === 'A' && b.group === 'B' && !bInvalid && observedDifference &&
    coreChecks.every(value => value === true) && a.boundary.normalIntervalEnd && b.boundary.normalIntervalEnd &&
    !a.validity.midRunInterruption && !b.validity.midRunInterruption &&
    !a.validity.shadowRuleConflict && !b.validity.shadowRuleConflict;
  const onlyAIds = new Set(a.rows.filter(row => !commonIds.has(row.id)).map(row => row.id));
  const onlyBIds = new Set(b.rows.filter(row => !commonIds.has(row.id)).map(row => row.id));
  const executionOrder = aStartedAt === null || bStartedAt === null || aStartedAt === bStartedAt ? null
    : aStartedAt < bStartedAt ? ['A', 'B'] : ['B', 'A'];
  const commonA = common.map(row => row.existing), commonB = common.map(row => row.single);
  return {
    evidence: 'in-memory comparison of existing A and single-dispatch B raw runs',
    argumentMeaning: { a: 'existing dispatch condition A', b: 'single-item dispatch condition B',
      executionOrderComesFromRunnerEvidence: true, observedExecutionOrder: executionOrder },
    strategy: { finding: strategyFinding, validForPolicyEvaluation: strategyValid,
      existingObservedPacketSizes: aPolicy.snapshotRawPacketSizes ?? a.dispatch.packetSizeCounts,
      singleObservedPacketSizes: bPolicy.snapshotRawPacketSizes ?? b.dispatch.packetSizeCounts,
      existingHadAnyMultiItemRequest: aAnyMulti, singleEveryObservedRequestWasOneItem: bObservedSingle,
      singleItemProof: bPolicy.singleItemProof,
      explanation: bInvalid ? 'B packet or dispatch evidence is invalid or inconsistent; do not evaluate policy benefit.'
        : !observedDifference ? 'The observed packet logs do not establish a dispatch-size contrast.'
          : !strategyValid ? 'A packet difference is observed, but one or more run-comparability checks are false or unknown.' : null },
    primary: { existingAll: a.summary, singleAll: b.summary,
      commonSources: common.length,
      existingCommon: summarize(commonA), singleCommon: summarize(commonB),
      common: common.map(row => ({ ...row, leadDeltaSingleMinusExistingMs:
        row.single.preparationLeadMs === null || row.existing.preparationLeadMs === null ? null
          : row.single.preparationLeadMs - row.existing.preparationLeadMs })),
      newlyTimely: common.filter(row => row.existing.preparation !== 'timely' && row.single.preparation === 'timely').map(row => row.id),
      lostTimely: common.filter(row => row.existing.preparation === 'timely' && row.single.preparation !== 'timely').map(row => row.id),
      newlyTranslatedVisible: common.filter(row => !row.existing.translatedVisible && row.single.translatedVisible).map(row => row.id),
      lostTranslatedVisible: common.filter(row => row.existing.translatedVisible && !row.single.translatedVisible).map(row => row.id),
      nonCommon: { onlyExisting: groupRows(a.rows, onlyAIds), onlySingle: groupRows(b.rows, onlyBIds) },
      unknownNaturalEvents: { existing: a.unknownNaturalEvents, single: b.unknownNaturalEvents },
      genericRuleRejectedEvents: { existing: a.genericRuleRejectedEvents, single: b.genericRuleRejectedEvents } },
    comparability: { correctSemanticGroups: a.group === 'A' && b.group === 'B',
      savedSettingsEqual: settingEquality, configurationEqualExceptDispatch: configurationEquality,
      budgetsEqual: budgetEquality, contractEqual: contractEquality, buildEqual: buildEquality,
      modelFingerprintEqual: modelEquality, nativeRangeEqual: rangeEquality, playbackRateEqual: rateEquality,
      resourceIdEqual: resourceIdEquality, cidEqual: cidEquality, sameVideoIdentity,
      executionOrderBThenA, aPacketEvidenceComplete, aPacketEvidenceConflictFree, exactCommonEventPresent,
      dispatchComparisonEnabled, filteringEnabled,
      existingNormalEndpoint: a.boundary.normalIntervalEnd, singleNormalEndpoint: b.boundary.normalIntervalEnd,
      environment: { existing: aEnvironment, single: bEnvironment,
        signaturesEqual: environmentSignatureEqual, comparable: environmentComparable },
      poolEqual: equalKnown(a.poolHash, b.poolHash), intervalPoolEqual: equalKnown(a.intervalPoolHash, b.intervalPoolHash),
      poolCounts: { existing: a.poolSources, single: b.poolSources,
        existingInterval: a.intervalPoolSources, singleInterval: b.intervalPoolSources } },
    source: { existingSha256: a.rawSha256, singleSha256: b.rawSha256 },
    runs: { existing: a, single: b },
    limits: ['Each run uses eligible natural initRender events as its primary denominator; unknown source mappings and generic-rule rejects remain separately listed.',
      'Preparation lead is natural initRender monotonicMs minus the first matching prepared monotonicMs; missing and unknown times are not filled with zero.',
      'Adapter selection is counted only when direct initRender-bound evidence is present; sampled visibility does not substitute for selection.',
      'Visibility uses exact dmid and text samples; absent sampled text remains unknown because brief visibility can be missed.',
      'Common events require exact source ID, original text, planned source time, and native playback rate. Full non-common rows remain available.',
      'Raw request-start item counts are reported as observed; request completion and provider activity use separate clocks.'],
  };
}
