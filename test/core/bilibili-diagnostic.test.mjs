import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterDiagnostic, adapterDiagnosticText, diagnosticCandidate, parseAdapterDiagnostic } from '../../src/core/adapter-diagnostic.ts';
import { bilibiliFailureDiagnostic, isReviewedDanmakuBuild, REVIEWED_DANMAKU_BUILDS, startBilibiliNativeBridge } from '../../src/platforms/bilibili/video.ts';

const href = 'https://www.bilibili.com/video/BV1SQbW6dELM/';
const candidate = 'BV1SQbW6dELM:p1';
test('diagnostic uses URL candidate only, strips extra fields and renders bounded plain metadata', () => {
  assert.equal(diagnosticCandidate(href + '?spm_id_from=anything'), candidate);
  assert.equal(diagnosticCandidate(href + '?p=2'), candidate.replace('p1', 'p2'));
  for (const url of ['https://www.bilibili.com/', 'https://live.bilibili.com/777', 'https://www.bilibili.com.evil.test/video/BV1SQbW6dELM/']) assert.equal(diagnosticCandidate(url), null);
  const input = { ...adapterDiagnostic(candidate, 'unsupported-version'), nativeVersion: '1.1.22', nativeCompiled: '2026-07-14T14:26:03+08:00',
    resourceId: 'av117224320801605:cid41641968199', originalText: 'not diagnostic data', apiKey: 'not diagnostic data' };
  const safe = parseAdapterDiagnostic(input, candidate);
  assert.deepEqual(Object.keys(safe).sort(), ['code','nativeCompiled','nativeVersion','platform','scenario','urlResourceId'].sort());
  assert.match(adapterDiagnosticText(safe), /1\.1\.22.*尚未支持.*2026-07-14/);
  assert.equal(parseAdapterDiagnostic(input, 'BV1SQbW6dELM:p2'), null);
  assert.equal(parseAdapterDiagnostic({ ...input, code: 'ready' }, candidate), null);
  const unsafe = parseAdapterDiagnostic({ ...input, nativeVersion: '<script>', nativeCompiled: 'x'.repeat(1000) }, candidate);
  assert.equal(unsafe.nativeVersion, undefined); assert.equal(unsafe.nativeCompiled, undefined);
});

test('reviewed versions require exact build pairs; unknown and hybrid builds remain closed', () => {
  assert.deepEqual(REVIEWED_DANMAKU_BUILDS.map(build => build.version).sort(), ['1.1.22', '1.1.24']);
  for (const build of REVIEWED_DANMAKU_BUILDS) {
    assert.equal(isReviewedDanmakuBuild(build), true);
    assert.equal(isReviewedDanmakuBuild({ ...build, lastCompiled: '2026-07-14T14:26:04+08:00' }), false);
    for (const other of REVIEWED_DANMAKU_BUILDS) if (other !== build) {
      assert.equal(isReviewedDanmakuBuild({ version: build.version, lastCompiled: other.lastCompiled }), false);
    }
  }
  assert.equal(isReviewedDanmakuBuild({ version: '1.1.23', lastCompiled: '2026-09-03T16:18:23+08:00' }), false);
  assert.equal(isReviewedDanmakuBuild({ version: '9.9.9', lastCompiled: '2026-09-10T15:18:49+08:00' }), false);
  const player = { danmaku: { getDanmakuX: () => ({ getMetadata: () => ({ version: '9.9.9', lastCompiled: '2026-09-10T15:18:49+08:00' }) }) } };
  assert.equal(bilibiliFailureDiagnostic(player, href).code, 'unsupported-version');
  assert.equal(bilibiliFailureDiagnostic(null, href).code, 'waiting-player');
  assert.equal(bilibiliFailureDiagnostic(player, 'https://www.bilibili.com/'), null);
});

test('native unavailable repeats once per second, changes immediately and cannot leak across URL candidates', () => {
  const originalWindow = globalThis.window, originalPerformance = globalThis.performance;
  let now = 0, tick, cleared = false;
  const sent = [], listeners = new Map();
  const metadata = { version: '9.9.9', lastCompiled: '2026-07-14T14:26:03+08:00' };
  const win = { location: { href, origin: 'https://www.bilibili.com' },
    player: { danmaku: { getDanmakuX: () => ({ getMetadata: () => metadata }) } },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() { cleared = true; },
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    postMessage(message, origin) { assert.equal(origin, win.location.origin); sent.push(message); } };
  let stop;
  try {
    globalThis.window = win; globalThis.performance = { now: () => now };
    stop = startBilibiliNativeBridge();
    assert.equal(sent.length, 1); assert.equal(sent[0].diagnostic.nativeVersion, '9.9.9');
    now = 999; tick(); assert.equal(sent.length, 1);
    now = 1000; tick(); assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].diagnostic, sent[0].diagnostic);
    win.location.href = href + '?p=2'; tick(); assert.equal(sent.length, 3);
    assert.equal(sent[2].diagnostic.urlResourceId, 'BV1SQbW6dELM:p2');
    win.player = null; tick(); assert.equal(sent.at(-1).diagnostic.code, 'waiting-player');
    listeners.get('pagehide')(); now += 2000; tick(); assert.equal(sent.length, 4);
    listeners.get('pageshow')(); assert.equal(sent.length, 5);
    stop(); assert.equal(cleared, true); assert.equal(listeners.size, 0);
  } finally { stop?.(); globalThis.window = originalWindow; globalThis.performance = originalPerformance; }
});
