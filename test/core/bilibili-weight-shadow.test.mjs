import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHT_CONTRACT_SHA256, WEIGHT_RULE_VERSION, WEIGHT_DEPENDENCY_FIELDS,
  WEIGHT_BOUNDARY_FIELDS, nativeWeightContract,
  verifyNativeWeightContract, readWeightDependencies, decideWeightShadow,
} from '../../src/diagnostics/bilibili-weight-shadow.mjs';

function fixture() {
  let nativeCalls = 0, metadataCalls = 0;
  class Manager {
    validate() { nativeCalls++; return false; }
    insert() { nativeCalls++; }
  }
  class Danmaku {
    getMetadata() { metadataCalls++; return { version: '1.1.22', lastCompiled: '2026-07-14T14:26:03+08:00' }; }
  }
  const filter = () => { nativeCalls++; return true; };
  const hooks = { beforeRender() { nativeCalls++; } };
  const setting = { area: 25, limit: 42 };
  Object.defineProperty(setting, 'aiLevel', { get() { throw new Error('private config getter executed'); } });
  const config = { setting, fn: { filter }, hooks };
  const manager = new Manager(); manager.config = config;
  const danmaku = new Danmaku(); danmaku.config = config; danmaku.hooks = hooks;
  const video = {}, binding = { manager, danmaku, video };
  const areaNode = { isConnected: true, textContent: '25%' };
  const root = {
    isConnected: true, contains: candidate => candidate === video,
    classList: { contains: name => name === 'bpx-player-container' },
    querySelectorAll: selector => selector === '.bpx-player-dm-setting-left-area .bui-area' ? [areaNode] : [],
    ownerDocument: { scripts: [{ src: 'https://s1.hdslb.com/bfs/static/player/main/core.5966babe.js' }] },
  };
  return { binding, root, config, setting, areaNode,
    get nativeCalls() { return nativeCalls; }, get metadataCalls() { return metadataCalls; } };
}

const verified = { verified: true, sha256: WEIGHT_CONTRACT_SHA256 };
const input = (weight, extra = {}) => ({ weight, weightKind: 'number', mode: 1,
  borderKind: 'missing', borderTruthy: false, ...extra });

function decide(sample, candidate, baseline = readWeightDependencies(sample.binding, sample.root)) {
  return decideWeightShadow(candidate, { contract: verified, baseline,
    current: readWeightDependencies(sample.binding, sample.root) });
}

test('only the observed build, exact core and two matching 25% readings are valid', () => {
  const sample = fixture();
  const first = readWeightDependencies(sample.binding, sample.root);
  assert.equal(first.valid, true);
  assert.equal(first.area, 25);
  assert.equal(first.domArea, '25%');
  assert.equal(sample.nativeCalls, 0);
  assert.ok(sample.metadataCalls > 0);

  sample.setting.area = 100;
  assert.equal(readWeightDependencies(sample.binding, sample.root).reason, 'native-area-not-25');
  sample.setting.area = 25; sample.areaNode.textContent = '50%';
  assert.equal(readWeightDependencies(sample.binding, sample.root).reason, 'native-area-dom-not-25');
  sample.areaNode.textContent = '25%';
  sample.root.ownerDocument.scripts[0].src = 'https://s1.hdslb.com/bfs/static/player/main/core.other.js';
  assert.equal(readWeightDependencies(sample.binding, sample.root).reason, 'native-core-script-mismatch');
  sample.root.ownerDocument.scripts[0].src = 'https://s1.hdslb.com/bfs/static/player/main/core.5966babe.js';
  sample.binding.danmaku.getMetadata = () => ({ version: '1.1.24', lastCompiled: '2026-07-14T14:26:03+08:00' });
  assert.equal(readWeightDependencies(sample.binding, sample.root).reason, 'native-build-mismatch');
  assert.equal(sample.nativeCalls, 0);
});

