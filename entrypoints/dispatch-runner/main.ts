import { browser } from 'wxt/browser';
import { BUILD_ID } from '../../src/core/build-identity';
import {
  DISPATCH_OWNED_KEY, DISPATCH_REFRESH_KEY, DISPLAY_PLAN_OWNER_KEY, RENDER_PREVIEW_OWNER_KEY,
  LIVE_PREVIEW_OWNER_KEY,
  NATIVE_SUPPLY_OWNER_KEY, NATIVE_REFERENCE_OWNER_KEY,
  DISPATCH_SESSION_KEY, DISPATCH_TARGET_URL, isDispatchTarget,
  parseDispatchCommand, parseDispatchHash, validDispatchId,
  type DispatchAuditAction, type DispatchCommand, type DispatchRpc, type DisplayPlanAction,
  type RenderPreviewAction, type LivePreviewAction, type LivePreviewPrepare,
  type NativeSupplyAction, type NativeSupplyPrepare, type UserFiltersAction,
} from '../../src/diagnostics/dispatch-runner-protocol';
import { NATIVE_SUPPLY_GUARD_KEY } from '../../src/diagnostics/live-preview-host';
import { matchesResourceUrl, sameSession, validSession } from '../../src/core/resource';
import { recoverLivePreviewWithoutNewCalls } from './live-preview-recovery';
import './style.css';

type SessionRecord = { connectionUrl: string; ownedTabId: number | null };
type DisplayPlanOwnerRecord = { tabId: number; buildId: string };
type PersistentGuardSummary = { key: string; present: boolean; enabled: boolean; declaredEnabled: boolean | null;
  kind: string | null; ownerTabId: number | null };
type RenderPreviewOwnerRecord = { tabId: number; buildId: string; persistentGuard: PersistentGuardSummary;
  cleanupConfirmed?: boolean };
type LivePreviewOwnerRecord = { tabId: number; buildId: string; taskId: string; runId: string;
  phase: 'main' | 'repair' | 'supplement'; instanceId?: string; epoch?: number; runIssued?: boolean;
  cleanupConfirmed?: boolean };
type NativeSupplyOwnerRecord = { tabId: number; buildId: string; taskId: string; runId: string;
  phase: 'main' | 'repair'; modelId: string; instanceId?: string; epoch?: number;
  runIssued?: boolean; replayIssued?: boolean; cleanupConfirmed?: boolean };
type NativeReferenceOwnerRecord = { tabId: number; buildId: string;
  persistentGuard: PersistentGuardSummary; cleanupConfirmed?: boolean };
type CommandResult = { result: unknown; reload?: true };
type RefreshRecord = { tabId: number; buildId: string; expiresAt: number };
const REFRESH_LIFETIME_MS = 2 * 60 * 1000;
const OWNED_RELOAD_WAIT_MS = 22 * 1000;

const manifest = browser.runtime.getManifest();
const state = document.getElementById('connection-state')!;
const status = document.getElementById('status')!;
const target = document.getElementById('target-state')!;
const lastCommand = document.getElementById('last-command')!;
const connectButton = document.getElementById('connect') as HTMLButtonElement;
const disconnectButton = document.getElementById('disconnect') as HTMLButtonElement;
document.getElementById('version')!.textContent = manifest.version;
document.getElementById('build-id')!.textContent = BUILD_ID;

let connection: ReturnType<typeof parseDispatchHash> | null = null;
let connected = false, connecting = false, executing = false;
let requestAbort: AbortController | null = null;
let ownedTabId: number | null = null;
let ownedReload: { tabId: number; expiresAt: number } | null = null;

function setState(value: 'offline' | 'online' | 'error', message: string) {
  state.dataset.state = value;
  state.textContent = value === 'online' ? '已连接' : value === 'error' ? '连接失败' : '未连接';
  status.textContent = message;
  connectButton.disabled = connected || connecting || !connection;
  disconnectButton.disabled = !connected || executing;
}

function fail(code: string): never { throw new Error(code); }

function targetTabState(tab: { url?: string; pendingUrl?: string } | null): 'ready' | 'pending' | 'foreign' {
  if (!tab) return 'foreign';
  // A foreign pending navigation supersedes an old matching document. A
  // matching pending navigation retains ownership but cannot receive actions.
  if (tab.pendingUrl) return isDispatchTarget(tab.pendingUrl) ? 'pending' : 'foreign';
  return isDispatchTarget(tab.url) ? 'ready' : 'foreign';
}

async function saveSession() {
  await browser.storage.session.set({ [DISPATCH_SESSION_KEY]: {
    connectionUrl: location.href, ownedTabId,
  } satisfies SessionRecord });
  if (ownedTabId === null) await browser.storage.local.remove(DISPATCH_OWNED_KEY);
  else await browser.storage.local.set({ [DISPATCH_OWNED_KEY]: ownedTabId });
}

async function restoreSession() {
  const saved = (await browser.storage.session.get(DISPATCH_SESSION_KEY))[DISPATCH_SESSION_KEY] as SessionRecord | undefined;
  // The connection URL contains a new port and token on every Node session. The
  // tab identity is independent of that credential and must survive extension reload.
  const persisted = (await browser.storage.local.get(DISPATCH_OWNED_KEY))[DISPATCH_OWNED_KEY];
  const candidates = [saved?.ownedTabId, persisted].filter((id): id is number =>
    Number.isSafeInteger(id) && (id as number) >= 0);
  for (const id of new Set(candidates)) {
    const tab = await browser.tabs.get(id).catch(() => null);
    const phase = targetTabState(tab);
    if (phase !== 'foreign') {
      ownedTabId = id;
      target.textContent = phase === 'pending' ? `正在打开 · ${id}` : `已打开 · ${id}`;
      return;
    }
  }
  ownedTabId = null;
  await browser.storage.local.remove([DISPATCH_OWNED_KEY, DISPATCH_REFRESH_KEY]);
}

async function ownedTab() {
  if (ownedTabId === null) return null;
  const tab = await browser.tabs.get(ownedTabId).catch(() => null);
  const phase = targetTabState(tab);
  // Chrome can briefly omit both URL fields during a reload we just issued.
  // Retain ownership only for this known tab and bounded interval; never send
  // a page command until its exact target URL is visible again.
  const blankOwnReload = phase === 'foreign' && tab && !tab.url && !tab.pendingUrl &&
    ownedReload?.tabId === ownedTabId && ownedReload.expiresAt > Date.now();
  if (phase === 'pending' || blankOwnReload) {
    target.textContent = `正在打开 · ${ownedTabId}`;
    return fail('TARGET_NAVIGATION_PENDING');
  }
  ownedReload = null;
  if (phase === 'foreign') {
    ownedTabId = null;
    target.textContent = '未打开';
    await browser.storage.local.remove(DISPATCH_REFRESH_KEY);
    await saveSession();
    return null;
  }
  target.textContent = `已打开 · ${ownedTabId}`;
  return tab;
}

function controllerUrl(path: '/hello' | '/command' | '/result') {
  if (!connection) return fail('INVALID_CONNECTION');
  return `http://127.0.0.1:${connection.port}${path}`;
}

