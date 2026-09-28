import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { DisplayPlanSession } from '../../src/diagnostics/display-plan-session.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { DISPATCH_AUDIT_ACTIONS, DISPATCH_OWNED_KEY, DISPATCH_SESSION_KEY, DISPATCH_REFRESH_KEY,
  DISPLAY_PLAN_OWNER_KEY, RENDER_PREVIEW_OWNER_KEY, LIVE_PREVIEW_OWNER_KEY,
  NATIVE_SUPPLY_OWNER_KEY, NATIVE_REFERENCE_OWNER_KEY,
  DISPATCH_TARGET_URL, parseDispatchHash,
  isDispatchTarget, parseDispatchCommand, validDispatchId } from '../../src/diagnostics/dispatch-runner-protocol.ts';
import { recoverLivePreviewWithoutNewCalls } from '../../entrypoints/dispatch-runner/live-preview-recovery.ts';
import { matchesResourceUrl, sameSession, validSession } from '../../src/core/resource.ts';
import { runnerEnvironmentComparable, runnerEnvironmentSignature, updateRunnerEnvironmentEvidence } from '../../src/diagnostics/bilibili-audit-main.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const compiled = ts.transpileModule(readFileSync(new URL('../../entrypoints/bilibili-audit.content.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const extensionId = 'fixture-extension';
const buildId = 'runner-build-fixture';
const pageUrl = 'chrome-extension://fixture-extension/dispatch-runner.html';
const token = '123e4567-e89b-42d3-a456-426614174000';
const runnerSender = { id: extensionId, url: `${pageUrl}#port=12345&token=${token}`, frameId: 0, tab: { id: 9 } };
const sample = (patch = {}) => ({
  playerRect: { left: 10, top: 20, width: 900, height: 506 }, videoRect: { left: 20, top: 30, width: 880, height: 495 },
  window: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900, devicePixelRatio: 1 },
  mode: { fullscreen: false, playerClasses: [], danmakuVisible: true },
  native: { contractVerified: true, contractSha256: 'contract-fixture', valid: true, area: 25, domArea: '25%',
    dependencies: ['ref:1'], boundary: ['ref:1'] },
  playback: { seeking: false, playbackRate: 1, paused: false, visibility: 'visible' },
  scroll: { x: 0, y: 0 }, ...patch,
});

function harness({ withModel = false, startSafety = {}, estimateRows = [] } = {}) {
  const h = { runtimeMessages: [], downloads: 0, pageMessages: [], captureActive: false,
    current: { resourceId: 'av123:cid456', time: 61, paused: true, seeking: false, rate: 1, display: true, scroll: { x: 12, y: 34 } } };
  const settings = { enabled: false, backend: 'local', localModelId: withModel ? 'model-1' : null,
    sourceLanguage: 'ja', targetLanguage: 'zh-Hans', concurrency: 2, translationScope: 'all', prefetchSeconds: 60 };
  const localState = withModel ? { phase: 'ready', generation: 8, active: 0, queued: 0,
    model: { id: 'model-1', fingerprint: 'model-fingerprint-fixture', architecture: 'fixture', quantization: 'Q4', bytes: 123456 },
    runtime: { parallel: 2 } } : { phase: 'idle', generation: 2, active: 0, queued: 0 };
  let contentWindowHandler, runnerListener;
  const fakeElement = tag => ({ tagName: tag.toUpperCase(), dataset: {}, style: {}, children: [], value: '', textContent: '',
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    setAttribute() {}, remove() {}, click() { h.downloads++; } });
  const document = { visibilityState: 'visible', createElement: fakeElement, body: { append() {} } };
  const location = { href: 'https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit', origin: 'https://www.bilibili.com' };
  const response = (request, type, payload = {}) => queueMicrotask(() => {
    const message = { channel: 'danlingo.bilibili.audit.v1', from: 'main', token: request.token,
      type, buildId, ...(request.requestId ? { requestId: request.requestId } : {}), ...payload };
    void contentWindowHandler?.({ source: window, origin: location.origin, data: message });
  });
  const previewReply = () => ({ ok: true, resourceId: h.current.resourceId, session: { sessionId: 'session-1', generation: 2 },
    configVersion: 4, items: Array.from({ length: withModel ? 55 : 1 }, (_, i) => ({ id: `source-${i}`,
      text: withModel ? `这是用于诊断的真实候选输入${String(i).padStart(2, '0')}，保持唯一并用于核验派发预算。` : '预览候选',
      translationEligible: true })),
    dispatch: { backgroundBuildId: buildId, watchBuildId: buildId, savedBatchLimit: 7, concurrency: 2 },
    settings: { ...settings }, local: { phase: withModel ? 'ready' : 'idle', modelMatched: withModel,
      generation: localState.generation, ...(withModel ? { modelFingerprint: 'model-fingerprint-fixture' } : {}),
      active: 0, queued: 0, singleItem: withModel },
    dispatchComparisonReady: withModel, engineIdle: true });
  const browser = { runtime: { id: extensionId, getManifest: () => ({ version: '0.4.14' }),
    getURL: path => `chrome-extension://${extensionId}${path}`,
    onMessage: { addListener: listener => { runnerListener = listener; }, removeListener() {} },
    sendMessage: async message => {
      h.runtimeMessages.push(message);
      if (message.type === 'bilibili-audit-read') return { ok: true, configVersion: 4, workerSession: 'worker-session',
        engine: { providerCalls: 0, pendingItems: 0, activeRequests: 0 }, settings: { ...settings } };
      if (message.type === 'bilibili-experiment-preview') return previewReply();
      if (message.type === 'bilibili-experiment-start') return { ok: true, runId: message.runId,
        report: { state: 'running', providerCalls: 0, safety: { modelMatched: true, modelLoads: 0, modelGeneration: localState.generation, savedSettingsWrites: 0 } },
        dispatch: { effectiveBatchLimit: message.singleDispatch ? 1 : 7 } };
      if (message.type === 'bilibili-experiment-status') return { ok: true, report: { state: 'running', providerCalls: 0 } };
      if (message.type === 'bilibili-experiment-stop') return { ok: true, report: { state: 'stopped', stopReason: 'manual', providerCalls: 0,
        safety: { modelMatched: withModel, modelLoads: 0, modelGeneration: localState.generation } }, dispatch: {} };
      return { ok: true };
    } } };
  const window = { postMessage: message => {
    h.pageMessages.push(message);
    if (message.from !== 'content') return;
    const current = h.current;
    if (message.type === 'inspect') response(message, 'inspection', { value: { identity: { resourceId: current.resourceId, cid: '456' },
      time: current.time, paused: current.paused, seeking: current.seeking, rate: current.rate, display: current.display, scroll: { ...current.scroll } } });
    else if (message.type === 'experiment-position') {
      current.time = message.seconds; current.paused = true; current.seeking = false;
      if (Number.isFinite(message.playbackRate)) current.rate = message.playbackRate;
      response(message, 'positioned', { seconds: current.time, paused: current.paused, seeking: current.seeking,
        playbackRate: current.rate, display: current.display, resourceId: current.resourceId });
    } else if (message.type === 'experiment-estimate') response(message, 'experiment-estimate', { rows: estimateRows,
      nativeContract: { verified: true, sha256: 'contract-fixture' }, nativeConfiguration: { valid: true, area: 25, domArea: '25%' },
      playback: { timeSeconds: current.time, paused: current.paused, seeking: current.seeking,
        playbackRate: current.rate, display: current.display } });
    else if (message.type === 'runner-environment') response(message, 'runner-environment', { resourceId: current.resourceId,
      sample: sample({ playback: { seeking: current.seeking, playbackRate: current.rate, paused: current.paused, visibility: 'visible' } }),
      signature: 'prepare-signature-fixture', comparable: { playerRect: { width: 900, height: 506 } },
      nativeContract: { verified: true, sha256: 'contract-fixture' }, nativeConfiguration: { valid: true, area: 25, domArea: '25%' },
      playback: { timeSeconds: current.time, paused: current.paused, seeking: current.seeking,
        playbackRate: current.rate, display: current.display } });
    else if (message.type === 'start') { h.captureActive = true; response(message, 'started', { started: { videoTimeMs: current.time * 1000 },
      identity: { resourceId: current.resourceId }, shadow: true }); }
    else if (message.type === 'play') { const before = current.time; current.paused = false; current.time += 0.1;
      response(message, 'played', { value: { fromSeconds: before, toSeconds: current.time, paused: false, seeking: false, playbackRate: 1 } }); }
    else if (message.type === 'stop') { h.captureActive = false;
      response(message, 'stopped', { ended: { reason: 'manual' }, restoration: { stopped: true, restored: [true], laterWrapperPreserved: false } }); }
    else if (message.type === 'drain') response(message, 'candidates', { rows: [], remaining: 0 });
    else if (message.type === 'export') response(message, 'export', { data: { schema: 2, identity: { cid: '456', resourceId: current.resourceId },
      records: [], visibleEvents: [], runnerEvidence: { environment: { status: 'stable', signature: 'run-signature-fixture',
        comparable: { playerRect: { width: 900, height: 506 } }, changes: [] }, buildId, startedAt: 1 }, shadowContract: { sha256: 'contract-fixture' } } });
    else if (message.type === 'restore') {
      current.time = message.timeSeconds; current.paused = message.paused; current.seeking = false;
      current.rate = message.playbackRate; current.scroll = { x: message.scrollX, y: message.scrollY };
      response(message, 'restored', { value: { timeSeconds: current.time, targetTimeSeconds: current.time,
        paused: current.paused, seeking: false, playbackRate: current.rate, scroll: { ...current.scroll } } });
    }
  }, addEventListener: (type, handler) => { if (type === 'message') contentWindowHandler = handler; }, removeEventListener() {} };
  const dependencies = {
    'wxt/browser': { browser }, 'wxt/utils/define-content-script': { defineContentScript: value => value },
    '../src/diagnostics/bilibili-audit-cache': { auditUrl: () => true }, '../src/core/build-identity': { BUILD_ID: buildId },
    '../src/diagnostics/dispatch-runner-protocol': { DISPATCH_AUDIT_ACTIONS, parseDispatchHash },
  };
  const exports = {};
  runInNewContext(compiled, { exports, browser, window, document, location,
    crypto: { randomUUID }, URL, Blob, performance, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    require: key => { assert.ok(key in dependencies, `unexpected import: ${key}`); return dependencies[key]; } });
  const api = exports.default.main({ setInterval: () => 1, onInvalidated() {} });
  h.invoke = (action, sender = runnerSender) => runnerListener?.({ type: 'dispatch-runner-action', action, args: {} }, sender);
  return h;
}

