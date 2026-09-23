import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-niconico-live.mjs', import.meta.url));
function check(...args) {
  return spawnSync(process.execPath, ['--experimental-strip-types', script, '--check-args', ...args],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
}
function parsed(...args) {
  const result = check(...args);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

test('media actions are explicit and leave the existing default lifecycle unchanged', () => {
  assert.deepEqual(parsed().selectedStages, []);
  const defaults = parsed('--lifecycle', '--next-room', 'lv123');
  assert.deepEqual(defaults.selectedStages, ['off-on', 'resize', 'fullscreen', 'reconnect', 'next-room']);
  assert.equal(defaults.fullLifecycleRequested, true);
});

test('each media action selects only its bounded recovery scope with a fixed 30s window', () => {
  for (const name of ['pause-resume', 'chase-live']) {
    const scope = parsed('--real-provider', '--lifecycle', '--stages', name, '--seconds', '120');
    assert.deepEqual(scope, { selectedStages: [name], fullLifecycleRequested: false, mediaRecoveryWindowSeconds: 30, drainMs: 6000 });
  }
});

test('combined media actions never claim the full lifecycle', () => {
  const scope = parsed('--lifecycle', '--stages', 'off-on,resize,fullscreen,reconnect,next-room,pause-resume,chase-live', '--next-room', 'lv123');
  assert.equal(scope.fullLifecycleRequested, false);
  assert.equal(scope.mediaRecoveryWindowSeconds, 30);
});

test('missing lifecycle, duplicate selection and unknown media actions fail before any runtime setup', () => {
  for (const args of [
    ['--stages', 'pause-resume'],
    ['--lifecycle', '--stages', 'pause-resume,pause-resume'],
    ['--lifecycle', '--stages', 'pause-resume', '--stages', 'chase-live'],
    ['--lifecycle', '--stages', 'fake-chase'],
  ]) {
    const result = check(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /AssertionError/);
    assert.equal(result.stdout, '');
  }
});

test('existing active-navigation exclusivity still applies with media actions', () => {
  const result = check('--lifecycle', '--stages', 'pause-resume,active-next-room,next-room', '--next-room', 'lv123');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Select active-next-room or next-room/);
});
