import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_TARGET_URL, isDispatchTarget, parseDispatchCommand, parseDispatchHash,
} from '../../src/diagnostics/dispatch-runner-protocol.ts';

const token = '0123456789abcdef'.repeat(4);

test('connection accepts only a bounded loopback port and strong token shape', () => {
  assert.deepEqual(parseDispatchHash(`#port=49321&token=${token}`), { port: 49321, token });
  assert.equal(parseDispatchHash('#token=123e4567-e89b-42d3-a456-426614174000&port=1024').port, 1024);
  for (const hash of [
    '', '#port=0&token=' + token, '#port=80&token=' + token,
    '#port=65536&token=' + token, '#port=049321&token=' + token,
    '#port=49321&token=short', '#port=49321&token=' + token + '&url=https://example.com',
    '#port=49321&port=49322&token=' + token,
  ]) assert.throws(() => parseDispatchHash(hash));
});

test('owned tab identity is restricted to the fixed audit video', () => {
  assert.equal(isDispatchTarget(DISPATCH_TARGET_URL), true);
  assert.equal(isDispatchTarget('https://www.bilibili.com/video/BV1yvhW6sEzi/?p=1#danlingo-audit'), true);
  for (const url of [
    'https://www.bilibili.com/video/BV1yvhW6sEzi/',
    'https://www.bilibili.com/video/BV1RHaw6mEDR/#danlingo-audit',
    'https://www.bilibili.com/video/BV1yvhW6sEzi/?p=2#danlingo-audit',
    'https://example.com/video/BV1yvhW6sEzi/#danlingo-audit',
  ]) assert.equal(isDispatchTarget(url), false);
});

test('command protocol rejects arbitrary RPC, actions and payloads', () => {
  const envelope = (command, payload) => ({ id: 'run_1', command, payload });
  assert.deepEqual(parseDispatchCommand(envelope('rpc', { type: 'local-control', control: { action: 'load', modelId: 'selected' } })),
    envelope('rpc', { type: 'local-control', control: { action: 'load', modelId: 'selected' } }));
  assert.deepEqual(parseDispatchCommand(envelope('audit', { action: 'start-B', args: {} })),
    envelope('audit', { action: 'start-B', args: {} }));
  assert.deepEqual(parseDispatchCommand(envelope('reload', { bootstrap: true })),
    envelope('reload', { bootstrap: true }));
  assert.deepEqual(parseDispatchCommand(envelope('openTarget', { refresh: true })),
    envelope('openTarget', { refresh: true }));
  for (const action of ['prepare', 'run', 'status', 'seek', 'export', 'cleanup'])
    assert.deepEqual(parseDispatchCommand(envelope('displayPlan', { action })),
      envelope('displayPlan', { action }));
  for (const action of ['prepare', 'run', 'status', 'pause', 'play', 'seek', 'export', 'cleanup'])
    assert.deepEqual(parseDispatchCommand(envelope('renderPreview', { action })),
      envelope('renderPreview', { action }));
  for (const value of [
    envelope('rpc', { type: 'settings', settings: { enabled: true } }),
    envelope('rpc', { type: 'configure', settings: { enabled: true } }),
    envelope('rpc', { type: 'local-control', control: { action: 'unload' } }),
    envelope('rpc', { type: 'local-control', control: { action: 'load', modelId: 'other', config: { warmup: false } } }),
    envelope('audit', { action: 'eval', args: {} }),
    envelope('audit', { action: 'play', args: { url: 'https://example.com' } }),
    envelope('openTarget', { url: 'https://example.com' }),
    envelope('openTarget', { refresh: false }),
    envelope('openTarget', { refresh: true, url: 'https://example.com' }),
    envelope('displayPlan', { action: 'seek', seconds: 90 }),
    envelope('displayPlan', { action: 'run', list: ['author'] }),
    envelope('displayPlan', { action: 'eval' }),
    envelope('renderPreview', { action: 'seek', seconds: 90 }),
    envelope('renderPreview', { action: 'run', list: ['author'] }),
    envelope('renderPreview', { action: 'run', repeat: true }),
    envelope('renderPreview', { action: 'status', replayRun: true }),
    envelope('renderPreview', { action: 'eval' }),
    envelope('reload', { force: true }),
    envelope('reload', { bootstrap: false }),
    envelope('reload', { bootstrap: true, force: true }),
    envelope('javascript', {}),
    { id: 'bad id', command: 'openTarget', payload: {} },
  ]) assert.throws(() => parseDispatchCommand(value));
});

