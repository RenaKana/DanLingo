import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridPerformanceModel } from '../../src/translation/hybrid-performance.ts';

function sample(index, overrides = {}) {
  const startedAt = index * 1000;
  return { startedAt, endedAt: startedAt + 400, inputChars: 40, outputChars: 30, items: 1,
    complete: true, timely: true, outcome: 'complete', streaming: false, ...overrides };
}
function train(model, key = 'model', count = 8, make = index => sample(index)) {
  for (let index = 0; index < count; index++) model.record(key, make(index));
}
const shape = { inputChars: 40, items: 1 };

test('cold and fewer than eight matching complete samples stay in learning; clear resets', () => {
  const model = new HybridPerformanceModel();
  assert.deepEqual(model.estimate('model', shape, 1), {
    ready: false, samples: 0, status: 'learning', outputChars: 52,
  });
  train(model, 'model', 7);
  const learning = model.estimate('model', shape, 7000);
  assert.equal(learning.samples, 7);
  assert.equal(learning.ready, false);
  assert.equal(learning.expectedMs, undefined);
  model.record('model', sample(7));
  assert.equal(model.estimate('model', shape, 8000).ready, true);
  model.clear();
  assert.equal(model.estimate('model', shape, 8000).samples, 0);
});

test('raw UTF-16 output already contains frame bytes, so same shape does not double-count them', () => {
  const model = new HybridPerformanceModel();
  train(model, 'emoji', 8, index => sample(index, { inputChars: '😀'.length, outputChars: '😀😀'.length }));
  const estimate = model.estimate('emoji', { inputChars: '😀'.length, items: 1 }, 8000);
  assert.equal(estimate.outputChars, 4);
  assert.equal(estimate.outputCeiling, 4);
  assert.equal(estimate.ready, true);
  const ordinary = new HybridPerformanceModel();
  train(ordinary);
  const sameShape = ordinary.estimate('model', shape, 8000);
  assert.equal(sameShape.outputChars, 30);
  assert.equal(sameShape.outputCeiling, 30);
});

test('nonstream nonnegative fit grows with input/output, and avoids implausible short latency', () => {
  const model = new HybridPerformanceModel();
  train(model, 'variable', 12, index => {
    const inputChars = 20 + index * 10;
    const outputChars = 15 + index * 7;
    return sample(index, { inputChars, outputChars, endedAt: index * 1000 + 150 + 2 * inputChars + 3 * outputChars });
  });
  const small = model.estimate('variable', { inputChars: 30, items: 1 }, 13000);
  const large = model.estimate('variable', { inputChars: 120, items: 1 }, 13000);
  assert.equal(small.ready, true);
  assert.equal(large.ready, true);
  assert.ok(large.outputChars > small.outputChars);
  assert.ok(large.expectedMs > small.expectedMs);
  assert.ok(small.expectedMs >= 250);

  const short = new HybridPerformanceModel();
  train(short, 'short', 8, index => sample(index, { endedAt: index * 1000 + 160, inputChars: 10,
    outputChars: 10 }));
  assert.ok(short.estimate('short', { inputChars: 10, items: 1 }, 8000).expectedMs >= 260);
  const long = short.estimate('short', { inputChars: 100, items: 1 }, 8000);
  const batch = short.estimate('short', { inputChars: 10, items: 4 }, 8000);
  assert.equal(long.ready, true);
  assert.equal(batch.ready, true);
  assert.ok(long.expectedMs >= 1600);
  assert.ok(batch.expectedMs >= 640);
  assert.ok(long.outputChars > long.outputCeiling);
});