test('runner sender requires its extension page identity and valid hash while accepting sender.tab', async () => {
  const h = harness();
  const result = await h.invoke('status');
  assert.equal(result.ok, true);
  assert.equal(result.buildId, buildId);
  assert.ok('idle' in result && 'runnerEvidence' in result && 'localReport' in result);
  for (const sender of [
    { ...runnerSender, id: 'other-extension' },
    { ...runnerSender, url: `${pageUrl}/nested#port=12345&token=${token}` },
    { ...runnerSender, url: `${pageUrl}?extra=1#port=12345&token=${token}` },
    { ...runnerSender, url: `${pageUrl}#port=12345&token=invalid` },
    { ...runnerSender, frameId: 2 },
  ]) assert.equal(h.invoke('status', sender), undefined);
  const rejected = await h.invoke('not-allowed');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'invalid-runner-action');
  assert.equal((await h.invoke('status', { ...runnerSender, tab: undefined })).ok, true);
});

test('prepare records a paused 52 second 25 percent snapshot and permits zero-call without a model', async () => {
  const h = harness();
  const prepared = await h.invoke('prepare');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.idle, true);
  assert.equal(prepared.paused, true);
  assert.equal(prepared.videoTimeMs, 52000);
  assert.equal(prepared.inspection.identity.resourceId, 'av123:cid456');
  assert.equal(prepared.inspection.nativeConfiguration.area, 25);
  assert.equal(prepared.localPreview.configVersion, 4);
  assert.equal(prepared.localPreview.dispatch.savedBatchLimit, 7);
  assert.equal(prepared.runnerEvidence.environment.status, 'unknown', 'one preparation sample is not interval stability');
  assert.equal(prepared.runnerEvidence.prepareEnvironment.signature, 'prepare-signature-fixture');
  assert.equal(h.runtimeMessages.some(message => message.type === 'bilibili-experiment-start'), false);
  const zero = await h.invoke('zero-start');
  assert.equal(zero.ok, true);
  assert.equal(zero.active, true);
  assert.equal(zero.localRun, null);
  assert.equal(h.runtimeMessages.some(message => message.type === 'bilibili-experiment-start'), false,
    'zero-start does not construct a LocalExperiment');
  const played = await h.invoke('play');
  assert.ok(played.played.toSeconds > played.played.fromSeconds);
  const stopped = await h.invoke('stop');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pending, 0);
  const exported = await h.invoke('export');
  assert.equal(exported.ok, true);
  assert.equal(exported.data.shadowContract.sha256, 'contract-fixture');
  assert.equal(h.downloads, 0, 'runner export returns data without starting a browser download');
  const restored = await h.invoke('restore');
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, true);
  assert.equal(restored.hooksRestored.laterWrapperPreserved, false);
  assert.equal(h.current.time, 61);
  assert.equal(h.current.paused, true);
  assert.deepEqual(h.current.scroll, { x: 12, y: 34 });
});

test('A/B starts send their intended batch mode and use only the preview model fingerprint', async () => {
  for (const [action, expectedSingleDispatch] of [['start-B', true], ['start-A', false]]) {
    const h = harness({ withModel: true });
    const prepared = await h.invoke('prepare');
    assert.equal(prepared.ok, true);
    assert.equal(typeof prepared.runnerEvidence.modelFingerprint, 'string');
    assert.equal(prepared.runnerEvidence.modelGeneration, 8);
    const started = await h.invoke(action);
    assert.equal(started.ok, true);
    assert.equal(started.localReady, true);
    assert.equal(started.localReport.report.state, 'running');
    assert.equal(started.localRun.singleDispatch, expectedSingleDispatch);
    const beginMessage = h.runtimeMessages.find(message => message.type === 'bilibili-experiment-start');
    assert.ok(beginMessage, `${action} sends an experiment begin message`);
    assert.equal(beginMessage.singleDispatch, expectedSingleDispatch,
      `${action} uses the expected dispatch batch mode in the actual begin message`);
    assert.equal(h.runtimeMessages.some(message => message.type === 'local-control'), false,
      'Bilibili content reads only the sanitized model preview and never requests local runtime state');
  }
});

