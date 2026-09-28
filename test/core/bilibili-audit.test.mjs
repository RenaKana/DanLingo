import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCache, auditCacheState, auditUrl } from '../../src/diagnostics/bilibili-audit-cache.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { translationCacheKey } from '../../src/translation/cache.ts';
import { modelElements, visibleGeometry, weightShadowTracker } from '../../src/diagnostics/bilibili-audit-main.mjs';
import { readWeightDependencies, WEIGHT_CONTRACT_SHA256 } from '../../src/diagnostics/bilibili-weight-shadow.mjs';
import { nativeRuleInputs, inspectNativeBranches } from '../../src/diagnostics/bilibili-native-branches.mjs';
import { attachPretranslationAudit } from '../../src/diagnostics/bilibili-pretranslation.mjs';

test('audit requires exact sample, part 1 and explicit URL opt-in', () => {
  assert.equal(auditUrl('https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit'), true);
  assert.equal(auditUrl('https://www.bilibili.com/video/BV1RHaw6mEDR/#danlingo-audit'), true);
  for (const url of ['https://www.bilibili.com/video/BV1yvhW6sEzi/',
    'https://www.bilibili.com/video/BV1yvhW6sEzi/?p=2#danlingo-audit',
    'https://www.bilibili.com/video/BV1RHaw6mEDR/?p=2#danlingo-audit',
    'https://www.bilibili.com/video/BV1RHaw6mEDRX/#danlingo-audit',
    'https://example.com/video/BV1yvhW6sEzi/#danlingo-audit']) assert.equal(auditUrl(url), false);
});

test('cache integrity receipt reads only count and metadata without opening absent databases or updating LRU', async () => {
  let opens = 0, closes = 0;
  const absent = await auditCacheState({ databases: async () => [], open() { opens++; } });
  assert.equal(absent.databaseExists, false); assert.equal(opens, 0);
  const metadata = [{ key: 'totals', entries: 2, bytes: 400, sequence: 9 }];
  const factory = { databases: async () => [{ name: 'danlingo-translations-v1' }], open() {
    opens++; const request = {};
    queueMicrotask(() => {
      request.result = { objectStoreNames: { contains: name => ['entries', 'meta'].includes(name) },
        close() { closes++; }, transaction(stores, mode) {
          assert.deepEqual(stores, ['entries', 'meta']); assert.equal(mode, 'readonly');
          const tx = { objectStore(name) { return name === 'entries' ? { count: () => ({ result: 2 }) }
            : { getAll: () => ({ result: metadata }) }; } };
          queueMicrotask(() => tx.oncomplete()); return tx;
        } }; request.onsuccess();
    }); return request;
  } };
  const before = await auditCacheState(factory), unchanged = await auditCacheState(factory);
  assert.deepEqual(before, unchanged); assert.equal(before.entries, 2);
  assert.match(before.metadataHash, /^[0-9a-f]{64}$/);
  metadata[0].sequence++;
  assert.notEqual((await auditCacheState(factory)).metadataHash, before.metadataHash);
  assert.equal(opens, closes);
});