test('streamed prediction needs two content chunks and at least 500 ms span', () => {
  const model = new HybridPerformanceModel();
  train(model, 'stream', 8, index => sample(index, { endedAt: index * 1000 + 1200,
    streaming: true, firstContentMs: 200, firstChunkChars: 10, contentChunks: 3,
    contentSpanMs: 1000, outputChars: 30 }));
  const estimate = model.estimate('stream', shape, 9000);
  assert.equal(estimate.charsPerSecond, 20);
  assert.equal(estimate.firstContentMs, 200);
  assert.equal(estimate.expectedMs, 1800);
  assert.ok(estimate.expectedMs >= estimate.firstContentMs +
    estimate.outputChars * 1000 / estimate.charsPerSecond + 100);
  const longPrompt = model.estimate('stream', { inputChars: 80, items: 1 }, 9000);
  assert.equal(longPrompt.ready, true);
  assert.equal(longPrompt.firstContentMs, 200);
  assert.equal(longPrompt.expectedMs, Math.ceil(400 +
    longPrompt.outputChars * 1000 / longPrompt.charsPerSecond + 100));
  assert.ok(longPrompt.expectedMs > estimate.expectedMs);

  const oneChunk = new HybridPerformanceModel();
  train(oneChunk, 'one', 8, index => sample(index, { streaming: true,
    firstContentMs: 50, firstChunkChars: 30, contentChunks: 1, contentSpanMs: 0 }));
  const fallback = oneChunk.estimate('one', shape, 8000);
  assert.equal(fallback.ready, true);
  assert.equal(fallback.charsPerSecond, undefined);
  assert.ok(Number.isFinite(fallback.expectedMs));

  const shortSpan = new HybridPerformanceModel();
  train(shortSpan, 'span', 8, index => sample(index, { streaming: true,
    firstContentMs: 50, firstChunkChars: 10, contentChunks: 3, contentSpanMs: 499 }));
  assert.equal(shortSpan.estimate('span', shape, 8000).charsPerSecond, undefined);
});

test('a slow first content segment and saved underprediction dominate a fast stream rate', () => {
  const baseline = new HybridPerformanceModel();
  const underestimated = new HybridPerformanceModel();
  for (let index = 0; index < 8; index++) {
    const observed = sample(index, { endedAt: index * 1000 + 1800, outputChars: 100,
      streaming: true, firstContentMs: 1000, firstChunkChars: 10, contentChunks: 3,
      contentSpanMs: 500 });
    baseline.record('fast', observed);
    underestimated.record('fast', index === 7 ? { ...observed, predictedMs: 100 } : observed);
  }
  const normal = baseline.estimate('fast', shape, 9000);
  const guarded = underestimated.estimate('fast', shape, 9000);
  assert.equal(guarded.firstContentMs, 1000);
  assert.equal(guarded.charsPerSecond, 180);
  assert.equal(normal.expectedMs, 1800);
  assert.equal(guarded.expectedMs, Math.ceil(1000 + 100 * 1000 / 180 + 1700));
  assert.ok(guarded.expectedMs > normal.expectedMs);
});

test('groups isolate observations, keep 32 recent entries for 10 minutes, and cap keys at 128', () => {
  const model = new HybridPerformanceModel();
  train(model, 'A', 40);
  assert.equal(model.estimate('A', shape, 40000).samples, 32);
  assert.equal(model.estimate('B', shape, 40000).ready, false);
  assert.equal(model.estimate('A', shape, 640000).samples, 0);

  model.record('A', sample(41, { outcome: 'error', complete: false, timely: false }));
  assert.equal(model.estimate('A', shape, 42000).samples, 31);

  for (let index = 0; index < 128; index++) model.record(`key-${index}`, sample(100));
  assert.equal(model.estimate('A', shape, 101000).samples, 0);
  assert.equal(model.estimate('key-127', shape, 101000).samples, 1);
});

test('recent underestimated latency tightens immediately, five timely completions recover ceiling by at most 20 percent', () => {
  const model = new HybridPerformanceModel();
  train(model);
  const initial = model.estimate('model', shape, 8000);
  assert.equal(initial.status, 'stable');
  assert.equal(initial.outputCeiling, 30);
  model.record('model', sample(8, { endedAt: 8800, predictedMs: 300, timely: false }));
  const slowing = model.estimate('model', shape, 9000);
  assert.equal(slowing.status, 'slowing');
  assert.equal(slowing.outputCeiling, 24);
  assert.ok(slowing.expectedMs >= 900);
  train(model, 'model', 5, index => sample(index + 9));
  const recovered = model.estimate('model', shape, 15000);
  assert.equal(recovered.status, 'stable');
  assert.equal(recovered.outputCeiling, 28);
  assert.ok(recovered.outputCeiling <= slowing.outputCeiling * 1.2);
  train(model, 'model', 5, index => sample(index + 14));
  const expanded = model.estimate('model', shape, 19000);
  assert.equal(expanded.outputCeiling, 33);
  assert.ok(expanded.outputCeiling > initial.outputCeiling);
  assert.ok(expanded.outputCeiling <= recovered.outputCeiling * 1.2);
});