test('environment signatures ignore position-only scrolling, retain context changes and reject unknown samples', () => {
  const first = sample();
  const baseline = updateRunnerEnvironmentEvidence(null, first, 1);
  assert.equal(baseline.status, 'stable');
  const moved = updateRunnerEnvironmentEvidence(baseline, sample({
    playerRect: { ...first.playerRect, left: 120, top: 90 }, videoRect: { ...first.videoRect, left: 130, top: 100 },
    scroll: { x: 110, y: 70 },
  }), 2);
  assert.equal(moved.status, 'stable');
  assert.equal(moved.signature, baseline.signature);
  assert.ok(moved.changes.length > 0 && moved.changes.every(change => change.severity === 'context' && change.changed === false));
  const resized = updateRunnerEnvironmentEvidence(moved, sample({ videoRect: { ...first.videoRect, width: 700 } }), 3);
  assert.equal(resized.status, 'changed');
  assert.ok(resized.changes.some(change => change.field === 'videoRect' && change.severity === 'hard'));
  assert.equal(runnerEnvironmentComparable({ ...first, playerRect: null }), null);
  assert.equal(runnerEnvironmentSignature({ ...first, videoRect: null }), null);
  const afterUnknown = updateRunnerEnvironmentEvidence(updateRunnerEnvironmentEvidence(null, null, 0), first, 1);
  assert.equal(afterUnknown.status, 'unknown', 'a later valid sample cannot erase an earlier missing sample');
});

function runnerPageHarness(reloadedTab, advanceAfterReload = 0, pageReply = { enabled: false, report: {} },
  planReply = null, renderReply = null, persistentGuard = null, liveFixture = null, nativeFixture = null,
  ownedFixture = null) {
  const source = readFileSync(new URL('../../entrypoints/dispatch-runner/main.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText + `\nexports.fixture = { userFiltersAction, displayPlanAction, renderPreviewAction,
    validateRenderPreviewPage, validateRenderPreviewBackground, ownedTab, targetTabState,
     closeRenderPreviewOwnedTarget, livePreviewAction, nativeSupplyAction, ownedSupplyStatus,
     getOwned: () => ownedTabId };`;
  const h = { pageActions: [], backgroundActions: [], backgroundEvents: [], operationOrder: [], tabRemovals: [],
    createdTargets: [], createdWindows: [], tabUpdates: [], sentMessages: [], now: 1000 };
  const local = { [DISPATCH_OWNED_KEY]: 7 }, session = {};
  const persistent = persistentGuard ?? { key: 'bilibiliUserFilters.zeroTransport.v1', present: true, enabled: true,
    declaredEnabled: false, kind: 'legacy-protection', ownerTabId: null };
  let renderTemporaryEnabled = false;
  let tabReads = 0, reloading = false, renderTabExists = false;
  const tab = (id = 7) => {
    if (ownedFixture && id === ownedFixture.host?.grant?.tabId) return ownedFixture.tab;
    if (id === 8 && nativeFixture?.newTargetStates?.length) return nativeFixture.newTargetStates.shift();
    if (id === 8) return renderTabExists ? { id: 8, url: DISPATCH_TARGET_URL } : null;
    if (!reloading) return { id: 7, url: DISPATCH_TARGET_URL };
    if (Array.isArray(reloadedTab)) return reloadedTab[Math.min(tabReads++, reloadedTab.length - 1)];
    return reloadedTab;
  };
  const store = data => ({
    get: async key => typeof key === 'string' ? { [key]: data[key] } : Object.fromEntries(key.map(k => [k, data[k]])),
    set: async value => { Object.assign(data, value); },
    remove: async key => { for (const k of Array.isArray(key) ? key : [key]) delete data[k]; },
  });
  const browser = {
    runtime: { id: extensionId, getManifest: () => ({ version: '0.4.16' }), getURL: path => `chrome-extension://${extensionId}${path}`,
      sendMessage: async message => {
        h.operationOrder.push(`background:${message.type}:${message.action ?? message.type}`);
        h.backgroundEvents.push(`${message.type}:${message.action ?? message.type}`);
        if (message.type === 'settings') return { ok: true, settings: { enabled: false } };
        if (message.type === 'build-identity') return { ok: true,
          version: ownedFixture?.backgroundVersion ?? '0.4.16',
          buildId: ownedFixture?.backgroundBuildId ?? buildId, idle: true,
          ...(ownedFixture ? { ownedSupply: ownedFixture.host } : {}),
          protections: { temporaryGuard: { enabled: false, kind: null, ownerTabId: null },
            persistentGuard: persistent, effectiveZeroTransport: persistent.enabled } };
        if (message.type === 'bilibili-live-preview-host' && liveFixture) return liveFixture.host;
        if (message.type === 'bilibili-native-supply-host' && nativeFixture) {
          nativeFixture.hostActions.push(message.action);
          if (message.action === 'prepare') {
            (nativeFixture.hostInputs ??= []).push(message.input);
            local['nativeSupply.zeroTransport.v1'] = { enabled: true, kind: 'native-supply',
              tabId: message.input.tabId, runId: message.input.runId };
          }
          return message.action === 'prepare' ? nativeFixture.recoveredHost : nativeFixture.beforeHost;
        }
        if (message.type === 'bilibili-display-plan-guard') return { ok: true, version: '0.4.16', buildId,
          zeroModelGuard: message.action !== 'cleanup', ownerTabId: message.action === 'cleanup' ? null : message.tabId, idle: true,
          actualModelCalls: 0, blockedTransports: 0 };
        if (message.type === 'bilibili-render-preview-guard') {
          if (message.action === 'prepare') renderTemporaryEnabled = true;
          if (message.action === 'cleanup') renderTemporaryEnabled = false;
          const temporaryGuard = { enabled: renderTemporaryEnabled, kind: renderTemporaryEnabled ? 'render-preview' : null,
            ownerTabId: renderTemporaryEnabled ? message.tabId : null };
          return { ok: true, version: '0.4.16', buildId, zeroModelGuard: renderTemporaryEnabled, idle: true,
            actualModelCalls: 0, blockedTransports: 0, temporaryGuard, persistentGuard: persistent,
            effectiveZeroTransport: renderTemporaryEnabled || persistent.enabled };
        }
        h.backgroundActions.push(message.action);
        if (message.type !== 'bilibili-user-filters-audit') throw Error('Unexpected background command');
        return { ok: true, version: '0.4.16', buildId, zeroModelGuard: message.action !== 'cleanup',
          actualModelCalls: 0, blockedTransports: 0 };
      } },
    storage: { local: store(local), session: store(session) },
    windows: { getCurrent: async () => ({ state: 'normal', width: 1280, height: 900, left: 10, top: 20 }),
      create: async options => { h.createdWindows.push(options); renderTabExists = true; return { tabs: [{ id: 8 }] }; } },
    tabs: { get: async id => tab(id), update: async (id, options) => { h.tabUpdates.push({ id, ...options }); }, reload: async () => {
      h.operationOrder.push('target:reload'); reloading = true; h.now += advanceAfterReload;
    }, create: async options => { h.createdTargets.push(options); renderTabExists = true; return { id: 8 }; },
      remove: async id => { h.tabRemovals.push(id); if (id === 8) renderTabExists = false; }, sendMessage: async (id, message, options) => {
        h.operationOrder.push(`page:${message.action}`);
        h.pageActions.push(message.action);
        h.sentMessages.push({ id, message, options });
        if (ownedFixture && message.type === 'bilibili-native-supply') return ownedFixture.page;
        assert.equal(tab(id)?.url, DISPATCH_TARGET_URL, 'never message a tab without verified target URL');
        if (message.type === 'bilibili-live-preview' && liveFixture) {
          if (message.action === 'start') {
            liveFixture.host.grant.state = 'running';
            liveFixture.host.grant.startedAt = 200;
          }
          return liveFixture.page;
        }
        if (message.type === 'bilibili-native-supply' && nativeFixture)
          return message.action === 'bind' ? nativeFixture.boundPage : nativeFixture.page;
        if (message.type === 'bilibili-display-plan-control') return planReply ?? {
          ok: true, version: '0.4.16', buildId, session: { id: 'fixture' },
          report: { coverage: { mainBuildId: buildId }, simulation: { A: { events: 0 }, B: { events: 0 } },
            playback: { seekCount: message.action === 'seek' ? 1 : 0, restored: message.action === 'cleanup' },
            restored: message.action === 'cleanup', actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 },
        };
        if (message.type === 'bilibili-render-preview-control') return renderReply ?? {
          ok: true, version: '0.4.16', buildId, session: { id: 'fixture' },
          report: { coverage: { mainBuildId: buildId }, simulation: { B: { events: [] } }, render: { events: [], frame: [] },
            playback: { seekCount: message.action === 'seek' ? 1 : 0, restored: message.action === 'cleanup' },
            restored: message.action === 'cleanup', actualModelCalls: 0, modelLoads: 0,
            nativeSettingsWrites: 0, adapterPrepared: 0 },
        };
        return { ok: true, version: '0.4.16', buildId, session: { id: 'fixture' }, ...pageReply };
      } },
    permissions: { contains: async () => false },
  };
  const elements = new Map();
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, disabled: false, addEventListener() {} });
    return elements.get(id);
  } };
  const window = {}; window.top = window;
  const location = { protocol: 'chrome-extension:', host: extensionId, pathname: '/dispatch-runner.html',
    hash: `#port=12345&token=${token}`, href: `${pageUrl}#port=12345&token=${token}` };
  const FakeDate = class extends Date { static now() { return h.now; } };
  const exports = {};
  runInNewContext(code, { exports, browser, window, document, location,
    Date: FakeDate, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController,
    setTimeout: callback => setImmediate(callback), clearTimeout() {},
    require: key => ({ 'wxt/browser': { browser }, '../../src/core/build-identity': { BUILD_ID: buildId },
      '../../src/diagnostics/dispatch-runner-protocol': {
        DISPATCH_OWNED_KEY, DISPATCH_SESSION_KEY, DISPATCH_REFRESH_KEY, DISPLAY_PLAN_OWNER_KEY,
        RENDER_PREVIEW_OWNER_KEY, LIVE_PREVIEW_OWNER_KEY, NATIVE_SUPPLY_OWNER_KEY,
        NATIVE_REFERENCE_OWNER_KEY, DISPATCH_TARGET_URL,
        isDispatchTarget, parseDispatchHash,
        parseDispatchCommand, validDispatchId,
      }, './live-preview-recovery': { recoverLivePreviewWithoutNewCalls },
      '../../src/diagnostics/live-preview-host': { NATIVE_SUPPLY_GUARD_KEY: 'nativeSupply.zeroTransport.v1' },
      '../../src/core/resource': { matchesResourceUrl, sameSession, validSession },
      './style.css': {} })[key] ?? (() => { throw Error(`Unexpected import ${key}`); })(),
  });
  return { ...h, api: exports.fixture, local, elements, closeTarget: () => { reloading = true; reloadedTab = null; } };
}

