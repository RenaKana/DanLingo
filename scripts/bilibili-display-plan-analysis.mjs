/** Independent analysis of an opt-in DisplayPlanSession.report(true) export. */
import { isDeepStrictEqual } from 'node:util';

export const DISPLAY_PLAN_ANALYSIS_LIMITS = Object.freeze({ inputFrames: 1000, providerInputs: 20_000 });

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = (a, b) => a.mediaTimeMs - b.mediaTimeMs || ordinal(a.sourceId, b.sourceId) || ordinal(a.id, b.id);
const keyOf = (resourceId, epoch, id) => JSON.stringify([resourceId, epoch, id]);
const tally = (rows, key) => rows.reduce((counts, row) => {
  const value = String(row[key]); counts[value] = (counts[value] ?? 0) + 1; return counts;
}, {});
const issue = (set, code) => { set.add(code); };

function validConfiguration(config) {
  const fields = ['backend', 'sourceLanguage', 'targetLanguage', 'batchSize', 'videoBatchSize',
    'concurrency', 'localConcurrency', 'translationScope', 'prefetchSeconds', 'provider',
    'delayMs', 'cache'];
  if (!record(config) || !isDeepStrictEqual(Object.keys(config).sort(), fields.sort())) return false;
  const cache = config.cache;
  return ['backend', 'sourceLanguage', 'targetLanguage'].every(key =>
    typeof config[key] === 'string' && config[key].length > 0) &&
    ['batchSize', 'videoBatchSize', 'concurrency', 'localConcurrency'].every(key =>
      integer(config[key]) && config[key] > 0) &&
    config.translationScope === 'window' && config.prefetchSeconds === 10 &&
    config.provider === 'isolated-memory' && nonnegative(config.delayMs) &&
    record(cache) && isDeepStrictEqual(Object.keys(cache).sort(), ['scope', 'maxEntries', 'maxBytes'].sort()) &&
    cache.scope === 'independent-session-memory' && cache.maxEntries === 4000 && cache.maxBytes === 2 * 1024 * 1024;
}

function validCandidate(row) {
  return record(row) && typeof row.id === 'string' && !!row.id && typeof row.sourceId === 'string' && !!row.sourceId &&
    typeof row.resourceId === 'string' && typeof row.originalText === 'string' && nonnegative(row.mediaTimeMs) &&
    typeof row.inScope === 'boolean' && typeof row.needsTranslation === 'boolean' &&
    ['exclude', 'retain', 'unknown'].includes(row.state) &&
    (row.nativeFiltered === undefined || typeof row.nativeFiltered === 'boolean');
}

function validFrame(frame) {
  return record(frame) && typeof frame.resourceId === 'string' && !!frame.resourceId && integer(frame.epoch) &&
    nonnegative(frame.mediaTimeMs) && nonnegative(frame.wallTimeMs) && nonnegative(frame.durationMs) &&
    integer(frame.sourceRevision) && integer(frame.ruleRevision) && typeof frame.complete === 'boolean' &&
    typeof frame.contextValid === 'boolean' && typeof frame.contentActive === 'boolean' &&
    typeof frame.paused === 'boolean' && typeof frame.seeking === 'boolean' &&
    [true, false, null].includes(frame.commentsVisible) && typeof frame.reset === 'boolean' &&
    Array.isArray(frame.upserts) && Array.isArray(frame.removes);
}

function applyDelta(candidates, frame, violations) {
  if (frame.reset) candidates.clear();
  for (const id of frame.removes) {
    if (typeof id !== 'string') { issue(violations, 'input-remove-invalid'); continue; }
    candidates.delete(id);
  }
  const seen = new Set();
  for (const row of frame.upserts) {
    if (!validCandidate(row) || seen.has(row.id)) { issue(violations, 'input-upsert-invalid'); continue; }
    seen.add(row.id); candidates.set(row.id, row);
  }
  if (integer(frame.observedCandidates) && frame.observedCandidates !== candidates.size)
    issue(violations, 'input-delta-size-mismatch');
}

