import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelEffortMetadata, sanitizeModelEffortMetadata } from '../../src/core/model-capabilities.ts';

test('reads arbitrary bounded effort names and discards unrelated provider fields', () => {
  assert.deepEqual(parseModelEffortMetadata({id:'new-model', cost:'secret', effort:{
    supported_levels:['low','ultra','low','thinking_2'], default_level:'ultra', hidden:'secret',
  }}), {supportedLevels:['low','ultra','thinking_2'], defaultLevel:'ultra'});
  assert.deepEqual(sanitizeModelEffortMetadata({supportedLevels:['xhigh'], defaultLevel:'high', hidden:'secret'}),
    {supportedLevels:['xhigh']});
});

test('malformed or unsafe effort lists never grant capabilities', () => {
  for (const levels of [[], 'high', ['HIGH'], ['high\n'], ['default'], ['off'], ['on'], ['__proto__'], ['constructor'],
    ['prototype'], ['high', null], ['a'.repeat(33)], Array(17).fill('high')]) {
    assert.equal(parseModelEffortMetadata({effort:{supported_levels:levels}}), undefined);
    assert.equal(sanitizeModelEffortMetadata({supportedLevels:levels}), undefined);
  }
  for (const row of [{}, {effort:null}, {effort:{default_level:'high'}}, {effort:{supported_levels:[]}}])
    assert.equal(parseModelEffortMetadata(row), undefined);
  assert.deepEqual(parseModelEffortMetadata({effort:{supported_levels:['low'],default_level:'__proto__'}}),
    {supportedLevels:['low']});
  assert.deepEqual(parseModelEffortMetadata({effort:{supported_levels:['none','xhigh'],default_level:'none'}}),
    {supportedLevels:['none','xhigh'],defaultLevel:'none'});
  assert.deepEqual(sanitizeModelEffortMetadata(Object.assign(Object.create({defaultLevel:'high'}),
    {supportedLevels:['high']})), {supportedLevels:['high']});
});
