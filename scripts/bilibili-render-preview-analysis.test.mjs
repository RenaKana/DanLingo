import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPreviewEngine } from '../src/core/render-preview.ts';
import { analyzeBilibiliRenderPreview } from './bilibili-render-preview-analysis.mjs';

const event = (id, mediaTimeMs, text = 'x') => ({ id, sourceId: id, resourceId: 'part', epoch: 3,
  originalText: text, mediaTimeMs, bucket: 1, startMs: 1000, selectedAtMs: 0,
  selectedWallTimeMs: 0, leadMs: mediaTimeMs, coldStart: false, unknown: true,
  needsTranslation: false, sourceRevision: 1, ruleRevision: 1, planRevision: 1,
  state: 'frozen', reason: 'selected' });
const clone = x => structuredClone(x);
function fixture() {
  const renderer = new RenderPreviewEngine({ measure: () => ({ widthPx: 80, heightPx: 30, lines: 1 }) });
  renderer.setLayout({ widthPx: 600, heightPx: 60, fontSizePx: 20, lineHeightPx: 22,
    paddingXPx: 4, paddingYPx: 4, gapPx: 16 }, 0);
  const rows = [event('a', 1000), event('b', 1000), event('c', 2000)];
  renderer.sync({ resourceId: 'part', epoch: 3, mediaTimeMs: 0, events: rows, contextValid: true });
  const frame = renderer.tick({ mediaTimeMs: 1020, wallTimeMs: 1020 });
  renderer.sampleVisible(frame.active.map(row => row.key), 1040, 1040);
  renderer.tick({ mediaTimeMs: 2000, wallTimeMs: 2000 });
  return renderer.report();
}

test('independent analyzer recomputes measured lane bounds, movement and lateness without text', () => {
  const result = analyzeBilibiliRenderPreview(fixture());
  assert.equal(result.ok, true, result.violations.join(', '));
  assert.equal(result.completeEvidence, true);
  assert.equal(result.selected, 3);
  assert.equal(result.committed, 3);
  assert.equal(result.sampledVisible, 2);
  assert.equal(result.samples, 2);
  assert.equal(result.lateness.maxMs, 20);
  assert.equal(JSON.stringify(result).includes('part'), false);
});

test('geometry violations are found without trusting allocator state', () => {
  const base = fixture();
  const overlap = clone(base);
  overlap.records.find(row => row.id === 'b').lane = 0;
  assert.ok(analyzeBilibiliRenderPreview(overlap).violations.includes('horizontal-overlap'));
  const badLane = clone(base);
  badLane.records.find(row => row.id === 'b').lane = 2;
  assert.ok(analyzeBilibiliRenderPreview(badLane).violations.includes('track-bounds-invalid'));
  const badSpeed = clone(base);
  badSpeed.layouts[0].speedPxPerMs *= 2;
  assert.ok(analyzeBilibiliRenderPreview(badSpeed).violations.includes('layout-geometry-invalid'));
  const badSample = clone(base);
  badSample.samples[0].xPx += 24;
  assert.ok(analyzeBilibiliRenderPreview(badSample).violations.includes('visible-sample-geometry-invalid'));
  const late = clone(base);
  late.records[0].latenessMs = 251;
  assert.ok(analyzeBilibiliRenderPreview(late).violations.includes('timing-invalid'));
});

test('sampling gaps and truncation do not masquerade as complete visible evidence', () => {
  const base = fixture();
  const missing = clone(base); missing.samples.pop();
  assert.ok(analyzeBilibiliRenderPreview(missing).violations.includes('visible-sample-count-mismatch'));
  const cut = clone(base); cut.truncated.samples = true;
  const result = analyzeBilibiliRenderPreview(cut);
  assert.equal(result.completeEvidence, false);
  assert.ok(result.violations.includes('samples-truncated'));
});

