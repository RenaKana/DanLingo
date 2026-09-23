import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { observeMixedRequestMetadata, summarizeMixedRequests } from './live-mixed-real-evidence.mjs';
const window = { startAt: 100, endAt: 200 };
const sources = [{ kind: 'vod', textSha256: 'v', observedAt: 0 }, { kind: 'live', textSha256: 'l', observedAt: 50 }];
const request = (id, textSha256, startedAt, completedAt) => ({ id, items: [{ textSha256 }], startedAt, completedAt });
const digest = text => createHash('sha256').update(text).digest('hex');
const body = content => ({ model: 'fixture-model', stream: true, thinking: { type: 'enabled' }, reasoning_effort: 'high',
  messages: [{ role: 'system', content: 'Translate comments from "auto" to "zh-Hans"; auto detects source.' },
    { role: 'user', content }] });

test('envelope and multirow JSONL observation retain only metadata and exact protected-body hashes', () => {
  const texts = ['  protected __DL_0__\ntext  ', '別のコメント'];
  const inputs = [
    ['envelope', JSON.stringify({ sourceLanguage: 'ja', targetLanguage: 'zh-Hans', items: texts.map((text, i) => ({ id: `item-${i}`, text })) })],
    ['jsonl', texts.map((text, i) => JSON.stringify([i, text])).join('\n')],
  ];
  for (const [protocol, content] of inputs) {
    const metadata = observeMixedRequestMetadata({ ...body(content), apiKey: 'fixture-secret' });
    assert.deepEqual(metadata, {
      model: 'fixture-model', protocol, stream: true, sourceLanguage: protocol === 'envelope' ? 'ja' : 'auto',
      targetLanguage: 'zh-Hans', thinking: 'enabled', reasoningEffort: 'high',
      items: texts.map((text, i) => ({ engineId: protocol === 'envelope' ? `item-${i}` : String(i), textSha256: digest(text) })),
    });
    const serialized = JSON.stringify(metadata);
    for (const secret of ['fixture-secret', '__DL_0__', texts[1]]) assert.equal(serialized.includes(secret), false);
  }
});

test('single-row JSONL request IDs may repeat while source identity follows protected text', () => {
  const requests = ['live protected', 'vod protected'].map((text, i) => ({ id: `http-${i}`, startedAt: 110 + i,
    completedAt: 150, ...observeMixedRequestMetadata(body(JSON.stringify([0, text]))) }));
  assert.deepEqual(requests.map(row => row.protocol), ['jsonl', 'jsonl']);
  assert.deepEqual(requests.map(row => row.items[0].engineId), ['0', '0']);
  const result = summarizeMixedRequests({ window, requests, sources: [
    { kind: 'live', textSha256: digest('live protected'), observedAt: 50 },
    { kind: 'vod', textSha256: digest('vod protected'), observedAt: 50 },
  ] });
  assert.deepEqual(result.requests.map(row => row.kind), ['live', 'vod']);
  assert.deepEqual(result.shares, { live: 1, vod: 1, ambiguous: 0, unknown: 0 });
});

test('invalid requests retain unavailable metadata and unknown workload without partial attribution', () => {
  for (const input of [null, {}, body('not JSON'), body('[0,"valid"]\n[1,42]'), body('[0,"a"]\n[0,"b"]'),
    body(JSON.stringify({ items: [{ id: 'x', text: 1 }] }))]) {
    const metadata = observeMixedRequestMetadata(input);
    assert.deepEqual(metadata, { items: [], metadataUnavailable: true });
    const result = summarizeMixedRequests({ window, sources, requests: [{ id: 'invalid', startedAt: 110, ...metadata }] });
    assert.equal(result.requests[0].kind, 'unknown');
    assert.equal(result.requests[0].metadataUnavailable, true);
    assert.deepEqual(result.unresolvedRequests, ['invalid']);
  }
});
test('real source shares and one VOD slot are counted from observed overlap', () => {
  const result = summarizeMixedRequests({ window, sources, requests: [request('v', 'v', 105, 160), request('l', 'l', 110, 140)] });
  assert.deepEqual(result.shares, { live: 1, vod: 1, ambiguous: 0, unknown: 0 });
  assert.equal(result.peakTotal, 2); assert.equal(result.admissions[0].reservation, 'OBSERVED_WITHIN_LIMIT');
});
test('cross-workload identical text remains ambiguous even with a completed response', () => {
  const result = summarizeMixedRequests({ window, sources: [...sources, { kind: 'vod', textSha256: 'l', observedAt: 20 }], requests: [request('shared', 'l', 120, 140)] });
  assert.equal(result.requests[0].kind, 'ambiguous'); assert.equal(result.shares.live, 0);
  assert.deepEqual(result.unresolvedRequests, ['shared']);
});
test('future source text cannot retroactively label a dispatch', () => {
  const result = summarizeMixedRequests({ window, sources: [{ kind: 'live', textSha256: 'x', observedAt: 180 }], requests: [request('unknown', 'x', 110, 140)] });
  assert.equal(result.requests[0].kind, 'unknown');
});
test('already in-flight VOD may drain, but another VOD admission violates the reserved slot', () => {
  const result = summarizeMixedRequests({ window, sources, requests: [request('old', 'v', 90, 170), request('new', 'v', 110, 160)] });
  assert.equal(result.admissions.length, 1); assert.equal(result.admissions[0].reservation, 'VIOLATION');
});
test('in-flight unknown work prevents claiming a proven reserved VOD slot', () => {
  const result = summarizeMixedRequests({ window, sources, requests: [request('unknown', 'x', 90), request('new', 'v', 110, 160)] });
  assert.equal(result.admissions[0].reservation, 'INCOMPLETE');
});