test('owned-supply status reads only the current grant document without touching playback or model', async () => {
  const oldBuildId = '0.4.28-personal-fixture';
  const session = { platform: 'bilibili', scenario: 'video',
    resourceId: 'av117318021548752:cid42173138507', urlResourceId: 'BV1yvhW6sEzi:p1',
    sessionId: 'personal-video', generation: 3 };
  const grant = { policy: 'owned', buildId: oldBuildId, tabId: 19, documentId: 'owned-document', session, epoch: 8 };
  const owned = { backgroundVersion: '0.4.28', backgroundBuildId: oldBuildId,
    host: { ok: true, buildId: oldBuildId, grant, inputs: [] },
    tab: { id: 19, url: 'https://www.bilibili.com/video/BV1yvhW6sEzi/?p=1' },
    page: { ok: true, version: '0.4.28', buildId: oldBuildId, policy: 'owned', session, epoch: 8,
      state: 'paused', sourceCount: 0 } };
  const h = runnerPageHarness(null, 0, undefined, null, null, null, null, null, owned);
  for (const action of ['status', 'export']) {
    const result = await h.api.ownedSupplyStatus(action);
    assert.equal(result.host, owned.host);
    assert.equal(result.page, owned.page);
    assert.equal(result.readerBuildId, buildId);
    assert.equal(result.backgroundBuildId, oldBuildId);
    assert.equal(result.backgroundVersion, '0.4.28');
    assert.equal(result.mixedBuild, true);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.sentMessages)), [
    { id: 19, message: { type: 'bilibili-native-supply', action: 'status' },
      options: { frameId: 0, documentId: 'owned-document' } },
    { id: 19, message: { type: 'bilibili-native-supply', action: 'export' },
      options: { frameId: 0, documentId: 'owned-document' } },
  ]);
  assert.deepEqual(h.backgroundEvents, ['build-identity:build-identity', 'build-identity:build-identity']);
  assert.deepEqual(h.tabUpdates, []);
  assert.deepEqual(h.tabRemovals, []);
  assert.deepEqual(h.createdTargets, []);

  owned.page = { ...owned.page, session: { ...session, generation: 4 }, epoch: 9 };
  const changed = await h.api.ownedSupplyStatus('status');
  assert.equal(changed.ok, false);
  assert.equal(changed.error, 'OWNED_SUPPLY_IDENTITY_MISMATCH');
  assert.equal(changed.expected.session.generation, 3);
  assert.equal(changed.observed.session.generation, 4);
  assert.equal(changed.expected.epoch, 8);
  assert.equal(changed.observed.epoch, 9);
  assert.equal(changed.host, owned.host);
  assert.equal(changed.page, owned.page);
  assert.equal(changed.mixedBuild, true);

  owned.page = { ...owned.page, session, epoch: 8, policy: 'native' };
  await assert.rejects(h.api.ownedSupplyStatus('status'), /OWNED_SUPPLY_PAGE_MISMATCH/);
  owned.page = { ...owned.page, policy: 'owned', buildId: 'other-build' };
  await assert.rejects(h.api.ownedSupplyStatus('status'), /OWNED_SUPPLY_PAGE_MISMATCH/);
  owned.page = { ...owned.page, buildId: oldBuildId };
  owned.tab = { id: 19, url: 'https://www.bilibili.com/video/BV1RHaw6mEDR/' };
  const readsBefore = h.sentMessages.length;
  await assert.rejects(h.api.ownedSupplyStatus('status'), /OWNED_SUPPLY_OWNER_URL_MISMATCH/);
  owned.tab = { id: 19, url: 'https://www.bilibili.com/video/BV1yvhW6sEzi/', pendingUrl: 'https://example.com/' };
  await assert.rejects(h.api.ownedSupplyStatus('status'), /OWNED_SUPPLY_OWNER_NAVIGATION_PENDING/);
  assert.equal(h.sentMessages.length, readsBefore, 'foreign or navigating tabs receive no message');
  owned.host.grant = null;
  await assert.rejects(h.api.ownedSupplyStatus('status'), /OWNED_SUPPLY_NO_OWNER/);
  assert.equal(h.sentMessages.length, readsBefore);
});

