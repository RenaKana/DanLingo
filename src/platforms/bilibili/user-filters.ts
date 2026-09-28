import { describeUserRegexp, compileUserRegexp, USER_REGEXP_WORK_LIMIT, type UserRegexpSampleBudget } from './user-regexp.ts';
import { legacyUserRegexp } from './user-regexp-legacy.ts';
/** Read-only user-rule matching. Rule values stay in MAIN and never enter a provider payload. */
export const USER_FILTER_CONTRACT = 'bilibili-core-ba67b466-user-rules-v1';
export type UserFilterState = 'exclude' | 'retain' | 'unknown';
export type UserRuleCategory = 'keyword' | 'regexp' | 'sender' | 'account';
export type UserRuleCoverage = 'ready' | 'disabled' | 'partial' | 'unknown';
export interface UserRuleSummary {
  status: UserRuleCoverage; total: number; enabled: number; supported: number; reason?: string;
  details?: { id: string; supported: boolean; reason: string; oldReason: string; features: string[]; flags: string; nativeValid: boolean }[];
  detailsTruncated?: number; degraded?: number;
}
export interface UserFilterSummary {
  contract: string; revision: number; scope: string; enabled: boolean | null;
  compileMs?: number;
  categories: Record<UserRuleCategory, UserRuleSummary>;
  readEvidence?: { storeFound: boolean; methodsMatch: boolean; callbackMatches: boolean;
    listComplete: boolean; switchKnown: boolean; accountScopeKnown: boolean };
}
export interface RawUserRule { type: number; filter: string; opened: boolean }
export interface UserRuleInput {
  scope: string; revision: number; verified: boolean; enabled: boolean | null;
  complete: boolean; rules: RawUserRule[];
}
export interface UserFilterDecision { state: UserFilterState; reason: string; revision: number; category?: UserRuleCategory }
export interface CompiledUserRules {
  summary: UserFilterSummary;
  match(source: unknown): UserFilterDecision;
  matchLegacy(source: unknown): UserFilterDecision;
  auditText(text: string): void;
  auditSummary(): { id: string; checked: number; positive: number; negative: number; differences: number; limited: number }[];
  auditGenerated(): ReturnType<CompiledUserRules['auditSummary']>;
}