test('audit reuses exact cache key in readonly transaction; expiration and zero capacity do not count as hits', async () => {
  const settings = { ...DEFAULT_SETTINGS, backend: 'online', endpoint: 'https://example.com/v1', model: 'test', targetLanguage: 'en' };
  const resource = 'av2:cid62131', text = '这是测试文本';
  const expectedKey = translationCacheKey(JSON.stringify(['bilibili', 'video', resource]), text, settings);
  let expiresAt = Date.now() + 60000, closed = 0;
  const factory = {
    databases: async () => [{ name: 'danlingo-translations-v1' }],
    open(name) {
      assert.equal(name, 'danlingo-translations-v1');
      const request = {};
      queueMicrotask(() => {
        request.result = { close() { closed++; }, transaction(store, mode) {
          assert.equal(store, 'entries'); assert.equal(mode, 'readonly');
          const tx = { objectStore() { return { get(key) {
            assert.equal(key, expectedKey);
            const lookup = {};
            queueMicrotask(() => { lookup.result = { text: 'This is a test.', createdAt: Date.now(), expiresAt };
              lookup.onsuccess(); tx.oncomplete(); });
            return lookup;
          } }; } }; return tx;
        } }; request.onsuccess();
      }); return request;
    },
  };
  assert.equal((await auditCache(settings, resource, [text], factory))[0].cacheHit, true);
  expiresAt = Date.now() - 1;
  assert.equal((await auditCache(settings, resource, [text], factory))[0].cacheHit, false);
  expiresAt = Date.now() + 60000;
  assert.equal((await auditCache({ ...settings, cacheMaxEntries: 0 }, resource, [text], factory))[0].cacheHit, false);
  assert.equal(closed, 3);
  assert.equal((await auditCache(settings, resource, [text], { databases: async () => [] }))[0].cacheHit, false);
});

test('DOM correlation avoids getters and creation alone does not imply visibility', () => {
  const priorElement = globalThis.Element, priorDocument = globalThis.document;
  class Element {}
  globalThis.Element = Element;
  globalThis.document = { visibilityState: 'visible' };
  try {
    const element = new Element(); element.isConnected = true; element.matches = () => false;
    const model = { renderer: { element }, get risky() { throw new Error('must not invoke getters'); } };
    assert.equal(modelElements(model)[0].element, element);
    assert.equal(modelElements(model)[0].path, 'renderer.element');
    assert.equal(visibleGeometry(element, { isConnected: true }), null);
  } finally { globalThis.Element = priorElement; globalThis.document = priorDocument; }
});

test('branch evidence never executes filtering or getters and exports only allowlisted values', () => {
  let invoked = 0;
  class Manager { validate() { invoked++; return false; } insert() { invoked++; } initRender() { invoked++; } }
  const manager = new Manager();
  manager.config = { density: 4, setting: { area: 25 }, privateBlockWords: ['do not export'],
    get aiLevel() { invoked++; return 9; }, filter() { invoked++; return false; }, fn: { filter() { invoked++; return false; } } };
  const before = Object.getOwnPropertyDescriptor(manager.config, 'aiLevel');
  const result = inspectNativeBranches({ manager, danmaku: {} });
  assert.equal(invoked, 0);
  assert.equal(result.methods.find(m => m.name === 'validate').owner, 'manager-prototype-1');
  assert.equal(result.surfaces.managerConfig.values.aiLevel.kind, 'accessor-not-invoked');
  assert.equal(result.surfaces.managerConfig.values.density.value, 4);
  assert.equal(result.surfaces.managerConfigSetting.values.area.value, 25);
  assert.match(result.surfaces.managerConfig.fnFilter.source, /return false/);
  assert.equal(JSON.stringify(result).includes('do not export'), false);
  assert.equal(Object.getOwnPropertyDescriptor(manager.config, 'aiLevel').get, before.get);
  assert.equal(Object.hasOwn(manager, 'validate'), false);
});

test('native rule inputs preserve unknown/missing weight and border bypass without coercion', () => {
  let reads = 0;
  const source = { mode: 1, get weight() { reads++; return 1; }, get border() { reads++; return false; } };
  assert.deepEqual(nativeRuleInputs(source), { weight: null, weightKind: 'accessor', borderTruthy: null, borderKind: 'accessor', onTruthy: false, onKind: 'missing', mode: 1 });
  assert.equal(reads, 0);
  assert.equal(nativeRuleInputs({ weight: '1' }).weight, null);
  assert.equal(nativeRuleInputs({}).weightKind, 'missing');
  assert.equal(nativeRuleInputs({ weight: -4, border: true }).borderTruthy, true);
  assert.equal(nativeRuleInputs({ weight: -4, border: false }).weight, -4);
  assert.equal(nativeRuleInputs(Object.create({ border: true })).borderTruthy, null);
  assert.equal(nativeRuleInputs(Object.create({ get border() { reads++; return true; } })).borderKind, 'inherited');
  assert.equal(nativeRuleInputs({ get on() { reads++; return true; } }).onTruthy, null);
  assert.equal(nativeRuleInputs({ on: true }).onTruthy, true);
  assert.equal(reads, 0);
});

