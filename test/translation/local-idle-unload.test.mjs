import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_IDLE_TIMEOUT_MS, LocalIdleUnloader } from '../../src/local/idle-unload.ts';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

class FakeClock {
  #now = 0;
  #next = 0;
  #timers = [];
  scheduleCalls = 0;
  cancelCalls = 0;

  now = () => this.#now;

  schedule = (callback, delayMs) => {
    this.scheduleCalls++;
    const timer = { id: ++this.#next, due: this.#now + delayMs, callback, cancelled: false };
    this.#timers.push(timer);
    return timer;
  };

  cancel = (timer) => {
    this.cancelCalls++;
    if (timer) timer.cancelled = true;
  };

  advance(ms) {
    this.#now += ms;
    const due = this.#timers.filter(timer => !timer.cancelled && timer.due <= this.#now);
    const dueIds = new Set(due.map(timer => timer.id));
    this.#timers = this.#timers.filter(timer => !dueIds.has(timer.id));
    for (const timer of due.sort((a, b) => a.due - b.due || a.id - b.id)) {
      if (!timer.cancelled) timer.callback();
    }
  }

  pending() {
    return this.#timers.filter(timer => !timer.cancelled);
  }
}

const readyState = (overrides = {}) => ({
  phase: 'ready',
  generation: 1,
  active: 0,
  queued: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  peakActive: 0,
  inferenceCalls: 0,
  contextTokens: 2048,
  verifiedTranslation: false,
  ...overrides,
});

function harness(initial = {}) {
  const clock = new FakeClock();
  let state = readyState(initial);
  let blocked = false;
  let check = async () => true;
  let canUnloadCalls = 0;
  let unloadCalls = 0;
  const unloadedStates = [];
  const controller = new LocalIdleUnloader({
    snapshot: () => structuredClone(state),
    unload: () => {
      unloadCalls++;
      state = { ...state, phase: 'idle', generation: state.generation + 1, active: 0, queued: 0 };
      return structuredClone(state);
    },
    canUnload: () => {
      canUnloadCalls++;
      return check();
    },
    unloaded: value => unloadedStates.push(structuredClone(value)),
    blocked: () => blocked,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  return {
    clock,
    controller,
    unloadedStates,
    get state() { return structuredClone(state); },
    get canUnloadCalls() { return canUnloadCalls; },
    get unloadCalls() { return unloadCalls; },
    setState(patch) { state = { ...state, ...patch }; },
    replaceReady(patch = {}) {
      state = { ...state, ...patch, phase: 'ready', generation: state.generation + 1, active: 0, queued: 0 };
    },
    setBlocked(value) { blocked = value; },
    setCheck(fn) { check = fn; },
  };
}

async function advance(h, ms) {
  h.clock.advance(ms);
  await flush();
}

test('unloads at exactly the five-minute idle threshold', async () => {
  const h = harness();
  assert.equal(LOCAL_IDLE_TIMEOUT_MS, 300_000);
  h.controller.changed();

  await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);
  assert.equal(h.canUnloadCalls, 0);
  assert.equal(h.unloadCalls, 0);

  await advance(h, 1);
  assert.equal(h.canUnloadCalls, 1);
  assert.equal(h.unloadCalls, 1);
  assert.equal(h.unloadedStates.length, 1);
});

test('repeated read-only polling does not extend an existing idle deadline', async () => {
  const h = harness();
  h.controller.changed();
  await advance(h, 100_000);
  h.controller.changed();
  await advance(h, 100_000);
  h.controller.changed();
  await advance(h, 99_999);
  h.controller.changed();

  assert.equal(h.clock.scheduleCalls, 1);
  await advance(h, 1);
  assert.equal(h.unloadCalls, 1);
});

test('a hold cancels the timer and release starts a fresh full idle window', async () => {
  const h = harness();
  h.controller.changed();
  const release = h.controller.hold();
  assert.equal(h.clock.pending().length, 0);

  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.canUnloadCalls, 0);
  assert.equal(h.unloadCalls, 0);

  release();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);
  assert.equal(h.unloadCalls, 0);
  await advance(h, 1);
  assert.equal(h.unloadCalls, 1);
});

for (const [label, busy] of [
  ['loading', { phase: 'loading' }],
  ['active generation work', { phase: 'generating', active: 1 }],
  ['queued generation work', { phase: 'ready', queued: 1 }],
]) {
  test(`${label} prevents an idle release and allows a later idle restart`, async () => {
    const h = harness();
    h.controller.changed();
    h.setState(busy);
    h.controller.changed();

    await advance(h, LOCAL_IDLE_TIMEOUT_MS);
    assert.equal(h.unloadCalls, 0);

    h.setState({ phase: 'ready', active: 0, queued: 0 });
    h.controller.changed();
    await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);
    assert.equal(h.unloadCalls, 0);
    await advance(h, 1);
    assert.equal(h.unloadCalls, 1);
  });
}