test('live-preview commands require exact one-run or reasoned-repair payloads', () => {
  const wrap = payload => ({ id: 'preview_1', command: 'livePreview', payload });
  const main = { action: 'prepare', taskId: 'task-1', runId: 'run-1', phase: 'main' };
  assert.deepEqual(parseDispatchCommand(wrap(main)), wrap(main));
  const repair = { ...main, runId: 'run-2', phase: 'repair', repairReason: 'verified result bridge fix',
    fromMs: 61_000, toMs: 78_000 };
  assert.deepEqual(parseDispatchCommand(wrap(repair)), wrap(repair));
  const supplement = { ...repair, phase: 'supplement', runId: 'run-3',
    repairReason: 'User explicitly authorized one extra full run', fromMs: 45_000, toMs: 85_000 };
  assert.deepEqual(parseDispatchCommand(wrap(supplement)), wrap(supplement));
  for (const invalid of [{ ...supplement, repairReason: '' }, { ...supplement, toMs: 65_000 },
    { ...supplement, fromMs: 46_000 }, { ...supplement, unlimited: true }])
    assert.throws(() => parseDispatchCommand(wrap(invalid)));
  for (const action of ['run', 'resume', 'status', 'drain', 'export', 'cleanup'])
    assert.deepEqual(parseDispatchCommand(wrap({ action })), wrap({ action }));
  assert.deepEqual(parseDispatchCommand({ id: 'close_1', command: 'close-live-preview-owned', payload: {} }),
    { id: 'close_1', command: 'close-live-preview-owned', payload: {} });
  for (const payload of [
    { ...main, fromMs: 45_000 }, { ...main, url: 'https://example.com' },
    { ...repair, repairReason: '' }, { ...repair, toMs: 82_000 },
    { ...repair, fromMs: -1 }, { ...repair, fromMs: 44_999 },
    { ...repair, toMs: 85_001 }, { ...repair, fromMs: 78_000 },
    { action: 'run', taskId: 'task-1' }, { action: 'status', text: 'leak' },
    { action: 'seek' },
  ]) assert.throws(() => parseDispatchCommand(wrap(payload)));
  assert.throws(() => parseDispatchCommand({ id: 'close_1', command: 'close-live-preview-owned', payload: { tabId: 10 } }));
});

test('native-supply runner accepts only fixed video phases and scoped actions', () => {
  const wrap = payload => ({ id: 'supply_1', command: 'nativeSupply', payload });
  const main = { action: 'prepare', taskId: 'task-1', runId: 'run-1', phase: 'main',
    modelId: 'registered-7b', fromMs: 0, toMs: 45_000 };
  assert.deepEqual(parseDispatchCommand(wrap(main)), wrap(main));
  assert.deepEqual(parseDispatchCommand(wrap({ ...main, action: 'recover-prepare' })),
    wrap({ ...main, action: 'recover-prepare' }));
  const repair = { ...main, runId: 'run-2', phase: 'repair', repairReason: 'verified bridge fix',
    fromMs: 12_000, toMs: 27_000 };
  assert.deepEqual(parseDispatchCommand(wrap(repair)), wrap(repair));
  for (const action of ['run', 'status', 'export', 'drain', 'stop', 'cleanup', 'replay'])
    assert.deepEqual(parseDispatchCommand(wrap({ action })), wrap({ action }));
  for (const action of ['reference-start', 'reference-full-start', 'reference-status',
    'reference-snapshot', 'reference-stop', 'reference-export', 'reference-cleanup',
    'reference-official-1-start', 'reference-official-3-start',
    'reference-official-5-start', 'reference-official-dom-start']) {
    assert.deepEqual(parseDispatchCommand(wrap({ action })), wrap({ action }));
    assert.throws(() => parseDispatchCommand(wrap({ action, durationMs: 120_000 })));
    assert.throws(() => parseDispatchCommand(wrap({ action, url: 'https://example.com' })));
  }
  assert.deepEqual(parseDispatchCommand({ id: 'close_1', command: 'close-native-supply-owned', payload: {} }),
    { id: 'close_1', command: 'close-native-supply-owned', payload: {} });
  for (const payload of [
    { ...main, toMs: 52_000 }, { ...main, fromMs: 1 }, { ...main, url: 'https://example.com' },
    { ...repair, repairReason: '' }, { ...repair, toMs: 45_001 }, { ...repair, fromMs: -1 },
    { ...repair, action: 'recover-prepare' }, { action: 'recover-prepare' },
    { ...repair, toMs: 28_000 }, { ...repair, taskId: '../other' },
    { action: 'translate', items: [] }, { action: 'cancel', requestId: '1' },
    { action: 'run', repeat: true }, { action: 'replay', phase: 'main' },
  ]) assert.throws(() => parseDispatchCommand(wrap(payload)));
  assert.deepEqual(parseDispatchCommand(wrap({ ...repair, authorizedExtraLoad: true })),
    wrap({ ...repair, authorizedExtraLoad: true }));
  for (const payload of [{ ...main, authorizedExtraLoad: true },
    { ...repair, authorizedExtraLoad: false }, { ...repair, authorizedExtraLoad: 3 },
    { ...repair, authorizedExtraLoad: true, toMs: 28_000 },
    { ...repair, action: 'recover-prepare', authorizedExtraLoad: true }])
    assert.throws(() => parseDispatchCommand(wrap(payload)));
  assert.throws(() => parseDispatchCommand({ id: 'close_1', command: 'close-native-supply-owned', payload: { tabId: 1 } }));
});

test('owned-supply runner status allows only read actions and no target or RPC fields', () => {
  const wrap = payload => ({ id: 'owned_1', command: 'ownedSupplyStatus', payload });
  for (const action of ['status', 'export'])
    assert.deepEqual(parseDispatchCommand(wrap({ action })), wrap({ action }));
  for (const payload of [{}, null, [], { action: 'run' }, { action: 'start' },
    { action: 'play' }, { action: 'cleanup' }, { action: 'settings' },
    { action: 'status', tabId: 7 }, { action: 'export', documentId: 'other' },
    { action: 'status', rpc: { type: 'local-control', control: { action: 'load' } } },
  ]) assert.throws(() => parseDispatchCommand(wrap(payload)), /INVALID_OWNED_SUPPLY_STATUS_ACTION/);
});