test('recent saved prediction error tightens a flat nonstream fit and releases after five timely completions', () => {
  const model = new HybridPerformanceModel();
  train(model);
  assert.equal(model.estimate('model', shape, 8000).expectedMs, 500);
  model.record('model', sample(8, { predictedMs: 50 }));
  const firstMiss = model.estimate('model', shape, 9000);
  assert.equal(firstMiss.status, 'slowing');
  assert.ok(firstMiss.expectedMs >= 750);
  model.record('model', sample(9, { endedAt: 9700, predictedMs: 350, timely: false }));
  const nextMiss = model.estimate('model', shape, 10000);
  assert.ok(nextMiss.expectedMs > firstMiss.expectedMs);
  train(model, 'model', 5, index => sample(index + 10, { predictedMs: 400 }));
  const recovered = model.estimate('model', shape, 15000);
  assert.equal(recovered.status, 'stable');
  assert.ok(recovered.expectedMs < nextMiss.expectedMs);
});

test('timeout and partial results are censored lower bounds, cancellation and errors cannot teach latency', () => {
  const model = new HybridPerformanceModel();
  train(model);
  model.record('model', sample(8, { endedAt: 10000, complete: false, timely: false,
    outcome: 'timeout', outputChars: 0 }));
  model.record('model', sample(10, { endedAt: 11200, complete: false, timely: false,
    outcome: 'cancelled', outputChars: 0 }));
  model.record('model', sample(11, { endedAt: 12000, complete: false, timely: false,
    outcome: 'error', outputChars: 0 }));
  const estimate = model.estimate('model', shape, 13000);
  assert.equal(estimate.samples, 8);
  assert.ok(estimate.expectedMs >= 2100);
  assert.equal(estimate.status, 'slowing');
  assert.equal(estimate.outputCeiling, 24);
  model.record('model', sample(13, { endedAt: 14300, complete: false, timely: false,
    outcome: 'partial', outputChars: 10 }));
  assert.ok(model.estimate('model', shape, 15000).expectedMs >= 1400);
  train(model, 'model', 5, index => sample(index + 15));
  const afterRecovery = model.estimate('model', shape, 20000);
  assert.equal(afterRecovery.samples, 8 + 5);
  assert.equal(afterRecovery.status, 'stable');
  assert.ok(afterRecovery.expectedMs < 1400);
});

test('in-flight lower bound only raises a ready estimate', () => {
  const model = new HybridPerformanceModel();
  train(model);
  const baseline = model.estimate('model', shape, 8000);
  assert.equal(model.estimate('model', shape, 8000, 10).expectedMs, baseline.expectedMs);
  assert.equal(model.estimate('model', shape, 8000, 10).status, 'stable');
  const stalled = model.estimate('model', shape, 8000, 2000);
  assert.ok(stalled.expectedMs >= 2100);
  assert.equal(stalled.status, 'slowing');
  assert.equal(stalled.outputCeiling, baseline.outputCeiling);
  assert.equal(model.estimate('model', shape, 8000).expectedMs, baseline.expectedMs);
  assert.equal(model.estimate('model', shape, 8000).status, 'stable');
});

test('an observed two-item range conservatively estimates even a larger batch', () => {
  const model = new HybridPerformanceModel();
  train(model, 'batch', 12, index => sample(index, { items: index % 2 + 1, inputChars: 40 + index * 4,
    outputChars: 28 + index * 3, endedAt: index * 1000 + 300 + (index % 2) * 150 }));
  const two = model.estimate('batch', { inputChars: 60, items: 2 }, 13000);
  const nine = model.estimate('batch', { inputChars: 60, items: 9 }, 13000);
  assert.equal(two.ready, true);
  assert.equal(nine.ready, true);
  assert.ok(nine.expectedMs >= two.expectedMs * 2);
  assert.ok(nine.outputChars > nine.outputCeiling);
});
