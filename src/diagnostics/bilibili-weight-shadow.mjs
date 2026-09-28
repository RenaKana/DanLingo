// Session-only diagnostic. No native filter, setting getter or provider is invoked here.
export const WEIGHT_RULE_VERSION = 'bilibili-1.1.22-core.5966babe-weight-ai3';
export const WEIGHT_CONTRACT_SHA256 = '4be11d9872943f00f7ca6738861998347858eb715eca55795a5f6e3fd4e476e5';

const VERSION = '1.1.22';
const COMPILED = '2026-07-14T14:26:03+08:00';
const CORE_URL = 'https://s1.hdslb.com/bfs/static/player/main/core.5966babe.js';
const AREA_SELECTOR = '.bpx-player-dm-setting-left-area .bui-area';
const ORDINARY_MODES = new Set([1, 4, 5, 6]);
export const WEIGHT_DEPENDENCY_FIELDS = Object.freeze([
  'manager', 'danmaku', 'video', 'config', 'fn', 'hooks', 'setting', 'managerPrototype',
  'filter', 'validate', 'insert', 'beforeRender', 'metadataMethod', 'areaNode',
  'root', 'area', 'limit', 'domArea', 'version', 'lastCompiled', 'coreScript',
]);
export const WEIGHT_BOUNDARY_FIELDS = Object.freeze(['activeInsert', 'activeValidate']);

function ownValue(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function nativeFunctions(binding) {
  const manager = ownValue(binding, 'manager'), danmaku = ownValue(binding, 'danmaku');
  const config = ownValue(manager, 'config'), fn = ownValue(config, 'fn');
  const hooks = ownValue(danmaku, 'hooks'), prototype = manager && Object.getPrototypeOf(manager);
  const functions = {
    filter: ownValue(fn, 'filter'),
    validate: ownValue(prototype, 'validate'),
    insert: ownValue(prototype, 'insert'),
    beforeRender: ownValue(hooks, 'beforeRender'),
  };
  return { manager, danmaku, config, fn, hooks, prototype, functions };
}

/** Source order is fixed by the real Chrome native-branches export. */
export function nativeWeightContract(binding) {
  try {
    const { functions } = nativeFunctions(binding);
    if (Object.values(functions).some(value => typeof value !== 'function'))
      return { valid: false, reason: 'native-functions-missing', functions: null, sources: null };
    const sources = ['filter', 'validate', 'insert', 'beforeRender']
      .map(key => Function.prototype.toString.call(functions[key]));
    return { valid: true, reason: null, functions, sources };
  } catch {
    return { valid: false, reason: 'native-functions-unavailable', functions: null, sources: null };
  }
}

/** Await once before shadow recording; re-read dependencies after awaiting. */
export async function verifyNativeWeightContract(contract) {
  if (!contract?.valid || !Array.isArray(contract.sources) || contract.sources.length !== 4 ||
      contract.sources.some(source => typeof source !== 'string'))
    return { verified: false, sha256: null, reason: 'native-contract-unavailable' };
  if (!globalThis.crypto?.subtle) return { verified: false, sha256: null, reason: 'webcrypto-unavailable' };
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(contract.sources));
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { verified: sha256 === WEIGHT_CONTRACT_SHA256, sha256,
      reason: sha256 === WEIGHT_CONTRACT_SHA256 ? null : 'native-contract-mismatch' };
  } catch {
    return { verified: false, sha256: null, reason: 'native-contract-digest-failed' };
  }
}

