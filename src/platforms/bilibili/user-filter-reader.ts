import { matchNativeRuleContract, matchesNativeRuleCallback, matchesNativeRuleMethods,
  matchesNativeRuleRegistry, type NativeRuleContract } from './native-rule-compatibility.ts';
import { compileBilibiliUserRules, type CompiledUserRules, type RawUserRule } from './user-filters.ts';

type RecordLike = Record<string, any>;
const observedMethods = new WeakMap<object, { original: Function; wrapper: Function }>();
function data(value: unknown): value is RecordLike { return !!value && typeof value === 'object'; }
function read(object: unknown, key: string): unknown {
  if (!data(object)) return undefined;
  try { return object[key]; } catch { return undefined; }
}
function method(object: unknown, name: string): unknown {
  if (!data(object)) return undefined;
  try { return object[name]; } catch { return undefined; }
}

export function verifyUserRuleContract(blockStore: unknown): boolean {
  return matchesNativeRuleMethods(name => nativeRuleMethod(blockStore, name));
}

function nativeRuleMethod(blockStore: unknown, name: string): unknown {
  const fn = method(blockStore, name);
  const observed = data(blockStore) ? observedMethods.get(blockStore) : undefined;
  return name === 'judgeWord' && observed && fn === observed.wrapper ? observed.original : fn;
}

/** Delegate one natural call exactly once; never invoke filtering proactively. */
export function observeUserRuleCalls(blockStore: unknown, receive: (source: unknown, result: unknown) => void): () => boolean {
  if (!data(blockStore) || !verifyUserRuleContract(blockStore) || observedMethods.has(blockStore)) return () => true;
  const original = method(blockStore, 'judgeWord') as Function;
  const descriptor = Object.getOwnPropertyDescriptor(blockStore, 'judgeWord');
  if (descriptor && (!('value' in descriptor) || descriptor.writable !== true)) return () => true;
  const wrapper = function(this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    try { receive(args[0], result); } catch { /* Evidence never changes native admission. */ }
    return result;
  };
  try {
    Object.defineProperty(blockStore, 'judgeWord', descriptor ? { ...descriptor, value: wrapper }
      : { configurable: true, enumerable: false, writable: true, value: wrapper });
  } catch { return () => true; }
  observedMethods.set(blockStore, { original, wrapper });
  return () => {
    try {
      const current = Object.getOwnPropertyDescriptor(blockStore, 'judgeWord');
      if (!current || !('value' in current) || current.value !== wrapper) return false;
      if (descriptor) Object.defineProperty(blockStore, 'judgeWord', descriptor);
      else if (!Reflect.deleteProperty(blockStore, 'judgeWord')) return false;
      return true;
    } catch { return false; }
    finally {
      if (observedMethods.get(blockStore)?.wrapper === wrapper) observedMethods.delete(blockStore);
    }
  };
}

/** Only accept a store that owns this very DanmakuX instance. Discovery does not
 * call arbitrary getters/functions, serialize objects, or inspect browser stores. */
export function findUserRuleStore(roots: unknown[], danmaku: unknown): RecordLike | null {
  // RootPlayer.decomposeSubStores exposes these two audited surfaces.
  for (const root of roots) for (const value of [read(root, 'rootStore'), root]) {
    if (!data(value)) continue;
    const dmStore = read(value, 'danmakuStore');
    if (data(dmStore) && read(dmStore, 'danmakuX') === danmaku &&
        data(read(value, 'blockStore')) && data(read(value, 'dmSettingStore'))) return value;
  }
  return null;
}

/** The public player API deliberately omits its RootPlayer. The current nano
 * registry exposes connected roots; inspect only the one owning this API and DM. */
export function findRegisteredUserRuleStore(api: unknown, danmaku: unknown, registry: unknown,
  getRoots: unknown = method(registry, 'valueOf')): RecordLike | null {
  if (typeof getRoots !== 'function' || !matchesNativeRuleRegistry(getRoots)) return null;
  try {
    const roots = getRoots.call(registry);
    if (!Array.isArray(roots) || roots.length > 32) return null;
    let matched: RecordLike | null = null;
    for (const root of roots) {
      if (read(root, 'api') !== api) continue;
      const store = read(root, 'rootStore');
      if (!data(store) || read(store, 'rootPlayer') !== root || findUserRuleStore([root], danmaku) !== store) continue;
      if (matched) return null;
      matched = store;
    }
    return matched;
  } catch { return null; }
}

export interface UserFilterReader {
  read(force?: boolean): { compiled: CompiledUserRules; changed: boolean; detectedAt: number };
  store(): RecordLike | null;
  contract(): NativeRuleContract | null;
}