test('native contract extracts only four function sources in filter, validate, insert, hook order', async () => {
  const sample = fixture();
  const contract = nativeWeightContract(sample.binding);
  assert.equal(contract.valid, true);
  assert.deepEqual(contract.sources, [
    sample.config.fn.filter,
    Object.getPrototypeOf(sample.binding.manager).validate,
    Object.getPrototypeOf(sample.binding.manager).insert,
    sample.binding.danmaku.hooks.beforeRender,
  ].map(fn => Function.prototype.toString.call(fn)));
  assert.equal(sample.nativeCalls, 0);
  const digest = await verifyNativeWeightContract(contract);
  assert.equal(digest.verified, false);
  assert.equal(digest.reason, 'native-contract-mismatch');
  assert.match(digest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(decideWeightShadow(input(1), { contract: digest,
    baseline: readWeightDependencies(sample.binding, sample.root),
    current: readWeightDependencies(sample.binding, sample.root) }).decision, 'unknown');
  assert.equal(sample.nativeCalls, 0);
});

test('weight boundary is strict, absolute, and retain never claims eligibility', () => {
  const sample = fixture();
  for (const weight of [0, -0, 1, -1, 2.999, -2.999]) {
    assert.deepEqual(decide(sample, input(weight)), {
      decision: 'exclude', reason: 'native-weight-below-ai-level', ruleVersion: WEIGHT_RULE_VERSION,
    });
  }
  for (const weight of [3, -3, 12, -12]) {
    assert.deepEqual(decide(sample, input(weight)), {
      decision: 'retain', reason: 'weight-not-below-ai-level', ruleVersion: WEIGHT_RULE_VERSION,
    });
  }
  for (const weight of [NaN, Infinity, -Infinity, '1', null])
    assert.equal(decide(sample, input(weight)).decision, 'unknown');
  assert.equal(sample.nativeCalls, 0);
});

test('border takes priority; an inherited or accessor border cannot be assumed false', () => {
  const sample = fixture();
  assert.equal(decide(sample, input(0, { borderKind: 'boolean', borderTruthy: true })).reason, 'border-exception');
  assert.equal(decide(sample, input(null, { borderKind: 'boolean', borderTruthy: true })).decision, 'retain');
  assert.equal(decide(sample, input(0, { borderKind: 'accessor', borderTruthy: null })).decision, 'unknown');
  assert.equal(decide(sample, input(0, { borderKind: 'inherited', borderTruthy: false })).decision, 'unknown');
  assert.equal(decide(sample, input(0, { borderKind: 'missing', borderTruthy: true })).decision, 'unknown');
  assert.equal(decide(sample, input(0, { borderKind: undefined, borderTruthy: true })).decision, 'unknown');
  assert.equal(decide(sample, input(0, { mode: 7 })).decision, 'unknown');
});

test('native accessors are not invoked and changing any rule dependency invalidates the baseline', () => {
  const sample = fixture();
  const baseline = readWeightDependencies(sample.binding, sample.root);
  Object.defineProperty(sample.setting, 'area', { get() { throw new Error('area getter executed'); }, configurable: true });
  assert.equal(readWeightDependencies(sample.binding, sample.root).reason, 'native-area-not-25');
  assert.equal(decide(sample, input(1), baseline).reason, 'dependencies-changed');
  Object.defineProperty(sample.setting, 'area', { value: 25, writable: true, configurable: true });
  const originalFilter = sample.config.fn.filter;
  sample.config.fn.filter = () => false;
  assert.equal(decide(sample, input(1), baseline).reason, 'dependencies-changed');
  sample.config.fn.filter = originalFilter;
  sample.setting.limit = 43;
  assert.equal(decide(sample, input(1), baseline).reason, 'dependencies-changed');
  sample.setting.limit = 42;
  const originalArea = sample.areaNode;
  sample.root.querySelectorAll = () => [{ isConnected: true, textContent: '25%' }];
  assert.equal(decide(sample, input(1), baseline).reason, 'dependencies-changed');
  sample.root.querySelectorAll = () => [originalArea];
  assert.equal(decide(sample, input(1), baseline).decision, 'exclude');
  assert.equal(sample.nativeCalls, 0);
});

test('own audit wrappers are separate from the native dependency baseline', () => {
  const sample = fixture();
  assert.equal(WEIGHT_DEPENDENCY_FIELDS.length, 21);
  assert.deepEqual(WEIGHT_BOUNDARY_FIELDS, ['activeInsert', 'activeValidate']);
  const baseline = readWeightDependencies(sample.binding, sample.root);
  sample.binding.manager.insert = function auditInsert() {};
  sample.binding.manager.validate = function auditValidate() {};
  const afterAttach = readWeightDependencies(sample.binding, sample.root);
  assert.deepEqual(afterAttach.dependencyFingerprint, baseline.dependencyFingerprint);
  assert.equal(decideWeightShadow(input(1), { contract: verified, baseline, current: afterAttach,
    boundaryBaseline: afterAttach.boundaryFingerprint }).decision, 'exclude');
  sample.binding.manager.validate = function laterWrapper() {};
  assert.equal(decideWeightShadow(input(1), { contract: verified, baseline,
    current: readWeightDependencies(sample.binding, sample.root),
    boundaryBaseline: afterAttach.boundaryFingerprint }).reason, 'native-boundary-changed');
});
