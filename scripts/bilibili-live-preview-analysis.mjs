// Event-level offline analysis. Only page timestamps are compared with page timestamps.
import assert from 'node:assert/strict';

const keyOf = row => JSON.stringify([row.resourceId, row.epoch, row.id]);
const ratio = (part, whole) => whole ? part / whole : null;
const validTime = value => Number.isFinite(value) && value >= 0;
const SENT = new Set(['sent', 'completed', 'failed', 'cancelled']);

export function analyzeBilibiliLivePreview({ page, host, phase = 'main', fromMs = 45_000, toMs = 85_000 }) {
  assert.ok(page?.report?.plan?.B && page.report.render?.contract === 'render-preview-v1',
    'Live preview needs the B plan and renderer');
  assert.ok(host?.ok === true && host.grant && host.budget, 'Live-preview host evidence is missing');
  assert.ok(['main', 'repair', 'supplement'].includes(phase));
  assert.ok(validTime(fromMs) && validTime(toMs) && toMs > fromMs);
  if (phase === 'supplement') assert.ok(fromMs === 45_000 && toMs === 85_000,
    'The authorized supplement uses the complete original interval');
  const { plan, render } = page.report, grant = host.grant, B = plan.B;
  const mainFrom = phase === 'main' ? 50_000 : fromMs + 5_000;
  const violations = [];
  if (grant.phase !== phase || grant.fromMs !== fromMs || grant.toMs !== toMs ||
      grant.runId !== page.report.runId || grant.instanceId !== page.report.instanceId ||
      grant.session?.resourceId !== page.session?.resourceId || grant.epoch !== page.epoch ||
      host.budget.taskId !== grant.taskId || host.budget.phases?.[phase]?.runId !== grant.runId)
    violations.push('run-range-or-budget-identity-mismatch');
  if (Object.hasOwn(plan, 'A')) violations.push('A-branch-present');
  if (page.report.adapterPrepared !== 0 || page.report.nativePrepared !== 0 || host.nativePrepared !== 0 ||
      host.onlineCalls !== 0 || page.report.nativeSettingsWrites !== 0)
    violations.push('native-adapter-or-online-write');
  if (render.truncated?.records || render.truncated?.samples || render.ui?.domSampleTruncated ||
      B.truncated || plan.inputTruncated) violations.push('evidence-truncated');

  const events = B.events ?? [], records = new Map((render.records ?? []).map(row => [row.key, row]));
  const ready = new Map((B.previewReadyLog ?? []).map(row => [row.key, row]));
  const outcomes = new Map((B.outcomes ?? []).map(row => [row.key, row]));
  const domSamples = render.ui?.domSamples ?? [];
  if (ready.size !== (B.previewReadyLog ?? []).length) violations.push('duplicate-preview-ready');
  const newResults = new Map(), invalidResults = [];
  for (const result of host.results ?? []) {
    if (!result.resultId || newResults.has(result.resultId)) { violations.push('duplicate-or-unidentified-result'); continue; }
    if (result.validated === false) { invalidResults.push({ resultId: result.resultId, reason: result.reason ?? 'invalid-output' }); continue; }
    if (result.validated !== true || result.configIdentity !== grant.configIdentity ||
        result.resultId !== `${grant.runId}:${result.taskId}` ||
        !result.originalText || !result.text?.trim() || result.text === result.originalText)
      violations.push(`invalid-new-result:${result.resultId}`);
    else newResults.set(result.resultId, result);
  }
  const selected = events.filter(row => row.needsTranslation === true && row.mediaTimeMs >= fromMs &&
    row.mediaTimeMs < toMs);
  if (events.some(row => row.mediaTimeMs < fromMs || row.mediaTimeMs >= toMs))
    violations.push('plan-event-outside-run-range');
  const summaries = selected.map(event => {
    const key = keyOf(event), row = records.get(key), prepared = ready.get(key);
    const result = prepared && newResults.get(prepared.resultId);
    const validReady = !!result && prepared.resourceId === event.resourceId &&
      prepared.epoch === event.epoch && prepared.id === event.id &&
      prepared.sourceId === event.sourceId && prepared.mediaTimeMs === event.mediaTimeMs &&
      prepared.runId === grant.runId && prepared.instanceId === grant.instanceId &&
      prepared.configIdentity === grant.configIdentity && prepared.taskId === result.taskId &&
      prepared.originalText === event.originalText && result.originalText === event.originalText &&
      prepared.translatedText === result.text && ['translated', 'cached'].includes(prepared.status);
    if (prepared && !validReady) violations.push(`invalid-preview-ready:${key}`);
    const nominalReady = validReady && validTime(row?.previewReadyAtMediaMs) &&
      row.previewReadyAtMediaMs < event.mediaTimeMs;
    const lockReady = validReady && validTime(row?.textLockedAtWallMs) &&
      validTime(row?.previewReadyAtWallMs) && row.previewReadyAtWallMs <= row.textLockedAtWallMs;
    const adopted = validReady && row?.sourceMode === 'stored-translation' &&
      row.origin === 'live-local' && validTime(row.renderSubmittedAtWallMs) &&
      row.runId === grant.runId && row.configIdentity === grant.configIdentity &&
      row.resultId === result.resultId && row.chosenText === result.text;
    if (row?.origin === 'live-local' && !adopted) violations.push(`unverified-adoption:${key}`);
    const visible = adopted && domSamples.some(sample => sample.key === key &&
      sample.sourceMode === 'stored-translation' && sample.origin === 'live-local' &&
      sample.resultId === result.resultId && sample.runId === grant.runId &&
      sample.configIdentity === grant.configIdentity);
    return { key, id: event.id, sourceId: event.sourceId, epoch: event.epoch,
      mediaTimeMs: event.mediaTimeMs, state: event.state, unknown: event.unknown,
      ready: validReady, nominalReady, lockReady, adopted, visible,
      resultId: validReady ? result.resultId : null, taskId: validReady ? result.taskId : null,
      kind: validReady ? prepared.kind : null, textLocked: validTime(row?.textLockedAtWallMs),
      renderSubmitted: validTime(row?.renderSubmittedAtWallMs),
      layoutFallback: row?.translationLayoutFallback === true,
      renderState: row?.state ?? null,
      reason: row?.reason ?? (row?.state === 'environment-reset' ? 'environment-reset' : null) ??
        outcomes.get(key)?.result ?? event.reason ?? 'unobserved' };
  });
  const summarize = subset => {
    const rows = summaries.filter(row => subset.has(row.key));
    const count = field => rows.filter(row => row[field]).length;
    return { denominator: rows.length, nominalReady: count('nominalReady'), lockReady: count('lockReady'),
      adopted: count('adopted'), visible: count('visible'),
      nominalReadyRate: ratio(count('nominalReady'), rows.length),
      lockReadyRate: ratio(count('lockReady'), rows.length),
      adoptedRate: ratio(count('adopted'), rows.length), visibleRate: ratio(count('visible'), rows.length),
      unresolvedDisplay: rows.filter(row => !row.textLocked && row.state === 'frozen').length };
  };

  // The proof's media clock came from the page. Host performance.now is never subtracted from it.
  const attempts = host.budget.attempts ?? [];
  const sent = attempts.filter(row => SENT.has(row.status) && row.phase === phase && row.runId === grant.runId);
  const inputs = new Map((host.inputs ?? []).map(row => [row.attemptId, row]));
  let newRequestsAfterCutoff = 0;
  for (const attempt of sent) {
    const input = inputs.get(attempt.attemptId);
    if (!input || !Array.isArray(input.items) || input.items.length !== attempt.items) {
      violations.push(`sent-input-evidence-missing:${attempt.attemptId}`); continue;
    }
    for (const item of input.items) {
      if (!Array.isArray(item.owners) || !item.owners.length)
        violations.push(`sent-owner-evidence-missing:${attempt.attemptId}`);
      for (const owner of item.owners ?? []) {
        const proofTime = owner.proofMediaTimeMs;
        if (!validTime(proofTime) || proofTime < fromMs || proofTime >= toMs ||
            !(owner.mediaTimeMs > proofTime) || owner.mediaTimeMs >= toMs || owner.epoch !== grant.epoch ||
            owner.resourceId !== grant.session.resourceId || owner.originalText !== item.text)
          violations.push(`invalid-send-proof:${attempt.attemptId}`);
        if (validTime(proofTime) && proofTime >= toMs) newRequestsAfterCutoff++;
      }
    }
  }
  const adoptedIds = new Set(summaries.filter(row => row.adopted).map(row => row.resultId));
  const visibleIds = new Set(summaries.filter(row => row.visible).map(row => row.resultId));
  const resultOwners = new Map();
  for (const input of inputs.values()) for (const item of input.items ?? []) {
    const list = resultOwners.get(item.id) ?? [];
    list.push(...(item.owners ?? [])); resultOwners.set(item.id, list);
  }
  const unused = [...newResults.values()].filter(result => !adoptedIds.has(result.resultId)).map(result => ({
    resultId: result.resultId, taskId: result.taskId,
    linkedEvents: [...new Map((resultOwners.get(result.taskId) ?? []).map(owner => {
      const key = keyOf(owner), event = summaries.find(row => row.key === key);
      return [key, { key, reason: event?.layoutFallback ? 'translation-layout-fallback' :
        event?.renderState && !['unallocated', 'reserved', 'committed'].includes(event.renderState) &&
          event.reason !== 'unobserved' ? event.reason :
        event?.ready && event.textLocked ? 'not-selected-at-lock' :
          event?.ready ? 'display-opportunity-unresolved' :
            event ? event.reason : 'event-outside-exported-plan' }];
    })).values()],
  }));
  const uniqueNew = newResults.size, adoptedNew = [...newResults.keys()].filter(id => adoptedIds.has(id)).length;
  const visibleNew = [...newResults.keys()].filter(id => visibleIds.has(id)).length;
  const budget = host.budget.phases?.[phase];
  if (!budget?.actualSent || !budget?.occupied) violations.push('budget-evidence-missing');
  if (budget?.actualSent?.requests !== sent.length) violations.push('sent-budget-count-mismatch');
  if (newRequestsAfterCutoff > 0) violations.push('new-send-after-cutoff');
  const usage = host.budget.usage ?? null;
  const mainKeys = new Set(selected.filter(row => row.mediaTimeMs >= mainFrom).map(keyOf));
  const coldKeys = new Set(selected.filter(row => row.mediaTimeMs < mainFrom).map(keyOf));
  return { ok: violations.length === 0, violations, phase, range: { fromMs, mainFromMs: mainFrom, toMs },
    main: summarize(mainKeys), coldStart: summarize(coldKeys), tail: {
      cutoffObserved: !!page.tailCutoff, stoppedSupply: B.supplyStopped === true,
      newRequestsAfterCutoff },
    resultUtilization: { uniqueNew, adopted: adoptedNew, visible: visibleNew, invalidResults,
      adoptedRate: ratio(adoptedNew, uniqueNew), visibleRate: ratio(visibleNew, uniqueNew), unused },
    cost: { actualSent: budget?.actualSent ?? null, occupied: budget?.occupied ?? null,
      remaining: budget?.remaining ?? null, usage, usageKnown: usage?.complete === true },
    events: summaries, completeEvidence: violations.length === 0 && !!page.tailCutoff &&
      B.supplyStopped === true && summaries.every(row => row.textLocked || row.state !== 'frozen') };
}
