import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePreviewBudget } from '../../src/diagnostics/live-preview-budget.ts';

function createStore(initial = null) {
  let value = initial === null ? null : structuredClone(initial);
  let writes = 0;
  let failWrite = false;
  return {
    async read() {
      return value === null ? null : structuredClone(value);
    },
    async write(record) {
      writes += 1;
      if (failWrite) {
        failWrite = false;
        throw new Error('storage detail must not escape');
      }
      value = structuredClone(record);
    },
    get value() { return value === null ? null : structuredClone(value); },
    get writes() { return writes; },
    failNextWrite() { failWrite = true; },
  };
}

const item = (id, text = 'hello') => ({ id, text });

test('persists only item identities and UTF-16 lengths before issuing a permit', async () => {
  const store = createStore();
  const budget = new LivePreviewBudget(store);
  assert.equal(await budget.readSnapshot(), null);
  await budget.open('task-1', 'model-a', 'config-a');
  await budget.beginPhase('main', 'run-1');

  const permit = await budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'attempt-1', items: [item('comment-1', 'A😀')] });

  assert.equal(permit.schema, 'danlingo-local-preview-permit');
  assert.equal(permit.itemCount, 1);
  assert.equal(permit.utf16Chars, 3);
  assert.equal(budget.validatePermit(permit, [item('comment-1', 'A😀')]), true);
  assert.equal(budget.validatePermit(permit, [item('comment-1', 'B😀')]), true,
    'the ledger binds budget by item ID and UTF-16 length; the host guard binds the final payload');
  assert.equal(budget.validatePermit({ ...permit }, [item('comment-1', 'A😀')]), false);
  assert.equal(JSON.stringify(store.value).includes('A😀'), false);
  assert.deepEqual(store.value.attempts[0].items, [{ id: 'comment-1', utf16Length: 3 }]);
  assert.deepEqual(budget.snapshot().total, {
    limits: { requests: 140, items: 140, utf16Chars: 14_000 },
    occupied: { requests: 1, items: 1, utf16Chars: 3 },
    actualSent: { requests: 0, items: 0, utf16Chars: 0 },
    remaining: { requests: 139, items: 139, utf16Chars: 13_997 },
  });
});

test('reopening marks unfinished reservations uncertain and charges them permanently', async () => {
  const store = createStore();
  const first = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await first.beginPhase('main', 'run-1');
  await first.reserve({ phase: 'main', runId: 'run-1', attemptId: 'attempt-1', items: [item('one', 'pending')] });

  const observer = new LivePreviewBudget(store);
  const observed = await observer.readSnapshot();
  assert.equal(observed.attempts[0].status, 'reserved');
  assert.equal(store.value.attempts[0].status, 'reserved', 'status reads do not recover or mutate the ledger');

  const reopened = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');

  assert.equal(reopened.snapshot().attempts[0].status, 'uncertain');
  assert.equal(reopened.snapshot().total.occupied.requests, 1);
  assert.equal(reopened.snapshot().total.actualSent.requests, 0);
  assert.equal(reopened.snapshot().usage.complete, false);
  await assert.rejects(reopened.reserve({ phase: 'main', runId: 'run-1', attemptId: 'attempt-1', items: [item('one')] }), /identities cannot be reused/);
});

test('settlement reports actual sends separately, accumulates usage, and never frees occupied budget', async () => {
  const store = createStore();
  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await budget.beginPhase('main', 'run-1');
  await budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'sent-1', items: [item('a', 'abc'), item('b', '😀')] });
  await budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'not-sent-1', items: [item('c', 'x')] });
  await budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'failed-1', items: [item('d', 'oops')] });
  await budget.settle('sent-1', { status: 'sent' });
  assert.equal(budget.snapshot().phases.main.actualSent.requests, 1);
  await budget.settle('sent-1', { status: 'completed', usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11, reasoningTokens: 1 } });
  await budget.settle('not-sent-1', { status: 'not-sent' });
  await budget.settle('failed-1', { status: 'sent' });
  await budget.settle('failed-1', { status: 'failed', usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 } });

  const snapshot = budget.snapshot();
  assert.deepEqual(snapshot.phases.main.occupied, { requests: 3, items: 4, utf16Chars: 10 });
  assert.deepEqual(snapshot.phases.main.actualSent, { requests: 2, items: 3, utf16Chars: 9 });
  assert.equal(snapshot.phases.main.remaining.requests, 97);
  assert.equal(snapshot.usage.complete, true);
  assert.equal(snapshot.usage.sentAttempts, 2);
  assert.equal(snapshot.usage.reportedAttempts, 2);
  assert.deepEqual(snapshot.usage.totals, { promptTokens: 8, completionTokens: 4, totalTokens: 12, reasoningTokens: 1 });
  assert.equal(snapshot.attempts.find(attempt => attempt.attemptId === 'failed-1').status, 'failed');
  await assert.rejects(budget.settle('sent-1', { status: 'failed' }), /already been settled/);
});

