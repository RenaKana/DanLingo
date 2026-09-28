import { compileUserRegexp, USER_REGEXP_WORK_LIMIT } from './user-regexp.ts';
import { createUserFilterReader } from './user-filter-reader.ts';
import type { CompiledUserRules } from './user-filters.ts';

const NATIVE_AI_JUDGE = 'function(n,r){return this.totalFiltleredDm+=1,Math.abs(n.weight)<r&&(this.aiCloudBlockCount+=1,!0)}';
const NATIVE_REPORT_FILTER = 'function(n){var r;return null!=(r=this.reportFilter)&&!!r.length&&this.reportFilter.some(function(r){if(new RegExp(r).test(n.text))return!0})}';
const NATIVE_MOBX_STATE_GETTER = 'function(){return this[ed].getObservablePropValue_(n)}';
const ORDINARY_MODES = new Set([1, 4, 5, 6]);
const MOBX_STATE_FIELDS = new Set(['status', 'dmarea', 'dmdensity', 'typeScroll', 'typeTopBottom',
  'typeColor', 'typeSpecial', 'seniorMode', 'preventshade']);
const BLOCK_MAP = {
  blockScroll: [1],
  blockTopBottom: [5, 4],
  blockColor: [2012, 2015, 2007, 2008, 2009, 2013, 2002, 2003, 2000, 2001, 2004, 5, 4, 1, 6],
  blockSpecial: [2005, 2012, 2015, 2002, 2003, 2000, 2001, 2004, 2006, 2013, 2008, 2009, 2011, 2007, 2014, 2010, 3000, 2016, 2017, 2018, 2020],
  preventShade: [4],
} as const;

type MatchState = 'retain' | 'exclude' | 'unknown';
export type BilibiliOwnedProjection = { mode: number; rawMode: number | undefined;
  color: unknown; colorfulImg: unknown };
type MatchResult = { state: MatchState; reason: string; projection?: BilibiliOwnedProjection };
type ReadValue = { known: true; value: any } | { known: false };
type ReportRule = { regex: RegExp | null; work: (length: number) => number; reason: string };

export interface BilibiliShadowNativeSettings {
  visible: boolean | null;
  noDanmakuXTypes: string[] | null;
  limit: number | null;
  sceneIsMini: boolean | null;
}

interface RuleSnapshot {
  compiled: CompiledUserRules;
  settings: {
    state: Record<string, unknown> | null;
    aiLevel: unknown;
    aiLevelKnown: boolean;
    settingVisible: unknown;
    noDanmakuXTypes: string[] | null;
    limit: number | null;
    sceneIsMini: boolean | null;
  };
  reportRules: ReportRule[] | null;
  reportReason: string | null;
  blockStore: Record<string, any> | null;
  blockMapValid: boolean;
  reason: string | null;
}

export interface BilibiliShadowRulesSnapshot {
  revision: number;
  fingerprint: string;
  known: boolean;
  reason: string | null;
  nativeSettings: BilibiliShadowNativeSettings;
  match(item: unknown): MatchResult;
  matchOwned?(item: unknown): MatchResult;
}

function objectLike(value: unknown): value is Record<string, any> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function readData(object: unknown, key: string): ReadValue {
  if (!objectLike(object)) return { known: false };
  try {
    for (let current: any = object; current; current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return 'value' in descriptor ? { known: true, value: descriptor.value } : { known: false };
    }
    return { known: true, value: undefined };
  } catch { return { known: false }; }
}

/** Read only the audited MobX observable properties on dmSettingStore.state.
 * Generic accessors remain unknown and are never invoked. */
function readNativeStateValue(state: unknown, key: string): ReadValue {
  const value = readData(state, key);
  if (value.known || !MOBX_STATE_FIELDS.has(key) || !objectLike(state)) return value;
  try {
    for (let current: any = state; current; current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) continue;
      const getter = descriptor.get;
      if (typeof getter !== 'function' || Function.prototype.toString.call(getter) !== NATIVE_MOBX_STATE_GETTER)
        return { known: false };
      return { known: true, value: Reflect.apply(getter, state, []) };
    }
    return { known: true, value: undefined };
  } catch { return { known: false }; }
}

