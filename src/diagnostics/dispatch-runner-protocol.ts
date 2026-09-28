export const DISPATCH_TARGET_URL = 'https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit';
export const DISPATCH_SESSION_KEY = 'dispatchRunner.v1';
export const DISPATCH_OWNED_KEY = 'dispatchRunner.owned.v1';
export const DISPATCH_REFRESH_KEY = 'dispatchRunner.refresh.v1';
export const DISPLAY_PLAN_OWNER_KEY = 'displayPlanRunner.owner.v1';
export const RENDER_PREVIEW_OWNER_KEY = 'renderPreviewRunner.owner.v1';
export const LIVE_PREVIEW_OWNER_KEY = 'livePreviewRunner.owner.v1';
export const NATIVE_SUPPLY_OWNER_KEY = 'nativeSupplyRunner.owner.v1';
export const NATIVE_REFERENCE_OWNER_KEY = 'nativeSupplyRunner.referenceOwner.v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RANDOM_TOKEN = /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43,86})$/i;
const COMMAND_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const DISPATCH_AUDIT_ACTIONS = Object.freeze([
  'inspect', 'prepare', 'zero-start', 'start-B', 'start-A', 'stop', 'export', 'status', 'play', 'restore',
] as const);
export type DispatchAuditAction = typeof DISPATCH_AUDIT_ACTIONS[number];
export const USER_FILTERS_ACTIONS = Object.freeze(['prepare', 'run', 'status', 'cleanup'] as const);
export type UserFiltersAction = typeof USER_FILTERS_ACTIONS[number];
export const DISPLAY_PLAN_ACTIONS = Object.freeze(['prepare', 'run', 'status', 'seek', 'export', 'cleanup'] as const);
export type DisplayPlanAction = typeof DISPLAY_PLAN_ACTIONS[number];
export const RENDER_PREVIEW_ACTIONS = Object.freeze([
  'prepare', 'run', 'status', 'pause', 'play', 'seek', 'export', 'cleanup',
] as const);
export type RenderPreviewAction = typeof RENDER_PREVIEW_ACTIONS[number];
export const LIVE_PREVIEW_ACTIONS = Object.freeze([
  'prepare', 'run', 'resume', 'status', 'drain', 'export', 'cleanup',
] as const);
export type LivePreviewAction = typeof LIVE_PREVIEW_ACTIONS[number];
export type LivePreviewPrepare = { action: 'prepare'; taskId: string; runId: string;
  phase: 'main' | 'repair' | 'supplement'; repairReason?: string; fromMs?: number; toMs?: number };
export const NATIVE_SUPPLY_ACTIONS = Object.freeze([
  'prepare', 'recover-prepare', 'run', 'status', 'export', 'drain', 'stop', 'cleanup', 'replay',
  'reference-start', 'reference-status', 'reference-stop', 'reference-export', 'reference-cleanup',
  'reference-full-start', 'reference-snapshot',
  'reference-official-1-start', 'reference-official-3-start',
  'reference-official-5-start', 'reference-official-dom-start',
] as const);
export type NativeSupplyAction = typeof NATIVE_SUPPLY_ACTIONS[number];
export type NativeSupplyPrepare = { action: 'prepare' | 'recover-prepare'; taskId: string; runId: string;
  phase: 'main' | 'repair'; modelId: string; fromMs: number; toMs: number; repairReason?: string;
  authorizedExtraLoad?: true };

export type DispatchRpc = { type: 'settings' | 'build-identity' }
  | { type: 'local-control'; control: { action: 'state' | 'list' } | { action: 'load'; modelId?: string } };
export type DispatchCommand = { id: string; command: 'rpc'; payload: DispatchRpc }
  | { id: string; command: 'audit'; payload: { action: DispatchAuditAction; args: Record<string, never> } }
  | { id: string; command: 'reload'; payload: { bootstrap?: true } }
  | { id: string; command: 'openTarget'; payload: { refresh?: true } }
  | { id: string; command: 'userFilters'; payload: { action: UserFiltersAction } }
  | { id: string; command: 'displayPlan'; payload: { action: DisplayPlanAction } }
  | { id: string; command: 'renderPreview'; payload: { action: RenderPreviewAction } }
  | { id: string; command: 'livePreview'; payload: LivePreviewPrepare | { action: Exclude<LivePreviewAction, 'prepare'> } }
  | { id: string; command: 'nativeSupply'; payload: NativeSupplyPrepare | { action: Exclude<NativeSupplyAction, 'prepare' | 'recover-prepare'> } }
  | { id: string; command: 'ownedSupplyStatus'; payload: { action: 'status' | 'export' } }
  | { id: string; command: 'close-render-preview-owned'; payload: Record<string, never> }
  | { id: string; command: 'close-live-preview-owned'; payload: Record<string, never> }
  | { id: string; command: 'close-native-supply-owned'; payload: Record<string, never> }
  | { id: string; command: 'close-owned'; payload: Record<string, never> };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}