function admissible(frame) {
  return frame.complete && frame.contextValid && frame.contentActive && frame.commentsVisible !== false &&
    !frame.seeking && frame.mediaTimeMs < frame.durationMs;
}

function selectedInBucket(candidates, frame, bucket, parameters, used) {
  const { bucketMs, lookaheadMs } = parameters;
  const possible = new Map(), conflicts = new Set();
  for (const row of candidates.values()) {
    if (row.resourceId !== frame.resourceId || !row.inScope || row.nativeFiltered === true ||
        row.state === 'exclude' || row.mediaTimeMs <= frame.mediaTimeMs ||
        row.mediaTimeMs >= frame.durationMs || row.mediaTimeMs > frame.mediaTimeMs + lookaheadMs ||
        Math.floor(row.mediaTimeMs / bucketMs) !== bucket || used.has(row.sourceId)) continue;
    if (possible.has(row.sourceId)) conflicts.add(row.sourceId);
    else possible.set(row.sourceId, row);
  }
  return [...possible.values()].filter(row => !conflicts.has(row.sourceId)).sort(order);
}

function replaySelections(frames, parameters, violations) {
  const expected = new Map(), candidates = new Map();
  let context = '', sealedThrough = -1, sourceRevision = -1, ruleRevision = -1;
  let used = new Set(), lastWall = -Infinity;
  for (const frame of frames) {
    if (!validFrame(frame)) { issue(violations, 'input-frame-invalid'); continue; }
    if (frame.wallTimeMs < lastWall) issue(violations, 'input-clock-reversed');
    lastWall = frame.wallTimeMs;
    const nextContext = JSON.stringify([frame.resourceId, frame.epoch]);
    if (nextContext !== context) {
      if (!frame.reset) issue(violations, 'input-context-without-reset');
      context = nextContext; sealedThrough = -1; used = new Set(); sourceRevision = ruleRevision = -1;
    }
    applyDelta(candidates, frame, violations);
    if (!admissible(frame) || frame.sourceRevision < sourceRevision || frame.ruleRevision < ruleRevision) continue;
    sourceRevision = frame.sourceRevision; ruleRevision = frame.ruleRevision;
    const { bucketMs, freezeMs, limit } = parameters;
    const current = Math.floor(frame.mediaTimeMs / bucketMs);
    const through = Math.min(Math.floor((frame.mediaTimeMs + freezeMs) / bucketMs),
      Math.ceil(frame.durationMs / bucketMs) - 1);
    for (let bucket = Math.max(current, sealedThrough + 1); bucket <= through; bucket++) {
      const available = selectedInBucket(candidates, frame, bucket, parameters, used);
      for (const row of available.slice(0, limit === null ? undefined : limit)) {
        const key = keyOf(frame.resourceId, frame.epoch, row.id);
        expected.set(key, { ...row, bucket, startMs: bucket * bucketMs,
          selectedAtMs: frame.mediaTimeMs, selectedWallTimeMs: frame.wallTimeMs,
          sourceRevision: frame.sourceRevision, ruleRevision: frame.ruleRevision });
        used.add(row.sourceId);
      }
    }
    sealedThrough = Math.max(sealedThrough, through);
  }
  return expected;
}

function distribution(events, freezeMs) {
  const leads = events.map(row => row.leadMs).filter(nonnegative).sort((a, b) => a - b);
  const percentile = fraction => leads.length ? leads[Math.ceil(leads.length * fraction) - 1] : null;
  return { coldStart: events.filter(row => row.coldStart === true).length,
    shortLead: leads.filter(value => value < freezeMs).length,
    minMs: leads[0] ?? null, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: leads.at(-1) ?? null };
}

