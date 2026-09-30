import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_CALLBACK_CURRENT,
  USER_FILTER_NATIVE_FUNCTIONS, USER_FILTER_NATIVE_REGISTRY,
  USER_FILTER_NATIVE_FUNCTIONS_121, USER_FILTER_NATIVE_REGISTRY_121,
  USER_FILTER_NATIVE_AI_JUDGE_121, USER_FILTER_NATIVE_REPORT_FILTER_121,
  USER_FILTER_NATIVE_MOBX_GETTER_121, USER_FILTER_NATIVE_CALLBACK_121,
  USER_FILTER_NATIVE_CALLBACK_121_NEWLINE } from './user-filter-contract.ts';

// These profiles describe exact observed controller contracts. Engine bundle
// recognition is separate: a matching engine alone does not verify its rules.
const shared = {
  methods: USER_FILTER_NATIVE_FUNCTIONS,
  registry: USER_FILTER_NATIVE_REGISTRY,
  aiJudge: 'function(n,r){return this.totalFiltleredDm+=1,Math.abs(n.weight)<r&&(this.aiCloudBlockCount+=1,!0)}',
  reportFilterReg: 'function(n){var r;return null!=(r=this.reportFilter)&&!!r.length&&this.reportFilter.some(function(r){if(new RegExp(r).test(n.text))return!0})}',
  mobxStateGetter: 'function(){return this[ed].getObservablePropValue_(n)}',
  ordinaryModes: new Set([1, 4, 5, 6]),
  mobxStateFields: new Set(['status', 'dmarea', 'dmdensity', 'typeScroll', 'typeTopBottom',
    'typeColor', 'typeSpecial', 'seniorMode', 'preventshade']),
  blockMap: {
    blockScroll: [1],
    blockTopBottom: [5, 4],
    blockColor: [2012, 2015, 2007, 2008, 2009, 2013, 2002, 2003, 2000, 2001, 2004, 5, 4, 1, 6],
    blockSpecial: [2005, 2012, 2015, 2002, 2003, 2000, 2001, 2004, 2006, 2013, 2008, 2009, 2011, 2007, 2014, 2010, 3000, 2016, 2017, 2018, 2020],
    preventShade: [4],
  },
} as const;

const core121 = {
  methods: USER_FILTER_NATIVE_FUNCTIONS_121,
  registry: USER_FILTER_NATIVE_REGISTRY_121,
  aiJudge: USER_FILTER_NATIVE_AI_JUDGE_121,
  reportFilterReg: USER_FILTER_NATIVE_REPORT_FILTER_121,
  mobxStateGetter: USER_FILTER_NATIVE_MOBX_GETTER_121,
  ordinaryModes: shared.ordinaryModes,
  mobxStateFields: shared.mobxStateFields,
  blockMap: shared.blockMap,
} as const;

export const NATIVE_RULE_CONTRACTS = [
  { ...shared, id: 'core-ba67b466-original-callback', callback: USER_FILTER_NATIVE_CALLBACK },
  { ...shared, id: 'core-ba67b466-current-callback', callback: USER_FILTER_NATIVE_CALLBACK_CURRENT },
  { ...core121, id: 'core-61de1491-common-callback', callback: USER_FILTER_NATIVE_CALLBACK_121 },
  { ...core121, id: 'core-61de1491-newline-callback', callback: USER_FILTER_NATIVE_CALLBACK_121_NEWLINE },
] as const;
export type NativeRuleContract = (typeof NATIVE_RULE_CONTRACTS)[number];

function source(value: unknown): string | null {
  if (typeof value !== 'function') return null;
  try { return Function.prototype.toString.call(value); } catch { return null; }
}

export function matchesNativeRuleMethods(readMethod: (name: keyof typeof USER_FILTER_NATIVE_FUNCTIONS) => unknown): boolean {
  return NATIVE_RULE_CONTRACTS.some(contract => Object.entries(contract.methods).every(([name, expected]) =>
    source(readMethod(name as keyof typeof USER_FILTER_NATIVE_FUNCTIONS)) === expected));
}

export function matchesNativeRuleCallback(callback: unknown): boolean {
  return NATIVE_RULE_CONTRACTS.some(contract => source(callback) === contract.callback);
}

export function matchNativeRuleContract(
  readMethod: (name: keyof typeof USER_FILTER_NATIVE_FUNCTIONS) => unknown, callback: unknown,
  registry?: unknown,
): NativeRuleContract | null {
  const callbackSource = source(callback);
  return NATIVE_RULE_CONTRACTS.find(contract => callbackSource === contract.callback &&
    (registry === undefined || source(registry) === contract.registry) &&
    Object.entries(contract.methods).every(([name, expected]) =>
      source(readMethod(name as keyof typeof USER_FILTER_NATIVE_FUNCTIONS)) === expected)) ?? null;
}

export function matchesNativeRuleRegistry(value: unknown): boolean {
  return NATIVE_RULE_CONTRACTS.some(contract => source(value) === contract.registry);
}

export function matchesNativeRuleFunction(contract: NativeRuleContract,
  name: 'aiJudge' | 'reportFilterReg' | 'mobxStateGetter', value: unknown): boolean {
  return source(value) === contract[name];
}

export function matchesNativeRuleModeMap(contract: NativeRuleContract, map: unknown,
  read: (object: unknown, key: string) => { known: boolean; value?: unknown }): boolean {
  for (const [key, expected] of Object.entries(contract.blockMap)) {
    const actual = read(map, key);
    if (!actual.known || !Array.isArray(actual.value) || actual.value.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index++)
      if (actual.value[index] !== expected[index]) return false;
  }
  return true;
}