test('runner observes a persisted page-button start and prevents a second run', async () => {
  const liveSession = { platform: 'bilibili', scenario: 'video', resourceId: 'av117318021548752:cid42173138507',
    sessionId: 'live-session' };
  const owner = { tabId: 7, buildId, taskId: 'live-task', runId: 'live-run', phase: 'main',
    instanceId: 'live-instance', epoch: 1, runIssued: false };
  const liveFixture = { host: { ok: true, buildId, nativePrepared: 0, onlineCalls: 0,
    grant: { ...owner, state: 'running', startedAt: 200 } },
  page: { ok: true, version: '0.4.16', buildId, session: liveSession, epoch: 1,
    report: { coverage: { mainBuildId: buildId }, nativePrepared: 0, adapterPrepared: 0,
      nativeSettingsWrites: 0, render: { contract: 'render-preview-v1' },
      clock: { mediaTimeMs: 47000 }, runId: owner.runId, instanceId: owner.instanceId, state: 'running' } } };
  const h = runnerPageHarness(null, 0, undefined, null, null, null, liveFixture);
  h.local[LIVE_PREVIEW_OWNER_KEY] = owner;
  const observed = await h.api.livePreviewAction('resume');
  assert.equal(observed.host.grant.startedAt, 200);
  assert.equal(h.local[LIVE_PREVIEW_OWNER_KEY].runIssued, true);
  assert.equal(h.tabUpdates.length, 1);
  assert.equal(h.tabUpdates[0].id, 7);
  assert.equal(h.tabUpdates[0].active, true);
  await assert.rejects(h.api.livePreviewAction('run'), /RUN_ALREADY_ISSUED/);
  assert.deepEqual(h.pageActions, ['status']);
  assert.equal(h.backgroundEvents.some(row => row.endsWith(':start') || row.endsWith(':translate')), false);
  h.tabUpdates.length = 0;
  liveFixture.host.grant.state = 'stopped';
  liveFixture.page.report.state = 'stopped';
  await h.api.livePreviewAction('resume');
  assert.equal(h.tabUpdates.length, 0, 'A stopped grant never reactivates its page');
});

test('runner restores a prepared supplement owner for one independent run', async () => {
  const owner = { tabId: 7, buildId, taskId: 'live-task', runId: 'supplement-run',
    phase: 'supplement', instanceId: 'supplement-instance', epoch: 1, runIssued: false };
  const liveFixture = { host: { ok: true, buildId, nativePrepared: 0, onlineCalls: 0,
    grant: { ...owner, state: 'prepared' } },
  page: { ok: true, version: '0.4.16', buildId,
    session: { platform: 'bilibili', scenario: 'video',
      resourceId: 'av117318021548752:cid42173138507', sessionId: 'live-session' }, epoch: 1,
    report: { coverage: { mainBuildId: buildId }, nativePrepared: 0, adapterPrepared: 0,
      nativeSettingsWrites: 0, render: { contract: 'render-preview-v1' },
      clock: { mediaTimeMs: 45000 }, runId: owner.runId, instanceId: owner.instanceId } } };
  const h = runnerPageHarness(null, 0, undefined, null, null, null, liveFixture);
  h.local[LIVE_PREVIEW_OWNER_KEY] = owner;
  const result = await h.api.livePreviewAction('run');
  assert.equal(result.host.grant.state, 'running');
  assert.equal(result.host.grant.startedAt, 200);
  assert.equal(h.local[LIVE_PREVIEW_OWNER_KEY].runIssued, true);
  assert.deepEqual(h.pageActions, ['start']);
  assert.deepEqual(h.tabUpdates, [{ id: 7, active: true }]);
  await assert.rejects(h.api.livePreviewAction('run'), /RUN_ALREADY_ISSUED/);
  assert.deepEqual(h.pageActions, ['start']);
});

test('native-supply recovery reloads the same owned tab and binds one recovered zero-call grant', async () => {
  const owner = { tabId: 7, buildId: '0.4.16-old-fixture', taskId: 'task-7b',
    runId: 'run-7b', phase: 'main', modelId: 'registered-7b', runIssued: false };
  const session = { platform: 'bilibili', scenario: 'video',
    resourceId: 'av117318021548752:cid42173138507', sessionId: 'document-7b' };
  const baseGrant = { ...owner, state: 'recovery-required', modelLoads: 1,
    loadRecoveryCount: 0, loadOwnership: 'owned', loadedByTask: true,
    modelGeneration: 1, fromMs: 0, toMs: 45_000 };
  const page = { ok: true, buildId, session, epoch: 2,
    clock: { paused: true, seeking: false, mediaTimeMs: 0 } };
  const nativeFixture = { hostActions: [], page, boundPage: { ...page, state: 'armed' },
    beforeHost: { ok: true, buildId, onlineCalls: 0, grant: baseGrant, activeRequests: 0,
      localState: { phase: 'idle', active: 0, queued: 0, inferenceCalls: 0,
        modelId: null, generation: 0 } },
    recoveredHost: { ok: true, buildId, onlineCalls: 0, grant: { ...baseGrant,
      buildId, state: 'prepared', epoch: 2, session, modelLoads: 2, loadRecoveryCount: 1,
      instanceId: 'recovered-instance', configIdentity: 'config-7b' } } };
  const h = runnerPageHarness([{ id: 7, url: DISPATCH_TARGET_URL }],
    0, undefined, null, null, null, null, nativeFixture);
  h.local[NATIVE_SUPPLY_OWNER_KEY] = owner;
  h.local['nativeSupply.zeroTransport.v1'] = { enabled: true, kind: 'native-supply',
    tabId: 7, runId: owner.runId };
  const input = { action: 'recover-prepare', taskId: owner.taskId, runId: owner.runId,
    phase: 'main', modelId: owner.modelId, fromMs: 0, toMs: 45_000 };
  const recovered = await h.api.nativeSupplyAction('recover-prepare', input);
  assert.equal(recovered.host.grant.instanceId, 'recovered-instance');
  assert.deepEqual(nativeFixture.hostActions, ['status', 'prepare']);
  assert.deepEqual(h.pageActions, ['status', 'prepare', 'bind']);
  assert.deepEqual(h.tabUpdates, [{ id: 7, active: true }]);
  assert.equal(h.local[NATIVE_SUPPLY_OWNER_KEY].taskId, owner.taskId);
  assert.equal(h.local[NATIVE_SUPPLY_OWNER_KEY].runId, owner.runId);
  assert.equal(h.local[NATIVE_SUPPLY_OWNER_KEY].buildId, buildId);
  assert.equal(h.local[NATIVE_SUPPLY_OWNER_KEY].runIssued, false);
  assert.deepEqual(h.createdTargets, []);
  const reloads = h.operationOrder.filter(event => event === 'target:reload');
  assert.deepEqual(reloads, ['target:reload']);
});