function validateEvents(name, branch, expected, violations) {
  const events = Array.isArray(branch.events) ? branch.events : [];
  if (!Array.isArray(branch.events)) issue(violations, 'events-missing');
  const byKey = new Map(), sources = new Set(), buckets = new Map();
  const { bucketMs, freezeMs, limit, dueGraceMs } = branch.parameters;
  for (const event of events) {
    if (!record(event) || typeof event.id !== 'string' || typeof event.sourceId !== 'string' ||
        typeof event.resourceId !== 'string' || !integer(event.epoch)) {
      issue(violations, 'event-shape-invalid'); continue;
    }
    const key = keyOf(event.resourceId, event.epoch, event.id);
    const sourceKey = keyOf(event.resourceId, event.epoch, event.sourceId);
    if (byKey.has(key)) issue(violations, 'event-duplicate');
    if (sources.has(sourceKey)) issue(violations, 'source-selected-twice');
    byKey.set(key, event); sources.add(sourceKey);
    const bucketKey = keyOf(event.resourceId, event.epoch, String(event.bucket));
    buckets.set(bucketKey, (buckets.get(bucketKey) ?? 0) + 1);
    const original = expected.get(key);
    if (!original) { issue(violations, 'selection-not-in-input-replay'); continue; }
    if (event.sourceId !== original.sourceId || event.originalText !== original.originalText ||
        event.mediaTimeMs !== original.mediaTimeMs || event.bucket !== original.bucket ||
        event.startMs !== original.startMs || event.selectedAtMs !== original.selectedAtMs ||
        event.selectedWallTimeMs !== original.selectedWallTimeMs ||
        event.needsTranslation !== original.needsTranslation ||
        event.leadMs !== original.mediaTimeMs - original.selectedAtMs ||
        !integer(event.planRevision) || !integer(event.sourceRevision) || !integer(event.ruleRevision) ||
        event.sourceRevision < original.sourceRevision || event.ruleRevision < original.ruleRevision) {
      issue(violations, 'selection-fields-mismatch');
    }
    if (event.ruleRevision === original.ruleRevision && event.unknown !== (original.state === 'unknown'))
      issue(violations, 'selection-unknown-mismatch');
    if (!['frozen', 'revoked', 'due', 'missed'].includes(event.state)) issue(violations, 'event-state-invalid');
    if (event.state === 'due' || event.state === 'missed') {
      if (!nonnegative(event.dueAtMs) || !nonnegative(event.dueMediaTimeMs) ||
          event.dueAtMs < event.selectedWallTimeMs || event.dueMediaTimeMs < event.mediaTimeMs)
        issue(violations, 'due-time-invalid');
      else if (event.state === 'due' && event.dueMediaTimeMs - event.mediaTimeMs > dueGraceMs ||
               event.state === 'missed' && event.dueMediaTimeMs - event.mediaTimeMs <= dueGraceMs)
        issue(violations, 'due-grace-mismatch');
    }
  }
  if (limit !== null && [...buckets.values()].some(value => value > limit)) issue(violations, 'bucket-density-exceeded');
  if ((branch.truncation?.events ?? 0) > 0) issue(violations, 'events-truncated');
  else if (events.length !== expected.size || [...expected.keys()].some(key => !byKey.has(key)))
    issue(violations, 'selection-replay-mismatch');
  return { events, byKey, bucketCount: buckets.size,
    counts: { selected: events.length, needTranslation: events.filter(row => row.needsTranslation === true).length,
      unknown: events.filter(row => row.unknown === true).length, states: tally(events, 'state'),
      lead: distribution(events, freezeMs) } };
}