export function createUserFilterReader(options: { roots: () => unknown[]; registry?: () => unknown; danmaku: unknown; documentScope: string; now: () => number }): UserFilterReader {
  let currentStore: RecordLike | null = null, revision = 0, nextRead = -Infinity, detectedAt = 0;
  let currentContract: NativeRuleContract | null = null;
  let fingerprint = '', compiled = compileBilibiliUserRules({ scope: options.documentScope, revision,
    verified: false, enabled: null, complete: false, rules: [] });
  let storeSequence = 0;
  let accountSequence = 0, accountIdentity = '';
  const storeIds = new WeakMap<object, number>();
  return {
    store: () => currentStore,
    contract: () => currentContract,
    read(force = false) {
      const now = options.now();
      if (!force && now < nextRead) return { compiled, changed: false, detectedAt };
      nextRead = now + 2000;
      let candidate: RecordLike | null = null;
      let registryMethod: unknown;
      try {
        const roots = options.roots();
        candidate = findUserRuleStore(roots, options.danmaku);
        if (!candidate && roots.length === 1 && options.registry) {
          const registry = options.registry();
          const getRoots = method(registry, 'valueOf');
          if (typeof getRoots === 'function') candidate = findRegisteredUserRuleStore(roots[0], options.danmaku, registry, getRoots);
          if (candidate) registryMethod = getRoots;
        }
      } catch { /* Invalidate the old snapshot below. */ }
      currentStore = candidate;
      if (candidate && !storeIds.has(candidate)) storeIds.set(candidate, ++storeSequence);
      const account = read(candidate, 'userStore');
      const accountState = read(account, 'state'), info = read(account, 'info') ?? read(account, 'userInfo');
      const accountValues = [read(account, 'mid'), read(account, 'isLogin'), read(accountState, 'mid'),
        read(accountState, 'uid'), read(accountState, 'isLogin'), read(info, 'mid')]
        .map(value => ['string', 'boolean', 'number'].includes(typeof value) ? value : null);
      const nextAccountIdentity = JSON.stringify(accountValues);
      if (accountIdentity !== nextAccountIdentity) { accountIdentity = nextAccountIdentity; accountSequence++; }
      const scope = `${options.documentScope}:store-${candidate ? storeIds.get(candidate) : 'unknown'}:account-${accountValues.every(v => v === null) ? 'unknown' : accountSequence}`;
      const block = read(candidate, 'blockStore'), setting = read(read(candidate, 'dmSettingStore'), 'state');
      let rules: RawUserRule[] = [], complete = false, enabled: boolean | null = null, verified = false;
      let methodsMatch = false, callbackMatches = false;
      try {
        const callback = read(read(read(options.danmaku, 'manager'), 'config'), 'fn');
        const filter = method(callback, 'filter');
        methodsMatch = verifyUserRuleContract(block);
        callbackMatches = matchesNativeRuleCallback(filter);
        currentContract = matchNativeRuleContract(name => nativeRuleMethod(block, name), filter, registryMethod);
        verified = !!currentContract;
        const status = read(setting, 'status');
        if (typeof status === 'boolean' || status === 0 || status === 1) enabled = !!status;
        const list = read(block, 'blockList');
        if (Array.isArray(list) && list.length <= 2000) {
          complete = true;
          for (const rule of list) {
            const type = read(rule, 'type'), filter = read(rule, 'filter'), opened = read(rule, 'opened');
            if (![0, 1, 2].includes(type as number)) continue;
            if (typeof filter !== 'string' || filter.length > 4000 || ![true, false, 0, 1].includes(opened as any)) {
              complete = false; break;
            }
            rules.push({ type: type as number, filter, opened: !!opened });
          }
        }
      } catch { currentContract = null; verified = false; complete = false; enabled = null; rules = []; }
      // Private fingerprint, never emitted: values are used solely for revision changes.
      const identity = JSON.stringify({ scope, contract: currentContract?.id ?? null,
        verified, methodsMatch, callbackMatches, enabled, complete, rules });
      if (identity === fingerprint) return { compiled, changed: false, detectedAt };
      fingerprint = identity; detectedAt = now;
      compiled = compileBilibiliUserRules({ scope, revision: ++revision, verified, enabled, complete, rules });
      compiled.summary.readEvidence = { storeFound: !!candidate, methodsMatch, callbackMatches,
        listComplete: complete, switchKnown: enabled !== null, accountScopeKnown: accountValues.some(v => v !== null) };
      return { compiled, changed: true, detectedAt };
    },
  };
}