test('full native reference waits for a newly created blank tab, snapshots without stopping, and releases its guard', async () => {
  const session = { platform: 'bilibili', scenario: 'video',
    resourceId: 'av117318021548752:cid42173138507', sessionId: 'full-document' };
  const page = { ok: true, buildId, session, epoch: 1,
    clock: { paused: false, seeking: false, mediaTimeMs: 2000 },
    reference: { fullVideo: true, durationMs: 183000, ended: false } };
  const fixture = { hostActions: [], page, newTargetStates: [{ id: 8, url: 'about:blank' }] };
  const h = runnerPageHarness(null, 0, undefined, null, null, null, null, fixture);
  const started = await h.api.nativeSupplyAction('reference-full-start');
  assert.equal(started.reference.fullVideo, true);
  assert.equal(started.ownedTargetTabId, 8);
  assert.deepEqual(h.pageActions, ['reference-ready', 'reference-full-start']);
  assert.deepEqual(h.backgroundEvents.filter(row => row.startsWith('bilibili-render-preview-guard:')),
    ['bilibili-render-preview-guard:prepare', 'bilibili-render-preview-guard:status']);
  const sampled = await h.api.nativeSupplyAction('reference-snapshot');
  assert.equal(sampled.reference.durationMs, 183000);
  assert.deepEqual(h.pageActions, ['reference-ready', 'reference-full-start', 'reference-snapshot']);
  assert.equal(h.local[NATIVE_REFERENCE_OWNER_KEY].tabId, 8);
  const receipt = await h.api.nativeSupplyAction('reference-cleanup');
  assert.equal(receipt.guardReleased, true);
  assert.equal(receipt.closed, true);
  assert.deepEqual(h.pageActions, ['reference-ready', 'reference-full-start', 'reference-snapshot', 'reference-stop']);
  assert.deepEqual(h.tabRemovals, [8]);
  assert.equal(h.local[NATIVE_REFERENCE_OWNER_KEY], undefined);
});

test('each official start uses the existing reference owner and zero-transport guard', async () => {
  for (const action of ['reference-official-1-start', 'reference-official-3-start',
    'reference-official-5-start', 'reference-official-dom-start']) {
    const page = { ok: true, buildId,
      session: { platform: 'bilibili', scenario: 'video',
        resourceId: 'av117318021548752:cid42173138507', sessionId: 'official-document' },
      epoch: 1, clock: { paused: false, seeking: false, mediaTimeMs: 0 } };
    const fixture = { hostActions: [], page, newTargetStates: [{ id: 8, url: 'about:blank' }] };
    const h = runnerPageHarness(null, 0, undefined, null, null, null, null, fixture);
    const started = await h.api.nativeSupplyAction(action);
    assert.equal(started.ownedTargetTabId, 8);
    assert.equal(h.createdWindows.length, action === 'reference-official-dom-start' ? 1 : 0);
    if (action === 'reference-official-dom-start') assert.deepEqual(JSON.parse(JSON.stringify(h.createdWindows[0])),
      { url: DISPATCH_TARGET_URL, focused: true, type: 'normal', width: 1280, height: 900, left: 10, top: 20 });
    assert.deepEqual(h.pageActions, ['reference-ready', action]);
    assert.equal(h.local[NATIVE_REFERENCE_OWNER_KEY].tabId, 8);
    assert.deepEqual(h.backgroundEvents.filter(row => row.startsWith('bilibili-render-preview-guard:')),
      ['bilibili-render-preview-guard:prepare', 'bilibili-render-preview-guard:status']);
    await h.api.nativeSupplyAction('reference-cleanup');
    assert.deepEqual(h.pageActions, ['reference-ready', action, 'reference-stop']);
    assert.deepEqual(h.tabRemovals, [8]);
  }
});

test('authorized extra-load repair binds a new owned tab to the same cleaned task without starting it', async () => {
  const session = { platform: 'bilibili', scenario: 'video',
    resourceId: 'av117318021548752:cid42173138507', sessionId: 'new-document' };
  const page = { ok: true, buildId, session, epoch: 1,
    clock: { paused: true, seeking: false, mediaTimeMs: 0 } };
  const input = { action: 'prepare', taskId: 'same-task', runId: 'repair-run', phase: 'repair',
    modelId: 'registered-7b', fromMs: 0, toMs: 15000, repairReason: 'Authorized startup repair', authorizedExtraLoad: true };
  const baseGrant = { taskId: input.taskId, runId: 'old-main', tabId: 7, phase: 'main',
    modelId: input.modelId, state: 'stopped', reason: 'owner-tab-retired', modelLoads: 2, loadRecoveryCount: 1 };
  const fixture = { hostActions: [], page, boundPage: { ...page, state: 'armed' },
    newTargetStates: [{ id: 8, url: 'about:blank' }],
    beforeHost: { ok: true, buildId, onlineCalls: 0, grant: baseGrant, activeRequests: 0,
      budget: { phases: { repair: { runId: null } } }, localState: { phase: 'idle', active: 0, queued: 0 } },
    recoveredHost: { ok: true, buildId, onlineCalls: 0, grant: { ...baseGrant,
      runId: input.runId, tabId: 8, phase: 'repair', state: 'prepared', epoch: 1, session,
      modelLoads: 3, instanceId: 'new-permit', configIdentity: 'same-config' } } };
  const h = runnerPageHarness(null, 0, undefined, null, null, null, null, fixture);
  const result = await h.api.nativeSupplyAction('prepare', input);
  assert.equal(result.ownedTargetTabId, 8);
  assert.equal(h.createdTargets.length, 1);
  assert.equal(fixture.hostInputs[0].authorizedExtraLoad, true);
  assert.equal(fixture.hostInputs[0].taskId, input.taskId);
  assert.deepEqual(h.pageActions, ['prepare', 'bind']);
  assert.equal(h.local[NATIVE_SUPPLY_OWNER_KEY].runIssued, false);
  await assert.rejects(h.api.nativeSupplyAction('prepare', input), /CLEANUP_REQUIRED/);
  assert.equal(fixture.hostInputs.length, 1);

  const bad = structuredClone(fixture);
  bad.beforeHost.grant.taskId = 'other-task'; bad.hostActions = [];
  const rejected = runnerPageHarness(null, 0, undefined, null, null, null, null, bad);
  await assert.rejects(rejected.api.nativeSupplyAction('prepare', input), /EXTRA_LOAD_REPAIR_UNAVAILABLE/);
  assert.equal(rejected.createdTargets.length, 0);

  const pending = structuredClone(fixture);
  pending.hostActions = []; pending.hostInputs = []; pending.recoveredHost.grant.tabId = 7;
  const resumed = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL },
    0, undefined, null, null, null, null, pending);
  resumed.local[NATIVE_SUPPLY_OWNER_KEY] = { tabId: 7, buildId: 'retired-build',
    taskId: input.taskId, runId: input.runId, modelId: input.modelId, phase: 'repair' };
  await resumed.api.nativeSupplyAction('prepare', input);
  assert.equal(resumed.createdTargets.length, 0, 'reuse the authenticated unbound owner after a preflight failure');
  assert.equal(resumed.local[NATIVE_SUPPLY_OWNER_KEY].buildId, buildId);
  assert.deepEqual(pending.hostActions, ['status', 'prepare']);
  assert.ok(resumed.operationOrder.includes('target:reload'));
});