function validateOutcomes(branch, events, byKey, violations) {
  const outcomes = Array.isArray(branch.outcomes) ? branch.outcomes : [];
  if (!Array.isArray(branch.outcomes)) issue(violations, 'outcomes-missing');
  const seen = new Set();
  for (const row of outcomes) {
    if (!record(row) || typeof row.key !== 'string' || !['due', 'missed', 'revoked'].includes(row.state) ||
        !nonnegative(row.checkedAtMs)) { issue(violations, 'outcome-invalid'); continue; }
    if (seen.has(row.key)) issue(violations, 'outcome-duplicate');
    seen.add(row.key);
    const event = byKey.get(row.key);
    if (!event && !(branch.truncation?.events > 0) || event &&
        (event.state !== row.state || row.checkedAtMs < event.selectedWallTimeMs))
      issue(violations, 'outcome-event-mismatch');
  }
  if (!(branch.truncation?.events > 0) && events.some(row => row.state !== 'frozen' &&
      !seen.has(keyOf(row.resourceId, row.epoch, row.id)))) issue(violations, 'terminal-outcome-missing');
  return { count: outcomes.length, byResult: tally(outcomes, 'result') };
}

function validateProvider(branch, frames, eventsByKey, outcomes, violations) {
  const log = Array.isArray(branch.providerInputLog) ? branch.providerInputLog : [];
  if (!Array.isArray(branch.providerInputLog)) issue(violations, 'provider-log-missing');
  if (!integer(branch.simulatedProviderInputs) || branch.simulatedProviderInputs !== log.length ||
      log.length > DISPLAY_PLAN_ANALYSIS_LIMITS.providerInputs) issue(violations, 'provider-log-count-mismatch');
  if (!integer(branch.orphanInputs) || branch.orphanInputs > 0) issue(violations, 'orphan-provider-attempt');
  const sorted = [...log].sort((a, b) => (a?.atMs ?? Infinity) - (b?.atMs ?? Infinity));
  const candidates = new Map(), terminal = new Map(outcomes.map(row => [row.key, row]));
  let committed = new Map(), frameIndex = 0, latest = null, invalid = 0;
  for (const input of sorted) {
    if (!record(input) || !nonnegative(input.atMs) || typeof input.resourceId !== 'string' ||
        !integer(input.epoch) || typeof input.originalText !== 'string' ||
        !Array.isArray(input.owners) || input.owners.length === 0) {
      invalid++; continue;
    }
    while (frameIndex < frames.length && validFrame(frames[frameIndex]) && frames[frameIndex].wallTimeMs <= input.atMs) {
      latest = frames[frameIndex++];
      applyDelta(candidates, latest, violations);
      if (latest.reset) committed = new Map();
      if (admissible(latest)) committed = new Map(candidates);
      else if (!latest.contextValid || !latest.contentActive || latest.commentsVisible === false || latest.seeking)
        committed = new Map();
    }
    if (!latest || latest.resourceId !== input.resourceId || latest.epoch !== input.epoch ||
        !latest.contextValid || !latest.contentActive || latest.commentsVisible === false || latest.seeking) {
      invalid++; continue;
    }
    let validOwner = true;
    for (const key of input.owners) {
      const event = typeof key === 'string' ? eventsByKey.get(key) : null;
      const candidate = event && committed.get(event.id);
      const ended = terminal.get(key);
      if (!event || !candidate || key !== keyOf(event.resourceId, event.epoch, event.id) ||
          event.resourceId !== input.resourceId || event.epoch !== input.epoch ||
          event.selectedWallTimeMs > input.atMs || ended && ended.checkedAtMs < input.atMs ||
          event.originalText !== input.originalText || !event.needsTranslation ||
          candidate.originalText !== input.originalText || candidate.sourceId !== event.sourceId ||
          candidate.mediaTimeMs !== event.mediaTimeMs || !candidate.inScope || !candidate.needsTranslation ||
          candidate.state === 'exclude' || candidate.nativeFiltered === true) validOwner = false;
    }
    if (!validOwner) invalid++;
  }
  if (invalid) issue(violations, 'provider-owner-invalid');
  return { inputs: log.length, invalidOwners: invalid, calls: branch.simulatedProviderCalls ?? null,
    subscriptions: branch.subscriptions ?? null };
}