// Never invoke a candidate's accessor or coerce arbitrary native objects.
export function ownData(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object') return undefined;
  try { const d = Object.getOwnPropertyDescriptor(object, key); return d && 'value' in d ? d.value : undefined; }
  catch { return undefined; }
}
function knownValue(object: unknown, key: string): { known: boolean; value?: unknown } {
  if (!object || typeof object !== 'object') return { known: false };
  try {
    const d = Object.getOwnPropertyDescriptor(object, key);
    if (d) return 'value' in d ? { known: true, value: d.value } : { known: false };
    return key in object ? { known: false } : { known: true, value: undefined };
  } catch { return { known: false }; }
}
export function escapeUserKeyword(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Syntax admission only. Production matching also enforces the input work bound. */
export function boundedUserRegexp(pattern: string, flags: string): RegExp | null {
  return compileUserRegexp(pattern, flags).regex;
}

// Filled from the reviewed current player's rule syntax (never eval a rule).
export function parseNativeUserRegexp(value: string): { pattern: string; flags: string } {
  const slash = /^\/(.+)\/([img]{0,3})$/.exec(value);
  if (slash) {
    try { new RegExp(slash[1]!, slash[2]!); return { pattern: slash[1]!, flags: slash[2]! }; }
    catch { /* Native filterRegexp falls back to the entire unmodified string. */ }
  }
  return { pattern: value, flags: '' };
}

export function compileBilibiliUserRules(input: UserRuleInput, legacy = false): CompiledUserRules {
  const compileStarted = performance.now();
  let baseline: CompiledUserRules | undefined;
  const blank = (reason: string): UserRuleSummary => ({ status: 'unknown', total: 0, enabled: 0, supported: 0, reason });
  const categories: UserFilterSummary['categories'] = {
    keyword: blank('source-unavailable'), regexp: blank('source-unavailable'), sender: blank('source-unavailable'),
    account: blank('account-blacklist-is-not-danmaku-sender-list'),
  };
  const summary: UserFilterSummary = { contract: USER_FILTER_CONTRACT, revision: input.revision,
    scope: input.scope, enabled: input.enabled, categories };
  const checks: ({ category: 'keyword'; regex: RegExp } | { category: 'regexp'; regex: RegExp;
    work: (length: number) => number; id: string; cache: Map<string, boolean | 'unknown'>; reference: RegExp | null; samples: (budget: UserRegexpSampleBudget) => string[] }
    | { category: 'sender'; filter: string })[] = [];
  const degraded = new Set<string>();
  const audited = new Set<string>();
  const auditResults = new Map<string, { id: string; checked: number; positive: number; negative: number; differences: number; limited: number }>();
  let generatedAudit: ReturnType<CompiledUserRules['auditSummary']> | undefined;
  const verified = input.verified && input.complete && typeof input.enabled === 'boolean' && input.rules.length <= 2000;
  if (verified) {
    for (const category of ['keyword', 'regexp', 'sender'] as const)
      categories[category] = { status: input.enabled ? 'ready' : 'disabled', total: 0, enabled: 0, supported: 0 };
    for (const rule of input.rules) {
      const category = rule.type === 0 ? 'keyword' : rule.type === 1 ? 'regexp' : rule.type === 2 ? 'sender' : null;
      if (!category) continue;
      const state = categories[category]; state.total++;
      if (!rule.opened || !rule.filter) continue;
      state.enabled++;
      if (!input.enabled) continue;
      if (category === 'keyword' && rule.filter.length <= 1000) {
        checks.push({ category, regex: new RegExp(escapeUserKeyword(rule.filter), 'i') }); state.supported++;
      } else if (category === 'sender' && rule.filter.length <= 1000) {
        checks.push({ category, filter: rule.filter }); state.supported++;
      } else if (category === 'regexp') {
        const parsed = parseNativeUserRegexp(rule.filter);
        const compiled = legacy ? { regex: legacyUserRegexp(parsed.pattern, parsed.flags), work: () => 0, reason: 'legacy-subset', samples: () => [] }
          : compileUserRegexp(parsed.pattern, parsed.flags);
        const regex = compiled.regex;
        const syntax = describeUserRegexp(parsed.pattern, parsed.flags);
        state.details ??= [];
        if (state.details.length < 32) state.details.push({ id: `R${state.enabled}`, supported: !!regex,
          reason: regex ? 'supported' : !syntax.nativeValid ? 'invalid-native-regexp' : legacy ? syntax.oldReason : compiled.reason, ...syntax });
        else state.detailsTruncated = (state.detailsTruncated ?? 0) + 1;
        state.degraded = 0;
        if (regex) {
          // Independent transcription of the reviewed native parser; no native method is invoked.
          let reference: RegExp | null = null;
          const parts = /^\/(.+)\/([img]{0,3})$/.exec(rule.filter);
          try { reference = new RegExp(parts![1]!, parts![2]!); }
          catch { try { reference = new RegExp(rule.filter); } catch { /* Classified below as a discrepancy. */ } }
          checks.push({ category, regex, work: compiled.work, samples: compiled.samples, id: `R${state.enabled}`, cache: new Map(), reference }); state.supported++;
        }
        else { state.status = 'partial'; state.reason = !syntax.nativeValid ? 'invalid-native-regexp' : legacy ? syntax.oldReason : compiled.reason; }
      } else { state.status = 'partial'; state.reason = 'rule-size-limit'; }
    }
  }
  const decision = (state: UserFilterState, reason: string, category?: UserRuleCategory): UserFilterDecision =>
    ({ state, reason, revision: input.revision, ...(category ? { category } : {}) });
  summary.compileMs = performance.now() - compileStarted;
  return {
    summary,
    auditText(text) {
      if (audited.size >= 20000 || audited.has(text)) return;
      audited.add(text);
      for (const check of checks) {
        if (check.category !== 'regexp') continue;
        let counts = auditResults.get(check.id);
        if (!counts) { counts = { id: check.id, checked: 0, positive: 0, negative: 0, differences: 0, limited: 0 }; auditResults.set(check.id, counts); }
        if (check.work(text.length) > USER_REGEXP_WORK_LIMIT) { counts.limited++; continue; }
        if (!check.reference || check.reference.source !== check.regex.source || check.reference.flags !== check.regex.flags) { counts.differences++; continue; }
        check.reference.lastIndex = check.regex.lastIndex = 0;
        const expected = check.reference.test(text), actual = check.regex.test(text);
        counts.checked++; if (expected) counts.positive++; else counts.negative++;
        if (expected !== actual) counts.differences++;
      }
    },
    auditSummary() { return [...auditResults.values()].slice(0, 32).map(row => ({ ...row })); },
    auditGenerated() {
      if (!generatedAudit) {
        generatedAudit = [];
        // One bounded, cached audit per compiled snapshot, shared by all rules.
        const sampleBudget = { remaining: 100_000, limited: 0 };
        let comparisonWork = 8_000_000;
        for (const check of checks) {
          if (check.category !== 'regexp' || generatedAudit.length >= 32) continue;
          const counts = { id: check.id, checked: 0, positive: 0, negative: 0, differences: 0, limited: 0 };
          // All strings stay inside this private MAIN closure. Only the counters leave.
          const beforeLimited = sampleBudget.limited;
          const texts = new Set(['', 'a', 'A', '中', 'あ', '\n', '😀', ...check.samples(sampleBudget).flatMap(text =>
            [text, text.slice(0, -1), text.slice(1), ` ${text} `, `${text}\n`, `${text}😀`])]);
          counts.limited += sampleBudget.limited - beforeLimited;
          for (const text of [...texts, ...[...texts].reverse()]) {
            const work = check.work(text.length);
            if (work > USER_REGEXP_WORK_LIMIT || 2 * work > comparisonWork) { counts.limited++; continue; }
            comparisonWork -= 2 * work;
            if (!check.reference || check.reference.source !== check.regex.source || check.reference.flags !== check.regex.flags) { counts.differences++; continue; }
            check.reference.lastIndex = check.regex.lastIndex = 0;
            const expected = check.reference.test(text), actual = check.regex.test(text);
            counts.checked++; if (expected) counts.positive++; else counts.negative++;
            if (expected !== actual) counts.differences++;
          }
          generatedAudit.push(counts);
        }
      }
      return generatedAudit.map(row => ({ ...row }));
    },
    matchLegacy(source) {
      baseline ??= compileBilibiliUserRules(input, true);
      return baseline.match(source);
    },
    match(source) {
      if (!verified) return decision('unknown', 'rule-snapshot-unverified');
      if (!input.enabled) return decision('retain', 'native-user-rules-disabled');
      // The current native implementation allows these before judgeWord.
      for (const key of ['border', 'shooterType', 'mode']) {
        const entry = knownValue(source, key);
        if (!entry.known) return decision('unknown', 'allow-exception-unreadable');
        if (key === 'border' && entry.value || key === 'shooterType' && entry.value === 1 || key === 'mode' && entry.value === 9)
          return decision('retain', 'native-user-rule-exception');
      }
      const text = ownData(source, 'text');
      if (typeof text !== 'string' || text.length > 1000) return decision('unknown', 'original-text-unavailable');
      if (![1, 4, 5, 6].includes(ownData(source, 'mode') as number)) return decision('unknown', 'ordinary-danmaku-only');
      let senderUnknown = false, regexpUnknown = false;
      for (const check of checks) {
        if (check.category !== 'sender') {
          if (check.category === 'regexp') {
            let hit = check.cache.get(text);
            if (hit === undefined) {
              if (check.work(text.length) > USER_REGEXP_WORK_LIMIT) {
                hit = 'unknown'; degraded.add(check.id); categories.regexp.degraded = degraded.size;
                const detail = categories.regexp.details?.find(row => row.id === check.id);
                if (detail) detail.reason = 'work-limit';
              } else { check.regex.lastIndex = 0; hit = check.regex.test(text); }
              if (check.cache.size >= 4096) check.cache.delete(check.cache.keys().next().value!);
              check.cache.set(text, hit);
            }
            if (hit === 'unknown') { regexpUnknown = true; continue; }
            if (hit) return decision('exclude', 'native-regexp', 'regexp');
            continue;
          }
          check.regex.lastIndex = 0;
          if (check.regex.test(text)) return decision('exclude', `native-${check.category}`, check.category);
          continue;
        }
        const hash = knownValue(source, 'uhash'), uid = knownValue(source, 'uid');
        const value = hash.value || uid.value;
        if (!hash.known || !hash.value && !uid.known ||
            typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
          senderUnknown = true; continue;
        }
        if (check.filter === String(value)) return decision('exclude', 'native-sender', 'sender');
      }
      if (senderUnknown) return decision('unknown', 'sender-identity-unavailable');
      if (regexpUnknown) return decision('unknown', 'regexp-work-limit');
      if (Object.values(categories).some(c => c.status === 'partial')) return decision('unknown', 'rule-coverage-incomplete');
      return decision('retain', 'no-supported-rule-matched');
    },
  };
}
