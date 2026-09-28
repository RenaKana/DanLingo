import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDispatchCommand } from '../src/diagnostics/dispatch-runner-protocol.ts';
import {
  prepareUserFilters, sampleUserFilters, observeUserFilters, cleanupUserFilters,
  createSession, loadSession, writeSession, resolveUserFilterArtifactRoot,
} from './verify-bilibili-user-filters.mjs';

const round = 'regexp-coverage-v1';

const expected = { buildId: '0.4.15-test', sourceHash: 'source' };
const receipt = (action, guarded = true, enabled = false) => ({ ok: true, buildId: expected.buildId,
  version: '0.4.15', session: 'page-session', enabled,
  report: action === 'cleanup' ? { restored: true, coverage: { featureEnabled: enabled } } : { coverage: {} },
  background: { buildId: expected.buildId, zeroModelGuard: guarded,
    blockedTransports: 0, actualModelCalls: 0 }, ...(action === 'cleanup' ? { guardReleased: true } : {}) });

test('user-filter command is exact and cannot carry page args or arbitrary actions', () => {
  for (const action of ['prepare', 'run', 'status', 'cleanup']) {
    const command = { id: 'filter_1', command: 'userFilters', payload: { action } };
    assert.deepEqual(parseDispatchCommand(command), command);
  }
  for (const payload of [{ action: 'run', args: {} }, { action: 'prepare', url: 'https://example.com' },
    { action: 'eval' }, { action: 'cleanup', force: true }, {}])
    assert.throws(() => parseDispatchCommand({ id: 'filter_1', command: 'userFilters', payload }));
});

test('all commands use the new round unless cleanup must recover an unfinished legacy run', () => {
  const roots = { legacyRoot: 'legacy-root', roundRoot: 'round-root' };
  for (const command of ['prepare', 'run', 'resume', 'cleanup']) {
    assert.equal(resolveUserFilterArtifactRoot(command, null, roots), roots.roundRoot);
    assert.equal(resolveUserFilterArtifactRoot(command, { phase: 'cleaned' }, roots), roots.roundRoot);
  }
  const unfinished = { phase: 'sampling' };
  assert.equal(resolveUserFilterArtifactRoot('cleanup', unfinished, roots), roots.legacyRoot);
  for (const command of ['prepare', 'run', 'resume'])
    assert.throws(() => resolveUserFilterArtifactRoot(command, unfinished, roots), /run cleanup before starting regexp-coverage-v1/);
});

