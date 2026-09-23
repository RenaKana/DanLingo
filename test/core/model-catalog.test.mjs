import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalogStore, modelCatalogScope, MODEL_CATALOG_KEY } from '../../src/core/model-catalog.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
test('catalog isolates canonical service/protocol/credential and persists without raw credentials', async () => {
  const data = {}, storage = { get: async () => structuredClone(data), set: async value => Object.assign(data, value) };
  const store = new ModelCatalogStore(storage), settings = {...DEFAULT_SETTINGS,endpoint:'https://EXAMPLE.com/v1'};
  const a = await modelCatalogScope(settings,'secret-A'), b = await modelCatalogScope(settings,'secret-B');
  assert.equal(a, await modelCatalogScope({...settings, endpoint:'https://example.com/v1/chat/completions'},'secret-A'));
  assert.notEqual(a,b); assert.notEqual(a,await modelCatalogScope({...settings,endpoint:'https://elsewhere.example/v1'},'secret-A'));
  await Promise.all([store.write(a,['one','one','two'],10),store.write(b,['other'],20)]);
  assert.deepEqual(await new ModelCatalogStore(storage).read(a),{models:['one','two'],fetchedAt:10});
  assert.deepEqual(await store.read(b),{models:['other'],fetchedAt:20});
  await store.write(a,[],30); assert.equal((await store.read(a)).fetchedAt,10);
  assert.ok(!JSON.stringify(data[MODEL_CATALOG_KEY]).includes('secret-'));
});