function analyzeBranch(name, branch, frames) {
  const violations = new Set();
  if (!record(branch) || !record(branch.parameters)) return { ok: false, violations: ['branch-or-parameters-missing'] };
  if (!validConfiguration(branch.configuration)) issue(violations, 'configuration-invalid');
  const p = branch.parameters;
  if (!nonnegative(p.lookaheadMs) || !nonnegative(p.freezeMs) || !nonnegative(p.bucketMs) ||
      p.bucketMs === 0 || !nonnegative(p.dueGraceMs) ||
      (name === 'A' ? p.limit !== null : p.limit !== 2)) issue(violations, 'parameters-invalid');
  const expected = replaySelections(frames, p, violations);
  const selected = validateEvents(name, branch, expected, violations);
  const outcome = validateOutcomes(branch, selected.events, selected.byKey, violations);
  const provider = validateProvider(branch, frames, selected.byKey, branch.outcomes ?? [], violations);
  return { ok: violations.size === 0, violations: [...violations],
    parameters: { ...p }, selected: selected.counts, frozenBucketCount: selected.bucketCount,
    provider, outcomes: outcome,
    presentationTruncation: { buckets: branch.truncation?.buckets ?? 0,
      drafts: branch.truncation?.drafts ?? 0, knownAtFreeze: branch.truncation?.knownAtFreeze ?? 0 },
    eventHistoryTruncated: (branch.truncation?.events ?? 0) > 0 };
}

/** Checks the real delta stream and final ledgers without using DisplayPlanner as an oracle. */
export function analyzeBilibiliDisplayPlan(value) {
  const report = value?.simulation ?? value?.report?.simulation ?? value;
  const violations = new Set();
  if (!record(report)) return { ok: false, violations: ['report-missing'] };
  const frames = Array.isArray(report.inputFrames) ? report.inputFrames : [];
  if (!Array.isArray(report.inputFrames)) issue(violations, 'input-frames-missing');
  if (!integer(report.inputFrameCount) || report.inputFrameCount !== frames.length ||
      frames.length > DISPLAY_PLAN_ANALYSIS_LIMITS.inputFrames) issue(violations, 'input-frame-count-mismatch');
  if (report.inputTruncated === true) issue(violations, 'input-frames-truncated');
  for (const key of ['actualModelCalls', 'modelLoads', 'nativeSettingsWrites', 'adapterPrepared'])
    if (report[key] !== 0) issue(violations, `${key}-nonzero`);
  const A = analyzeBranch('A', report.A, frames), B = analyzeBranch('B', report.B, frames);
  for (const [name, branch] of [['A', A], ['B', B]])
    for (const code of branch.violations) issue(violations, `${name}:${code}`);
  if (A.parameters && B.parameters) {
    for (const key of ['lookaheadMs', 'freezeMs', 'bucketMs', 'dueGraceMs'])
      if (A.parameters[key] !== B.parameters[key]) issue(violations, 'comparison-parameters-differ');
  }
  if (record(report.A) && record(report.B) &&
      !isDeepStrictEqual(report.A.configuration, report.B.configuration))
    issue(violations, 'comparison-configuration-differ');
  if (A.selected && B.selected && B.selected.selected > A.selected.selected)
    issue(violations, 'B-selected-more-than-A');
  const differences = A.selected && B.selected ? {
    selected: A.selected.selected - B.selected.selected,
    needTranslation: A.selected.needTranslation - B.selected.needTranslation,
    simulatedProviderInputs: A.provider.inputs - B.provider.inputs,
    subscriptions: A.provider.subscriptions - B.provider.subscriptions,
  } : null;
  return { ok: violations.size === 0, violations: [...violations], inputFrameCount: frames.length,
    completeEvidence: !report.inputTruncated && !A.eventHistoryTruncated && !B.eventHistoryTruncated,
    branches: { A, B }, differences };
}