test('verified owned tab survives only transient missing URL during its own user-filter reload', async () => {
  const h = runnerPageHarness([{ id: 7 }, { id: 7 }, { id: 7, url: DISPATCH_TARGET_URL }]);
  await flush(); await flush();
  assert.equal(h.api.targetTabState({ id: 7, url: DISPATCH_TARGET_URL }), 'ready');
  assert.equal(h.api.getOwned(), 7, h.elements.get('status')?.textContent);
  const receipt = await h.api.userFiltersAction('prepare');
  assert.equal(receipt.ok, true);
  assert.deepEqual(h.pageActions, ['prepare']);
  assert.equal(h.local[DISPATCH_OWNED_KEY], 7);
  assert.deepEqual(h.tabRemovals, []);
});

test('foreign pending navigation and expired blank URL never receive user-filter actions', async () => {
  for (const [state, elapsed] of [
    [{ id: 7, url: DISPATCH_TARGET_URL, pendingUrl: 'https://example.com/' }, 0],
    [{ id: 7, url: 'https://example.com/' }, 0],
    [{ id: 7 }, 30000],
  ]) {
    const h = runnerPageHarness(state, elapsed);
    await flush(); await flush();
    await assert.rejects(h.api.userFiltersAction('prepare'), /OWNED_TARGET_UNAVAILABLE/);
    assert.deepEqual(h.pageActions, []);
    assert.equal(h.local[DISPATCH_OWNED_KEY], undefined);
  }
});

test('cleanup restores either saved user-filter setting before releasing the zero-model guard', async () => {
  for (const saved of [false, true]) {
    const h = runnerPageHarness(null, 0, { enabled: saved,
      report: { restored: true, coverage: { featureEnabled: saved } } });
    await flush(); await flush();
    const result = await h.api.userFiltersAction('cleanup');
    assert.equal(result.guardReleased, true);
    assert.equal(result.enabled, saved);
    assert.deepEqual(h.pageActions, ['cleanup']);
    assert.deepEqual(h.backgroundActions, ['status', 'cleanup']);
  }
});

test('cleanup refuses missing or mismatched restoration without releasing the guard', async () => {
  for (const pageReply of [
    { enabled: true, report: { restored: false, coverage: { featureEnabled: true } } },
    { enabled: true, report: { restored: true, coverage: { featureEnabled: false } } },
    { enabled: false, report: { restored: true, coverage: {} } },
  ]) {
    const h = runnerPageHarness(null, 0, pageReply);
    await flush(); await flush();
    await assert.rejects(h.api.userFiltersAction('cleanup'), /USER_FILTERS_RESTORE_UNCONFIRMED/);
    assert.deepEqual(h.pageActions, ['cleanup']);
    assert.deepEqual(h.backgroundActions, ['status'], 'background cleanup never ran');
  }
});

test('display-plan preparation waits for read-only page readiness before installing the owner guard', async () => {
  const h = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL });
  await flush(); await flush();
  const result = await h.api.displayPlanAction('prepare');
  assert.equal(result.ok, true);
  assert.equal(result.background.ownerTabId, 7);
  assert.deepEqual(h.backgroundEvents.slice(0, 3), [
    'settings:settings', 'build-identity:build-identity', 'bilibili-display-plan-guard:prepare',
  ]);
  assert.ok(h.operationOrder.indexOf('page:prepare') < h.operationOrder.indexOf('background:bilibili-display-plan-guard:prepare'));
  assert.equal(h.local[DISPATCH_OWNED_KEY], 7);
  assert.equal(h.local[DISPLAY_PLAN_OWNER_KEY].tabId, 7);
});

test('display-plan status rejects body fields and cleanup preserves the guard unless watch confirms restoration', async () => {
  const leaking = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL }, 0, undefined, {
    ok: true, version: '0.4.16', buildId, session: { id: 'fixture' },
    report: { coverage: { mainBuildId: buildId }, simulation: { inputFrames: [{ text: 'private' }], A: {}, B: {} },
      actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 },
  });
  await flush(); await flush();
  await assert.rejects(leaking.api.displayPlanAction('status'), /DISPLAY_PLAN_STATUS_CONTAINS_INPUT_BODY/);

  const unrestored = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL }, 0, undefined, {
    ok: true, version: '0.4.16', buildId, session: { id: 'fixture' },
    report: { coverage: { mainBuildId: buildId }, simulation: { A: {}, B: {} }, restored: false,
      actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 },
  });
  await flush(); await flush();
  await assert.rejects(unrestored.api.displayPlanAction('cleanup'), /DISPLAY_PLAN_RESTORE_UNCONFIRMED/);
  assert.equal(unrestored.backgroundEvents.includes('bilibili-display-plan-guard:cleanup'), false);
});

test('display-plan cleanup confirms page restoration before releasing the owner guard', async () => {
  const h = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL });
  await flush(); await flush();
  const result = await h.api.displayPlanAction('cleanup');
  assert.equal(result.guardReleased, true);
  assert.equal(result.report.restored, true);
  assert.ok(h.operationOrder.indexOf('page:cleanup') < h.operationOrder.indexOf('background:bilibili-display-plan-guard:cleanup'));
  assert.equal(h.local[DISPLAY_PLAN_OWNER_KEY], undefined);
});

test('display-plan cleanup can release its matching guard only after proving the owned tab is absent', async () => {
  const h = runnerPageHarness(null);
  await flush(); await flush();
  h.local[DISPLAY_PLAN_OWNER_KEY] = { tabId: 7, buildId };
  h.closeTarget();
  const result = await h.api.displayPlanAction('cleanup');
  assert.equal(result.closedTargetEvidence.exists, false);
  assert.equal(result.closedTargetEvidence.tabId, 7);
  assert.equal(result.guardReleased, true);
  assert.deepEqual(h.pageActions, []);
  assert.equal(h.local[DISPLAY_PLAN_OWNER_KEY], undefined);
});