/** Only own native data descriptors are inspected; the opaque tuple stays in MAIN memory. */
export function readWeightDependencies(binding, root) {
  const unknown = reason => ({ valid: false, reason, area: null, domArea: null,
    dependencyFingerprint: null, boundaryFingerprint: null });
  try {
    const { manager, danmaku, config, fn, hooks, prototype, functions } = nativeFunctions(binding);
    const video = ownValue(binding, 'video');
    if (!manager || !danmaku || !video || !config || !fn || !hooks ||
        Object.values(functions).some(value => typeof value !== 'function')) return unknown('native-dependency-missing');
    const setting = ownValue(config, 'setting');
    const area = ownValue(setting, 'area');
    if (!Number.isFinite(area) || area !== 25) return unknown('native-area-not-25');

    let owner = danmaku, metadataMethod;
    for (let depth = 0; owner && depth < 3; depth++, owner = Object.getPrototypeOf(owner)) {
      metadataMethod = ownValue(owner, 'getMetadata');
      if (metadataMethod !== undefined) break;
    }
    if (typeof metadataMethod !== 'function') return unknown('native-metadata-unavailable');
    const metadata = metadataMethod.call(danmaku);
    const version = ownValue(metadata, 'version'), lastCompiled = ownValue(metadata, 'lastCompiled');
    if (version !== VERSION || lastCompiled !== COMPILED) return unknown('native-build-mismatch');

    if (!root?.isConnected || typeof root.contains !== 'function' || !root.contains(video) ||
        !root.classList?.contains('bpx-player-container') || typeof root.querySelectorAll !== 'function')
      return unknown('player-root-unavailable');
    const areaNodes = root.querySelectorAll(AREA_SELECTOR);
    if (areaNodes.length !== 1 || areaNodes[0].isConnected !== true)
      return unknown('native-area-dom-unavailable');
    const areaNode = areaNodes[0], domArea = areaNode.textContent?.trim();
    if (domArea !== '25%') return unknown('native-area-dom-not-25');

    const scripts = root.ownerDocument?.scripts;
    if (!scripts) return unknown('native-core-script-unavailable');
    const coreScripts = [...scripts].map(script => script.src)
      .filter(src => typeof src === 'string' && /\/player\/main\/core\.[^/]+\.js(?:[?#]|$)/.test(src));
    if (coreScripts.length !== 1 || coreScripts[0] !== CORE_URL) return unknown('native-core-script-mismatch');

    const dependencyFingerprint = Object.freeze([manager, danmaku, video, config, fn, hooks,
      setting, prototype, functions.filter, functions.validate, functions.insert,
      functions.beforeRender, metadataMethod, areaNode, root, area, ownValue(setting, 'limit'),
      domArea, version, lastCompiled, coreScripts[0]]);
    const boundaryFingerprint = Object.freeze([ownValue(manager, 'insert'), ownValue(manager, 'validate')]);
    return { valid: true, reason: null, area, domArea, dependencyFingerprint, boundaryFingerprint };
  } catch {
    return unknown('native-dependency-read-failed');
  }
}

function sameDependencies(baseline, current) {
  const first = baseline?.dependencyFingerprint, second = current?.dependencyFingerprint;
  return baseline?.valid === true && current?.valid === true && Array.isArray(first) &&
    Array.isArray(second) && first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameBoundary(expected, current) {
  const actual = current?.boundaryFingerprint;
  return Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length &&
    expected.every((value, index) => value === actual[index]);
}

/** Retain means only that this single sufficient rejection rule did not match. */
export function decideWeightShadow(input, context) {
  const result = (decision, reason) => ({ decision, reason, ruleVersion: WEIGHT_RULE_VERSION });
  if (context?.contract?.verified !== true || context.contract.sha256 !== WEIGHT_CONTRACT_SHA256)
    return result('unknown', 'native-contract-unverified');
  if (!sameDependencies(context.baseline, context.current)) return result('unknown', 'dependencies-changed');
  if (!sameBoundary(context.boundaryBaseline ?? context.baseline?.boundaryFingerprint, context.current))
    return result('unknown', 'native-boundary-changed');
  if (!ORDINARY_MODES.has(input?.mode)) return result('unknown', 'non-ordinary-mode');
  const ownBooleanBorder = input.borderKind === 'boolean' && typeof input.borderTruthy === 'boolean';
  const absentBorder = input.borderKind === 'missing' && input.borderTruthy === false;
  if (!ownBooleanBorder && !absentBorder)
    return result('unknown', 'border-unavailable');
  if (input.borderTruthy === true) return result('retain', 'border-exception');
  if (input.weightKind !== 'number' || typeof input.weight !== 'number' || !Number.isFinite(input.weight))
    return result('unknown', 'weight-unavailable');
  return Math.abs(input.weight) < 3
    ? result('exclude', 'native-weight-below-ai-level')
    : result('retain', 'weight-not-below-ai-level');
}