test('completion restarts the idle window from completion time', async () => {
  const h = harness();
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);

  h.setState({ phase: 'generating', active: 1 });
  h.controller.changed();
  await advance(h, 10_000);
  h.setState({ phase: 'ready', active: 0, queued: 0, completed: 1 });
  h.controller.changed();

  await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);
  assert.equal(h.unloadCalls, 0);
  await advance(h, 1);
  assert.equal(h.unloadCalls, 1);
});

test('a blocked benchmark prevents idle scheduling until the block clears', async () => {
  const h = harness();
  h.setBlocked(true);
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.canUnloadCalls, 0);
  assert.equal(h.unloadCalls, 0);

  h.setBlocked(false);
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.unloadCalls, 1);
});

test('a new demand during an async permission check invalidates the pending release', async () => {
  const h = harness();
  const permission = deferred();
  h.setCheck(() => permission.promise);
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.canUnloadCalls, 1);

  h.setState({ phase: 'generating', active: 1 });
  h.controller.changed();
  permission.resolve(true);
  await flush();
  assert.equal(h.unloadCalls, 0);
  assert.equal(h.unloadedStates.length, 0);

  h.setState({ phase: 'ready', active: 0, queued: 0 });
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.unloadCalls, 1);
});

test('a ready-state demand hold and release invalidates a pending permission check', async () => {
  const h = harness();
  const permission = deferred();
  h.setCheck(() => permission.promise);
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.canUnloadCalls, 1);

  const release = h.controller.hold();
  assert.equal(h.clock.pending().length, 0);
  release();
  assert.equal(h.clock.pending().length, 1);

  permission.resolve(true);
  await flush();
  assert.equal(h.unloadCalls, 0);
  await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);
  assert.equal(h.unloadCalls, 0);
  await advance(h, 1);
  assert.equal(h.unloadCalls, 1);
});

test('a replacement generation stays protected even when the replacement is ready', async () => {
  const h = harness();
  const permission = deferred();
  h.setCheck(() => permission.promise);
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.canUnloadCalls, 1);

  h.replaceReady({ completed: 2 });
  permission.resolve(true);
  await flush();
  assert.equal(h.unloadCalls, 0);
  assert.equal(h.unloadedStates.length, 0);

  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.unloadCalls, 1);
});

for (const [label, result] of [
  ['denied', () => Promise.resolve(false)],
  ['rejected', () => Promise.reject(new Error('permission unavailable'))],
]) {
  test(`a ${label} permission check retries only after another full idle window`, async () => {
    const h = harness();
    let checks = 0;
    h.setCheck(() => ++checks === 1 ? result() : Promise.resolve(true));
    h.controller.changed();

    await advance(h, LOCAL_IDLE_TIMEOUT_MS);
    assert.equal(h.canUnloadCalls, 1);
    assert.equal(h.unloadCalls, 0);
    assert.equal(h.clock.pending().length, 1);

    await advance(h, LOCAL_IDLE_TIMEOUT_MS - 1);
    assert.equal(h.canUnloadCalls, 1);
    assert.equal(h.unloadCalls, 0);

    await advance(h, 1);
    assert.equal(h.canUnloadCalls, 2);
    assert.equal(h.unloadCalls, 1);
  });
}

test('successful timeout unloads the controller once and emits one completion callback', async () => {
  const h = harness();
  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS);
  assert.equal(h.unloadCalls, 1);
  assert.equal(h.unloadedStates.length, 1);

  h.controller.changed();
  await advance(h, LOCAL_IDLE_TIMEOUT_MS * 2);
  assert.equal(h.unloadCalls, 1);
  assert.equal(h.unloadedStates.length, 1);
});

test('manual unload and dispose invalidate stale timer callbacks', async () => {
  const manual = harness();
  const manualPermission = deferred();
  manual.setCheck(() => manualPermission.promise);
  manual.controller.changed();
  await advance(manual, LOCAL_IDLE_TIMEOUT_MS);
  manual.setState({ phase: 'idle', generation: manual.state.generation + 1, active: 0, queued: 0, completed: 3 });
  manualPermission.resolve(true);
  await flush();
  assert.equal(manual.unloadCalls, 0);
  assert.equal(manual.unloadedStates.length, 0);
  assert.equal(manual.clock.pending().length, 0);
  await advance(manual, LOCAL_IDLE_TIMEOUT_MS * 2);
  assert.equal(manual.unloadCalls, 0);

  const disposed = harness();
  const disposedPermission = deferred();
  disposed.setCheck(() => disposedPermission.promise);
  disposed.controller.changed();
  await advance(disposed, LOCAL_IDLE_TIMEOUT_MS);
  disposed.controller.dispose();
  disposedPermission.resolve(true);
  await flush();
  await advance(disposed, LOCAL_IDLE_TIMEOUT_MS * 2);
  assert.equal(disposed.unloadCalls, 0);
  assert.equal(disposed.unloadedStates.length, 0);
});
