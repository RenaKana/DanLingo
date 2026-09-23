import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OnlineBudgetError,
  onlineBudgetDayKey,
  validOnlineBudgetLimit,
} from '../../src/core/online-budget.ts';

test('online budget day keys use local calendar fields and a stable YYYY-MM-DD shape', () => {
  const date = new Date(2026, 0, 2, 0, 15, 0);
  const expected = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  assert.equal(onlineBudgetDayKey(date), expected);
  assert.match(onlineBudgetDayKey(date), /^\d{4}-\d{2}-\d{2}$/u);
  assert.throws(() => onlineBudgetDayKey(new Date(Number.NaN)), RangeError);
});

test('online request budget accepts only positive safe integer limits', () => {
  for (const value of [1, 2, Number.MAX_SAFE_INTEGER]) assert.equal(validOnlineBudgetLimit(value), true);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '4', null]) {
    assert.equal(validOnlineBudgetLimit(value), false);
  }
});

test('online budget errors expose stable machine-readable codes', () => {
  for (const code of ['online-daily-limit-reached', 'online-budget-storage-unavailable', 'cancelled']) {
    const error = new OnlineBudgetError(code);
    assert.equal(error.name, 'OnlineBudgetError');
    assert.equal(error.code, code);
    assert.equal(error.message, code);
  }
});
