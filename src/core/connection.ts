import type {
  ConnectionEndpointMode,
  ConnectionOverride,
  ProviderBackend,
  ProviderBrand,
  ProviderProtocol,
  ProviderProtocolSetting,
} from './types.ts';

/** A local backend never needs a network request, but keeps a stable URL-shaped identity. */
export const LOCAL_COMPLETION_ENDPOINT = 'https://danlingo.local/v1/chat/completions';

export type ConnectionPathKind = 'root' | 'versioned-base' | 'models' | 'completion' | 'custom';
export type ConnectionProtocolSource = 'auto' | 'manual';
export type ConnectionErrorCode =
  | 'invalid-address'
  | 'unsupported-address-protocol'
  | 'address-credentials'
  | 'unsafe-address-query'
  | 'https-required'
  | 'local-http-disabled'
  | 'unsupported-connection-protocol'
  | 'ambiguous-models-endpoint';

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  override readonly cause?: unknown;

  constructor(code: ConnectionErrorCode, cause?: unknown) {
    super(code);
    this.name = 'ConnectionError';
    this.code = code;
    this.cause = cause;
  }
}

export interface ConnectionInput {
  endpoint: string;
  allowLocalHttp?: boolean;
  backend?: ProviderBackend;
  protocol?: ProviderProtocolSetting;
  protocolOverride?: ProviderProtocolSetting;
  endpointMode?: ConnectionEndpointMode;
  connectionOverride?: ConnectionOverride;
}

export interface EffectiveConnection {
  /** Trimmed value before path normalization. */
  inputUrl: string;
  /** Parsed API base, when the input identifies one. */
  baseEndpoint?: string;
  /** Configured operation endpoint, before local dispatch indirection. */
  configuredCompletionEndpoint: string;
  /** Endpoint used by the online provider; local backends use LOCAL_COMPLETION_ENDPOINT. */
  completionEndpoint: string;
  /** Configured model-list endpoint, when the base path is known. */
  configuredModelsEndpoint?: string;
  /** Model-list endpoint used by the online provider. */
  modelsEndpoint?: string;
  origin: string;
  protocol: ProviderProtocol;
  protocolSource: ConnectionProtocolSource;
  brand: ProviderBrand;
  pathKind: ConnectionPathKind;
  endpointMode: ConnectionEndpointMode;
  backend: ProviderBackend;
  /** True when the custom path was preserved without claiming it is a base URL. */
  requiresManualPath: boolean;
}

const SENSITIVE_QUERY_KEY = /^(?:apikey|accesstoken|authorization|auth|key|password|passwd|secret|token)$/i;