test('render-preview status is body-free, B-only, and never prepares the real adapter', () => {
  const h = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL });
  const receipt = { ok: true, version: '0.4.16', buildId, session: { id: 'fixture' }, report: {
    coverage: { mainBuildId: buildId }, simulation: { B: { activeSubscriptions: 1,
      simulatedProviderCalls: 1, simulatedProviderInputs: 1,
      events: [{ id: 'opaque-1', state: 'entered' }],
      outcomes: [{ id: 'opaque-1', result: 'accepted' }] } }, render: { events: [], frame: [] },
    playback: {}, actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0, adapterPrepared: 0,
  } };
  assert.equal(h.api.validateRenderPreviewPage('status', receipt), receipt);
  const realSession = new DisplayPlanSession(DEFAULT_SETTINGS, { comparison: false });
  const productionStatus = { ...receipt, report: { ...receipt.report, simulation: realSession.report() } };
  assert.equal(h.api.validateRenderPreviewPage('status', productionStatus), productionStatus);
  realSession.stop('cleanup');
  for (const key of ['inputFrames', 'sourceText', 'originalText', 'inputText', 'translatedText', 'text', 'body']) {
    const leaking = structuredClone(receipt);
    leaking.report.render.events = [{ [key]: 'must-not-leak' }];
    assert.throws(() => h.api.validateRenderPreviewPage('status', leaking), /RENDER_PREVIEW_STATUS_CONTAINS_BODY/);
  }
  const bothBranches = structuredClone(receipt);
  bothBranches.report.simulation.A = { events: [] };
  assert.throws(() => h.api.validateRenderPreviewPage('status', bothBranches), /RENDER_PREVIEW_SIMULATION_NOT_B_ONLY/);
  const leakingOutcome = structuredClone(receipt);
  leakingOutcome.report.simulation.B.outcomes[0].authorName = 'private';
  assert.throws(() => h.api.validateRenderPreviewPage('status', leakingOutcome), /RENDER_PREVIEW_STATUS_CONTAINS_BODY/);
  const preparedAdapter = structuredClone(receipt);
  preparedAdapter.report.adapterPrepared = 1;
  assert.throws(() => h.api.validateRenderPreviewPage('status', preparedAdapter), /RENDER_PREVIEW_PAGE_MISMATCH/);
  assert.throws(() => h.api.validateRenderPreviewPage('seek', { ...receipt, report: {
    ...receipt.report, playback: { seekCount: 2 },
  } }), /RENDER_PREVIEW_SEEK_UNCONFIRMED/);
});

test('render-preview prepare installs a separate temporary guard and binds it to the owned target', async () => {
  const persistent = { key: 'bilibiliUserFilters.zeroTransport.v1', present: true, enabled: true,
    declaredEnabled: false, kind: 'legacy-protection', ownerTabId: null };
  const h = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL }, 0, undefined, undefined, undefined, persistent);
  const oldPlanOwner = { tabId: 6, buildId: 'old-plan-build' };
  h.local[DISPLAY_PLAN_OWNER_KEY] = oldPlanOwner;
  await flush(); await flush();
  const result = await h.api.renderPreviewAction('prepare');
  assert.equal(result.ok, true);
  assert.equal(result.background.protections.temporaryGuard.enabled, true);
  assert.equal(result.background.protections.temporaryGuard.ownerTabId, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(result.protectionBaseline)), persistent);
  assert.deepEqual(JSON.parse(JSON.stringify(h.local[RENDER_PREVIEW_OWNER_KEY])),
    { tabId: 8, buildId, persistentGuard: persistent });
  assert.equal(h.local[DISPATCH_OWNED_KEY], 7, 'render-preview never adopts the older shared runner tab');
  assert.equal(h.createdTargets.length, 1);
  assert.equal(h.createdTargets[0].url, DISPATCH_TARGET_URL);
  assert.equal(h.local[DISPLAY_PLAN_OWNER_KEY], oldPlanOwner, 'render preview must not mutate display-plan ownership');
  const guardIndex = h.operationOrder.indexOf('background:bilibili-render-preview-guard:prepare');
  const pageIndex = h.operationOrder.indexOf('page:prepare');
  assert.ok(guardIndex >= 0 && pageIndex > guardIndex, 'temporary guard is installed before page preparation');
});

test('render-preview cleanup restores first, releases only its temporary guard, and preserves persistent protection', async () => {
  const persistent = { key: 'bilibiliUserFilters.zeroTransport.v1', present: true, enabled: true,
    declaredEnabled: false, kind: 'legacy-protection', ownerTabId: null };
  const h = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL }, 0, undefined, undefined, undefined, persistent);
  const oldPlanOwner = { tabId: 6, buildId: 'old-plan-build' };
  h.local[DISPLAY_PLAN_OWNER_KEY] = oldPlanOwner;
  await flush(); await flush();
  await h.api.renderPreviewAction('prepare');
  const result = await h.api.renderPreviewAction('cleanup');
  assert.equal(result.report.restored, true);
  assert.equal(result.guardReleased, true);
  assert.equal(result.background.protections.temporaryGuard.enabled, false);
  assert.equal(result.background.effectiveZeroTransport, true, 'persistent zero-transport remains effective');
  assert.deepEqual(JSON.parse(JSON.stringify(result.background.protections.persistentGuard)), persistent);
  assert.equal(h.local[RENDER_PREVIEW_OWNER_KEY].cleanupConfirmed, true);
  assert.equal(h.local[DISPLAY_PLAN_OWNER_KEY], oldPlanOwner);
  const pageIndex = h.operationOrder.lastIndexOf('page:cleanup');
  const guardIndex = h.operationOrder.lastIndexOf('background:bilibili-render-preview-guard:cleanup');
  assert.ok(pageIndex >= 0 && guardIndex > pageIndex, 'restore precedes temporary-guard release');
  const closed = await h.api.closeRenderPreviewOwnedTarget();
  assert.deepEqual({ ...closed }, { closed: true, tabId: 8, targetWasPresent: true });
  assert.deepEqual(h.tabRemovals, [8], 'only the render-preview target is closed');
  assert.equal(h.local[RENDER_PREVIEW_OWNER_KEY], undefined);
  assert.equal(h.local[DISPATCH_OWNED_KEY], 7, 'the older shared runner ownership remains untouched');
});

test('display-plan status accepts redacted production logs and category summary names', async () => {
  const simulation = new DisplayPlanSession(DEFAULT_SETTINGS);
  const report = simulation.report(); simulation.stop('invalidated');
  const h = runnerPageHarness({ id: 7, url: DISPATCH_TARGET_URL }, 0, undefined, {
    ok: true, version: '0.4.16', buildId, session: { id: 'fixture' },
    report: { coverage: { mainBuildId: buildId, categories: { sender: { status: 'ready' } } },
      simulation: report,
      actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 },
  });
  await flush(); await flush();
  assert.equal((await h.api.displayPlanAction('status')).ok, true);
});