test('candidate and validate input evidence is captured before native mutations, without extra calls', () => {
  let calls = 0;
  const item = { dmid: '18446744073709551615', text: '原始弹幕', stime: 12, mode: 1, weight: 1, border: false };
  const manager = { dataBase: { dmArray: [item] }, visualArray: [],
    validate(source) { calls++; source.weight = 9; return false; },
    insert(items) { for (const source of items) if (this.validate(source)) this.initRender(source); },
    initRender() { throw new Error('must remain rejected'); } };
  const original = manager.validate;
  const video = { currentTime: 10, playbackRate: 1, paused: true, isConnected: true };
  const player = { danmaku: { getDanmakuX: () => ({ manager, hooks: { beforeRender() {} },
    getMetadata: () => ({ version: '1.1.22', lastCompiled: '2026-07-14T14:26:03+08:00' }) }) },
    mediaElement: () => video, getManifest: () => ({ bvid: 'BV1xx411c7mD', aid: '2', cid: '62131', p: 1 }) };
  const probe = attachPretranslationAudit(player, 'https://www.bilibili.com/video/BV1xx411c7mD/', { timer: false, session: 'input-timing' });
  assert.equal(calls, 0);
  item.weight = 3;
  manager.insert([item]);
  const row = probe.snapshot().records[0];
  assert.equal(row.nativeInputAtCandidate.weight, 1);
  assert.equal(row.validateFirst.nativeInputBeforeCall.weight, 3);
  assert.equal(item.weight, 9);
  assert.equal(calls, 1);
  assert.equal(row.validateFirst.nativeReturn, false);
  probe.stop();
  assert.equal(manager.validate, original);
});

test('shadow integration exports cloneable identities and fails closed on later wrapper or dependency changes', () => {
  class Manager { insert() {} validate() {} }
  const manager = new Manager(), video = {};
  const hooks = { beforeRender() {} };
  const config = { setting: { area: 25, limit: 10 }, fn: { filter() {} }, hooks };
  manager.config = config;
  const danmaku = { config, hooks, getMetadata: () => ({ version: '1.1.22', lastCompiled: '2026-07-14T14:26:03+08:00' }) };
  const areaNode = { isConnected: true, textContent: '25%' };
  const root = { isConnected: true, contains: item => item === video,
    classList: { contains: () => true }, querySelectorAll: () => [areaNode],
    ownerDocument: { scripts: [{ src: 'https://s1.hdslb.com/bfs/static/player/main/core.5966babe.js' }] } };
  const binding = { manager, danmaku, video };
  const tracker = weightShadowTracker(binding, root, { verified: true, sha256: WEIGHT_CONTRACT_SHA256 },
    readWeightDependencies(binding, root));
  manager.insert = function auditInsert() {};
  manager.validate = function auditValidate() {};
  const first = structuredClone(tracker.readContext());
  const input = nativeRuleInputs({ mode: 1, weight: 1 });
  assert.equal(tracker.predict(input, first).decision, 'exclude');
  assert.ok(first.fingerprint.length < 512);
  assert.ok(JSON.stringify(first).length < 8192);
  assert.equal(tracker.readContext().fingerprint, first.fingerprint);
  areaNode.textContent = '50%';
  assert.equal(tracker.predict(input, structuredClone(tracker.readContext())).decision, 'unknown');
  areaNode.textContent = '25%';
  const observedValidate = manager.validate;
  manager.validate = function laterWrapper() {};
  assert.equal(tracker.predict(input, tracker.readContext()).decision, 'unknown');
  manager.validate = observedValidate;
  config.fn.filter = function changedFilter() {};
  assert.equal(tracker.predict(input, tracker.readContext()).decision, 'unknown');
});