test('DOM rectangle samples are checked against media-time motion and measured style', () => {
  const report = fixture();
  const first = report.samples[0];
  const row = report.records.find(item => item.key === first.key);
  const layout = report.layouts.find(item => item.revision === row.layoutRevision);
  report.ui = { domSampleCount: 1, domSampleTruncated: false,
    domSamples: [{ key: first.key, mediaTimeMs: first.mediaTimeMs, wallTimeMs: first.wallTimeMs,
      xPx: first.xPx + 1, yPx: first.yPx + 1, widthPx: row.widthPx, heightPx: row.heightPx,
      stageWidthPx: layout.widthPx + 2, fontSizePx: layout.fontSizePx, lineHeightPx: layout.lineHeightPx }] };
  assert.equal(analyzeBilibiliRenderPreview(report).ok, true);
  const moved = clone(report); moved.ui.domSamples[0].xPx += 12;
  assert.ok(analyzeBilibiliRenderPreview(moved).violations.includes('dom-sample-geometry-invalid'));
});

test('reserved future geometry participates in independent two-sided spacing checks', () => {
  const renderer = new RenderPreviewEngine({ measure: () => ({ widthPx: 80, heightPx: 30, lines: 1 }) });
  renderer.setLayout({ widthPx: 600, heightPx: 30, fontSizePx: 20, lineHeightPx: 22,
    paddingXPx: 4, paddingYPx: 4, gapPx: 16 }, 0);
  const rows = [event('first', 1000), event('later', 3000)];
  renderer.sync({ resourceId: 'part', epoch: 3, mediaTimeMs: 0, events: rows, contextValid: true });
  const report = renderer.report();
  assert.equal(analyzeBilibiliRenderPreview(report).ok, true);
  const changed = clone(report);
  changed.records[1].mediaTimeMs = 1500;
  assert.ok(analyzeBilibiliRenderPreview(changed).violations.includes('horizontal-overlap'));
});

test('a withdrawn committed object frees its lane without inventing a collision', () => {
  const renderer = new RenderPreviewEngine({ measure: () => ({ widthPx: 80, heightPx: 30, lines: 1 }) });
  renderer.setLayout({ widthPx: 600, heightPx: 30, fontSizePx: 20, lineHeightPx: 22,
    paddingXPx: 4, paddingYPx: 4, gapPx: 16 }, 0);
  const first = event('first', 1000), second = event('second', 1200);
  renderer.sync({ resourceId: 'part', epoch: 3, mediaTimeMs: 0, events: [first], contextValid: true });
  renderer.tick({ mediaTimeMs: 1000, wallTimeMs: 1000 });
  renderer.sync({ resourceId: 'part', epoch: 3, mediaTimeMs: 1100, events: [first, second],
    contextValid: true, eligibility: row => row.id === 'first' ? 'exclude' : 'retain' });
  renderer.tick({ mediaTimeMs: 1200, wallTimeMs: 1200 });
  const analysis = analyzeBilibiliRenderPreview(renderer.report());
  assert.equal(analysis.ok, true, analysis.violations.join(', '));
  assert.equal(analysis.committed, 2);
});

test('separate playback epochs and resources can reuse a lane after media time moves backward', () => {
  for (const identity of [{ resourceId: 'part', epoch: 4 }, { resourceId: 'next-part', epoch: 3 }]) {
    const renderer = new RenderPreviewEngine({ measure: () => ({ widthPx: 80, heightPx: 30, lines: 1 }) });
    renderer.setLayout({ widthPx: 600, heightPx: 30, fontSizePx: 20, lineHeightPx: 22,
      paddingXPx: 4, paddingYPx: 4, gapPx: 16 }, 0);
    renderer.sync({ resourceId: 'part', epoch: 3, mediaTimeMs: 0,
      events: [event('old', 1000)], contextValid: true });
    renderer.tick({ mediaTimeMs: 1000, wallTimeMs: 1000 });
    const next = { ...event('new', 500), ...identity };
    renderer.sync({ ...identity, mediaTimeMs: 0, events: [next], contextValid: true });
    renderer.tick({ mediaTimeMs: 500, wallTimeMs: 1100 });
    const report = renderer.report();
    assert.equal(report.records.find(row => row.id === 'old').state, 'environment-reset');
    assert.equal(report.records.find(row => row.id === 'new').state, 'committed');
    const analysis = analyzeBilibiliRenderPreview(report);
    assert.equal(analysis.ok, true, `${identity.resourceId}/${identity.epoch}: ${analysis.violations.join(', ')}`);
  }
});
