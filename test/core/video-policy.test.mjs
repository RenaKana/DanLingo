import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoEligibility } from '../../src/core/video-policy.ts';

const valid = () => ({ revision: 1, epoch: 3, reset: true, capability: 'unknown', display: 'visible',
  items: [{ id: 'one', originalText: '原文', state: 'filtered' }] });

test('native qualification parser bounds the wire shape and retains no private rule fields', () => {
  const update = valid();
  update.items[0].blacklist = 'private rule'; update.author = 'private identifier';
  assert.deepEqual(parseVideoEligibility(update), valid());
  for (const patch of [{ revision: -1 }, { revision: Infinity }, { epoch: 0.5 }, { reset: 'true' },
    { capability: 'assumed-visible' }, { display: 'off' }, { items: {} }, { items: Array(201).fill(update.items[0]) },
    { items: [update.items[0], update.items[0]] }, { items: [{ ...update.items[0], originalText: 'x'.repeat(1001) }] },
    { items: [{ ...update.items[0], id: '' }] }, { items: [{ ...update.items[0], state: 'blacklisted' }] }]) {
    assert.equal(parseVideoEligibility({ ...valid(), ...patch }), null);
  }
});
