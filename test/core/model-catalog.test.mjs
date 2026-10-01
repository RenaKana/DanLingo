import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalogStore, modelCatalogScope, MODEL_CATALOG_KEY, selectModelEffort } from '../../src/core/model-catalog.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';
test('catalog isolates canonical service/protocol/credential and persists without raw credentials', async () => {
  const data = {}, storage = { get: async () => structuredClone(data), set: async value => Object.assign(data, value) };
  const store = new ModelCatalogStore(storage), settings = onlineSettings({endpoint:'https://EXAMPLE.com/v1'});
  const a = await modelCatalogScope(settings,'secret-A'), b = await modelCatalogScope(settings,'secret-B');
  assert.equal(a, await modelCatalogScope({...settings, endpoint:'https://example.com/v1/chat/completions'},'secret-A'));
  assert.notEqual(a,b); assert.notEqual(a,await modelCatalogScope({...settings,endpoint:'https://elsewhere.example/v1'},'secret-A'));
  await Promise.all([store.write(a,['one','one','two'],10),store.write(b,['other'],20)]);
  assert.deepEqual(await new ModelCatalogStore(storage).read(a),{models:['one','two'],fetchedAt:10});
  assert.deepEqual(await store.read(b),{models:['other'],fetchedAt:20});
  await store.write(a,[],30); assert.equal((await store.read(a)).fetchedAt,10);
  assert.ok(!JSON.stringify(data[MODEL_CATALOG_KEY]).includes('secret-'));
});

test('optional metadata is scoped, sanitized, and retained until the next successful discovery', async () => {
  const data = {}, storage = { get: async () => structuredClone(data), set: async value => Object.assign(data, value) };
  const store = new ModelCatalogStore(storage), settings = onlineSettings({endpoint:'https://example.com/v1'});
  const scope = await modelCatalogScope(settings,'secret-A');
  const otherScope = await modelCatalogScope(settings,'secret-B');
  const timestamp = 10_000;
  const capabilities = Object.create(null);
  capabilities['new/model'] = {supportedLevels:['low','ultra'],defaultLevel:'ultra', remote:'secret'};
  capabilities['__proto__'] = {supportedLevels:['high'],defaultLevel:'high'};
  capabilities.unlisted = {supportedLevels:['high']};
  await store.write(scope,['new/model','__proto__'],timestamp,capabilities);
  const catalog = await new ModelCatalogStore(storage).read(scope);
  assert.deepEqual(catalog.models,['new/model','__proto__']);
  assert.deepEqual(selectModelEffort(catalog,'new/model',timestamp), {supportedLevels:['low','ultra'],defaultLevel:'ultra'});
  assert.deepEqual(selectModelEffort(catalog,'__proto__',timestamp), {supportedLevels:['high'],defaultLevel:'high'});
  assert.equal(Object.hasOwn(catalog.capabilities,'unlisted'), false);
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(await store.read(otherScope), undefined);
  assert.equal(selectModelEffort(catalog,'new/model',timestamp + 2 * 24 * 60 * 60 * 1000)?.defaultLevel,'ultra');
  assert.equal(selectModelEffort(catalog,'new/model',timestamp - 1),undefined);
  assert.equal(selectModelEffort(catalog,'other',timestamp),undefined);
  assert.equal(selectModelEffort(catalog,'new/model',NaN),undefined);
  assert.deepEqual(catalog.models,['new/model','__proto__']);
  await store.write(scope, ['new/model'], timestamp + 100, { 'new/model': { supportedLevels: ['low'] } });
  assert.deepEqual(selectModelEffort(await new ModelCatalogStore(storage).read(scope), 'new/model', timestamp + 100),
    { supportedLevels: ['low'] }, 'a successful refresh replaces, rather than merges, old capabilities');
  await store.write(scope, ['new/model'], timestamp + 200);
  assert.equal(selectModelEffort(await store.read(scope), 'new/model', timestamp + 200), undefined,
    'a new names-only discovery cannot retain obsolete capability claims');
});

test('legacy and corrupt metadata caches remain names-only with safe own reads', async () => {
  const scope='scope', inherited={supportedLevels:['high']};
  const storage={get:async()=>({[MODEL_CATALOG_KEY]:{[scope]:{
    models:['legacy','inherited','invalid'],fetchedAt:10,
    capabilities:Object.assign(Object.create({inherited}),{invalid:{supportedLevels:['bad\nlevel']}}),
  }}}),set:async()=>{}};
  const catalog=await new ModelCatalogStore(storage).read(scope);
  assert.deepEqual(catalog,{models:['legacy','inherited','invalid'],fetchedAt:10});
  assert.equal(selectModelEffort(catalog,'legacy',10),undefined);
});
