import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentFilterRows, createExperimentFilterPublisher } from '../../src/diagnostics/bilibili-experiment-native.mjs';

const identity = { resourceId: 'av2:cid62131', urlResourceId: 'BV1xx411c7mD:p1', aid: '2', cid: '62131', page: 1, bvid: 'BV1xx411c7mD' };
test('only inactive events are filtered; original pool, same-text events and baseline remain intact', () => {
  const pool = [
    { dmid: '1234567890123456789', text: 'same text', stime: 12, mode: 1, weight: 1 },
    { dmid: '1234567890123456790', text: 'same text', stime: 13, mode: 1, weight: 1, on: true },
    { dmid: '1234567890123456791', text: 'same text', stime: 14, mode: 1, weight: 1 },
  ];
  let reads = 0;
  Object.defineProperty(pool[2], 'on', { get() { reads++; return false; } });
  const binding = { identity, manager: { dataBase: { dmArray: pool } } };
  let predicts = 0;
  const tracker = { readContext: () => ({ fingerprint: 'a' }), predict: () => { predicts++; return { decision: 'exclude' }; } };
  const originalText = pool.map(row => row.text);
  const filtered = experimentFilterRows(binding, tracker, true);
  assert.deepEqual(filtered.rows.map(row => row.state), ['filtered', 'unknown', 'unknown']);
  assert.equal(new Set(filtered.rows.map(row => row.id)).size, 3);
  assert.equal(reads, 0); assert.equal(predicts, 1);
  assert.deepEqual(pool.map(row => row.text), originalText);
  assert.ok(experimentFilterRows(binding, tracker, false).rows.every(row => row.state === 'unknown'));
  assert.equal(predicts, 1);
});

test('filter publication gates readiness until complete, restores changes and resets on dependency invalidation', () => {
  const sent = [], publisher = createExperimentFilterPublisher(value => sent.push(value));
  const rows = Array.from({ length: 201 }, (_, i) => ({ id: String(i), originalText: 'x', state: 'filtered' }));
  publisher.publish({ rows, fingerprint: 'a' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].reset, true); assert.equal(sent[0].ready, false);
  assert.equal(sent[1].reset, false); assert.equal(sent[1].ready, true);
  publisher.publish({ rows, fingerprint: 'a' });
  assert.deepEqual(sent.at(-1).items, []); assert.equal(sent.at(-1).ready, true);
  publisher.publish({ rows: rows.slice(1), fingerprint: 'a' });
  assert.deepEqual(sent.at(-1).items, [{ ...rows[0], state: 'unknown' }]);
  publisher.publish({ rows: rows.map(row => ({ ...row, state: 'unknown' })), fingerprint: 'b' });
  assert.equal(sent.at(-2).reset, true);
  assert.ok(sent.at(-1).items.every(row => row.state === 'unknown'));
  publisher.stop();
  assert.deepEqual(sent.at(-1), { revision: 7, reset: true, ready: false, items: [] });
});