test('round checkpoints are isolated and leave legacy active evidence byte-for-byte unchanged', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'bilibili-user-filter-round-'));
  const legacyRoot = join(tempRoot, 'legacy');
  const roundRoot = join(legacyRoot, round);
  await mkdir(legacyRoot, { recursive: true });
  await mkdir(roundRoot, { recursive: true });
  try {
    const legacy = await createSession(legacyRoot, null);
    const originalLog = console.log;
    console.log = () => {};
    try { await writeSession(legacy, 'cleaned', { restored: true }); }
    finally { console.log = originalLog; }

    const legacyPointerPath = join(legacyRoot, 'active.json');
    const legacyCheckpointPath = join(legacy.folder, 'checkpoint-0001.json');
    const legacyPointer = await readFile(legacyPointerPath, 'utf8');
    const legacyCheckpoint = await readFile(legacyCheckpointPath, 'utf8');

    const current = await createSession(roundRoot, round);
    console.log = () => {};
    try { await writeSession(current, 'prepared'); }
    finally { console.log = originalLog; }

    const loaded = await loadSession(roundRoot, round);
    assert.equal(loaded.id, current.id);
    assert.equal(loaded.phase, 'prepared');
    assert.equal(loaded.round, round);
    assert.equal(JSON.parse(await readFile(join(roundRoot, 'active.json'), 'utf8')).round, round);
    assert.equal(JSON.parse(await readFile(join(current.folder, 'checkpoint-0001.json'), 'utf8')).round, round);
    assert.equal(await readFile(legacyPointerPath, 'utf8'), legacyPointer);
    assert.equal(await readFile(legacyCheckpointPath, 'utf8'), legacyCheckpoint);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('prepare reads only settings and build identity, reloads then installs guard before page work', async () => {
  const seen = [];
  const control = async (command, payload) => {
    seen.push(`${command}:${payload?.type ?? payload?.action ?? ''}`);
    if (payload?.type === 'settings') return { settings: { enabled: false, backend: 'online' } };
    if (payload?.type === 'build-identity') return { idle: true,
      buildId: seen.includes('reload:') ? expected.buildId : 'previous' };
    if (command === 'userFilters') return receipt('prepare');
    return { willReload: true };
  };
  const result = await prepareUserFilters({ control, expected, checkpoint: async phase => seen.push(`checkpoint:${phase}`),
    refreshConnection: async () => seen.push('reconnect'), sleep: async () => {} });
  assert.equal(result.background.zeroModelGuard, true);
  assert.deepEqual(seen.filter(item => !item.startsWith('checkpoint:')), [
    'rpc:settings', 'rpc:build-identity', 'reload:', 'reconnect', 'rpc:build-identity',
    'rpc:settings', 'userFilters:prepare',
  ]);
  assert.equal(seen.some(item => /local-control|audit:/.test(item)), false);
});

test('bounded page recovery leaves guard in place when the third prepare fails', async () => {
  let attempts = 0;
  const phases = [];
  await assert.rejects(prepareUserFilters({ expected,
    control: async (command, payload) => {
      if (payload?.type === 'settings') return { settings: { enabled: false } };
      if (payload?.type === 'build-identity') return { idle: true, buildId: expected.buildId };
      if (command === 'userFilters') { attempts++; throw Error('USER_FILTERS_PAGE_NOT_READY'); }
    }, checkpoint: async phase => phases.push(phase), refreshConnection: async () => {}, sleep: async () => {},
  }), /PAGE_NOT_READY/);
  assert.equal(attempts, 3);
  assert.equal(phases.filter(phase => phase === 'guard-installing').length, 3);
  assert.equal(phases.includes('prepared'), false);
});

test('run records intent first and resume only samples status without a second run', async () => {
  const seen = [], recorded = [];
  const options = { expectedBuildId: expected.buildId,
    control: async (_command, payload) => { seen.push(payload.action); return receipt(payload.action); },
    checkpoint: async phase => seen.push(`checkpoint:${phase}`),
    save: async name => recorded.push(name), sleep: async () => {} };
  await sampleUserFilters(options);
  assert.deepEqual(seen.filter(item => item === 'run'), ['run']);
  assert.ok(seen.indexOf('checkpoint:run-issuing') < seen.indexOf('run'));
  assert.equal(recorded.filter(item => item.startsWith('status-')).length, 4);
  assert.equal(recorded.at(-1), 'final-status');
  seen.length = 0;
  await observeUserFilters(options);
  assert.equal(seen.includes('run'), false);
});

test('cleanup requires a page restoration receipt and released guard before closing owned tab', async () => {
  const seen = [];
  const base = { expectedBuildId: expected.buildId, checkpoint: async phase => seen.push(`checkpoint:${phase}`),
    save: async name => seen.push(`save:${name}`) };
  await assert.rejects(cleanupUserFilters({ ...base, control: async command => {
    seen.push(command); return { ...receipt('cleanup', true), report: { restored: false, coverage: { featureEnabled: false } } };
  } }), /guard state changed/);
  assert.deepEqual(seen, ['userFilters']);
  for (const originallyEnabled of [false, true]) {
    seen.length = 0;
    await cleanupUserFilters({ ...base, control: async command => {
      seen.push(command); return command === 'close-owned' ? { closed: true } : receipt('cleanup', false, originallyEnabled);
    } });
    assert.deepEqual(seen, ['userFilters', 'save:cleanup', 'checkpoint:guard-released',
      'close-owned', 'save:closed-owned', 'checkpoint:cleaned']);
  }
  for (const invalid of [
    { report: { restored: false, coverage: { featureEnabled: true } } },
    { enabled: true, report: { restored: true, coverage: { featureEnabled: false } } },
    { report: { restored: true, coverage: {} } },
  ]) {
    seen.length = 0;
    await assert.rejects(cleanupUserFilters({ ...base, control: async command => {
      seen.push(command); return { ...receipt('cleanup', false, true), ...invalid };
    } }));
    assert.deepEqual(seen, ['userFilters'], 'invalid restoration cannot close the owned tab');
  }
});