/** RFC1918/loopback HTTP is explicit because browser permission and transport differ from HTTPS. */
export function privateHttpHost(host: string): boolean {
  const value = host.toLowerCase();
  if (value === 'localhost' || value === '127.0.0.1') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  const [a, b] = parts;
  return a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function parseUrl(value: unknown, allowLocalHttp: boolean): URL {
  if (typeof value !== 'string' || !value.trim()) throw new ConnectionError('invalid-address');
  const input = value.trim().replace(/^(https?):(?=[^/])/i, '$1://');
  let url: URL;
  try { url = new URL(input); }
  catch (error) { throw new ConnectionError('invalid-address', error); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConnectionError('unsupported-address-protocol');
  if (url.username || url.password) throw new ConnectionError('address-credentials');
  if (url.hash) throw new ConnectionError('invalid-address');
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (SENSITIVE_QUERY_KEY.test(normalizedKey)) throw new ConnectionError('unsafe-address-query');
  }
  if (url.protocol === 'http:' && !allowLocalHttp) throw new ConnectionError('https-required');
  if (url.protocol === 'http:' && !privateHttpHost(url.hostname)) throw new ConnectionError('local-http-disabled');
  return url;
}

function trimmedPath(url: URL): string {
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return path === '/' ? '' : path;
}

function withPath(url: URL, path: string): string {
  const result = new URL(url.href);
  result.pathname = path || '/';
  return result.href;
}

function appendPath(path: string, suffix: string): string {
  return `${path || ''}/${suffix}`.replace(/\/{2,}/g, '/');
}

function isVersionedBase(path: string): boolean {
  // Includes /v1, /v1beta, /v1beta/openai and arbitrary reverse-proxy prefixes.
  return /(?:^|\/)v\d+[a-z0-9]*(?:\/openai)?$/i.test(path) || /\/openai$/i.test(path);
}

function protocolFrom(input: ConnectionInput): { protocol: ProviderProtocol; source: ConnectionProtocolSource } {
  // `protocol` is the normalized effective value persisted in Settings. It is not
  // evidence that the user selected a manual override; only the override fields
  // determine the source shown in the UI.
  if (input.protocol !== undefined && input.protocol !== 'auto' && input.protocol !== 'chat-completions') throw new ConnectionError('unsupported-connection-protocol');
  const override = input.connectionOverride?.protocol ?? input.protocolOverride;
  if (override === undefined || override === 'auto') return { protocol: 'chat-completions', source: 'auto' };
  if (override === 'chat-completions') return { protocol: override, source: 'manual' };
  throw new ConnectionError('unsupported-connection-protocol');
}

function brandFrom(url: URL): ProviderBrand {
  const host = url.hostname.toLowerCase();
  if (host === 'api.minimax.cn' || host.endsWith('.minimax.cn')) return 'minimax';
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
  if (host === 'generativelanguage.googleapis.com' || host.endsWith('.googleapis.com')) return 'gemini';
  return 'unknown';
}

function pathModeFrom(input: ConnectionInput): ConnectionEndpointMode {
  return input.connectionOverride?.endpointMode ?? input.endpointMode ?? 'auto';
}

/**
 * Resolve one configured URL into the base, completion and model-list forms used by every request path.
 * Unknown custom paths are preserved as complete operation endpoints until an explicit `base` override is used.
 */
export function resolveConnection(input: ConnectionInput): EffectiveConnection {
  const url = parseUrl(input.endpoint, input.allowLocalHttp === true);
  const inputUrl = input.endpoint.trim().replace(/^(https?):(?=[^/])/i, '$1://');
  const path = trimmedPath(url);
  const protocol = protocolFrom(input);
  const endpointMode = pathModeFrom(input);
  const completionPath = path.toLowerCase().endsWith('/chat/completions') ? path : undefined;
  const modelPath = path.toLowerCase().endsWith('/models') ? path.slice(0, -'/models'.length).replace(/\/+$/, '') : undefined;
  let basePath: string | undefined;
  let configuredCompletionPath: string;
  let pathKind: ConnectionPathKind;
  let requiresManualPath = false;

  if (completionPath) {
    // A known full operation endpoint also gives us the sibling model-list path,
    // even when the caller explicitly selected completion mode.
    configuredCompletionPath = completionPath;
    basePath = path.slice(0, -'/chat/completions'.length).replace(/\/+$/, '') || undefined;
    pathKind = 'completion';
  }
  else if (endpointMode === 'completion') {
    // Explicit completion mode treats the supplied path as the complete operation.
    // An empty root therefore remains the root path instead of inventing /v1.
    configuredCompletionPath = path || '/';
    pathKind = 'completion';
  }
  else if (endpointMode === 'base' || !path) {
    basePath = endpointMode === 'base' && path ? path : path || '/v1';
    configuredCompletionPath = appendPath(basePath, 'chat/completions');
    pathKind = path ? 'versioned-base' : 'root';
  }
  else if (modelPath !== undefined) {
    basePath = modelPath || undefined;
    configuredCompletionPath = appendPath(basePath || '/v1', 'chat/completions');
    pathKind = 'models';
  }
  else if (isVersionedBase(path)) {
    basePath = path;
    configuredCompletionPath = appendPath(path, 'chat/completions');
    pathKind = 'versioned-base';
  }
  else {
    // A custom gateway may expose a nonstandard operation path. Preserve it exactly and
    // let the advanced base/completion override control discovery when needed.
    configuredCompletionPath = path;
    pathKind = 'custom';
    requiresManualPath = true;
  }

  const configuredCompletionEndpoint = withPath(url, configuredCompletionPath);
  const configuredModelsEndpoint = basePath === undefined ? undefined : withPath(url, appendPath(basePath, 'models'));
  const backend = input.backend === 'local' ? 'local' : 'online';
  const completionEndpoint = backend === 'local' ? LOCAL_COMPLETION_ENDPOINT : configuredCompletionEndpoint;
  const modelsEndpoint = backend === 'local' ? undefined : configuredModelsEndpoint;
  return {
    inputUrl,
    ...(basePath === undefined ? {} : { baseEndpoint: withPath(url, basePath) }),
    configuredCompletionEndpoint,
    completionEndpoint,
    ...(configuredModelsEndpoint === undefined ? {} : { configuredModelsEndpoint }),
    ...(modelsEndpoint === undefined ? {} : { modelsEndpoint }),
    origin: url.origin,
    protocol: protocol.protocol,
    protocolSource: protocol.source,
    brand: brandFrom(url),
    pathKind,
    endpointMode,
    backend,
    requiresManualPath,
  };
}

/** Alias used by callers that describe this operation as effective connection resolution. */
export const effectiveConnection = resolveConnection;
export const normalizeConnection = resolveConnection;

export function connectionDisplay(connection: EffectiveConnection | ConnectionInput): {
  address: string;
  protocol: ProviderProtocol;
  protocolSource: ConnectionProtocolSource;
  brand: ProviderBrand;
  status: 'recognized' | 'manual-path' | 'local';
} {
  const value = 'configuredCompletionEndpoint' in connection ? connection : resolveConnection(connection);
  return {
    address: value.completionEndpoint,
    protocol: value.protocol,
    protocolSource: value.protocolSource,
    brand: value.brand,
    status: value.backend === 'local' ? 'local' : value.requiresManualPath ? 'manual-path' : 'recognized',
  };
}

export function connectionErrorMessage(error: unknown): string {
  const code = error instanceof ConnectionError ? error.code : undefined;
  switch (code) {
    case 'invalid-address': return '服务地址无效';
    case 'unsupported-address-protocol': return '服务地址协议不受支持';
    case 'address-credentials': return '服务地址不能包含用户名或密码';
    case 'unsafe-address-query': return '服务地址查询参数不能包含凭据';
    case 'https-required': return '请使用 HTTPS；本机或私有 IPv4 局域网 HTTP 服务需单独启用';
    case 'local-http-disabled': return 'HTTP 服务仅允许本机或私有 IPv4 地址，并需显式启用';
    case 'unsupported-connection-protocol': return '请求协议覆盖不受支持';
    case 'ambiguous-models-endpoint': return '自定义服务路径无法自动推导模型列表地址，请使用完整接口或高级路径覆盖';
    default: return error instanceof Error ? error.message : '服务地址无效';
  }
}

export function modelsEndpointFromConnection(connection: EffectiveConnection | ConnectionInput): string {
  const value = 'configuredCompletionEndpoint' in connection ? connection : resolveConnection(connection);
  if (!value.modelsEndpoint) throw new ConnectionError('ambiguous-models-endpoint');
  return value.modelsEndpoint;
}