export function parseDispatchHash(hash: string): { port: number; token: string } {
  if (!hash.startsWith('#')) throw new Error('INVALID_CONNECTION');
  const fields = new URLSearchParams(hash.slice(1));
  if ([...fields.keys()].sort().join(',') !== 'port,token') throw new Error('INVALID_CONNECTION');
  const portText = fields.get('port') ?? '';
  const token = fields.get('token') ?? '';
  if (!/^[1-9]\d{3,4}$/.test(portText)) throw new Error('INVALID_PORT');
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
  if (!UUID.test(token) && !RANDOM_TOKEN.test(token)) throw new Error('INVALID_TOKEN');
  return { port, token };
}

export function isDispatchTarget(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://www.bilibili.com' && parsed.pathname === '/video/BV1yvhW6sEzi/' &&
      parsed.hash === '#danlingo-audit' && (!parsed.search || parsed.search === '?p=1');
  } catch { return false; }
}

export function validDispatchId(value: unknown): value is string {
  return typeof value === 'string' && COMMAND_ID.test(value);
}

export function parseDispatchCommand(value: unknown): DispatchCommand {
  if (!record(value) || !validDispatchId(value.id) || typeof value.command !== 'string' ||
      !keys(value, ['id', 'command', 'payload'])) throw new Error('INVALID_COMMAND');
  const { id, command, payload } = value;
  if (command === 'rpc') {
    if (!record(payload) || typeof payload.type !== 'string') throw new Error('INVALID_RPC');
    if (payload.type === 'settings' || payload.type === 'build-identity') {
      if (!keys(payload, ['type'])) throw new Error('INVALID_RPC');
      return { id, command, payload: { type: payload.type } };
    }
    if (payload.type !== 'local-control' || !keys(payload, ['type', 'control']) || !record(payload.control))
      throw new Error('INVALID_RPC');
    const control = payload.control;
    if ((control.action === 'state' || control.action === 'list') && keys(control, ['action']))
      return { id, command, payload: { type: 'local-control', control: { action: control.action } } };
    if (control.action === 'load' &&
        (keys(control, ['action']) || keys(control, ['action', 'modelId']) &&
          typeof control.modelId === 'string' && !!control.modelId && control.modelId.length <= 200))
      return { id, command, payload: { type: 'local-control', control: {
        action: 'load', ...(typeof control.modelId === 'string' ? { modelId: control.modelId } : {}),
      } } };
    throw new Error('INVALID_RPC');
  }
  if (command === 'audit') {
    if (!record(payload) || !keys(payload, ['action', 'args']) ||
        !DISPATCH_AUDIT_ACTIONS.includes(payload.action as DispatchAuditAction) ||
        !record(payload.args) || !keys(payload.args, [])) throw new Error('INVALID_AUDIT_ACTION');
    return { id, command, payload: { action: payload.action as DispatchAuditAction, args: {} } };
  }
  if (command === 'userFilters') {
    if (!record(payload) || !keys(payload, ['action']) ||
        !USER_FILTERS_ACTIONS.includes(payload.action as UserFiltersAction)) throw new Error('INVALID_USER_FILTERS_ACTION');
    return { id, command, payload: { action: payload.action as UserFiltersAction } };
  }
  if (command === 'displayPlan') {
    if (!record(payload) || !keys(payload, ['action']) ||
        !DISPLAY_PLAN_ACTIONS.includes(payload.action as DisplayPlanAction)) throw new Error('INVALID_DISPLAY_PLAN_ACTION');
    return { id, command, payload: { action: payload.action as DisplayPlanAction } };
  }
  if (command === 'renderPreview') {
    if (!record(payload) || !keys(payload, ['action']) ||
        !RENDER_PREVIEW_ACTIONS.includes(payload.action as RenderPreviewAction))
      throw new Error('INVALID_RENDER_PREVIEW_ACTION');
    return { id, command, payload: { action: payload.action as RenderPreviewAction } };
  }
  if (command === 'livePreview') {
    if (!record(payload) || !LIVE_PREVIEW_ACTIONS.includes(payload.action as LivePreviewAction))
      throw new Error('INVALID_LIVE_PREVIEW_ACTION');
    if (payload.action !== 'prepare') {
      if (!keys(payload, ['action'])) throw new Error('INVALID_LIVE_PREVIEW_ACTION');
      return { id, command, payload: { action: payload.action as Exclude<LivePreviewAction, 'prepare'> } };
    }
    const validId = (item: unknown) => typeof item === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item);
    if (!validId(payload.taskId) || !validId(payload.runId) ||
        !['main', 'repair', 'supplement'].includes(payload.phase as string)) throw new Error('INVALID_LIVE_PREVIEW_PREPARE');
    if (payload.phase === 'main') {
      if (!keys(payload, ['action', 'taskId', 'runId', 'phase'])) throw new Error('INVALID_LIVE_PREVIEW_PREPARE');
      return { id, command, payload: { action: 'prepare', taskId: payload.taskId as string,
        runId: payload.runId as string, phase: 'main' } };
    }
    if (!keys(payload, ['action', 'taskId', 'runId', 'phase', 'repairReason', 'fromMs', 'toMs']) ||
        typeof payload.repairReason !== 'string' || !payload.repairReason.trim() || payload.repairReason.length > 500 ||
        !Number.isSafeInteger(payload.fromMs) || !Number.isSafeInteger(payload.toMs) ||
        (payload.toMs as number) <= (payload.fromMs as number) ||
        (payload.phase === 'repair' && (payload.toMs as number) - (payload.fromMs as number) > 20_000) ||
        (payload.phase === 'supplement' && (payload.fromMs !== 45_000 || payload.toMs !== 85_000)) ||
        (payload.fromMs as number) < 45_000 || (payload.toMs as number) > 85_000)
      throw new Error('INVALID_LIVE_PREVIEW_PREPARE');
    return { id, command, payload: { action: 'prepare', taskId: payload.taskId as string,
      runId: payload.runId as string, phase: payload.phase as 'repair' | 'supplement', repairReason: payload.repairReason,
      fromMs: payload.fromMs as number, toMs: payload.toMs as number } };
  }
  if (command === 'nativeSupply') {
    if (!record(payload) || !NATIVE_SUPPLY_ACTIONS.includes(payload.action as NativeSupplyAction))
      throw new Error('INVALID_NATIVE_SUPPLY_ACTION');
    if (payload.action !== 'prepare' && payload.action !== 'recover-prepare') {
      if (!keys(payload, ['action'])) throw new Error('INVALID_NATIVE_SUPPLY_ACTION');
      return { id, command, payload: { action: payload.action as Exclude<NativeSupplyAction, 'prepare' | 'recover-prepare'> } };
    }
    const validId = (item: unknown) => typeof item === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(item);
    if (!validId(payload.taskId) || !validId(payload.runId) || !validId(payload.modelId) ||
        !Number.isSafeInteger(payload.fromMs) || !Number.isSafeInteger(payload.toMs))
      throw new Error('INVALID_NATIVE_SUPPLY_PREPARE');
    if (payload.phase === 'main') {
      if (!keys(payload, ['action', 'taskId', 'runId', 'phase', 'modelId', 'fromMs', 'toMs']) ||
          payload.fromMs !== 0 || payload.toMs !== 45_000) throw new Error('INVALID_NATIVE_SUPPLY_PREPARE');
      return { id, command, payload: payload as NativeSupplyPrepare };
    }
    if (payload.action === 'recover-prepare') throw new Error('INVALID_NATIVE_SUPPLY_PREPARE');
    const repairKeys = ['action', 'taskId', 'runId', 'phase', 'modelId', 'fromMs', 'toMs', 'repairReason'];
    if (payload.phase !== 'repair' || !(keys(payload, repairKeys) ||
        keys(payload, [...repairKeys, 'authorizedExtraLoad']) && payload.authorizedExtraLoad === true) ||
        typeof payload.repairReason !== 'string' || !payload.repairReason.trim() ||
        payload.repairReason.length > 500 || (payload.fromMs as number) < 0 ||
        (payload.toMs as number) > 45_000 || (payload.toMs as number) <= (payload.fromMs as number) ||
        (payload.toMs as number) - (payload.fromMs as number) > 15_000)
      throw new Error('INVALID_NATIVE_SUPPLY_PREPARE');
    return { id, command, payload: payload as NativeSupplyPrepare };
  }
  if (command === 'ownedSupplyStatus') {
    if (!record(payload) || !keys(payload, ['action']) ||
        (payload.action !== 'status' && payload.action !== 'export'))
      throw new Error('INVALID_OWNED_SUPPLY_STATUS_ACTION');
    return { id, command, payload: { action: payload.action } };
  }
  if (command === 'reload' || command === 'openTarget') {
    const option = command === 'reload' ? 'bootstrap' : 'refresh';
    if (!record(payload) || !(keys(payload, []) || keys(payload, [option]) && payload[option] === true))
      throw new Error('INVALID_COMMAND_PAYLOAD');
    return { id, command, payload: payload[option] === true ? { [option]: true } : {} } as DispatchCommand;
  }
  if (command === 'close-owned') {
    if (!record(payload) || !keys(payload, [])) throw new Error('INVALID_COMMAND_PAYLOAD');
    return { id, command, payload: {} };
  }
  if (command === 'close-render-preview-owned') {
    if (!record(payload) || !keys(payload, [])) throw new Error('INVALID_COMMAND_PAYLOAD');
    return { id, command, payload: {} };
  }
  if (command === 'close-live-preview-owned') {
    if (!record(payload) || !keys(payload, [])) throw new Error('INVALID_COMMAND_PAYLOAD');
    return { id, command, payload: {} };
  }
  if (command === 'close-native-supply-owned') {
    if (!record(payload) || !keys(payload, [])) throw new Error('INVALID_COMMAND_PAYLOAD');
    return { id, command, payload: {} };
  }
  throw new Error('UNKNOWN_COMMAND');
}
