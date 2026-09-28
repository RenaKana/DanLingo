// Diagnostic evidence only. Never invoke native filtering, config getters or constructors.
const METHODS = ['insert', 'validate', 'initRender'];
const NUMERIC_SETTINGS = ['aiLevel', 'dmarea', 'dmdensity', 'density', 'area', 'dmArea', 'maxNumber', 'limit'];

function ownValue(object, key) {
  if (!object || !['object', 'function'].includes(typeof object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Preserve missing/non-numeric weight as unknown; do not coerce or mutate native input. */
export function nativeRuleInputs(source) {
  const weight = ownValue(source, 'weight'), mode = ownValue(source, 'mode');
  const describe = key => {
    const descriptor = source && Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) return 'value' in descriptor ? typeof descriptor.value : 'accessor';
    return source && key in Object(source) ? 'inherited' : 'missing';
  };
  const truthy = key => ['accessor', 'inherited'].includes(describe(key)) ? null : !!ownValue(source, key);
  return {
    weight: typeof weight === 'number' && Number.isFinite(weight) ? weight : null,
    weightKind: describe('weight'),
    borderTruthy: truthy('border'),
    borderKind: describe('border'),
    onTruthy: truthy('on'),
    onKind: describe('on'),
    mode: typeof mode === 'number' && Number.isFinite(mode) ? mode : null,
  };
}

function functionText(value) {
  if (typeof value !== 'function') return null;
  const source = Function.prototype.toString.call(value), limit = 20000;
  return { source: source.slice(0, limit), length: source.length, truncated: source.length > limit };
}

function settingSurface(object) {
  if (!object || typeof object !== 'object') return null;
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const values = {};
  for (const key of NUMERIC_SETTINGS) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    const value = 'value' in descriptor ? descriptor.value : undefined;
    values[key] = typeof value === 'number' && Number.isFinite(value)
      ? { value, kind: 'number' } : { value: null, kind: 'value' in descriptor ? typeof value : 'accessor-not-invoked' };
  }
  const hooks = ownValue(object, 'hooks');
  const fn = ownValue(object, 'fn');
  return { keys: Object.keys(descriptors).slice(0, 100), values,
    filter: functionText(ownValue(object, 'filter')),
    fnFilter: functionText(ownValue(fn, 'filter')),
    beforeRender: functionText(ownValue(hooks, 'beforeRender')) };
}

/** Small named surface, not a serialization of the player/store or user block rules. */
export function inspectNativeBranches(binding) {
  const methods = [];
  let owner = binding.manager;
  for (let depth = 0; owner && depth < 3; depth++, owner = Object.getPrototypeOf(owner)) {
    for (const name of METHODS) {
      const text = functionText(ownValue(owner, name));
      if (text) methods.push({ owner: depth === 0 ? 'manager-own' : `manager-prototype-${depth}`, name, ...text });
    }
  }
  return {
    evidence: 'READ_ONLY_FUNCTION_SOURCE_AND_ALLOWLISTED_DATA_DESCRIPTORS',
    nativeFunctionsInvoked: 0, gettersInvoked: 0,
    managerKeys: Object.getOwnPropertyNames(binding.manager).slice(0, 100),
    danmakuKeys: Object.getOwnPropertyNames(binding.danmaku).slice(0, 100),
    methods,
    surfaces: {
      managerConfig: settingSurface(ownValue(binding.manager, 'config')),
      managerConfigSetting: settingSurface(ownValue(ownValue(binding.manager, 'config'), 'setting')),
      managerOptions: settingSurface(ownValue(binding.manager, 'options')),
      managerSetting: settingSurface(ownValue(binding.manager, 'setting')),
      managerFn: settingSurface(ownValue(binding.manager, 'fn')),
      danmakuConfig: settingSurface(ownValue(binding.danmaku, 'config')),
      danmakuConfigSetting: settingSurface(ownValue(ownValue(binding.danmaku, 'config'), 'setting')),
      danmakuOptions: settingSurface(ownValue(binding.danmaku, 'options')),
      danmakuSetting: settingSurface(ownValue(binding.danmaku, 'setting')),
      danmakuFn: settingSurface(ownValue(binding.danmaku, 'fn')),
    },
    beforeRender: functionText(ownValue(ownValue(binding.danmaku, 'hooks'), 'beforeRender')),
    limits: 'Function source may be an existing wrapper. Accessors and closure state are not evaluated. No prediction or exclusion is made.',
  };
}