async function request(path: '/hello' | '/command' | '/result', method: 'GET' | 'POST', body?: unknown) {
  if (!connection) return fail('INVALID_CONNECTION');
  const controller = new AbortController();
  requestAbort = controller;
  const timeout = setTimeout(() => controller.abort(), path === '/command' ? 25000 : 60000);
  try {
    const response = await fetch(controllerUrl(path), {
      method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { Authorization: `Bearer ${connection.token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    if (!response.ok) return fail(`RUNNER_HTTP_${response.status}`);
    return response;
  } finally {
    clearTimeout(timeout);
    if (requestAbort === controller) requestAbort = null;
  }
}

async function commandBody(response: Response): Promise<unknown> {
  if (response.status === 204 || !response.body) return { idle: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) { await reader.cancel(); return fail('COMMAND_TOO_LARGE'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function runtime(message: DispatchRpc) {
  const reply = await browser.runtime.sendMessage(message);
  if (!reply?.ok) return fail(typeof reply?.error === 'string' ? reply.error : 'BACKGROUND_UNAVAILABLE');
  return reply;
}

function idleState(reply: any): boolean {
  const model = reply?.state;
  return reply?.ok === true && model && ['idle', 'ready'].includes(model.phase) &&
    Number.isSafeInteger(model.active) && model.active === 0 &&
    Number.isSafeInteger(model.queued) && model.queued === 0;
}

function samePerformanceExceptWarmup(current: Record<string, unknown>, selected: Record<string, unknown>) {
  const pairs = (config: Record<string, unknown>) => Object.keys(config).filter(key => key !== 'warmup')
    .sort().map(key => [key, config[key]]);
  return JSON.stringify(pairs(current)) === JSON.stringify(pairs(selected));
}

async function loadSelectedModel(modelId?: string) {
  const settingsReply = await runtime({ type: 'settings' });
  const settings = settingsReply.settings;
  if (settings?.backend !== 'local' || typeof settings.localModelId !== 'string' || !settings.localModelId ||
      modelId && modelId !== settings.localModelId || settings.enabled !== false ||
      settingsReply.performancePaused === true) return fail('SELECTED_LOCAL_MODEL_MISMATCH');
  if (!settings.localPerformance || typeof settings.localPerformance !== 'object') return fail('LOCAL_CONFIG_UNAVAILABLE');
  const loadConfig = { ...settings.localPerformance, warmup: false };
  const warmupSuppressed = settings.localPerformance.warmup !== false;
  const listed = await runtime({ type: 'local-control', control: { action: 'list' } });
  if (!Array.isArray(listed.models) || !listed.models.some((model: any) =>
    model?.id === settings.localModelId && (!model.availability || model.availability === 'ready')))
    return fail('SELECTED_LOCAL_MODEL_UNAVAILABLE');
  const current = await runtime({ type: 'local-control', control: { action: 'state' } });
  if (!idleState(current)) return fail('LOCAL_MODEL_BUSY');
  if (current.state.phase === 'ready') {
    if (current.state.model?.id !== settings.localModelId ||
        !current.state.requested ||
        !samePerformanceExceptWarmup(current.state.requested, settings.localPerformance))
      return fail('LOCAL_MODEL_ALREADY_LOADED_DIFFERENTLY');
    return { ok: true, alreadyReady: true, warmupSuppressed, state: current.state };
  }
  const fresh = await runtime({ type: 'settings' });
  if (fresh.configVersion !== settingsReply.configVersion || fresh.settings?.backend !== 'local' ||
      fresh.settings.localModelId !== settings.localModelId ||
      JSON.stringify(fresh.settings.localPerformance) !== JSON.stringify(settings.localPerformance))
    return fail('SETTINGS_CHANGED');
  const loaded = await runtime({ type: 'local-control', control: {
    action: 'load', modelId: settings.localModelId, config: loadConfig,
  } } as DispatchRpc);
  if (loaded.state?.phase !== 'ready' || loaded.state.model?.id !== settings.localModelId)
    return fail('LOCAL_MODEL_NOT_READY');
  return { ok: true, warmupSuppressed, state: loaded.state };
}

async function auditAction(action: DispatchAuditAction) {
  const tab = await ownedTab();
  if (tab?.id === undefined) return fail('OWNED_TARGET_UNAVAILABLE');
  const reply = await browser.tabs.sendMessage(tab.id, {
    type: 'dispatch-runner-action', action, args: {},
  }, { frameId: 0 });
  if (reply === undefined || reply === null) return fail('AUDIT_NOT_READY');
  if (!reply?.ok) return fail(typeof reply?.error === 'string' ? reply.error : 'AUDIT_ACTION_FAILED');
  return reply;
}

async function userFiltersBackground(action: 'prepare' | 'status' | 'cleanup') {
  const result = await browser.runtime.sendMessage({ type: 'bilibili-user-filters-audit', action });
  if (result?.ok !== true || result.version !== manifest.version || result.buildId !== BUILD_ID ||
      typeof result.zeroModelGuard !== 'boolean' || result.actualModelCalls !== 0 ||
      !Number.isSafeInteger(result.blockedTransports) || result.blockedTransports < 0)
    return fail(typeof result?.error === 'string' ? result.error : 'USER_FILTERS_BACKGROUND_MISMATCH');
  if (action !== 'status' && result.zeroModelGuard !== (action === 'prepare')) return fail('USER_FILTERS_GUARD_MISMATCH');
  return result;
}

async function userFiltersPage(action: UserFiltersAction, waitForReady = false) {
  const end = Date.now() + (waitForReady ? 20000 : 0);
  do {
    try {
      const tab = await ownedTab();
      if (tab?.id === undefined) return fail('OWNED_TARGET_UNAVAILABLE');
      const result = await browser.tabs.sendMessage(tab.id, {
        type: 'bilibili-user-filters-control', action,
      }, { frameId: 0 });
      if (result?.ok !== true) return fail(typeof result?.error === 'string' ? result.error : 'USER_FILTERS_PAGE_NOT_READY');
      if (result.version !== manifest.version || result.buildId !== BUILD_ID ||
          typeof result.enabled !== 'boolean' || result.session === undefined || !result.report ||
          typeof result.report !== 'object') return fail('USER_FILTERS_PAGE_MISMATCH');
      return result;
    } catch (error) {
      if (!waitForReady || Date.now() >= end || !(error instanceof Error) ||
          !/TARGET_NAVIGATION_PENDING|Receiving end does not exist|Could not establish connection|USER_FILTERS_PAGE_NOT_READY|watch-not-ready/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (true);
}

async function userFiltersAction(action: UserFiltersAction) {
  if (action === 'prepare') {
    // The guard must precede both a fresh document and the first page message.
    const background = await userFiltersBackground('prepare');
    const tab = await ownedTab();
    if (tab?.id !== undefined) {
      await browser.tabs.update(tab.id, { active: true });
      ownedReload = { tabId: tab.id, expiresAt: Date.now() + OWNED_RELOAD_WAIT_MS };
      try { await browser.tabs.reload(tab.id); }
      catch (error) { ownedReload = null; throw error; }
    } else {
      const opened = await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
      if (!Number.isSafeInteger(opened.id)) return fail('TARGET_TAB_MISSING_ID');
      ownedTabId = opened.id!;
      try { await saveSession(); }
      catch (error) { await browser.tabs.remove(opened.id!).catch(() => {}); ownedTabId = null; throw error; }
      target.textContent = `已打开 · ${ownedTabId}`;
    }
    const page = await userFiltersPage('prepare', true);
    await userFiltersBackground('status');
    return { ...page, background };
  }
  const before = await userFiltersBackground('status');
  if (action === 'cleanup') {
    if (!before.zeroModelGuard && !await ownedTab())
      return { ok: true, alreadyClean: true, guardReleased: true, background: before };
    const page = await userFiltersPage('cleanup');
    if (page.report?.restored !== true || typeof page.report?.coverage?.featureEnabled !== 'boolean' ||
        page.enabled !== page.report.coverage.featureEnabled) return fail('USER_FILTERS_RESTORE_UNCONFIRMED');
    const background = await userFiltersBackground('cleanup');
    return { ...page, background, guardReleased: true };
  }
  if (!before.zeroModelGuard) return fail('USER_FILTERS_GUARD_REQUIRED');
  const page = await userFiltersPage(action);
  const background = await userFiltersBackground('status');
  return { ...page, background };
}

async function displayPlanBackground(action: 'prepare' | 'status' | 'cleanup', tabId: number, allowReleased = false) {
  const result = await browser.runtime.sendMessage({ type: 'bilibili-display-plan-guard', action, tabId });
  if (result?.ok !== true || result.version !== manifest.version || result.buildId !== BUILD_ID ||
      typeof result.zeroModelGuard !== 'boolean' || result.actualModelCalls !== 0 ||
      !Number.isSafeInteger(result.blockedTransports) || result.blockedTransports < 0 ||
      result.ownerTabId !== (result.zeroModelGuard ? tabId : null) || typeof result.idle !== 'boolean')
    return fail(typeof result?.error === 'string' ? result.error : 'DISPLAY_PLAN_BACKGROUND_MISMATCH');
  if (action === 'cleanup' ? result.zeroModelGuard !== false : !allowReleased && result.zeroModelGuard !== true)
    return fail('DISPLAY_PLAN_GUARD_MISMATCH');
  if (!result.idle) return fail('DISPLAY_PLAN_BACKGROUND_NOT_IDLE');
  return result;
}

function validateDisplayPlanPage(action: DisplayPlanAction, result: any) {
  if (result?.ok === true && !result.report?.coverage?.mainBuildId && action === 'prepare')
    return fail('DISPLAY_PLAN_PAGE_NOT_READY');
  if (result?.ok !== true || result.version !== manifest.version || result.buildId !== BUILD_ID ||
      result.session === undefined || !result.report || typeof result.report !== 'object' ||
      result.report.coverage?.mainBuildId !== BUILD_ID || result.report.actualModelCalls !== 0 ||
      result.report.modelLoads !== 0 || result.report.nativeSettingsWrites !== 0)
    return fail(typeof result?.error === 'string' ? result.error : 'DISPLAY_PLAN_PAGE_MISMATCH');
  if (action === 'status') {
    const bodyKeys = new Set(['inputFrames', 'sourceText', 'originalText', 'inputText',
      'translatedText', 'author', 'authorName', 'uid', 'ruleValues']);
    const containsBody = (value: unknown): boolean => Array.isArray(value) ? value.some(containsBody)
      : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
        bodyKeys.has(key) && (key === 'inputFrames' ? Array.isArray(item) : item !== undefined && item !== null) || containsBody(item)) : false;
    if (containsBody(result.report)) return fail('DISPLAY_PLAN_STATUS_CONTAINS_INPUT_BODY');
  }
  if (action === 'export' && (!Array.isArray(result.report.simulation?.inputFrames) ||
      !Number.isSafeInteger(result.report.simulation?.inputFrameCount)))
    return fail('DISPLAY_PLAN_EXPORT_INCOMPLETE');
  if (action === 'seek' && result.report.playback?.seekCount !== 1)
    return fail('DISPLAY_PLAN_SEEK_UNCONFIRMED');
  if (action === 'cleanup' && result.report.restored !== true)
    return fail('DISPLAY_PLAN_RESTORE_UNCONFIRMED');
  return result;
}

async function displayPlanPage(action: DisplayPlanAction, waitForReady = false) {
  const end = Date.now() + (waitForReady ? 20000 : 0);
  do {
    try {
      const tab = await ownedTab();
      if (tab?.id === undefined) return fail('OWNED_TARGET_UNAVAILABLE');
      const result = await browser.tabs.sendMessage(tab.id, { type: 'bilibili-display-plan-control', action }, { frameId: 0 });
      return validateDisplayPlanPage(action, result);
    } catch (error) {
      if (!waitForReady || Date.now() >= end || !(error instanceof Error) ||
          !/TARGET_NAVIGATION_PENDING|Receiving end does not exist|Could not establish connection|DISPLAY_PLAN_PAGE_NOT_READY|watch-not-ready/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (true);
}

async function refreshOwnedDisplayTarget() {
  const tab = await ownedTab();
  if (tab?.id !== undefined) {
    await browser.tabs.update(tab.id, { active: true });
    ownedReload = { tabId: tab.id, expiresAt: Date.now() + OWNED_RELOAD_WAIT_MS };
    try { await browser.tabs.reload(tab.id); }
    catch (error) { ownedReload = null; throw error; }
    return tab.id;
  }
  const opened = await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
  if (!Number.isSafeInteger(opened.id)) return fail('TARGET_TAB_MISSING_ID');
  ownedTabId = opened.id!;
  try { await saveSession(); }
  catch (error) { await browser.tabs.remove(opened.id!).catch(() => {}); ownedTabId = null; throw error; }
  target.textContent = `已打开 · ${ownedTabId}`;
  return ownedTabId;
}

async function saveDisplayPlanOwner(tabId: number | null) {
  if (tabId === null) await browser.storage.local.remove(DISPLAY_PLAN_OWNER_KEY);
  else await browser.storage.local.set({ [DISPLAY_PLAN_OWNER_KEY]: { tabId, buildId: BUILD_ID } satisfies DisplayPlanOwnerRecord });
}

async function displayPlanOwnerTabId(): Promise<number | null> {
  const saved = (await browser.storage.local.get(DISPLAY_PLAN_OWNER_KEY))[DISPLAY_PLAN_OWNER_KEY] as DisplayPlanOwnerRecord | undefined;
  return saved && Number.isSafeInteger(saved.tabId) && saved.tabId >= 0 ? saved.tabId : ownedTabId;
}

function noSuchTab(error: unknown): boolean {
  return error instanceof Error && /(?:no tab with id|tab.*not found|invalid tab id)/i.test(error.message);
}

async function displayPlanClosedTargetCleanup(tabId: number) {
  let tab: { id?: number; url?: string; pendingUrl?: string } | null;
  try { tab = await browser.tabs.get(tabId); }
  catch (error) { if (noSuchTab(error)) tab = null; else throw error; }
  if (tab) {
    const phase = targetTabState(tab);
    if (phase === 'foreign') return fail('DISPLAY_PLAN_TARGET_REPLACED');
    return null;
  }
  const backgroundBefore = await displayPlanBackground('status', tabId, true);
  const background = await displayPlanBackground('cleanup', tabId);
  await saveDisplayPlanOwner(null);
  return { ok: true, version: manifest.version, buildId: BUILD_ID, session: { targetClosed: true },
    report: { restored: true, playback: { started: false, restored: true, seekCount: 0, targetClosed: true },
      actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 },
    backgroundBefore, background, guardReleased: true, closedTargetEvidence: { tabId, exists: false } };
}

async function displayPlanAction(action: DisplayPlanAction) {
  if (action === 'prepare') {
    const saved = await runtime({ type: 'settings' });
    if (saved.settings?.enabled !== false) return fail('DISPLAY_PLAN_REQUIRES_TRANSLATION_DISABLED');
    const identity = await runtime({ type: 'build-identity' });
    if (identity.version !== manifest.version || identity.buildId !== BUILD_ID || identity.idle !== true)
      return fail('DISPLAY_PLAN_BACKGROUND_NOT_IDLE');
    const tabId = await refreshOwnedDisplayTarget();
    const page = await displayPlanPage('prepare', true);
    const background = await displayPlanBackground('prepare', tabId);
    await saveDisplayPlanOwner(tabId);
    const verified = await displayPlanBackground('status', tabId);
    return { ...page, background: verified, preparedBackground: background };
  }

  if (action === 'cleanup') {
    const ownerTabId = await displayPlanOwnerTabId();
    if (ownerTabId === null) return fail('DISPLAY_PLAN_OWNER_UNAVAILABLE');
    const closed = await displayPlanClosedTargetCleanup(ownerTabId);
    if (closed) return closed;
    if (ownedTabId === null) ownedTabId = ownerTabId;
  }
  const tab = await ownedTab();
  if (tab?.id === undefined) return fail('OWNED_TARGET_UNAVAILABLE');
  if (action === 'run') await browser.tabs.update(tab.id, { active: true });
  await displayPlanBackground('status', tab.id, action === 'cleanup');
  const page = await displayPlanPage(action, action === 'status' || action === 'cleanup');
  if (action !== 'cleanup') return { ...page, background: await displayPlanBackground('status', tab.id) };
  const background = await displayPlanBackground('cleanup', tab.id);
  await saveDisplayPlanOwner(null);
  return { ...page, background, guardReleased: true };
}

function validOwnerTabId(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value) && (value as number) >= 0;
}

function persistentGuardSummary(value: any): PersistentGuardSummary {
  if (!value || typeof value.key !== 'string' || !value.key || typeof value.present !== 'boolean' ||
      typeof value.enabled !== 'boolean' || !(value.declaredEnabled === null || typeof value.declaredEnabled === 'boolean') ||
      !(value.kind === null || typeof value.kind === 'string') || !validOwnerTabId(value.ownerTabId) ||
      Object.hasOwn(value, 'value')) return fail('RENDER_PREVIEW_PERSISTENT_GUARD_INVALID');
  return { key: value.key, present: value.present, enabled: value.enabled,
    declaredEnabled: value.declaredEnabled, kind: value.kind, ownerTabId: value.ownerTabId };
}

function renderPreviewProtections(source: any) {
  const protections = source?.protections ?? source;
  const temporaryGuard = protections?.temporaryGuard;
  if (!temporaryGuard || typeof temporaryGuard.enabled !== 'boolean' ||
      !(temporaryGuard.kind === null || typeof temporaryGuard.kind === 'string') ||
      !validOwnerTabId(temporaryGuard.ownerTabId) || typeof protections?.effectiveZeroTransport !== 'boolean')
    return fail('RENDER_PREVIEW_PROTECTIONS_INVALID');
  return { temporaryGuard: { enabled: temporaryGuard.enabled, kind: temporaryGuard.kind,
      ownerTabId: temporaryGuard.ownerTabId },
    persistentGuard: persistentGuardSummary(protections.persistentGuard),
    effectiveZeroTransport: protections.effectiveZeroTransport };
}

async function saveRenderPreviewOwner(owner: RenderPreviewOwnerRecord | null) {
  if (owner === null) await browser.storage.local.remove(RENDER_PREVIEW_OWNER_KEY);
  else await browser.storage.local.set({ [RENDER_PREVIEW_OWNER_KEY]: owner });
}

async function readRenderPreviewOwner(): Promise<RenderPreviewOwnerRecord | null> {
  const owner = (await browser.storage.local.get(RENDER_PREVIEW_OWNER_KEY))[RENDER_PREVIEW_OWNER_KEY] as
    RenderPreviewOwnerRecord | undefined;
  if (!owner) return null;
  if (!Number.isSafeInteger(owner.tabId) || owner.tabId < 0 || typeof owner.buildId !== 'string' || !owner.buildId)
    return fail('RENDER_PREVIEW_OWNER_INVALID');
  return { ...owner, persistentGuard: persistentGuardSummary(owner.persistentGuard) };
}

function validateRenderPreviewBackground(action: 'prepare' | 'status' | 'cleanup', result: any, tabId: number,
  baseline?: PersistentGuardSummary) {
  if (result?.ok !== true || result.version !== manifest.version || result.buildId !== BUILD_ID ||
      result.actualModelCalls !== 0 || !Number.isSafeInteger(result.blockedTransports) || result.blockedTransports < 0 ||
      result.idle !== true) return fail(typeof result?.error === 'string' ? result.error : 'RENDER_PREVIEW_BACKGROUND_MISMATCH');
  const protections = renderPreviewProtections(result);
  if (baseline && JSON.stringify(protections.persistentGuard) !== JSON.stringify(baseline))
    return fail('RENDER_PREVIEW_PERSISTENT_GUARD_CHANGED');
  if (result.zeroModelGuard !== protections.temporaryGuard.enabled)
    return fail('RENDER_PREVIEW_TEMPORARY_GUARD_MISMATCH');
  if (action === 'cleanup') {
    if (protections.temporaryGuard.enabled || protections.temporaryGuard.ownerTabId !== null)
      return fail('RENDER_PREVIEW_TEMPORARY_GUARD_NOT_RELEASED');
  } else if (!protections.temporaryGuard.enabled || protections.temporaryGuard.ownerTabId !== tabId ||
      protections.effectiveZeroTransport !== true) return fail('RENDER_PREVIEW_TEMPORARY_GUARD_MISMATCH');
  return { ...result, protections };
}

function validateRenderPreviewPage(action: RenderPreviewAction, result: any) {
  if (result?.ok === true && !result.report?.coverage?.mainBuildId && action === 'prepare')
    return fail('RENDER_PREVIEW_PAGE_NOT_READY');
  if (result?.ok !== true || result.version !== manifest.version || result.buildId !== BUILD_ID ||
      result.session === undefined || !result.report || typeof result.report !== 'object' ||
      result.report.coverage?.mainBuildId !== BUILD_ID || result.report.actualModelCalls !== 0 ||
      result.report.modelLoads !== 0 || result.report.nativeSettingsWrites !== 0 || result.report.adapterPrepared !== 0)
    return fail(typeof result?.error === 'string' ? result.error : 'RENDER_PREVIEW_PAGE_MISMATCH');
  if (action !== 'cleanup' && result.report.simulation &&
      (!result.report.simulation.B || Object.hasOwn(result.report.simulation, 'A')))
    return fail('RENDER_PREVIEW_SIMULATION_NOT_B_ONLY');
  if (action === 'status') {
    const bodyKeys = new Set(['inputFrames', 'sourceText', 'originalText', 'inputText', 'translatedText',
      'text', 'body', 'contentText', 'author', 'authorName', 'uid', 'ruleValues']);
    const containsBody = (value: unknown): boolean => Array.isArray(value) ? value.some(containsBody)
      : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
        bodyKeys.has(key) && item !== undefined && item !== null &&
          !(key === 'inputFrames' && Number.isSafeInteger(item)) || containsBody(item)) : false;
    if (containsBody(result.report)) return fail('RENDER_PREVIEW_STATUS_CONTAINS_BODY');
  }
  if (action === 'seek' && result.report.playback?.seekCount !== 1)
    return fail('RENDER_PREVIEW_SEEK_UNCONFIRMED');
  if (action === 'cleanup' && result.report.restored !== true)
    return fail('RENDER_PREVIEW_RESTORE_UNCONFIRMED');
  return result;
}

async function renderPreviewBackground(action: 'prepare' | 'status' | 'cleanup', tabId: number,
  baseline?: PersistentGuardSummary) {
  const result = await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action, tabId });
  return validateRenderPreviewBackground(action, result, tabId, baseline);
}

async function renderPreviewPage(action: RenderPreviewAction, tabId: number, waitForReady = false) {
  const end = Date.now() + (waitForReady ? 20000 : 0);
  do {
    try {
      let tab;
      try { tab = await browser.tabs.get(tabId); }
      catch (error) { if (noSuchTab(error)) return fail('RENDER_PREVIEW_TARGET_MISSING'); else throw error; }
      if (targetTabState(tab) === 'foreign') return fail('RENDER_PREVIEW_TARGET_REPLACED');
      if (targetTabState(tab) === 'pending') return fail('TARGET_NAVIGATION_PENDING');
      const result = await browser.tabs.sendMessage(tabId,
        { type: 'bilibili-render-preview-control', action }, { frameId: 0 });
      return validateRenderPreviewPage(action, result);
    } catch (error) {
      if (!waitForReady || Date.now() >= end || !(error instanceof Error) ||
          !/TARGET_NAVIGATION_PENDING|Receiving end does not exist|Could not establish connection|RENDER_PREVIEW_PAGE_NOT_READY|watch-not-ready/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (true);
}

async function renderPreviewOwnerTabId() {
  const owner = await readRenderPreviewOwner();
  return owner?.tabId ?? null;
}

async function renderPreviewAction(action: RenderPreviewAction) {
  if (action === 'prepare') {
    const saved = await runtime({ type: 'settings' });
    if (saved.settings?.enabled !== false) return fail('RENDER_PREVIEW_REQUIRES_TRANSLATION_DISABLED');
    const identity = await runtime({ type: 'build-identity' });
    if (identity.version !== manifest.version || identity.buildId !== BUILD_ID || identity.idle !== true)
      return fail('RENDER_PREVIEW_BACKGROUND_NOT_IDLE');
    const protections = renderPreviewProtections(identity);
    const existing = await readRenderPreviewOwner();
    if (existing) {
      if (existing.cleanupConfirmed) return fail('RENDER_PREVIEW_OWNED_TARGET_CLOSE_REQUIRED');
      if (!protections.temporaryGuard.enabled || existing.tabId !== protections.temporaryGuard.ownerTabId ||
          JSON.stringify(existing.persistentGuard) !== JSON.stringify(protections.persistentGuard))
        return fail('RENDER_PREVIEW_TEMPORARY_GUARD_ALREADY_OWNED');
      const background = await renderPreviewBackground('status', existing.tabId, existing.persistentGuard);
      const page = validateRenderPreviewPage('status', await renderPreviewPage('status', existing.tabId));
      return { ...page, background, protectionBaseline: existing.persistentGuard };
    }
    if (protections.temporaryGuard.enabled) return fail('RENDER_PREVIEW_TEMPORARY_GUARD_ALREADY_OWNED');
    // The render-preview run owns a fresh, exact target tab. It never adopts a
    // matching video tab left by another runner or the user's browsing session.
    const opened = await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
    if (!Number.isSafeInteger(opened.id)) return fail('TARGET_TAB_MISSING_ID');
    const tabId = opened.id!;
    const owner: RenderPreviewOwnerRecord = { tabId, buildId: BUILD_ID, persistentGuard: protections.persistentGuard };
    // Persist ownership before installing the background guard so cleanup can recover a lost reply.
    try { await saveRenderPreviewOwner(owner); }
    catch (error) { await browser.tabs.remove(tabId).catch(() => {}); throw error; }
    // Wait read-only for the fresh content script to register its video resource.
    await renderPreviewPage('status', tabId, true);
    const background = await renderPreviewBackground('prepare', tabId, owner.persistentGuard);
    const page = await renderPreviewPage('prepare', tabId, true);
    const verified = await renderPreviewBackground('status', tabId, owner.persistentGuard);
    return { ...page, background: verified, preparedBackground: background, protectionBaseline: owner.persistentGuard };
  }

  const owner = await readRenderPreviewOwner();
  if (!owner) return fail('RENDER_PREVIEW_OWNER_UNAVAILABLE');
  if (action !== 'cleanup' && owner.buildId !== BUILD_ID) return fail('RENDER_PREVIEW_OWNER_BUILD_MISMATCH');

  if (action === 'cleanup') {
    let tab: { id?: number; url?: string; pendingUrl?: string } | null;
    try { tab = await browser.tabs.get(owner.tabId); }
    catch (error) { if (noSuchTab(error)) tab = null; else throw error; }
    let page;
    if (!tab) {
      page = { ok: true, version: manifest.version, buildId: BUILD_ID, session: { targetClosed: true },
        report: { restored: true, playback: { started: false, restored: true, seekCount: 0, targetClosed: true },
          actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0, adapterPrepared: 0 },
        closedTargetEvidence: { tabId: owner.tabId, exists: false } };
    } else {
      const phase = targetTabState(tab);
      if (phase === 'foreign') return fail('RENDER_PREVIEW_TARGET_REPLACED');
      page = await renderPreviewPage('cleanup', owner.tabId, true);
    }
    // A prepare failure can leave ownership recorded before the guard was acquired.
    const beforeRaw = await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'status', tabId: owner.tabId });
    const before = validateRenderPreviewBackground(beforeRaw?.zeroModelGuard ? 'status' : 'cleanup',
      beforeRaw, owner.tabId, owner.persistentGuard);
    const background = await renderPreviewBackground('cleanup', owner.tabId, owner.persistentGuard);
    await saveRenderPreviewOwner({ ...owner, buildId: BUILD_ID, cleanupConfirmed: true });
    return { ...page, backgroundBefore: before, background, guardReleased: true, ownedTargetTabId: owner.tabId };
  }

  let tab;
  try { tab = await browser.tabs.get(owner.tabId); }
  catch (error) { if (noSuchTab(error)) return fail('RENDER_PREVIEW_TARGET_MISSING'); else throw error; }
  const phase = targetTabState(tab);
  if (phase === 'foreign') return fail('RENDER_PREVIEW_TARGET_REPLACED');
  if (phase === 'pending') return fail('TARGET_NAVIGATION_PENDING');
  await renderPreviewBackground('status', owner.tabId, owner.persistentGuard);
  if (action === 'run') await browser.tabs.update(owner.tabId, { active: true });
  const page = await renderPreviewPage(action, owner.tabId, action === 'status');
  const background = await renderPreviewBackground('status', owner.tabId, owner.persistentGuard);
  return { ...page, background };
}

async function closeRenderPreviewOwnedTarget() {
  const owner = await readRenderPreviewOwner();
  if (!owner) return { closed: false };
  if (owner.buildId !== BUILD_ID || owner.cleanupConfirmed !== true)
    return fail('RENDER_PREVIEW_CLOSE_REQUIRES_CONFIRMED_CLEANUP');
  let tab: { id?: number; url?: string; pendingUrl?: string } | null;
  try { tab = await browser.tabs.get(owner.tabId); }
  catch (error) { if (noSuchTab(error)) tab = null; else throw error; }
  if (tab && targetTabState(tab) === 'foreign') return fail('RENDER_PREVIEW_TARGET_REPLACED');
  if (tab) await browser.tabs.remove(owner.tabId);
  await saveRenderPreviewOwner(null);
  return { closed: true, tabId: owner.tabId, targetWasPresent: !!tab };
}

const LIVE_RESOURCE = 'av117318021548752:cid42173138507';
async function readLivePreviewOwner(): Promise<LivePreviewOwnerRecord | null> {
  const owner = (await browser.storage.local.get(LIVE_PREVIEW_OWNER_KEY))[LIVE_PREVIEW_OWNER_KEY] as
    LivePreviewOwnerRecord | undefined;
  if (!owner) return null;
  if (!Number.isSafeInteger(owner.tabId) || owner.tabId < 0 ||
      typeof owner.buildId !== 'string' || !owner.buildId ||
      typeof owner.taskId !== 'string' || !owner.taskId ||
      typeof owner.runId !== 'string' || !owner.runId || !['main', 'repair', 'supplement'].includes(owner.phase))
    return fail('LIVE_PREVIEW_OWNER_INVALID');
  return owner;
}
async function saveLivePreviewOwner(owner: LivePreviewOwnerRecord | null) {
  if (owner) await browser.storage.local.set({ [LIVE_PREVIEW_OWNER_KEY]: owner });
  else await browser.storage.local.remove(LIVE_PREVIEW_OWNER_KEY);
}
async function liveHost(action: string, extra: Record<string, unknown> = {}) {
  const reply = await browser.runtime.sendMessage({ type: 'bilibili-live-preview-host', action, ...extra });
  if (reply?.ok !== true || reply.buildId !== BUILD_ID)
    return fail(typeof reply?.error === 'string' ? reply.error : 'LIVE_PREVIEW_HOST_UNAVAILABLE');
  if (reply.nativePrepared !== 0 || reply.onlineCalls !== 0) return fail('LIVE_PREVIEW_HOST_NATIVE_OR_ONLINE_WRITE');
  return reply;
}
function validateLivePreviewPage(action: string, reply: any, fromMs = 45_000) {
  if (reply?.ok !== true || reply.buildId !== BUILD_ID ||
      reply.session?.resourceId !== LIVE_RESOURCE || reply.session?.scenario !== 'video' ||
      !reply.session.sessionId || !Number.isSafeInteger(reply.epoch) || reply.epoch < 0 ||
      !reply.report || reply.report.coverage?.mainBuildId !== BUILD_ID ||
      reply.report.adapterPrepared !== 0 || reply.report.nativeSettingsWrites !== 0 ||
      reply.report.nativePrepared !== 0 ||
      !Number.isFinite(reply.report.clock?.mediaTimeMs) ||
      reply.report.render?.contract !== 'render-preview-v1')
    return fail(typeof reply?.error === 'string' ? reply.error : 'LIVE_PREVIEW_PAGE_MISMATCH');
  const plan = reply.report.plan;
  if (plan && (!plan.B || Object.hasOwn(plan, 'A'))) return fail('LIVE_PREVIEW_MUST_BE_B_ONLY');
  if (action === 'prepare' && (reply.report.clock.paused !== true || reply.report.clock.seeking !== false ||
      Math.abs(reply.report.clock.mediaTimeMs - fromMs) >= 250)) return fail('LIVE_PREVIEW_PREPARE_POSITION_MISMATCH');
  if (action === 'status') {
    const body = new Set(['originalText', 'translatedText', 'sourceText', 'inputText', 'author', 'authorName',
      'authorId', 'uid', 'ruleValues', 'body']);
    const containsBody = (value: unknown): boolean => Array.isArray(value) ? value.some(containsBody)
      : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
        body.has(key) && item !== undefined && item !== null || containsBody(item)) : false;
    if (containsBody(reply.report) || containsBody(reply.mainCutoff) || containsBody(reply.tailCutoff))
      return fail('LIVE_PREVIEW_STATUS_CONTAINS_INPUT_BODY');
  }
  return reply;
}
async function livePreviewPage(action: string, tabId: number, extra: Record<string, unknown> = {}, waitForReady = false) {
  const end = Date.now() + (waitForReady ? 20_000 : 0);
  do {
    try {
      let tab;
      try { tab = await browser.tabs.get(tabId); }
      catch (error) { if (noSuchTab(error)) return fail('LIVE_PREVIEW_TARGET_MISSING'); else throw error; }
      if (targetTabState(tab) === 'foreign') return fail('LIVE_PREVIEW_TARGET_REPLACED');
      if (targetTabState(tab) === 'pending') return fail('TARGET_NAVIGATION_PENDING');
      const reply = await browser.tabs.sendMessage(tabId,
        { type: 'bilibili-live-preview', action, ...extra }, { frameId: 0 });
      const requested = extra.input as { fromMs?: number } | undefined;
      return validateLivePreviewPage(action, reply,
        typeof requested?.fromMs === 'number' ? requested.fromMs : 45_000);
    } catch (error) {
      if (!waitForReady || Date.now() >= end || !(error instanceof Error) ||
          !/TARGET_NAVIGATION_PENDING|Receiving end does not exist|Could not establish connection|watch-not-ready/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (true);
}
async function livePreviewAction(action: LivePreviewAction, input?: LivePreviewPrepare) {
  if (action === 'prepare') {
    if (!input) return fail('LIVE_PREVIEW_PREPARE_INPUT_REQUIRED');
    const saved = await runtime({ type: 'settings' });
    if (saved.settings?.enabled !== false || saved.settings?.backend !== 'local' ||
        !saved.settings?.localModelId) return fail('LIVE_PREVIEW_REQUIRES_DISABLED_SELECTED_LOCAL_MODEL');
    const existing = await readLivePreviewOwner();
    if (existing) {
      if (existing.buildId !== BUILD_ID || existing.taskId !== input.taskId ||
          existing.runId !== input.runId || existing.phase !== input.phase || existing.cleanupConfirmed)
        return fail('LIVE_PREVIEW_OWNED_TARGET_CLEANUP_REQUIRED');
      const host = await liveHost('status');
      if (host.grant?.state !== 'prepared' || host.grant.tabId !== existing.tabId ||
          host.grant.runId !== input.runId) return fail('LIVE_PREVIEW_PREPARE_NEEDS_CLEANUP');
      const tab = await browser.tabs.get(existing.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
      if (targetTabState(tab) !== 'ready') return fail('LIVE_PREVIEW_TARGET_NOT_READY');
      const page = await livePreviewPage('status', existing.tabId, {}, true);
      if (page.epoch !== host.grant.epoch || page.session?.resourceId !== host.grant.session?.resourceId ||
          page.session?.sessionId !== host.grant.session?.sessionId) return fail('LIVE_PREVIEW_PREPARE_PAGE_CHANGED');
      const bound = await livePreviewPage('bind', existing.tabId, { input: { taskId: input.taskId,
        runId: input.runId, instanceId: host.grant.instanceId,
        configIdentity: host.grant.configIdentity, modelIdentity: host.grant.modelIdentity,
        phase: input.phase, fromMs: host.grant.fromMs, toMs: host.grant.toMs, epoch: page.epoch } });
      await saveLivePreviewOwner({ ...existing, instanceId: host.grant.instanceId, epoch: page.epoch });
      return { ...bound, preparedPage: page, host, ownedTargetTabId: existing.tabId };
    }
    const identity = await runtime({ type: 'build-identity' });
    if (identity.version !== manifest.version || identity.buildId !== BUILD_ID || identity.idle !== true)
      return fail('LIVE_PREVIEW_BACKGROUND_NOT_IDLE');
    const prior = await liveHost('status');
    if (prior.grant && prior.grant.state !== 'stopped') return fail('LIVE_PREVIEW_PRIOR_RUN_NOT_CLEAN');
    const opened = await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
    if (!Number.isSafeInteger(opened.id)) return fail('TARGET_TAB_MISSING_ID');
    const owner: LivePreviewOwnerRecord = { tabId: opened.id!, buildId: BUILD_ID,
      taskId: input.taskId, runId: input.runId, phase: input.phase };
    try { await saveLivePreviewOwner(owner); }
    catch (error) { await browser.tabs.remove(opened.id!).catch(() => {}); throw error; }
    const page = await livePreviewPage('prepare', owner.tabId,
      { input: { fromMs: input.phase === 'repair' ? input.fromMs : 45_000 } }, true);
    const epoch = page.epoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) return fail('LIVE_PREVIEW_PREPARE_EPOCH_MISSING');
    const host = await liveHost('prepare', { input: { taskId: input.taskId, runId: input.runId,
      phase: input.phase, tabId: owner.tabId, epoch,
      ...(input.phase !== 'main' ? { repairReason: input.repairReason,
        fromMs: input.fromMs, toMs: input.toMs } : {}) } });
    if (host.grant?.taskId !== input.taskId || host.grant.runId !== input.runId ||
        host.grant.tabId !== owner.tabId || host.grant.epoch !== epoch || host.grant.state !== 'prepared' ||
        !host.grant.instanceId || !host.grant.configIdentity || !host.grant.modelIdentity)
      return fail('LIVE_PREVIEW_GRANT_MISMATCH');
    const binding = { taskId: input.taskId, runId: input.runId,
      instanceId: host.grant.instanceId, configIdentity: host.grant.configIdentity,
      modelIdentity: host.grant.modelIdentity, phase: input.phase,
      fromMs: host.grant.fromMs, toMs: host.grant.toMs, epoch };
    const bound = await livePreviewPage('bind', owner.tabId, { input: binding });
    await saveLivePreviewOwner({ ...owner, instanceId: binding.instanceId, epoch });
    return { ...bound, preparedPage: page, host, ownedTargetTabId: owner.tabId };
  }
  const owner = await readLivePreviewOwner();
  if (!owner) return fail('LIVE_PREVIEW_OWNER_UNAVAILABLE');
  if (action !== 'cleanup' && owner.buildId !== BUILD_ID) return fail('LIVE_PREVIEW_OWNER_BUILD_MISMATCH');
  if (action === 'cleanup') {
    // Revoke the host permit before touching page UI or releasing the temporary guard.
    const revoked = await liveHost('stop', { reason: 'runner-cleanup' });
    let page: any = null;
    let pageError: string | null = null;
    const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
    if (tab) {
      if (targetTabState(tab) === 'foreign') return fail('LIVE_PREVIEW_TARGET_REPLACED');
      if (targetTabState(tab) === 'ready') {
        try { page = await livePreviewPage('cleanup', owner.tabId, {}, true); }
        catch (error) { pageError = error instanceof Error ? error.message : 'page-restore-failed'; }
      } else pageError = 'target-navigation-pending';
    } else page = { ok: true, version: manifest.version, buildId: BUILD_ID,
      session: { targetClosed: true }, report: { restored: false, targetClosed: true },
      closedTargetEvidence: { tabId: owner.tabId, exists: false } };
    const host = await liveHost('cleanup');
    if (host.grant && (host.grant.taskId !== owner.taskId || host.grant.runId !== owner.runId ||
        host.grant.tabId !== owner.tabId || host.grant.state !== 'stopped') || host.activeRequests !== 0)
      return fail('LIVE_PREVIEW_CLEANUP_UNCONFIRMED');
    const protections = (await runtime({ type: 'build-identity' })).protections;
    if (protections?.temporaryGuard?.enabled !== false) return fail('LIVE_PREVIEW_GUARD_NOT_RELEASED');
    if (tab && (!page || page.report?.restored !== true)) {
      const current = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
      if (current && targetTabState(current) !== 'ready') return fail('LIVE_PREVIEW_TARGET_REPLACED');
      if (current) await browser.tabs.remove(owner.tabId);
      page = { ok: true, version: manifest.version, buildId: BUILD_ID,
        session: { targetClosed: true }, report: { restored: false, targetClosed: true },
        closedTargetEvidence: { tabId: owner.tabId, exists: false,
          reason: pageError ?? 'page-restore-unconfirmed' } };
    }
    await saveLivePreviewOwner({ ...owner, buildId: BUILD_ID, cleanupConfirmed: true });
    return { ...page, hostBefore: revoked, host, ownedTargetTabId: owner.tabId,
      guardReleased: true, pageError };
  }
  if (action === 'resume') {
    const before = await liveHost('status');
    if (before.grant?.taskId !== owner.taskId || before.grant?.runId !== owner.runId ||
        before.grant?.tabId !== owner.tabId) return fail('LIVE_PREVIEW_HOST_OWNER_MISMATCH');
    if (!owner.runIssued && Number.isFinite(before.grant.startedAt) && before.grant.startedAt > 0 &&
        before.grant.instanceId === owner.instanceId && before.grant.epoch === owner.epoch) {
      // The ordinary page button already consumed the explicit start. Observation must not replay it.
      owner.runIssued = true;
      await saveLivePreviewOwner(owner);
    }
    if (before.grant.state === 'recovery-required') {
      // Keep the page's tail/renderer ledger, then revoke the old host grant.
      // Neither branch rotates the permit or replays the one-time start.
      const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
      const { page, pageError, pageSupplyStopped, host } = await recoverLivePreviewWithoutNewCalls({
        pageReady: targetTabState(tab) === 'ready',
        drainPage: () => livePreviewPage('drain', owner.tabId),
        stopHost: () => liveHost('stop', { reason: 'runner-recovery-partial-evidence' }),
        exportPage: () => livePreviewPage('export', owner.tabId),
      });
      return { ok: true, buildId: BUILD_ID, partialEvidence: true, newCallsRevoked: true,
        page, pageError, pageSupplyStopped, host, ownedTargetTabId: owner.tabId };
    }
  }
  const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
  if (targetTabState(tab) !== 'ready') return fail('LIVE_PREVIEW_TARGET_NOT_READY');
  const hostBefore = await liveHost('status');
  if (hostBefore.grant?.taskId !== owner.taskId || hostBefore.grant.runId !== owner.runId ||
      hostBefore.grant.tabId !== owner.tabId ||
      owner.instanceId && hostBefore.grant.instanceId !== owner.instanceId) return fail('LIVE_PREVIEW_HOST_OWNER_MISMATCH');
  if (action === 'run') {
    if (owner.runIssued) return fail('LIVE_PREVIEW_RUN_ALREADY_ISSUED_USE_RESUME');
    if (hostBefore.grant.state !== 'prepared') return fail('LIVE_PREVIEW_NOT_PREPARED');
    await saveLivePreviewOwner({ ...owner, runIssued: true });
    await browser.tabs.update(owner.tabId, { active: true });
    const page = await livePreviewPage('start', owner.tabId);
    const host = await liveHost('status');
    if (host.grant?.state !== 'running') return fail('LIVE_PREVIEW_START_UNCONFIRMED');
    return { ...page, host };
  }
  if (action === 'drain') {
    const host = await liveHost('drain', { reason: 'main-window-ended' });
    const page = await livePreviewPage('drain', owner.tabId);
    if (host.grant?.state !== 'draining') return fail('LIVE_PREVIEW_DRAIN_UNCONFIRMED');
    return { ...page, host };
  }
  // Opening the authenticated controller can temporarily hide the owned page.
  // An already-running grant may be observed in its page again; this never starts playback or a stopped grant.
  if (action === 'resume' && hostBefore.grant.state === 'running')
    await browser.tabs.update(owner.tabId, { active: true });
  const page = await livePreviewPage(action === 'resume' ? 'status' : action, owner.tabId,
    {}, action === 'status' || action === 'resume');
  const host = action === 'export' ? await liveHost('export') : await liveHost('status');
  return { ...page, host };
}
async function closeLivePreviewOwnedTarget() {
  const owner = await readLivePreviewOwner();
  if (!owner) return { closed: false };
  if (owner.buildId !== BUILD_ID || !owner.cleanupConfirmed)
    return fail('LIVE_PREVIEW_CLOSE_REQUIRES_CONFIRMED_CLEANUP');
  const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
  if (tab && targetTabState(tab) === 'foreign') return fail('LIVE_PREVIEW_TARGET_REPLACED');
  if (tab) await browser.tabs.remove(owner.tabId);
  await saveLivePreviewOwner(null);
  return { closed: true, tabId: owner.tabId, targetWasPresent: !!tab };
}

async function readNativeSupplyOwner(allowUnboundRepair = false): Promise<NativeSupplyOwnerRecord | null> {
  const owner = (await browser.storage.local.get(NATIVE_SUPPLY_OWNER_KEY))[NATIVE_SUPPLY_OWNER_KEY] as
    NativeSupplyOwnerRecord | undefined;
  if (!owner) return null;
  const unboundRepair = allowUnboundRepair && owner.phase === 'repair' && !owner.instanceId &&
    owner.epoch === undefined && !owner.runIssued && !owner.cleanupConfirmed;
  if (!Number.isSafeInteger(owner.tabId) || owner.tabId < 0 || owner.buildId !== BUILD_ID && !unboundRepair ||
      !owner.taskId || !owner.runId || !owner.modelId || !['main', 'repair'].includes(owner.phase))
    return fail('NATIVE_SUPPLY_OWNER_INVALID');
  return owner;
}
async function saveNativeSupplyOwner(owner: NativeSupplyOwnerRecord | null) {
  if (owner) await browser.storage.local.set({ [NATIVE_SUPPLY_OWNER_KEY]: owner });
  else await browser.storage.local.remove(NATIVE_SUPPLY_OWNER_KEY);
}
async function nativeSupplyHost(action: 'prepare' | 'status' | 'export' | 'drain' | 'stop' | 'cleanup',
  extra: Record<string, unknown> = {}) {
  const reply = await browser.runtime.sendMessage({ type: 'bilibili-native-supply-host', action, ...extra });
  if (reply?.ok !== true || reply.buildId !== BUILD_ID || reply.onlineCalls !== 0)
    return fail(typeof reply?.error === 'string' ? reply.error : 'NATIVE_SUPPLY_HOST_MISMATCH');
  return reply;
}
async function ownedSupplyStatus(action: 'status' | 'export') {
  const identity = await runtime({ type: 'build-identity' });
  if (typeof identity.buildId !== 'string' || !identity.buildId ||
      typeof identity.version !== 'string' || !identity.version ||
      identity.ownedSupply?.buildId !== identity.buildId) return fail('OWNED_SUPPLY_BACKGROUND_MISMATCH');
  const host = identity.ownedSupply, grant = host.grant;
  if (!grant) return fail('OWNED_SUPPLY_NO_OWNER');
  if (grant.policy !== 'owned' || grant.buildId !== identity.buildId ||
      !Number.isSafeInteger(grant.tabId) || grant.tabId < 0 ||
      typeof grant.documentId !== 'string' || !grant.documentId ||
      !validSession(grant.session) || grant.session.platform !== 'bilibili' ||
      grant.session.scenario !== 'video' || !Number.isSafeInteger(grant.epoch) || grant.epoch < 0)
    return fail('OWNED_SUPPLY_GRANT_INVALID');
  const tab = await browser.tabs.get(grant.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
  if (!tab) return fail('OWNED_SUPPLY_OWNER_TAB_MISSING');
  if (tab.pendingUrl) return fail('OWNED_SUPPLY_OWNER_NAVIGATION_PENDING');
  if (!matchesResourceUrl(grant.session, tab.url ?? '')) return fail('OWNED_SUPPLY_OWNER_URL_MISMATCH');
  const page = await browser.tabs.sendMessage(grant.tabId,
    { type: 'bilibili-native-supply', action }, { frameId: 0, documentId: grant.documentId });
  if (page?.ok !== true || page.policy !== 'owned' || page.buildId !== identity.buildId ||
      page.version !== identity.version || !validSession(page.session) ||
      !Number.isSafeInteger(page.epoch) || page.epoch < 0)
    return fail(typeof page?.error === 'string' ? page.error : 'OWNED_SUPPLY_PAGE_MISMATCH');
  const source = { readerVersion: manifest.version, readerBuildId: BUILD_ID,
    backgroundVersion: identity.version, backgroundBuildId: identity.buildId,
    mixedBuild: identity.version !== manifest.version || identity.buildId !== BUILD_ID };
  if (!sameSession(grant.session, page.session) || grant.epoch !== page.epoch) return {
    ...source, host, page,
    ok: false, error: 'OWNED_SUPPLY_IDENTITY_MISMATCH',
    expected: { session: grant.session, epoch: grant.epoch },
    observed: { session: page.session, epoch: page.epoch },
  };
  return { ...source, host, page };
}
async function nativeSupplyPage(action: string, tabId: number, input?: Record<string, unknown>, waitForReady = false,
  newlyCreated = false) {
  const end = Date.now() + (waitForReady ? 20_000 : 0);
  do {
    try {
      const tab = await browser.tabs.get(tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
      if (!tab) return fail('NATIVE_SUPPLY_TARGET_MISSING');
      // Chrome can briefly omit both URLs after tabs.create. Only this newly
      // created owned tab may wait for that blank transition; never act on it.
      if (waitForReady && newlyCreated && !tab.pendingUrl && (!tab.url || tab.url === 'about:blank'))
        return fail('TARGET_NAVIGATION_PENDING');
      if (targetTabState(tab) === 'foreign') return fail('NATIVE_SUPPLY_TARGET_REPLACED');
      if (targetTabState(tab) === 'pending') return fail('TARGET_NAVIGATION_PENDING');
      const reply = await browser.tabs.sendMessage(tabId, { type: 'bilibili-native-supply', action,
        ...(input ? { input } : {}) }, { frameId: 0 });
      if (reply?.ok !== true || reply.buildId !== BUILD_ID ||
          reply.session?.resourceId !== LIVE_RESOURCE || reply.session?.scenario !== 'video' ||
          reply.session?.platform !== 'bilibili' || !reply.session.sessionId ||
          !Number.isSafeInteger(reply.epoch) || reply.epoch < 0 || !reply.clock ||
          !Number.isFinite(reply.clock.mediaTimeMs))
        return fail(typeof reply?.error === 'string' ? reply.error : 'NATIVE_SUPPLY_PAGE_MISMATCH');
      if (action === 'prepare' || action === 'replay-prepare') {
        const fromMs = Number(input?.fromMs ?? 0);
        if (reply.clock.paused !== true || reply.clock.seeking !== false ||
            Math.abs(reply.clock.mediaTimeMs - fromMs) >= 300) return fail('NATIVE_SUPPLY_PREPARE_POSITION_MISMATCH');
      }
      return reply;
    } catch (error) {
      if (!waitForReady || Date.now() >= end || !(error instanceof Error) ||
          !/TARGET_NAVIGATION_PENDING|Receiving end does not exist|Could not establish connection|watch-not-ready/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (true);
}
async function nativeSupplyGuard(owner: NativeSupplyOwnerRecord, required: boolean) {
  const guard = (await browser.storage.local.get(NATIVE_SUPPLY_GUARD_KEY))[NATIVE_SUPPLY_GUARD_KEY] as
    { enabled?: boolean; kind?: string; tabId?: number; runId?: string } | undefined;
  if (required && (guard?.enabled !== true || guard.kind !== 'native-supply' ||
      guard.tabId !== owner.tabId || guard.runId !== owner.runId)) return fail('NATIVE_SUPPLY_GUARD_OWNER_MISMATCH');
  if (!required && guard !== undefined) return fail('NATIVE_SUPPLY_GUARD_NOT_RELEASED');
}
async function readNativeReferenceOwner(): Promise<NativeReferenceOwnerRecord | null> {
  const owner = (await browser.storage.local.get(NATIVE_REFERENCE_OWNER_KEY))[NATIVE_REFERENCE_OWNER_KEY] as
    NativeReferenceOwnerRecord | undefined;
  if (!owner) return null;
  if (!Number.isSafeInteger(owner.tabId) || owner.tabId < 0 || owner.buildId !== BUILD_ID)
    return fail('NATIVE_REFERENCE_OWNER_INVALID');
  return { ...owner, persistentGuard: persistentGuardSummary(owner.persistentGuard) };
}
async function saveNativeReferenceOwner(owner: NativeReferenceOwnerRecord | null) {
  if (owner) await browser.storage.local.set({ [NATIVE_REFERENCE_OWNER_KEY]: owner });
  else await browser.storage.local.remove(NATIVE_REFERENCE_OWNER_KEY);
}
async function nativeReferenceAction(action: Extract<NativeSupplyAction,
  'reference-start' | 'reference-full-start' | 'reference-status' | 'reference-snapshot' |
  'reference-stop' | 'reference-export' | 'reference-cleanup' |
  'reference-official-1-start' | 'reference-official-3-start' |
  'reference-official-5-start' | 'reference-official-dom-start'>) {
  if (action === 'reference-start' || action === 'reference-full-start' || action.startsWith('reference-official-')) {
    if (await readNativeReferenceOwner() || await readNativeSupplyOwner())
      return fail('NATIVE_REFERENCE_OWNED_TARGET_CLEANUP_REQUIRED');
    const saved = await runtime({ type: 'settings' });
    if (saved.settings?.enabled !== false || saved.settings?.bilibiliNativeTranslationOnly === true)
      return fail('NATIVE_REFERENCE_REQUIRES_ORDINARY_DISABLED_MODE');
    const identity = await runtime({ type: 'build-identity' });
    if (identity.buildId !== BUILD_ID || identity.version !== manifest.version || identity.idle !== true)
      return fail('NATIVE_REFERENCE_BACKGROUND_NOT_IDLE');
    const protections = renderPreviewProtections(identity);
    if (protections.temporaryGuard.enabled) return fail('NATIVE_REFERENCE_GUARD_ALREADY_OWNED');
    // A DOM-only control needs a continuously visible page. A separate task
    // window keeps ordinary tab switches from hiding it; retain the same profile
    // and viewport bounds. Cleanup still removes only our owned target tab.
    const currentWindow = action === 'reference-official-dom-start' ? await browser.windows.getCurrent() : null;
    const opened = currentWindow ? (await browser.windows.create({ url: DISPATCH_TARGET_URL, focused: true,
      type: 'normal', ...(currentWindow.state === 'maximized' ? { state: 'maximized' as const } : {
        width: currentWindow.width, height: currentWindow.height, left: currentWindow.left, top: currentWindow.top }) }))?.tabs?.[0]
      : await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
    if (!opened || !Number.isSafeInteger(opened.id)) return fail('NATIVE_REFERENCE_TARGET_MISSING_ID');
    const owner: NativeReferenceOwnerRecord = { tabId: opened.id!, buildId: BUILD_ID,
      persistentGuard: protections.persistentGuard };
    try { await saveNativeReferenceOwner(owner); }
    catch (error) { await browser.tabs.remove(owner.tabId).catch(() => {}); throw error; }
    // Save tab ownership before acquiring the independent zero-transport guard.
    await nativeSupplyPage('reference-ready', owner.tabId, undefined, true, true);
    await renderPreviewBackground('prepare', owner.tabId, owner.persistentGuard);
    const page = await nativeSupplyPage(action, owner.tabId, undefined, true);
    const background = await renderPreviewBackground('status', owner.tabId, owner.persistentGuard);
    return { ...page, background, ownedTargetTabId: owner.tabId };
  }
  const owner = await readNativeReferenceOwner();
  if (!owner) return fail('NATIVE_REFERENCE_OWNER_UNAVAILABLE');
  if (action === 'reference-cleanup') {
    const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
    if (tab && targetTabState(tab) === 'foreign') return fail('NATIVE_REFERENCE_TARGET_REPLACED');
    let page: any = null;
    if (tab && targetTabState(tab) === 'ready') page = await nativeSupplyPage('reference-stop', owner.tabId);
    const background = await renderPreviewBackground('cleanup', owner.tabId, owner.persistentGuard);
    await saveNativeReferenceOwner({ ...owner, cleanupConfirmed: true });
    if (tab) await browser.tabs.remove(owner.tabId);
    await saveNativeReferenceOwner(null);
    return { ok: true, buildId: BUILD_ID, page, background, guardReleased: true,
      ownedTargetTabId: owner.tabId, closed: true };
  }
  if (owner.cleanupConfirmed) return fail('NATIVE_REFERENCE_ALREADY_CLEANED');
  await renderPreviewBackground('status', owner.tabId, owner.persistentGuard);
  const page = await nativeSupplyPage(action === 'reference-status' ? 'status' : action, owner.tabId,
    undefined, action === 'reference-status');
  const background = await renderPreviewBackground('status', owner.tabId, owner.persistentGuard);
  return { ...page, background, ownedTargetTabId: owner.tabId };
}
async function nativeSupplyAction(action: NativeSupplyAction, input?: NativeSupplyPrepare) {
  if (action.startsWith('reference-')) return nativeReferenceAction(action as Extract<NativeSupplyAction,
    'reference-start' | 'reference-full-start' | 'reference-status' | 'reference-snapshot' |
    'reference-stop' | 'reference-export' | 'reference-cleanup' |
    'reference-official-1-start' | 'reference-official-3-start' |
    'reference-official-5-start' | 'reference-official-dom-start'>);
  if (action === 'recover-prepare') {
    if (!input || input.phase !== 'main' || input.fromMs !== 0 || input.toMs !== 45_000)
      return fail('NATIVE_SUPPLY_RECOVERY_INPUT_INVALID');
    const raw = (await browser.storage.local.get(NATIVE_SUPPLY_OWNER_KEY))[NATIVE_SUPPLY_OWNER_KEY] as
      NativeSupplyOwnerRecord | undefined;
    if (!raw || !Number.isSafeInteger(raw.tabId) || raw.tabId < 0 ||
        typeof raw.buildId !== 'string' || !raw.buildId.startsWith(`${manifest.version}-`) ||
        raw.taskId !== input.taskId ||
        raw.runId !== input.runId || raw.modelId !== input.modelId || raw.phase !== 'main' ||
        raw.runIssued === true || raw.replayIssued === true || raw.cleanupConfirmed)
      return fail('NATIVE_SUPPLY_RECOVERY_OWNER_MISMATCH');
    await nativeSupplyGuard(raw, true);
    const before = await nativeSupplyHost('status');
    const grant = before.grant;
    const unusedRetiredPreparation = grant?.state === 'stopped' && grant.reason === 'owner-tab-retired' &&
      grant.configIdentity === '' && !before.budget;
    if (grant?.state !== 'recovery-required' && !unusedRetiredPreparation || grant.buildId !== raw.buildId ||
        grant.taskId !== input.taskId || grant.runId !== input.runId ||
        grant.tabId !== raw.tabId || grant.modelId !== input.modelId ||
        grant.phase !== 'main' || grant.fromMs !== 0 || grant.toMs !== 45_000 ||
        grant.modelLoads !== 1 || grant.loadRecoveryCount !== 0 ||
        grant.loadOwnership !== 'owned' || grant.loadedByTask !== true ||
        before.activeRequests !== 0 ||
        (before.budget?.total?.occupied &&
          Object.values(before.budget.total.occupied).some(value => value !== 0)))
      return fail('NATIVE_SUPPLY_RECOVERY_NOT_ZERO_CALL');
    // A rebuilt extension may have unloaded the offscreen model. The host owns
    // the metadata/generation check for either idle or the exact prior load.
    const local = before.localState;
    if (!local || !['idle', 'ready'].includes(local.phase) || local.active !== 0 ||
        local.queued !== 0 || local.inferenceCalls !== 0 ||
        local.phase === 'ready' && (local.modelId !== input.modelId ||
          local.generation !== grant.modelGeneration))
      return fail('NATIVE_SUPPLY_RECOVERY_MODEL_BUSY_OR_CHANGED');
    const tab = await browser.tabs.get(raw.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
    if (targetTabState(tab) !== 'ready') return fail('NATIVE_SUPPLY_RECOVERY_TARGET_NOT_READY');
    const saved = await runtime({ type: 'settings' });
    const identity = await runtime({ type: 'build-identity' });
    if (saved.settings?.enabled !== false || identity.buildId !== BUILD_ID || identity.idle !== true)
      return fail('NATIVE_SUPPLY_RECOVERY_BACKGROUND_CHANGED');
    // Reload only the verified task-owned video tab. Extension reload does not
    // re-inject content scripts into a document that was already open.
    await browser.tabs.update(raw.tabId, { active: true });
    await browser.tabs.reload(raw.tabId);
    await nativeSupplyPage('status', raw.tabId, undefined, true);
    const page = await nativeSupplyPage('prepare', raw.tabId,
      { runId: raw.runId, fromMs: input.fromMs, toMs: input.toMs }, true);
    const host = await nativeSupplyHost('prepare', { input: { taskId: raw.taskId,
      runId: raw.runId, phase: 'main', tabId: raw.tabId, epoch: page.epoch,
      modelId: raw.modelId, fromMs: 0, toMs: 45_000 } });
    if (host.grant?.buildId !== BUILD_ID || host.grant?.state !== 'prepared' ||
        host.grant.taskId !== raw.taskId || host.grant.runId !== raw.runId ||
        host.grant.tabId !== raw.tabId || host.grant.epoch !== page.epoch ||
        host.grant.session?.sessionId !== page.session.sessionId ||
        host.grant.modelId !== raw.modelId || host.grant.modelLoads !== 2 ||
        host.grant.loadRecoveryCount !== 1 || !host.grant.instanceId || !host.grant.configIdentity)
      return fail('NATIVE_SUPPLY_RECOVERY_GRANT_MISMATCH');
    await nativeSupplyGuard(raw, true);
    const bound = await nativeSupplyPage('bind', raw.tabId, { grant: host.grant });
    if (bound.state !== 'armed' || bound.epoch !== page.epoch)
      return fail('NATIVE_SUPPLY_RECOVERY_BIND_MISMATCH');
    await saveNativeSupplyOwner({ ...raw, buildId: BUILD_ID, instanceId: host.grant.instanceId,
      epoch: page.epoch, runIssued: false, replayIssued: false });
    return { ...bound, preparedPage: page, host, ownedTargetTabId: raw.tabId };
  }
  if (action === 'prepare') {
    if (!input) return fail('NATIVE_SUPPLY_PREPARE_INPUT_REQUIRED');
    const saved = await runtime({ type: 'settings' });
    if (saved.settings?.enabled !== false) return fail('NATIVE_SUPPLY_REQUIRES_DISABLED_TRANSLATION');
    const identity = await runtime({ type: 'build-identity' });
    if (identity.buildId !== BUILD_ID || identity.version !== manifest.version || identity.idle !== true)
      return fail('NATIVE_SUPPLY_BACKGROUND_NOT_IDLE');
    const existing = await readNativeSupplyOwner(input.authorizedExtraLoad === true);
    const unboundRepair = input.authorizedExtraLoad === true && existing?.phase === 'repair' &&
      existing.taskId === input.taskId && existing.runId === input.runId && existing.modelId === input.modelId &&
      !existing.instanceId && existing.epoch === undefined && !existing.runIssued && !existing.cleanupConfirmed;
    if (existing && !unboundRepair && (existing.cleanupConfirmed || existing.taskId !== input.taskId ||
        existing.modelId !== input.modelId || existing.phase !== 'main' || input.phase !== 'repair' ||
        existing.replayIssued)) return fail('NATIVE_SUPPLY_OWNED_TARGET_CLEANUP_REQUIRED');
    const priorHost = await nativeSupplyHost('status');
    if (input.authorizedExtraLoad === true && (existing && !unboundRepair || input.phase !== 'repair' ||
        priorHost.grant?.taskId !== input.taskId || priorHost.grant.runId === input.runId ||
        priorHost.grant.phase !== 'main' || priorHost.grant.state !== 'stopped' ||
        !['cleanup', 'owner-tab-retired'].includes(priorHost.grant.reason) || priorHost.grant.modelId !== input.modelId ||
        priorHost.grant.modelLoads !== 2 || priorHost.grant.loadRecoveryCount !== 1 ||
        priorHost.activeRequests !== 0 || !priorHost.budget || priorHost.budget.phases.repair.runId !== null ||
        priorHost.localState?.phase !== 'idle' || priorHost.localState.active !== 0 || priorHost.localState.queued !== 0))
      return fail('NATIVE_SUPPLY_EXTRA_LOAD_REPAIR_UNAVAILABLE');
    if (existing && !unboundRepair && (priorHost.grant?.taskId !== existing.taskId || priorHost.grant.runId !== existing.runId ||
        priorHost.grant.tabId !== existing.tabId || priorHost.grant.state !== 'stopped' ||
        priorHost.activeRequests !== 0)) return fail('NATIVE_SUPPLY_REPAIR_REQUIRES_STOPPED_OWNER');
    if (!existing && priorHost.grant && priorHost.grant.state !== 'stopped')
      return fail('NATIVE_SUPPLY_PRIOR_RUN_NOT_CLEAN');
    let owner = existing, newlyCreated = false;
    if (!owner) {
      const opened = await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
      if (!Number.isSafeInteger(opened.id)) return fail('TARGET_TAB_MISSING_ID');
      owner = { tabId: opened.id!, buildId: BUILD_ID, taskId: input.taskId,
        runId: input.runId, phase: input.phase, modelId: input.modelId };
      try { await saveNativeSupplyOwner(owner); }
      catch (error) { await browser.tabs.remove(owner.tabId).catch(() => {}); throw error; }
      newlyCreated = true;
    } else if (unboundRepair) {
      const tab = await browser.tabs.get(owner.tabId);
      if (targetTabState(tab) !== 'ready') return fail('NATIVE_SUPPLY_TARGET_NOT_READY');
      await browser.tabs.reload(owner.tabId);
      owner = { ...owner, buildId: BUILD_ID }; await saveNativeSupplyOwner(owner);
    } else {
      await nativeSupplyGuard(owner, true);
      await nativeSupplyPage('cleanup', owner.tabId);
    }
    const page = await nativeSupplyPage('prepare', owner.tabId,
      { runId: input.runId, fromMs: input.fromMs, toMs: input.toMs }, true, newlyCreated);
    const host = await nativeSupplyHost('prepare', { input: { taskId: input.taskId,
      runId: input.runId, phase: input.phase, tabId: owner.tabId, epoch: page.epoch,
      modelId: input.modelId, fromMs: input.fromMs, toMs: input.toMs,
      ...(input.authorizedExtraLoad === true ? { authorizedExtraLoad: true } : {}),
      ...(input.phase === 'repair' ? { repairReason: input.repairReason } : {}) } });
    if (host.grant?.taskId !== input.taskId || host.grant.runId !== input.runId ||
        host.grant.tabId !== owner.tabId || host.grant.epoch !== page.epoch ||
        host.grant.state !== 'prepared' || !host.grant.instanceId || !host.grant.configIdentity ||
        host.grant.session?.sessionId !== page.session.sessionId || host.grant.modelId !== input.modelId)
      return fail('NATIVE_SUPPLY_GRANT_MISMATCH');
    await nativeSupplyGuard({ ...owner, runId: input.runId }, true);
    const bound = await nativeSupplyPage('bind', owner.tabId, { grant: host.grant });
    if (bound.state !== 'armed' || bound.epoch !== page.epoch) return fail('NATIVE_SUPPLY_BIND_MISMATCH');
    owner = { ...owner, taskId: input.taskId, runId: input.runId, phase: input.phase,
      instanceId: host.grant.instanceId, epoch: page.epoch, runIssued: false, replayIssued: false };
    await saveNativeSupplyOwner(owner);
    return { ...bound, preparedPage: page, host, ownedTargetTabId: owner.tabId };
  }
  const owner = await readNativeSupplyOwner();
  if (!owner) return fail('NATIVE_SUPPLY_OWNER_UNAVAILABLE');
  if (action === 'cleanup') {
    await nativeSupplyHost('stop', { reason: 'runner-cleanup' });
    let page: any = null;
    const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
    if (tab && targetTabState(tab) === 'foreign') return fail('NATIVE_SUPPLY_TARGET_REPLACED');
    if (tab && targetTabState(tab) === 'ready') page = await nativeSupplyPage('cleanup', owner.tabId);
    const host = await nativeSupplyHost('cleanup');
    if (host.grant?.taskId !== owner.taskId || host.grant?.tabId !== owner.tabId ||
        host.grant.state !== 'stopped' || host.activeRequests !== 0) return fail('NATIVE_SUPPLY_CLEANUP_UNCONFIRMED');
    await nativeSupplyGuard(owner, false);
    await saveNativeSupplyOwner({ ...owner, cleanupConfirmed: true });
    return { ok: true, buildId: BUILD_ID, page, host, ownedTargetTabId: owner.tabId,
      guardReleased: true, closedTargetEvidence: tab ? null : { tabId: owner.tabId, exists: false } };
  }
  if (owner.cleanupConfirmed) return fail('NATIVE_SUPPLY_ALREADY_CLEANED');
  await nativeSupplyGuard(owner, true);
  const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
  if (targetTabState(tab) !== 'ready') return fail('NATIVE_SUPPLY_TARGET_NOT_READY');
  const before = await nativeSupplyHost('status');
  if (before.grant?.taskId !== owner.taskId || before.grant.runId !== owner.runId ||
      before.grant.tabId !== owner.tabId || before.grant.instanceId !== owner.instanceId)
    return fail('NATIVE_SUPPLY_HOST_OWNER_MISMATCH');
  if (action === 'run') {
    if (owner.runIssued || before.grant.state !== 'prepared') return fail('NATIVE_SUPPLY_RUN_NOT_PREPARED');
    await saveNativeSupplyOwner({ ...owner, runIssued: true });
    await browser.tabs.update(owner.tabId, { active: true });
    const page = await nativeSupplyPage('start', owner.tabId);
    const host = await nativeSupplyHost('status');
    if (host.grant?.state !== 'running') return fail('NATIVE_SUPPLY_START_UNCONFIRMED');
    return { ...page, host, ownedTargetTabId: owner.tabId };
  }
  if (action === 'replay') {
    if (!owner.runIssued || owner.replayIssued || before.grant.state !== 'stopped' ||
        before.activeRequests !== 0) return fail('NATIVE_SUPPLY_REPLAY_NOT_IDLE');
    await browser.tabs.update(owner.tabId, { active: true });
    const page = await nativeSupplyPage('replay', owner.tabId);
    const host = await nativeSupplyHost('status');
    if (host.grant?.state !== 'prepared' || host.grant.cacheOnly !== true ||
        host.grant.epoch !== page.epoch || host.grant.instanceId === owner.instanceId)
      return fail('NATIVE_SUPPLY_REPLAY_GRANT_MISMATCH');
    await saveNativeSupplyOwner({ ...owner, instanceId: host.grant.instanceId,
      epoch: page.epoch, runIssued: false, replayIssued: true });
    return { ...page, host, ownedTargetTabId: owner.tabId };
  }
  if (action === 'drain') {
    const page = await nativeSupplyPage('drain', owner.tabId);
    const host = await nativeSupplyHost('status');
    if (!['draining', 'stopped'].includes(host.grant?.state)) return fail('NATIVE_SUPPLY_DRAIN_UNCONFIRMED');
    return { ...page, host, ownedTargetTabId: owner.tabId };
  }
  if (action === 'stop') {
    const host = await nativeSupplyHost('stop', { reason: 'runner-stop' });
    const page = await nativeSupplyPage('stop', owner.tabId);
    if (host.grant?.state !== 'stopped') return fail('NATIVE_SUPPLY_STOP_UNCONFIRMED');
    return { ...page, host, ownedTargetTabId: owner.tabId };
  }
  const page = await nativeSupplyPage(action, owner.tabId, undefined, action === 'status');
  const host = await nativeSupplyHost(action === 'export' ? 'export' : 'status');
  return { ...page, host, ownedTargetTabId: owner.tabId };
}
async function closeNativeSupplyOwnedTarget() {
  const owner = await readNativeSupplyOwner();
  if (!owner) return { closed: false };
  if (!owner.cleanupConfirmed) return fail('NATIVE_SUPPLY_CLOSE_REQUIRES_CONFIRMED_CLEANUP');
  const tab = await browser.tabs.get(owner.tabId).catch(error => { if (noSuchTab(error)) return null; throw error; });
  if (tab && targetTabState(tab) === 'foreign') return fail('NATIVE_SUPPLY_TARGET_REPLACED');
  if (tab) await browser.tabs.remove(owner.tabId);
  await saveNativeSupplyOwner(null);
  return { closed: true, tabId: owner.tabId, targetWasPresent: !!tab };
}

const PROBE_RANGE = { fromMs: 52000, toMs: 67000, prefetchSeconds: 5 } as const;

async function probePreparedDispatch(prepared: any) {
  const tab = await ownedTab();
  if (tab?.id === undefined) return fail('OWNED_TARGET_UNAVAILABLE');
  const status = await auditAction('status');
  const videoTimeMs = status.videoTimeMs ?? status.playback?.videoTimeMs;
  if (status.idle !== true || status.paused !== true || !Number.isFinite(videoTimeMs) ||
      Math.abs(videoTimeMs - PROBE_RANGE.fromMs) > 1500) return fail('PROBE_REQUIRES_PAUSED_52_IDLE');
  const preview = prepared.localPreview ?? prepared.preview;
  const resourceId = prepared.inspection?.identity?.resourceId;
  if (typeof resourceId !== 'string' || !resourceId || preview?.ok !== true ||
      preview.resourceId !== resourceId || !Number.isSafeInteger(preview.configVersion) ||
      preview.dispatch?.savedBatchLimit < 1) return fail('PROBE_PREVIEW_UNAVAILABLE');
  const savedBatchLimit = preview.dispatch.savedBatchLimit;
  const settingsBefore = await runtime({ type: 'settings' });
  const before = await runtime({ type: 'local-control', control: { action: 'state' } });
  if (settingsBefore.settings?.enabled !== false || settingsBefore.performancePaused === true ||
      settingsBefore.settings?.concurrency !== 2 || settingsBefore.configVersion !== preview.configVersion ||
      !idleState(before) || !Number.isSafeInteger(before.state.inferenceCalls))
    return fail('PROBE_BACKGROUND_NOT_IDLE');

  const runId = crypto.randomUUID();
  let apply: any, stop: any, applyFailure: unknown = null;
  try {
    apply = await browser.tabs.sendMessage(tab.id, {
      type: 'bilibili-experiment-configure', runId, configVersion: preview.configVersion,
      resourceId, ...PROBE_RANGE, filterEnabled: true, singleDispatch: true,
    }, { frameId: 0 });
    if (apply?.ok !== true) return fail(typeof apply?.error === 'string' ? apply.error : 'PROBE_CONFIGURE_REJECTED');
    if (apply.buildId !== BUILD_ID || apply.version !== manifest.version ||
        apply.effectiveBatchLimit !== 1 || apply.concurrency !== 2 || apply.singleDispatch !== true)
      return fail('PROBE_CONFIGURE_MISMATCH');
  } catch (error) { applyFailure = error; }
  finally {
    // An ack can be lost after watch has applied the setting. Always stop the
    // exact temporary run, including mismatch or transport-failure paths.
    stop = await browser.tabs.sendMessage(tab.id, { type: 'bilibili-experiment-stop', runId }, { frameId: 0 })
      .catch(error => ({ ok: false, error: error instanceof Error ? error.message : 'PROBE_STOP_FAILED' }));
  }
  if (stop?.ok !== true && (apply?.ok === true || !apply)) return fail('PROBE_RESTORE_UNCONFIRMED');
  if (applyFailure) throw applyFailure;
  const restored = await browser.tabs.sendMessage(tab.id, {
    type: 'bilibili-experiment-preview', resourceId, ...PROBE_RANGE,
  }, { frameId: 0 });
  if (restored?.ok !== true || restored.resourceId !== resourceId || restored.buildId !== BUILD_ID ||
      restored.effectiveBatchLimit !== savedBatchLimit) return fail('PROBE_SAVED_BATCH_NOT_RESTORED');
  const after = await runtime({ type: 'local-control', control: { action: 'state' } });
  const settingsAfter = await runtime({ type: 'settings' });
  if (!idleState(after) || after.state.generation !== before.state.generation ||
      after.state.inferenceCalls !== before.state.inferenceCalls ||
      settingsAfter.configVersion !== settingsBefore.configVersion ||
      JSON.stringify(settingsAfter.settings) !== JSON.stringify(settingsBefore.settings))
    return fail('PROBE_MODEL_OR_SAVED_SETTINGS_CHANGED');
  return { runId, apply, stop, restored: {
    effectiveBatchLimit: restored.effectiveBatchLimit, buildId: restored.buildId,
    session: restored.session,
  }, savedBatchLimit, inference: { generation: before.state.generation,
    before: before.state.inferenceCalls, after: after.state.inferenceCalls } };
}

async function ensureBackgroundIdle() {
  const settings = await runtime({ type: 'settings' });
  if (settings.settings?.enabled !== false || settings.performancePaused === true)
    return fail('EXTENSION_NOT_IDLE');
  const local = await runtime({ type: 'local-control', control: { action: 'state' } });
  if (!idleState(local)) return fail('LOCAL_MODEL_BUSY');
  const background = await runtime({ type: 'build-identity' });
  if (background.idle !== true) return fail('BACKGROUND_NOT_IDLE');
}

async function ensureReloadIdle() {
  await ensureBackgroundIdle();
  if (await ownedTab()) {
    const audit = await auditAction('status');
    if (audit.idle !== true) return fail('AUDIT_NOT_IDLE');
  }
}

async function refreshMarker(tabId: number): Promise<boolean> {
  const value = (await browser.storage.local.get(DISPATCH_REFRESH_KEY))[DISPATCH_REFRESH_KEY] as RefreshRecord | undefined;
  return value?.tabId === tabId && value.buildId === BUILD_ID &&
    Number.isFinite(value.expiresAt) && value.expiresAt > Date.now();
}

async function ensureRefreshIdle(tabId: number) {
  await ensureBackgroundIdle();
  try {
    const audit = await auditAction('status');
    if (audit.idle !== true) return fail('AUDIT_NOT_IDLE');
  } catch (error) {
    // A verified idle reload invalidates the old content listener. Only this
    // one-shot marker permits refreshing the already-owned, fixed target tab.
    const missingListener = error instanceof Error &&
      /Receiving end does not exist|Could not establish connection/i.test(error.message);
    if (!missingListener || !await refreshMarker(tabId)) throw error;
  }
}

async function execute(command: DispatchCommand): Promise<CommandResult> {
  if (command.command === 'rpc') return { result: command.payload.type === 'local-control' &&
    command.payload.control.action === 'load' ? await loadSelectedModel(command.payload.control.modelId)
      : await runtime(command.payload) };
  if (command.command === 'userFilters') return { result: await userFiltersAction(command.payload.action) };
  if (command.command === 'displayPlan') return { result: await displayPlanAction(command.payload.action) };
  if (command.command === 'renderPreview') return { result: await renderPreviewAction(command.payload.action) };
  if (command.command === 'livePreview') return { result: await livePreviewAction(command.payload.action,
    command.payload.action === 'prepare' ? command.payload : undefined) };
  if (command.command === 'nativeSupply') return { result: await nativeSupplyAction(command.payload.action,
    command.payload.action === 'prepare' || command.payload.action === 'recover-prepare' ? command.payload : undefined) };
  if (command.command === 'ownedSupplyStatus') return { result: await ownedSupplyStatus(command.payload.action) };
  if (command.command === 'close-render-preview-owned') return { result: await closeRenderPreviewOwnedTarget() };
  if (command.command === 'close-live-preview-owned') return { result: await closeLivePreviewOwnedTarget() };
  if (command.command === 'close-native-supply-owned') return { result: await closeNativeSupplyOwnedTarget() };
  if (command.command === 'reload') {
    // A previous background that rejects runner RPC cannot prove idle. Even an
    // explicit bootstrap command must fail until it can perform these checks.
    await ensureReloadIdle();
    if (ownedTabId !== null) await browser.storage.local.set({ [DISPATCH_REFRESH_KEY]: {
      tabId: ownedTabId, buildId: BUILD_ID, expiresAt: Date.now() + REFRESH_LIFETIME_MS,
    } satisfies RefreshRecord });
    await saveSession();
    return { result: { willReload: true }, reload: true };
  }
  if (command.command === 'openTarget') {
    const existing = await ownedTab();
    if (existing?.id !== undefined) {
      if (command.payload.refresh === true) {
        await ensureRefreshIdle(existing.id);
        // Consume before navigation so an interrupted update cannot permit a
        // second refresh with a missing audit listener.
        await browser.storage.local.remove(DISPATCH_REFRESH_KEY);
        await browser.tabs.update(existing.id, { active: true });
        await browser.tabs.reload(existing.id);
      } else await browser.tabs.update(existing.id, { active: true });
      return { result: { tabId: existing.id, reused: true, refreshed: command.payload.refresh === true } };
    }
    const opened = await browser.tabs.create({ url: DISPATCH_TARGET_URL, active: true });
    if (!Number.isSafeInteger(opened.id)) return fail('TARGET_TAB_MISSING_ID');
    ownedTabId = opened.id!;
    try { await saveSession(); }
    catch (error) { await browser.tabs.remove(opened.id!).catch(() => {}); ownedTabId = null; throw error; }
    target.textContent = `已打开 · ${ownedTabId}`;
    return { result: { tabId: ownedTabId, reused: false } };
  }
  if (command.command === 'audit') {
    if (command.payload.action !== 'prepare') return { result: await auditAction(command.payload.action) };
    const prepared = await auditAction('prepare');
    const configurationProbe = await probePreparedDispatch(prepared);
    // Watch configure/stop advances the page session generation. Refresh the
    // content preview before the Node runner uses it for a later experiment.
    return { result: { ...await auditAction('prepare'), configurationProbe } };
  }
  const tab = await ownedTab();
  if (tab?.id === undefined) return { result: { closed: false } };
  await browser.tabs.remove(tab.id);
  ownedTabId = null;
  await browser.storage.local.remove(DISPATCH_REFRESH_KEY);
  await saveSession();
  target.textContent = '未打开';
  return { result: { closed: true } };
}

async function postResult(id: string, ok: boolean, result: unknown, error: string | null) {
  const body = { id, ok, result: ok ? result : null, error };
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024 * 1024)
    return fail('RESULT_TOO_LARGE');
  await request('/result', 'POST', serialized);
}

async function poll() {
  while (connected) {
    // Chrome may omit Origin on an extension GET with host permission. POST
    // keeps the real extension Origin so the runner can require it on every call.
    const raw = await commandBody(await request('/command', 'POST', {}));
    if (!connected) break;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        Object.keys(raw).length === 2 && (raw as { idle?: unknown; closing?: unknown }).idle === true &&
        (raw as { closing?: unknown }).closing === true) {
      connected = false;
      setState('offline', '本地 runner 已结束。');
      const current = await browser.tabs.getCurrent();
      if (current?.id !== undefined && current.url?.startsWith(browser.runtime.getURL('/dispatch-runner.html#')))
        await browser.tabs.remove(current.id);
      break;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        Object.keys(raw).length === 1 && (raw as { idle?: unknown }).idle === true) continue;
  const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { id?: unknown }).id : null;
    if (!validDispatchId(id)) return fail('INVALID_COMMAND_ID');
    executing = true;
    disconnectButton.disabled = true;
    let result: CommandResult | null = null, error: string | null = null;
    try { result = await execute(parseDispatchCommand(raw)); }
    catch (cause) { error = cause instanceof Error ? cause.message.slice(0, 200) : 'COMMAND_FAILED'; }
    lastCommand.textContent = `${String((raw as { command?: string }).command ?? '未知').slice(0, 40)} · ${error ? '失败' : '完成'}`;
    try { await postResult(id, !error, result?.result ?? null, error); }
    finally { executing = false; disconnectButton.disabled = !connected; }
    if (result?.reload && !error) {
      connected = false;
      setState('offline', '扩展即将重载；本地 runner 会重新打开控制台。');
      setTimeout(() => browser.runtime.reload(), 200);
      break;
    }
  }
}

async function start() {
  if (!connection || connected || connecting) return;
  connecting = true;
  connectButton.disabled = true;
  try {
    await request('/hello', 'POST', { extensionId: browser.runtime.id, version: manifest.version });
    await restoreSession();
    await saveSession();
    connected = true;
    setState('online', '本地 runner 已连接，等待命令。');
    await poll();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError' && !connected)
      setState('offline', '连接已断开。');
    else if (connected || connecting) setState('error', error instanceof Error ? error.message : '连接中断');
  } finally {
    connected = false;
    connecting = false;
    requestAbort = null;
    if (state.dataset.state === 'online') setState('offline', '连接已断开。');
    else connectButton.disabled = !connection;
    disconnectButton.disabled = true;
  }
}

connectButton.addEventListener('click', async () => {
  if (!connection) return;
  try {
    const granted = await browser.permissions.request({ origins: ['http://127.0.0.1/*'] });
    if (!granted) return fail('LOOPBACK_PERMISSION_DENIED');
    await start();
  } catch (error) { setState('error', error instanceof Error ? error.message : '连接失败'); }
});
disconnectButton.addEventListener('click', () => {
  if (executing) return;
  connected = false;
  requestAbort?.abort();
  setState('offline', '连接已断开。');
});

async function initialize() {
  if (window.top !== window || location.protocol !== 'chrome-extension:' || location.host !== browser.runtime.id ||
      location.pathname !== '/dispatch-runner.html') return fail('INVALID_EXTENSION_ORIGIN');
  connection = parseDispatchHash(location.hash);
  await restoreSession();
  setState('offline', '等待连接。');
  if (await browser.permissions.contains({ origins: ['http://127.0.0.1/*'] })) void start();
}
void initialize().catch(error => setState('error', error instanceof Error ? error.message : '连接参数无效'));
