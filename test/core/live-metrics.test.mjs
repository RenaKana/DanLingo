import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMetrics } from '../../src/core/live-metrics.ts';

const metrics = () => ({ received:4,submitted:3,presented:2,translated:1,original:1,timedOut:1,overloaded:0,removed:0,abandoned:0,pending:1,
  translatedChars:12,cachedTranslated:1,observationMs:2000,readinessMs:{p50:100,p95:150,p99:160,samples:1},releaseDelayMs:{p50:100,p95:2000,p99:2000,samples:3} });
test('page metrics use an independent numeric whitelist across the background boundary',()=>{
  const input={...metrics(),message:'private',author:'private',readinessMs:{...metrics().readinessMs,key:'private'}};
  const output=nativeMetrics(input); assert.deepEqual(output,metrics());
  output.readinessMs.p50=0;assert.equal(input.readinessMs.p50,100);
});
test('invalid or unbounded page aggregates fail closed',()=>{
  for(const invalid of [null,{}, {...metrics(),received:Infinity},{...metrics(),pending:-1},{...metrics(),readinessMs:{p50:0,p95:0,p99:0,samples:1201}}])assert.equal(nativeMetrics(invalid),undefined);
});