test('allows one repair phase only after main, requires a reason, and applies separate caps', async () => {
  const store = createStore();
  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await assert.rejects(budget.beginPhase('repair', 'repair-run', 'fix a failed phrase'), /only after the main phase/);
  await budget.beginPhase('main', 'main-run');
  await assert.rejects(budget.beginPhase('repair', 'repair-run', '  '), /reason is required/);
  await budget.beginPhase('repair', 'repair-run', 'fix a failed phrase');
  await assert.rejects(budget.beginPhase('repair', 'other-repair', 'fix a failed phrase'), /different run identity/);
  await assert.rejects(budget.reserve({ phase: 'main', runId: 'main-run', attemptId: 'late-main', items: [item('late')] }), /closed after repair/);

  for (let index = 0; index < 40; index += 1) {
    await budget.reserve({ phase: 'repair', runId: 'repair-run', attemptId: `repair-${index}`, items: [item(`repair-item-${index}`)] });
  }
  await assert.rejects(budget.reserve({ phase: 'repair', runId: 'repair-run', attemptId: 'repair-over', items: [item('repair-over-item')] }), /exceeds its limit/);
  assert.equal(budget.snapshot().phases.repair.occupied.requests, 40);
});

test('accepts an existing v1 main and repair ledger for one reasoned supplement without losing usage', async () => {
  const store = createStore();
  const first = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await first.beginPhase('main', 'main-run');
  await first.reserve({ phase: 'main', runId: 'main-run', attemptId: 'old-main', items: [item('old-a', 'abc')] });
  await first.settle('old-main', { status: 'completed', usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 } });
  await first.beginPhase('repair', 'repair-run', 'first repair');
  await first.reserve({ phase: 'repair', runId: 'repair-run', attemptId: 'old-repair', items: [item('old-b', 'xy')] });
  await first.settle('old-repair', { status: 'completed', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
  const legacy = store.value;
  delete legacy.phaseRuns.supplement;
  await store.write(legacy);

  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  assert.deepEqual(store.value, legacy, 'opening an old v1 record does not rewrite it');
  await assert.rejects(budget.beginPhase('supplement', 'supplement-run', '  '), /supplement reason is required/);
  await budget.beginPhase('supplement', 'supplement-run', 'explicit extra full pass');
  await budget.beginPhase('supplement', 'supplement-run', 'explicit extra full pass');
  await assert.rejects(budget.beginPhase('supplement', 'another-run', 'extra pass'), /different run identity/);
  await assert.rejects(budget.reserve({ phase: 'main', runId: 'main-run', attemptId: 'late-main', items: [item('late-a')] }), /closed after/);
  await assert.rejects(budget.reserve({ phase: 'repair', runId: 'repair-run', attemptId: 'late-repair', items: [item('late-b')] }), /closed after supplement/);
  await budget.reserve({ phase: 'supplement', runId: 'supplement-run', attemptId: 'supplement-1', items: [item('new-a', '😀')] });
  assert.deepEqual(store.value.attempts.slice(0, 2), legacy.attempts);
  assert.deepEqual(store.value.phaseRuns, { main: 'main-run', repair: 'repair-run', supplement: 'supplement-run' });
  assert.deepEqual(budget.snapshot().usage.totals, { promptTokens: 13, completionTokens: 5, totalTokens: 18 });
  assert.deepEqual(budget.snapshot().total.occupied, { requests: 3, items: 3, utf16Chars: 7 });
  assert.equal(budget.snapshot().phases.supplement.runId, 'supplement-run');
  await assert.rejects(LivePreviewBudget.open(store, 'task-1', 'model-b', 'config-a'), /identity does not match/);
});

test('supplement reservations respect all three cumulative caps and their snapshot remaining amounts', async () => {
  const attempt = (phase, runId, index, items) => ({
    attemptId: `${phase}-${index}`, phase, runId, items, status: 'completed',
  });
  const record = attempts => ({
    schema: 'danlingo-local-preview-budget', version: 1, taskId: 'task-1',
    modelIdentity: 'model-a', configIdentity: 'config-a',
    phaseRuns: { main: 'main-run', repair: 'repair-run' }, attempts,
  });
  const supplement = (attemptId, text) => ({
    phase: 'supplement', runId: 'supplement-run', attemptId, items: [item(attemptId, text)],
  });

  const requests = await LivePreviewBudget.open(createStore(record([
    ...Array.from({ length: 100 }, (_, index) => attempt('main', 'main-run', index, [{ id: `m-${index}`, utf16Length: 1 }])),
    ...Array.from({ length: 39 }, (_, index) => attempt('repair', 'repair-run', index, [{ id: `r-${index}`, utf16Length: 1 }])),
  ])), 'task-1', 'model-a', 'config-a');
  await requests.beginPhase('supplement', 'supplement-run', 'one remaining request');
  assert.equal(requests.snapshot().phases.supplement.remaining.requests, 1);
  await requests.reserve(supplement('last-request', 'x'));
  await assert.rejects(requests.reserve(supplement('too-many-requests', 'x')), /exceeds its limit/);
  assert.equal(requests.snapshot().phases.supplement.occupied.requests, 1);
  assert.equal(requests.snapshot().phases.supplement.remaining.requests, 0);

  const items = await LivePreviewBudget.open(createStore(record([
    attempt('main', 'main-run', 0, Array.from({ length: 100 }, (_, index) => ({ id: `m-${index}`, utf16Length: 1 }))),
    attempt('repair', 'repair-run', 0, Array.from({ length: 39 }, (_, index) => ({ id: `r-${index}`, utf16Length: 1 }))),
  ])), 'task-1', 'model-a', 'config-a');
  await items.beginPhase('supplement', 'supplement-run', 'one remaining item');
  assert.equal(items.snapshot().phases.supplement.remaining.items, 1);
  await items.reserve(supplement('last-item', 'x'));
  await assert.rejects(items.reserve(supplement('too-many-items', 'x')), /exceeds its limit/);
  assert.equal(items.snapshot().phases.supplement.remaining.items, 0);

  const utf16 = await LivePreviewBudget.open(createStore(record([
    attempt('main', 'main-run', 0, [{ id: 'm', utf16Length: 10_000 }]),
    attempt('repair', 'repair-run', 0, [{ id: 'r', utf16Length: 4_000 }]),
  ])), 'task-1', 'model-a', 'config-a');
  await utf16.beginPhase('supplement', 'supplement-run', 'no remaining text budget');
  assert.equal(utf16.snapshot().phases.supplement.remaining.utf16Chars, 0);
  await assert.rejects(utf16.reserve(supplement('too-many-chars', 'x')), /exceeds its limit/);
  assert.equal(utf16.snapshot().total.occupied.utf16Chars, 14_000);
});

test('requires completed phase registration and rejects malformed optional supplement fields', async () => {
  const store = createStore();
  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await assert.rejects(budget.beginPhase('supplement', 'supplement-run', 'extra pass'), /only after the main phase/);
  await budget.beginPhase('main', 'main-run');
  await assert.rejects(budget.beginPhase('supplement', 'supplement-run', 'extra pass'), /only after the repair phase/);
  const base = store.value;
  for (const supplement of ['', undefined, 3]) {
    const invalid = createStore({ ...base, phaseRuns: { ...base.phaseRuns, supplement } });
    await assert.rejects(LivePreviewBudget.open(invalid, 'task-1', 'model-a', 'config-a'), /Invalid supplement run identity/);
  }
  const unregistered = createStore({ ...base, attempts: [{
    attemptId: 'extra', phase: 'supplement', runId: 'supplement-run',
    items: [{ id: 'extra', utf16Length: 1 }], status: 'completed',
  }] });
  await assert.rejects(LivePreviewBudget.open(unregistered, 'task-1', 'model-a', 'config-a'), /Invalid local preview budget record/);
});

test('serializes concurrent reservations so a boundary cannot be exceeded', async () => {
  const store = createStore();
  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await budget.beginPhase('main', 'run-1');
  const results = await Promise.allSettled(Array.from({ length: 101 }, (_, index) => budget.reserve({
    phase: 'main', runId: 'run-1', attemptId: `attempt-${index}`, items: [item(`item-${index}`)],
  })));

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 100);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(budget.snapshot().phases.main.occupied.requests, 100);
});