function sameNumberArray(value: unknown, expected: readonly number[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) if (value[index] !== expected[index]) return false;
  return true;
}

function verifyBlockMap(blockStore: unknown): boolean {
  const value = readData(blockStore, 'DmBlockMap');
  if (!value.known || !objectLike(value.value)) return false;
  for (const [key, expected] of Object.entries(BLOCK_MAP)) {
    const actual = readData(value.value, key);
    if (!actual.known || !sameNumberArray(actual.value, expected)) return false;
  }
  return true;
}

function compileReportRules(blockStore: unknown): { rules: ReportRule[] | null; reason: string | null } {
  const method = readData(blockStore, 'reportFilterReg');
  if (!method.known || typeof method.value !== 'function' || Function.prototype.toString.call(method.value) !== NATIVE_REPORT_FILTER)
    return { rules: null, reason: 'report-filter-contract-unverified' };

  const list = readData(blockStore, 'reportFilter');
  if (!list.known) return { rules: null, reason: 'report-filter-data-unavailable' };
  if (list.value === undefined || list.value === null) return { rules: [], reason: null };
  if (!Array.isArray(list.value) || list.value.length > 2000)
    return { rules: null, reason: 'report-filter-data-unavailable' };
  const some = readData(list.value, 'some');
  if (!some.known || some.value !== Array.prototype.some ||
      !Function.prototype.toString.call(Array.prototype.some).includes('[native code]'))
    return { rules: null, reason: 'report-filter-array-unverified' };

  const rules: ReportRule[] = [];
  for (let index = 0; index < list.value.length; index++) {
    const entry = readData(list.value, String(index));
    if (!entry.known) return { rules: null, reason: 'report-filter-data-unavailable' };
    if (entry.value === undefined && !(index in list.value)) continue;
    if (typeof entry.value !== 'string') return { rules: null, reason: 'report-filter-data-unavailable' };
    const compiled = compileUserRegexp(entry.value, '');
    rules.push({ regex: compiled.regex, work: compiled.work, reason: compiled.reason });
  }
  return { rules, reason: null };
}

function numberValue(value: unknown): { known: boolean; value?: number } {
  if (value === undefined) return { known: true, value: Number.NaN };
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return { known: true, value: Number(value) };
  }
  return { known: false };
}

function flagValue(value: unknown): { known: boolean; value?: boolean } {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return { known: true, value: !!value };
  return { known: false };
}

/** The audited aiLevel accessor is derived from state. Reproduce it without
 * invoking the native getter, which can change or expose player state. */
function readNativeAiLevel(state: unknown): ReadValue {
  const area = readNativeStateValue(state, 'dmarea');
  if (!area.known || (area.value !== undefined && area.value !== null &&
      typeof area.value !== 'boolean' && typeof area.value !== 'number' && typeof area.value !== 'string'))
    return { known: false };
  const areaNumber = Number(area.value);
  if (areaNumber > 0 && areaNumber < 100) return { known: true, value: 3 };

  const density = readNativeStateValue(state, 'dmdensity');
  if (!density.known) return { known: false };
  if (density.value === 2 || density.value === 3) return { known: true, value: 2 };
  if (density.value === 1) return { known: true, value: 3 };
  return { known: true, value: undefined };
}

function nativeColorIsWhite(value: unknown): { known: boolean; white?: boolean } {
  if (!value) return { known: true, white: false };
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'bigint')
    return { known: false };
  try {
    const hex = (value as number).toString(16);
    const color = `#${(`00000${hex}`).slice(-6)}`.toUpperCase();
    return { known: true, white: color === '#FFFFFF' };
  } catch { return { known: false }; }
}

function opaqueFingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `shadow-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizedNativeSettings(snapshot: RuleSnapshot['settings']): BilibiliShadowNativeSettings {
  return {
    visible: typeof snapshot.settingVisible === 'boolean' ? snapshot.settingVisible : null,
    noDanmakuXTypes: snapshot.noDanmakuXTypes ? [...snapshot.noDanmakuXTypes] : null,
    limit: snapshot.limit,
    sceneIsMini: snapshot.sceneIsMini,
  };
}

function modeStackState(blockStore: unknown, state: unknown, item: unknown): { known: boolean; present?: boolean } {
  const id = readData(item, 'dmid');
  const fallback = id.known && id.value === undefined ? readData(item, 'id_str') : id;
  if (!fallback.known || typeof fallback.value !== 'string' || !/^\d+$/.test(fallback.value)) return { known: false };
  const map = readData(blockStore, 'dmMap');
  if (!map.known || !(map.value instanceof Map)) return { known: false };
  let entry: unknown;
  try {
    if (!Map.prototype.has.call(map.value, fallback.value)) return { known: true, present: false };
    entry = Map.prototype.get.call(map.value, fallback.value);
  } catch { return { known: false }; }
  // The native beforeRender hook does nothing when the map entry or its stack
  // is absent. With a populated stack, the last mode gates three history
  // branches; color history is checked for every mode.
  if (entry === undefined || entry === null) return { known: true, present: false };
  const stack = readData(entry, 'modeStack');
  if (!stack.known) return { known: false };
  if (stack.value === undefined || stack.value === null) return { known: true, present: false };
  if (!Array.isArray(stack.value)) return { known: false };
  const length = readData(stack.value, 'length');
  if (!length.known || !Number.isSafeInteger(length.value)) return { known: false };
  if (length.value === 0) return { known: true, present: false };

  const index = readData(entry, 'index');
  if (!index.known || !Number.isSafeInteger(index.value) || index.value < 0 || index.value >= length.value)
    return { known: false };
  const current = readData(stack.value, String(index.value));
  const itemMode = readData(item, 'mode'), itemRawMode = readData(item, 'rawMode');
  const stackMode = current.known ? readData(current.value, 'mode') : { known: false as const };
  const stackRawMode = current.known ? readData(current.value, 'rawMode') : { known: false as const };
  if (!itemMode.known || !itemRawMode.known || !stackMode.known || !stackRawMode.known ||
      ![itemMode.value, itemRawMode.value, stackMode.value, stackRawMode.value].every(value =>
        typeof value === 'number' && Number.isSafeInteger(value))) return { known: false };
  if (itemMode.value !== stackMode.value || itemRawMode.value !== stackRawMode.value)
    return { known: true, present: true };

  const last = readData(stack.value, String(length.value - 1));
  const lastMode = last.known ? readData(last.value, 'mode') : { known: false as const };
  if (!lastMode.known || typeof lastMode.value !== 'number' || !Number.isSafeInteger(lastMode.value) ||
      !verifyBlockMap(blockStore)) return { known: false };

  const flags = [
    ['blockColor', 'typeColor', true],
    ['blockSpecial', 'typeSpecial', true],
    ['blockTopBottom', 'typeTopBottom', true],
    ['preventShade', 'preventshade', false],
  ] as const;
  for (const [historyKey, settingKey, inverse] of flags) {
    if (historyKey !== 'blockColor' && !(BLOCK_MAP[historyKey] as readonly number[]).includes(lastMode.value)) continue;
    const history = readData(entry, historyKey), setting = readNativeStateValue(state, settingKey);
    if (!history.known || !setting.known || typeof history.value !== 'boolean' ||
        typeof setting.value !== 'boolean') return { known: false };
    if (history.value !== (inverse ? !setting.value : setting.value))
      return { known: true, present: true };
  }
  return { known: true, present: false };
}

function projectOwnedBeforeRender(blockStore: unknown, state: unknown, item: unknown):
  { known: true; item: Record<string, unknown>; projection: BilibiliOwnedProjection } |
  { known: false; reason: string } {
  const unavailable = (reason = 'mode-stack-state-unavailable') => ({ known: false as const, reason });
  if (!objectLike(item)) return unavailable('candidate-unavailable');
  const mode = readData(item, 'mode'), rawMode = readData(item, 'rawMode');
  const color = readData(item, 'color'), colorfulImg = readData(item, 'colorfulImg');
  if (!mode.known || !Number.isSafeInteger(mode.value) || !rawMode.known ||
      rawMode.value !== undefined && !Number.isSafeInteger(rawMode.value) ||
      !color.known || !colorfulImg.known) return unavailable();
  if (!ORDINARY_MODES.has(mode.value)) return unavailable('non-ordinary-mode');
  const projection: BilibiliOwnedProjection = { mode: mode.value, rawMode: rawMode.value,
    color: color.value, colorfulImg: colorfulImg.value };
  const assigned = new Set<keyof BilibiliOwnedProjection>();
  const map = readData(blockStore, 'dmMap'), id = readData(item, 'dmid');
  if (!map.known || !(map.value instanceof Map) || !id.known) return unavailable();
  let entry: unknown;
  try { entry = Map.prototype.get.call(map.value, id.value); } catch { return unavailable(); }
  if (entry !== undefined && entry !== null) {
    const stack = readData(entry, 'modeStack');
    if (!stack.known || stack.value !== undefined && stack.value !== null && !Array.isArray(stack.value))
      return unavailable();
    if (Array.isArray(stack.value)) {
      const length = readData(stack.value, 'length');
      if (!length.known || !Number.isSafeInteger(length.value)) return unavailable();
      if (length.value > 0) {
        const last = readData(stack.value, String(length.value - 1));
        const lastMode = last.known ? readData(last.value, 'mode') : { known: false as const };
        if (!lastMode.known || !Number.isSafeInteger(lastMode.value) || !verifyBlockMap(blockStore))
          return unavailable();
        let index: number | null = null;
        const move = (direction: -1 | 1, bounded: boolean): boolean => {
          if (index === null) {
            const current = readData(entry, 'index');
            if (!current.known || !Number.isSafeInteger(current.value) ||
                current.value < 0 || current.value >= length.value) return false;
            index = current.value;
          }
          const targetIndex = index! + direction;
          if (bounded && (targetIndex < 0 || targetIndex >= length.value)) return true;
          if (targetIndex < 0 || targetIndex >= length.value) return false;
          const target = readData(stack.value, String(targetIndex));
          const nextMode = target.known ? readData(target.value, 'mode') : { known: false as const };
          const nextRaw = target.known ? readData(target.value, 'rawMode') : { known: false as const };
          if (!nextMode.known || !nextRaw.known || !Number.isSafeInteger(nextMode.value) ||
              !Number.isSafeInteger(nextRaw.value)) return false;
          projection.mode = nextMode.value; projection.rawMode = nextRaw.value;
          assigned.add('mode'); assigned.add('rawMode'); index = targetIndex;
          return true;
        };
        const branch = (key: 'blockSpecial' | 'blockTopBottom' | 'preventShade',
          settingKey: 'typeSpecial' | 'typeTopBottom' | 'preventshade', inverse: boolean) => {
          if (!(BLOCK_MAP[key] as readonly number[]).includes(lastMode.value)) return { known: true as const, change: false, desired: false };
          const history = readData(entry, key), setting = readNativeStateValue(state, settingKey);
          if (!history.known || !setting.known || typeof setting.value !== 'boolean' ||
              history.value !== undefined && typeof history.value !== 'boolean') return { known: false as const };
          const desired = inverse ? !setting.value : setting.value;
          return { known: true as const, change: history.value !== desired, desired };
        };
        const special = branch('blockSpecial', 'typeSpecial', true);
        if (!special.known) return unavailable();
        if (special.change && !move(special.desired ? -1 : 1, false)) return unavailable('mode-stack-target-unavailable');
        const shade = branch('preventShade', 'preventshade', false);
        if (!shade.known) return unavailable();
        if (shade.change && !move(shade.desired ? -1 : 1, true)) return unavailable();
        const topBottom = branch('blockTopBottom', 'typeTopBottom', true);
        if (!topBottom.known) return unavailable();
        if (topBottom.change && !move(topBottom.desired ? -1 : 1, true)) return unavailable();
        const blockColor = readData(entry, 'blockColor'), typeColor = readNativeStateValue(state, 'typeColor');
        if (!blockColor.known || !typeColor.known || typeof typeColor.value !== 'boolean' ||
            blockColor.value !== undefined && typeof blockColor.value !== 'boolean') return unavailable();
        const blocked = !typeColor.value;
        if (blockColor.value !== blocked) {
          if (blocked) {
            projection.color = 0xffffff; assigned.add('color');
            if (projection.colorfulImg) { projection.colorfulImg = ''; assigned.add('colorfulImg'); }
          } else {
            const restoredColor = readData(entry, 'color'), restoredImage = readData(entry, 'colorfulImg');
            if (!restoredColor.known || !restoredImage.known) return unavailable();
            projection.color = restoredColor.value; projection.colorfulImg = restoredImage.value;
            assigned.add('color'); assigned.add('colorfulImg');
          }
        }
      }
    }
  }
  if (!ORDINARY_MODES.has(projection.mode) ||
      projection.rawMode !== undefined && !ORDINARY_MODES.has(projection.rawMode))
    return unavailable('mode-stack-nonordinary');
  if (projection.colorfulImg) return unavailable('mode-stack-nonordinary');
  try {
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of assigned) {
      const descriptor = descriptors[key];
      if (descriptor ? !('value' in descriptor) || descriptor.writable !== true :
          !Object.isExtensible(item) || key in item) return unavailable();
    }
    for (const key of ['mode', 'rawMode', 'color', 'colorfulImg'] as const) {
      const descriptor = descriptors[key];
      descriptors[key] = { configurable: true, enumerable: descriptor?.enumerable ?? true,
        writable: true, value: projection[key] };
    }
    return { known: true, item: Object.create(Object.getPrototypeOf(item), descriptors), projection };
  } catch { return unavailable(); }
}

/** Pure candidate matcher for the reviewed 1.1.24 native rule order. */
export function matchBilibiliShadowRules(item: unknown, snapshot: RuleSnapshot, afterOwnedProjection = false): MatchResult {
  const unknown = (reason: string): MatchResult => ({ state: 'unknown', reason });
  const exclude = (reason: string): MatchResult => ({ state: 'exclude', reason });
  const retain = (reason: string): MatchResult => ({ state: 'retain', reason });
  if (!objectLike(item)) return unknown('candidate-unavailable');

  const mode = readData(item, 'mode');
  if (!mode.known || typeof mode.value !== 'number' || !Number.isFinite(mode.value)) return unknown('mode-unavailable');
  if (!ORDINARY_MODES.has(mode.value)) return unknown('non-ordinary-mode');
  if (!afterOwnedProjection) {
    const stack = modeStackState(snapshot.blockStore, snapshot.settings.state, item);
    if (!stack.known) return unknown('mode-stack-state-unavailable');
    if (stack.present) return unknown('mode-stack-adjustment');
  }

  const visible = snapshot.settings.settingVisible;
  if (typeof visible !== 'boolean') return unknown('player-visibility-unavailable');
  if (!visible) return exclude('native-player-not-visible');
  const excludedTypes = snapshot.settings.noDanmakuXTypes;
  if (!excludedTypes) return unknown('native-type-exclusions-unavailable');
  if (excludedTypes.includes('common')) return exclude('native-common-type-disabled');

  const border = readData(item, 'border');
  if (!border.known) return unknown('border-unavailable');
  const borderFlag = flagValue(border.value);
  if (!borderFlag.known) return unknown('border-unavailable');
  if (borderFlag.value) return retain('native-border-exception');

  const user = snapshot.compiled.match(item);
  if (user.state === 'exclude') return exclude(`native-user-${user.category ?? 'rule'}`);
  let unresolved: string | null = user.state === 'unknown' ? `user-${user.reason}` : null;

  const aiMethod = readData(snapshot.blockStore, 'aiJudge');
  if (!aiMethod.known || typeof aiMethod.value !== 'function' || Function.prototype.toString.call(aiMethod.value) !== NATIVE_AI_JUDGE)
    return unknown('ai-rule-contract-unverified');
  const aiWeight = readData(item, 'weight'), aiLevel = numberValue(snapshot.settings.aiLevel);
  const weightNumber = aiWeight.known ? numberValue(aiWeight.value) : { known: false as const };
  if (!aiWeight.known || !snapshot.settings.aiLevelKnown || !aiLevel.known || !weightNumber.known) unresolved ??= 'weight-unavailable';
  else if (Math.abs(weightNumber.value!) < aiLevel.value!) return exclude('native-ai-weight');

  if (!snapshot.reportRules) return unknown(snapshot.reportReason ?? 'report-filter-unknown');
  const text = readData(item, 'text');
  if (!text.known || typeof text.value !== 'string') unresolved ??= 'report-text-unavailable';
  else for (const rule of snapshot.reportRules) {
    if (!rule.regex) return unknown(rule.reason === 'supported' ? 'report-regexp-unavailable' : 'report-regexp-unsupported');
    if (rule.work(text.value.length) > USER_REGEXP_WORK_LIMIT) return unknown('report-regexp-work-limit');
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text.value)) return exclude('native-report-rule');
  }

  const seniorMode = readNativeStateValue(snapshot.settings.state, 'seniorMode');
  const senior: { known: boolean; value?: boolean } = seniorMode.known ? flagValue(seniorMode.value) : { known: false };
  const seniorWeight: { known: boolean; value?: number } = aiWeight.known ? numberValue(aiWeight.value) : { known: false };
  if (!senior.known || !seniorWeight.known) unresolved ??= 'senior-weight-unavailable';
  else if (senior.value && seniorWeight.value! <= 10) return exclude('native-senior-weight');

  const typeColor = readNativeStateValue(snapshot.settings.state, 'typeColor');
  const colorful = readData(item, 'colorful');
  const colorEnabled: { known: boolean; value?: boolean } = typeColor.known ? flagValue(typeColor.value) : { known: false };
  const colorfulFlag: { known: boolean; value?: boolean } = colorful.known ? flagValue(colorful.value) : { known: false };
  if (!colorEnabled.known || !colorfulFlag.known) unresolved ??= 'color-setting-unavailable';
  else if (!colorEnabled.value && colorfulFlag.value) return exclude('native-colorful-filter');

  const dmBlockMap = readData(snapshot.blockStore, 'DmBlockMap');
  if (!dmBlockMap.known || !verifyBlockMap(snapshot.blockStore)) return unknown('native-mode-map-unverified');
  const pool = readData(item, 'pool');
  if (!pool.known) unresolved ??= 'pool-unavailable';
  const checks: [string, string, boolean][] = [
    ['typeScroll', 'blockScroll', false],
    ['typeTopBottom', 'blockTopBottom', false],
    ['typeSpecial', 'blockSpecial', pool.known && pool.value === 2],
  ];
  for (const [settingName, listName, poolBlocked] of checks) {
    const setting = readNativeStateValue(snapshot.settings.state, settingName);
    const flag: { known: boolean; value?: boolean } = setting.known ? flagValue(setting.value) : { known: false };
    const list = readData(dmBlockMap.value, listName);
    if (!flag.known || !list.known || !Array.isArray(list.value)) { unresolved ??= `${settingName}-unavailable`; continue; }
    if (!flag.value && (list.value.includes(mode.value) || (settingName === 'typeSpecial' && poolBlocked)))
      return exclude(`native-${settingName}-filter`);
  }

  if (!colorEnabled.known) unresolved ??= 'color-setting-unavailable';
  else if (!colorEnabled.value) {
    const blockColors = readData(dmBlockMap.value, 'blockColor');
    if (!blockColors.known || !Array.isArray(blockColors.value)) unresolved ??= 'color-mode-map-unavailable';
    else if (blockColors.value.includes(mode.value)) {
      const color = readData(item, 'color');
      if (!color.known) unresolved ??= 'color-unavailable';
      else {
        const normalized = nativeColorIsWhite(color.value);
        if (!normalized.known) unresolved ??= 'color-unavailable';
        else if (color.value && !normalized.white) return exclude('native-color-filter');
      }
    }
  }

  const preventShade = readNativeStateValue(snapshot.settings.state, 'preventshade');
  const preventFlag = preventShade.known ? flagValue(preventShade.value) : { known: false };
  const preventModes = readData(dmBlockMap.value, 'preventShade');
  if (!preventFlag.known || !preventModes.known || !Array.isArray(preventModes.value)) unresolved ??= 'prevent-shade-unavailable';
  else if (preventFlag.value && preventModes.value.includes(mode.value)) return exclude('native-prevent-shade');

  return unresolved ? unknown(unresolved) : retain('no-native-rule-matched');
}

export function createBilibiliShadowRules(options: {
  player: unknown; danmaku: unknown; documentScope: string; now: () => number;
  /** Strict mode may forecast unknown per-item rules; native admission still filters first. */
  allowPartialUserRules?: () => boolean;
}): { read(): BilibiliShadowRulesSnapshot } {
  const reader = createUserFilterReader({ roots: () => [options.player],
    registry: () => (globalThis as any).window?.nano, danmaku: options.danmaku,
    documentScope: options.documentScope, now: options.now });
  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 0, revision = 0, fingerprint = '';

  const idOf = (value: unknown): number => {
    if (!objectLike(value)) return 0;
    let id = objectIds.get(value);
    if (!id) { id = ++nextObjectId; objectIds.set(value, id); }
    return id;
  };

  return {
    read() {
      const userSnapshot = reader.read();
      const compiled = userSnapshot.compiled;
      const store = reader.store();
      const blockRead = readData(store, 'blockStore'), dmSettingRead = readData(store, 'dmSettingStore');
      const blockStore = blockRead.known && objectLike(blockRead.value) ? blockRead.value : null;
      const dmSetting = dmSettingRead.known && objectLike(dmSettingRead.value) ? dmSettingRead.value : null;
      const stateRead = readData(dmSetting, 'state');
      const sourceState = stateRead.known && objectLike(stateRead.value) ? stateRead.value : null;
      const state = sourceState ? Object.create(null) as Record<string, unknown> : null;
      let stateFieldsKnown = !!sourceState;
      if (sourceState && state) for (const key of MOBX_STATE_FIELDS) {
        const value = readNativeStateValue(sourceState, key);
        if (!value.known) stateFieldsKnown = false;
        else state[key] = value.value;
      }
      const aiLevel = readNativeAiLevel(state);
      const aiLevelKnown = stateFieldsKnown && aiLevel.known;
      const manager = readData(options.danmaku, 'manager');
      const config: ReadValue = manager.known ? readData(manager.value, 'config') : { known: false };
      const setting: ReadValue = config.known ? readData(config.value, 'setting') : { known: false };
      const scene: ReadValue = config.known ? readData(config.value, 'scene') : { known: false };
      const settingVisible: ReadValue = setting.known ? readData(setting.value, 'visible') : { known: false };
      const noDanmakuXTypes: ReadValue = setting.known ? readData(setting.value, 'noDanmakuXTypes') : { known: false };
      const limit: ReadValue = setting.known ? readData(setting.value, 'limit') : { known: false };
      const sceneIsMini: ReadValue = scene.known ? readData(scene.value, 'isMini') : { known: false };
      const report = compileReportRules(blockStore);
      const blockMapValid = verifyBlockMap(blockStore);
      const evidence = compiled.summary.readEvidence;
      const reasons: string[] = [];
      if (!evidence?.storeFound || !evidence.methodsMatch || !evidence.callbackMatches || !evidence.listComplete || !evidence.switchKnown)
        reasons.push('user-filter-snapshot-unverified');
      if (!options.allowPartialUserRules?.() &&
          ['keyword', 'regexp', 'sender'].some(category => !['ready', 'disabled'].includes(compiled.summary.categories[category as keyof typeof compiled.summary.categories].status)))
        reasons.push('user-filter-coverage-incomplete');
      if (!blockStore || !dmSetting || !state || !stateFieldsKnown || !aiLevel.known) reasons.push('native-settings-unavailable');
      if (!report.rules) reasons.push(report.reason ?? 'report-filter-unknown');
      if (!blockMapValid) reasons.push('native-mode-map-unverified');
      if (!setting.known || !settingVisible.known || typeof settingVisible.value !== 'boolean') reasons.push('player-visibility-unavailable');
      if (!noDanmakuXTypes.known || !Array.isArray(noDanmakuXTypes.value) || noDanmakuXTypes.value.some((value: unknown) => typeof value !== 'string'))
        reasons.push('native-type-exclusions-unavailable');

      const nativeSettings: BilibiliShadowNativeSettings = {
        visible: settingVisible.known && typeof settingVisible.value === 'boolean' ? settingVisible.value : null,
        noDanmakuXTypes: noDanmakuXTypes.known && Array.isArray(noDanmakuXTypes.value) && noDanmakuXTypes.value.every((value: unknown) => typeof value === 'string')
          ? [...noDanmakuXTypes.value] : null,
        limit: limit.known && typeof limit.value === 'number' && Number.isFinite(limit.value) ? limit.value : null,
        sceneIsMini: sceneIsMini.known && typeof sceneIsMini.value === 'boolean' ? sceneIsMini.value : null,
      };
      const settings = {
        state, aiLevel: aiLevelKnown ? aiLevel.value : undefined, aiLevelKnown,
        settingVisible: settingVisible.known ? settingVisible.value : undefined,
        noDanmakuXTypes: nativeSettings.noDanmakuXTypes,
        limit: nativeSettings.limit,
        sceneIsMini: nativeSettings.sceneIsMini,
      };
      const nextFingerprint = opaqueFingerprint({
        store: idOf(store), blockStore: idOf(blockStore), dmSetting: idOf(dmSetting), manager: idOf(manager.known ? manager.value : undefined),
        userRevision: compiled.summary.revision, userStatus: compiled.summary.enabled,
        state: state && ['status', 'dmarea', 'dmdensity', 'typeScroll', 'typeTopBottom', 'typeColor', 'typeSpecial', 'seniorMode', 'preventshade']
          .map(key => { const value = readNativeStateValue(state, key); return value.known ? value.value : 'unknown'; }),
        aiLevel: aiLevel.known ? aiLevel.value : 'unknown',
        report: report.rules?.map(rule => rule.regex?.source ?? rule.reason) ?? report.reason,
        visible: settingVisible.known ? settingVisible.value : 'unknown',
        noDanmakuXTypes: nativeSettings.noDanmakuXTypes, limit: nativeSettings.limit,
        sceneIsMini: nativeSettings.sceneIsMini, blockMapValid,
      });
      if (nextFingerprint !== fingerprint) { fingerprint = nextFingerprint; revision++; }

      const ruleSnapshot: RuleSnapshot = { compiled, settings, reportRules: report.rules, reportReason: report.reason,
        blockStore, blockMapValid, reason: reasons[0] ?? null };
      return { revision, fingerprint, known: reasons.length === 0, reason: reasons[0] ?? null,
        nativeSettings, match: item => matchBilibiliShadowRules(item, ruleSnapshot),
        matchOwned: item => {
          const projected = projectOwnedBeforeRender(blockStore, state, item);
          if (!projected.known) return { state: 'unknown', reason: projected.reason };
          return { ...matchBilibiliShadowRules(projected.item, ruleSnapshot, true), projection: projected.projection };
        } };
    },
  };
}
