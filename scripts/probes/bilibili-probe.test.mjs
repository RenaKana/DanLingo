import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeElement, decodeSegment, decodeViewSegmentConfig, encodeSegment, sanitizeElements } from './bilibili-protobuf.mjs';
import { attachNativeObserver } from './bilibili-native-observer.mjs';
import { sha256, getPublic } from './bilibili-http.mjs';

const fixtures = new URL('../../test/fixtures/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const sourceFixture = read('bilibili-source-synthetic.json');
const queryFixture = read('bilibili-query-synthetic.json');

test('hand-authored source pseudocode preserves before-render ordering without site excerpts', () => {
  assert.equal(sourceFixture.evidenceLevel, 'synthetic-only');
  assert.match(sourceFixture.origin, /Hand-authored/);
  const quote = sourceFixture.quotations.find(item => item.name === 'before-render notification precedes model construction');
  assert.ok(quote);
  assert.ok(quote.excerpt.indexOf("notify('beforeRender'") < quote.excerpt.indexOf('buildTestModels'));
  assert.equal(sourceFixture.runtimeVerified, false);
});
for (const item of read('bilibili-protobuf-cases.json').cases) {
  test(item.name, () => assert.deepEqual(decodeSegment(Buffer.from(item.hex, 'hex')), item.expected));
}

test('hand-authored query cases are explicitly synthetic', () => {
  assert.equal(queryFixture.evidenceLevel, 'synthetic-only');
  assert.match(queryFixture.origin, /Hand-authored/);
  assert.ok(queryFixture.samples.length >= 3);
});
for (const sample of queryFixture.samples) test(`decode ${sample.name}`, () => {
  const bytes = Buffer.from(sample.protobufBase64, 'base64');
  assert.equal(sha256(bytes), sample.sha256);
  assert.deepEqual(decodeSegment(bytes).elems, sample.expected);
  assert.deepEqual(decodeSegment(encodeSegment(sample.expected)).elems, sample.expected);
  assert.ok(sample.expected.length <= 8);
});

test('malformed/truncated protobuf and invalid UTF-8 fail closed', () => {
  for (const hex of ['0a05ff', '0a0110', '00', '0b', '0a0103', '0a021201',
    '0a033a01ff', '0a0b0880808080808080808002', '9801ffff']) {
    assert.throws(() => decodeSegment(Buffer.from(hex, 'hex')), undefined, hex);
  }
});
test('unknown fixed32/fixed64/length fields skip without misaligning following content', () => {
  const value = decodeElement(Buffer.from('a50601020304a1060102030405060708aa0601781001', 'hex'));
  assert.deepEqual(value, { progress: 1, unknownFieldNumbers: [100, 101] });
});
test('negative int32, int64 and max int64 preserve signed values', () => {
  const expected = [{ progress: -1, weight: -10, ctime: '-1', id: '9223372036854775807' }];
  assert.deepEqual(decodeSegment(encodeSegment(expected)).elems, expected);
});
test('view segment length and count; absent config is not invented', () => {
  assert.deepEqual(decodeViewSegmentConfig(Buffer.from('220608c0fc151006', 'hex')), { pageSize: '360000', total: '6' });
  assert.equal(decodeViewSegmentConfig(Buffer.alloc(0)), null);
  assert.throws(() => decodeViewSegmentConfig(Buffer.from('22020901', 'hex')));
});
test('sanitization removes original content, user identifiers, source IDs and extension fields', () => {
  const original = { id: '123456789', idStr: '123456789', midHash: 'private-hash', content: 'private comment',
    ctime: '1741234567', animation: 'private-url', action: 'private-action', oid: '777',
    mode: 1, progress: 1200, fontsize: 25, color: 0, pool: 0, unknownFieldNumbers: [99] };
  const before = structuredClone(original), safe = sanitizeElements([original]);
  assert.deepEqual(original, before);
  const serialized = JSON.stringify(safe);
  for (const secret of ['private', '123456789', '1741234567', '777', 'unknownFieldNumbers']) assert.ok(!serialized.includes(secret));
  assert.equal(safe[0].color, 0);
  assert.deepEqual(decodeSegment(encodeSegment(safe)).elems, safe);
});
test('GET allowlist rejects credentials, alternate hosts and non-HTTPS without network', async () => {
  for (const url of ['http://api.bilibili.com/', 'https://api.bilibili.com.evil.test/',
    'https://user:password@api.bilibili.com/', 'https://api.bilibili.com:444/']) {
    await assert.rejects(getPublic(url), /allowlist/);
  }
});

function mockNative(previous = () => 'native-return') {
  return { getMetadata: () => ({ version: '1.1.23', lastCompiled: '2026-09-03T16:18:23+08:00' }),
    hooks: { beforeRender: previous }, manager: { visualArray: [] } };
}
const ordinary = () => ({ text: '原文', stime: 5, mode: 1, rawMode: 1, size: 25, color: 0xffffff, on: false });
test('observer preserves native hook receiver/return and source objects; records only new ordinary models', () => {
  const native = mockNative(function() { assert.equal(this, native); return 37; });
  const previous = native.hooks.beforeRender, probe = attachNativeObserver(native, { resourceKey: 'BV:CID:p1', maxRecords: 2 });
  const item = ordinary(), before = structuredClone(item), playing = { ...ordinary(), on: true };
  const special = { ...ordinary(), mode: 7 };
  assert.equal(native.hooks.beforeRender.call(native, [{ textData: playing }], [item, playing, special]), 37);
  native.hooks.beforeRender.call(native, [], [item]);
  assert.deepEqual(item, before);
  assert.equal(probe.snapshot().seenCount, 1);
  native.manager.visualArray = [{ textData: item, text: item.text, width: 54, height: 28, showed: true }];
  assert.equal(probe.snapshot().active[0].label, 1);
  assert.equal(probe.snapshot().nativeReplacementPassed, false);
  assert.ok(!JSON.stringify(probe.snapshot()).includes('原文'));
  assert.deepEqual(probe.stop(), { restored: true, laterWrapperPreserved: false });
  assert.equal(native.hooks.beforeRender, previous);
});
test('observer stays bounded and never overwrites a wrapper installed later', () => {
  const native = mockNative(), probe = attachNativeObserver(native, { resourceKey: 'resource', maxRecords: 2 });
  const ours = native.hooks.beforeRender;
  ours([], [ordinary(), ordinary(), ordinary()]);
  assert.equal(probe.snapshot().records.length, 2);
  const later = (...args) => ours(...args);
  native.hooks.beforeRender = later;
  assert.equal(probe.stop().restored, false);
  assert.equal(native.hooks.beforeRender, later);
  later([], [ordinary()]);
  assert.equal(probe.snapshot().seenCount, 3);
});
test('native callback exceptions propagate; unknown versions or read-only hook rejected', () => {
  const native = mockNative(() => { throw new Error('native-error'); });
  const probe = attachNativeObserver(native, { resourceKey: 'resource' });
  assert.throws(() => native.hooks.beforeRender([], []), /native-error/);
  probe.stop();
  native.getMetadata = () => ({ version: 'other' });
  assert.throws(() => attachNativeObserver(native, { resourceKey: 'resource' }), /Unreviewed/);
  const locked = mockNative(); Object.freeze(locked.hooks);
  assert.throws(() => attachNativeObserver(locked, { resourceKey: 'resource' }), /writable/);
});