test('rejects mismatched identities and fails closed when storage reads or writes fail', async () => {
  const store = createStore();
  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await budget.beginPhase('main', 'run-1');
  await assert.rejects(LivePreviewBudget.open(store, 'task-2', 'model-a', 'config-a'), /different task/);
  await assert.rejects(LivePreviewBudget.open(store, 'task-1', 'model-b', 'config-a'), /identity does not match/);

  store.failNextWrite();
  await assert.rejects(budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'failed-write', items: [item('one', 'secret')] }), /Unable to persist/);
  assert.equal(budget.snapshot().total.occupied.requests, 0);
  assert.equal(JSON.stringify(store.value).includes('secret'), false);
});

test('rejects invalid reservation inputs and refuses an incomplete identity record', async () => {
  const store = createStore();
  const budget = await LivePreviewBudget.open(store, 'task-1', 'model-a', 'config-a');
  await budget.beginPhase('main', 'run-1');
  await assert.rejects(budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'empty', items: [] }), /at least one item/);
  await assert.rejects(budget.reserve({ phase: 'main', runId: 'run-1', attemptId: 'duplicate', items: [item('same'), item('same')] }), /duplicate item identities/);
  await assert.rejects(budget.reserve({ phase: 'main', runId: 'wrong-run', attemptId: 'wrong-run', items: [item('one')] }), /active phase run/);
  const corruptStore = createStore({ schema: 'danlingo-local-preview-budget', version: 1 });
  await assert.rejects(LivePreviewBudget.open(corruptStore, 'task-1', 'model-a', 'config-a'), /Invalid local preview budget record/);
});
