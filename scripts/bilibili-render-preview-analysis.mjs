/** Independent numeric inspection of RenderPreviewEngine.report(), without importing its allocator. */
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const nonnegative = x => finite(x) && x >= 0;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const close = (a, b, tolerance = 1e-5) => finite(a) && finite(b) && Math.abs(a - b) <= tolerance;
const issue = (errors, code) => errors.add(code);
const percentiles = values => {
  const sorted = values.filter(nonnegative).sort((a, b) => a - b);
  return { count: sorted.length, minMs: sorted[0] ?? null,
    medianMs: sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null,
    maxMs: sorted.at(-1) ?? null };
};

export function analyzeBilibiliRenderPreview(value) {
  const report = value?.preview ?? value?.report?.preview ?? value;
  const errors = new Set();
  if (!record(report) || report.contract !== 'render-preview-v1')
    return { ok: false, violations: ['report-contract-invalid'] };
  const layouts = Array.isArray(report.layouts) ? report.layouts : [];
  const rows = Array.isArray(report.records) ? report.records : [];
  const samples = Array.isArray(report.samples) ? report.samples : [];
  if (!Array.isArray(report.layouts) || !Array.isArray(report.records) || !Array.isArray(report.samples))
    issue(errors, 'evidence-array-missing');
  const limits = report.limits;
  if (!record(limits) || !integer(limits.maxRecords) || !integer(limits.maxSamples) ||
      rows.length > limits.maxRecords || samples.length > limits.maxSamples || layouts.length > 64)
    issue(errors, 'evidence-budget-invalid');
  if (report.truncated?.records) issue(errors, 'records-truncated');
  if (report.truncated?.samples) issue(errors, 'samples-truncated');
  if (report.ui?.domSampleTruncated) issue(errors, 'dom-samples-truncated');

  const byLayout = new Map();
  for (const layout of layouts) {
    if (!record(layout) || !integer(layout.revision) || byLayout.has(layout.revision) ||
        !finite(layout.widthPx) || layout.widthPx <= 0 || !finite(layout.heightPx) || layout.heightPx <= 0 ||
        !finite(layout.fontSizePx) || layout.fontSizePx <= 0 ||
        !finite(layout.lineHeightPx) || layout.lineHeightPx < layout.fontSizePx ||
        !nonnegative(layout.paddingXPx) || !nonnegative(layout.paddingYPx) ||
        !nonnegative(layout.gapPx) || !nonnegative(layout.safetyPx) ||
        !close(layout.laneHeightPx, layout.lineHeightPx + 2 * layout.paddingYPx) ||
        !close(layout.speedPxPerMs, layout.widthPx / 6000) ||
        layout.laneCount !== Math.floor(layout.heightPx / layout.laneHeightPx)) {
      issue(errors, 'layout-geometry-invalid'); continue;
    }
    byLayout.set(layout.revision, layout);
  }

  const byKey = new Map(), lanes = new Map(), states = {}, modes = {};
  let committed = 0, visibleDistinct = 0, unknown = 0, fallback = 0, readyRejected = 0, lateResults = 0;
  const lateness = [];
  for (const row of rows) {
    if (!record(row) || typeof row.key !== 'string' || typeof row.id !== 'string' ||
        typeof row.sourceId !== 'string' || !row.sourceId || typeof row.resourceId !== 'string' ||
        !integer(row.epoch) || !nonnegative(row.mediaTimeMs) ||
        !['unallocated', 'reserved', 'committed', 'exited', 'missed', 'oversize',
          'text-unsupported', 'layout-rejected', 'revoked', 'environment-reset',
          'layout-reset', 'hidden-skipped', 'closed'].includes(row.state)) {
      issue(errors, 'record-invalid'); continue;
    }
    if (byKey.has(row.key) || row.key !== JSON.stringify([row.resourceId, row.epoch, row.id]))
      issue(errors, 'record-identity-invalid');
    byKey.set(row.key, row);
    states[row.state] = (states[row.state] ?? 0) + 1;
    if (row.unknown) unknown++;
    if (row.visibleSamples > 0) visibleDistinct++;
    if (row.translationLayoutFallback) fallback++;
    if (row.translationReadyButRejected) readyRejected++;
    if (integer(row.lateResultCount)) lateResults += row.lateResultCount;
    else issue(errors, 'late-result-count-invalid');
    const hasCommit = row.chosenAtMediaMs !== null && row.chosenAtMediaMs !== undefined;
    if (!hasCommit) {
      if (row.state === 'committed' || row.state === 'exited' || row.sourceMode !== null)
        issue(errors, 'commit-state-invalid');
      if (row.state === 'reserved') {
        const layout = byLayout.get(row.layoutRevision);
        if (!layout || !integer(row.lane) || row.lane >= layout.laneCount ||
            !finite(row.widthPx) || row.widthPx <= 0 || !finite(row.heightPx) || row.heightPx <= 0 ||
            !close(row.occupiedWidthPx, row.widthPx + layout.safetyPx) ||
            row.heightPx > layout.laneHeightPx + 1e-5 ||
            row.lane * layout.laneHeightPx + row.heightPx > layout.heightPx + 1e-5)
          issue(errors, 'track-bounds-invalid');
        if (layout && integer(row.lane) && finite(row.occupiedWidthPx)) {
          const key = JSON.stringify([row.resourceId, row.epoch, row.layoutRevision, row.lane]);
          const lane = lanes.get(key) ?? []; lane.push(row); lanes.set(key, lane);
        }
      }
    } else {
      committed++;
      if (row.sourceMode !== 'original' && row.sourceMode !== 'stored-translation')
        issue(errors, 'text-mode-invalid');
      else modes[row.sourceMode] = (modes[row.sourceMode] ?? 0) + 1;
      const layout = byLayout.get(row.layoutRevision);
      if (!layout || !integer(row.lane) || row.lane >= layout.laneCount ||
          !finite(row.widthPx) || row.widthPx <= 0 || !finite(row.heightPx) || row.heightPx <= 0 ||
          !close(row.occupiedWidthPx, row.widthPx + layout.safetyPx) ||
          row.lane * layout.laneHeightPx + row.heightPx > layout.heightPx + 1e-5 ||
          row.heightPx > layout.laneHeightPx + 1e-5)
        issue(errors, 'track-bounds-invalid');
      if (!nonnegative(row.latenessMs) || row.latenessMs > 250 + 1e-5 ||
          !close(row.chosenAtMediaMs, row.mediaTimeMs + row.latenessMs) ||
          !close(row.endMs, row.mediaTimeMs + (layout?.widthPx + row.occupiedWidthPx) / layout?.speedPxPerMs) ||
          row.endMs - row.mediaTimeMs > 18000 + 1e-5)
        issue(errors, 'timing-invalid');
      if (nonnegative(row.latenessMs)) lateness.push(row.latenessMs);
      if (layout && integer(row.lane) && finite(row.occupiedWidthPx)) {
        const key = JSON.stringify([row.resourceId, row.epoch, row.layoutRevision, row.lane]);
        const lane = lanes.get(key) ?? []; lane.push(row); lanes.set(key, lane);
      }
    }
  }
  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.mediaTimeMs - b.mediaTimeMs || (a.sourceId < b.sourceId ? -1 : 1));
    for (let i = 1; i < lane.length; i++) {
      const b = lane[i];
      for (let j = 0; j < i; j++) {
        const a = lane[j], layout = byLayout.get(a.layoutRevision);
        if (a.endMs !== null && a.endMs <= b.mediaTimeMs ||
            a.terminalAtMediaMs !== null && a.terminalAtMediaMs <= b.mediaTimeMs) continue;
        if (layout.speedPxPerMs * (b.mediaTimeMs - a.mediaTimeMs) + 1e-5 <
            a.occupiedWidthPx + layout.gapPx) issue(errors, 'horizontal-overlap');
      }
    }
  }
  const sampleCount = new Map();
  for (const sample of samples) {
    const row = record(sample) ? byKey.get(sample.key) : null;
    const layout = row && byLayout.get(row.layoutRevision);
    if (!row || !layout || !nonnegative(sample.mediaTimeMs) || !nonnegative(sample.wallTimeMs) ||
        sample.layoutRevision !== row.layoutRevision || row.chosenAtMediaMs === null ||
        sample.mediaTimeMs < row.mediaTimeMs || sample.mediaTimeMs >= row.endMs ||
        !close(sample.xPx, layout.widthPx - layout.speedPxPerMs * (sample.mediaTimeMs - row.mediaTimeMs)) ||
        !close(sample.yPx, row.lane * layout.laneHeightPx) ||
        sample.xPx + row.widthPx <= 0 || sample.xPx >= layout.widthPx)
      issue(errors, 'visible-sample-geometry-invalid');
    else sampleCount.set(sample.key, (sampleCount.get(sample.key) ?? 0) + 1);
  }
  if (!report.truncated?.samples && rows.some(row => integer(row.visibleSamples) &&
    row.visibleSamples !== (sampleCount.get(row.key) ?? 0))) issue(errors, 'visible-sample-count-mismatch');
  const domSamples = report.ui?.domSamples;
  if (domSamples !== undefined && !Array.isArray(domSamples)) issue(errors, 'dom-samples-invalid');
  for (const sample of Array.isArray(domSamples) ? domSamples : []) {
    const row = record(sample) ? byKey.get(sample.key) : null;
    const layout = row && byLayout.get(row.layoutRevision);
    const x = layout && layout.widthPx - layout.speedPxPerMs * (sample.mediaTimeMs - row.mediaTimeMs);
    const y = layout && row.lane * layout.laneHeightPx;
    // getBoundingClientRect() is relative to the stage border, clientWidth is the inner width.
    if (!row || !layout || row.chosenAtMediaMs === null || !nonnegative(sample.mediaTimeMs) ||
        sample.mediaTimeMs < row.mediaTimeMs || sample.mediaTimeMs >= row.endMs ||
        !close(sample.xPx, x + 1, 1) || !close(sample.yPx, y + 1, 1) ||
        !close(sample.widthPx, row.widthPx, 1) || !close(sample.heightPx, row.heightPx, 1) ||
        !close(sample.stageWidthPx, layout.widthPx + 2, 1) ||
        !close(sample.fontSizePx, layout.fontSizePx, .25) ||
        !close(sample.lineHeightPx, layout.lineHeightPx, .25))
      issue(errors, 'dom-sample-geometry-invalid');
  }
  const counts = report.counts;
  if (!record(counts) || counts.selected !== rows.length || counts.entered !== committed ||
      counts.unknown !== unknown || counts.visibleDistinct !== visibleDistinct ||
      counts.translationLayoutFallback !== fallback || counts.translationReadyButRejected !== readyRejected ||
      counts.lateResults !== lateResults ||
      Object.entries(states).some(([state, count]) => counts[state] !== count) ||
      Object.entries(modes).some(([mode, count]) => counts[mode] !== count)) issue(errors, 'ledger-count-mismatch');
  const lead = percentiles(lateness);
  if (!record(report.lateness) || Object.keys(lead).some(key =>
    typeof lead[key] === 'number' ? !close(lead[key], report.lateness[key]) : lead[key] !== report.lateness[key]))
    issue(errors, 'lateness-distribution-mismatch');
  return { ok: errors.size === 0, violations: [...errors], completeEvidence: !report.truncated?.records &&
    !report.truncated?.samples && !report.ui?.domSampleTruncated && errors.size === 0,
    selected: rows.length, committed, sampledVisible: visibleDistinct,
    states, textModes: modes, translationLayoutFallback: fallback,
    translationReadyButRejected: readyRejected, lateResults, layouts: layouts.length,
    samples: samples.length, domSamples: Array.isArray(domSamples) ? domSamples.length : 0, lateness: lead };
}
