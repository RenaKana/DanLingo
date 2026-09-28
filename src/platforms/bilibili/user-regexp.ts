/** Syntax metadata only. Never return literal text or a stable rule fingerprint. */
export function describeUserRegexp(pattern: string, flags: string) {
  const features = new Set<string>();
  let oldReason = '', inClass = false;
  if (pattern.length > 256) oldReason = 'pattern-size-limit';
  if (!/^[img]*$/.test(flags) || new Set(flags).size !== flags.length) oldReason ||= 'unsupported-flags';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[++i];
      if (next && /[1-9k]/.test(next)) { features.add('backreference'); oldReason ||= 'backreference'; }
      else if (!next || /[pPuUc]/.test(next)) { features.add('extended-escape'); oldReason ||= 'unsupported-escape'; }
      else features.add('escape');
      continue;
    }
    if (c === '[' && !inClass) { inClass = true; features.add('character-class'); continue; }
    if (c === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (c === '(') { features.add(pattern[i + 1] === '?' && pattern[i + 2] !== ':' ? 'lookaround' : 'group'); oldReason ||= 'group'; }
    else if (c === '|') { features.add('alternation'); oldReason ||= 'alternation'; }
    else if ('*+?{}'.includes(c) && pattern[i - 1] !== '(') {
      features.add('quantifier'); oldReason ||= 'quantifier';
      if (c === '*' || c === '+') features.add('unbounded-quantifier');
      if (c === '{') features.add('bounded-quantifier');
      if (pattern[i - 1] === ')') features.add('repeated-group');
    }
    else if (c === '^' || c === '$') features.add('anchor');
    else if (c === '.') features.add('wildcard');
  }
  let nativeValid = true;
  try { new RegExp(pattern, flags); } catch { nativeValid = false; oldReason = 'invalid-native-regexp'; }
  return { nativeValid, oldReason: oldReason || 'supported', features: [...features], flags };
}

export const USER_REGEXP_WORK_LIMIT = 500_000;
export type UserRegexpSampleBudget = { remaining: number; limited: number };
type Samples = (budget: UserRegexpSampleBudget) => string[];
const spendSampleWork = (budget: UserRegexpSampleBudget, work: number) => {
  if (work > budget.remaining) { budget.limited++; return false; }
  budget.remaining -= work; return true;
};
type Shape = { nodes: number; width: number; paths: number; repeats: number; assertion: boolean;
  choices: (length: number) => number; samples: Samples };
const cap = (value: number) => Math.min(USER_REGEXP_WORK_LIMIT + 1, value);
const sampleLimit = (texts: string[]) => [...new Set(texts.filter(text => text.length <= 1000))].slice(0, 16);
const memoSamples = (create: Samples): Samples => {
  let value: string[] | undefined;
  return budget => value ??= spendSampleWork(budget, 1) ? create(budget) : [];
};
const add = (a: Shape, b: Shape): Shape => ({ nodes: a.nodes + b.nodes, width: a.width + b.width,
  paths: a.paths * b.paths, repeats: a.repeats + b.repeats, assertion: a.assertion || b.assertion,
  choices: length => cap(a.choices(length) * b.choices(length)),
  samples: memoSamples(budget => {
    const lefts = a.samples(budget), rights = b.samples(budget), texts: string[] = [];
    for (const left of lefts) for (const right of rights) {
      if (!spendSampleWork(budget, left.length + right.length + 1)) return sampleLimit(texts);
      if (left.length + right.length <= 1000) texts.push(left + right);
    }
    return sampleLimit(texts);
  }) });
const atom = (assertion = false, samples: Samples = () => ['']): Shape =>
  ({ nodes: 1, width: assertion ? 0 : 1, paths: 1, repeats: 0, assertion, choices: () => 1, samples });

/** A cost parser, not a matcher. The admitted pattern is executed unchanged by
 * JavaScript. Repetition bodies must have a fixed, nonempty width and no choice
 * or assertion. This excludes nested/ambiguous repetition before it can run.
 *
 * With n UTF-16 units, a non-nested repeat has at most n+1 continuation choices.
 * Product of choices * expanded atoms * (n+1 start positions) bounds traversal
 * of this restricted backtracking tree (with a conservative constant factor).
 * The estimate is a work bound, not a wall-clock timeout or engine benchmark. */
export function compileUserRegexp(pattern: string, flags: string): {
  regex: RegExp | null; reason: string; work: (length: number) => number; samples: Samples;
} {
  const reject = (reason: string) => ({ regex: null, reason, work: () => Infinity, samples: () => [] });
  if (pattern.length > 1024) return reject('pattern-size-limit');
  if (!/^[img]*$/.test(flags) || new Set(flags).size !== flags.length) return reject('unsupported-flags');
  let pos = 0, tokens = 0;
  const fail = (reason: string): never => { throw reason; };
  // Used only by the opt-in local semantic audit, never normal matching. The
  // Seed from the atom's own literals/escape endpoints, then bounded byte values.
  // Never enumerate the full UTF-16 space or exceed the whole-audit budget.
  function atomSamples(source: string): Samples {
    let cached: string[] | undefined;
    return budget => {
      if (cached) return cached;
      const reference = new RegExp(`^(?:${source})$`, flags.replace('g', ''));
      const seeds = ['a', 'A', '0', ' ', '\n', '中', 'あ', ...source];
      for (const match of source.matchAll(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|c([a-z]))/gi))
        seeds.push(String.fromCharCode(match[3] ? match[3].toUpperCase().charCodeAt(0) % 32 : parseInt(match[1] ?? match[2]!, 16)));
      for (let point = 0; point < 256; point++) seeds.push(String.fromCharCode(point));
      for (const text of new Set(seeds)) {
        if (!spendSampleWork(budget, source.length + 1)) return cached = [];
        if (reference.test(text)) return cached = [text];
      }
      return cached = [];
    };
  }
  function escape(): boolean {
    const c = pattern[pos++];
    if (!c) return fail('unsupported-escape');
    if (/[1-9k]/.test(c)) return fail('backreference');
    if (/[pP]/.test(c)) return fail('unsupported-escape');
    if (c === '0' && /[0-9]/.test(pattern[pos] ?? '')) return fail('unsupported-escape');
    if (c === 'u' || c === 'x') {
      const size = c === 'u' ? 4 : 2, digits = pattern.slice(pos, pos + size);
      if (digits.length !== size || !/^[0-9a-f]+$/i.test(digits)) return fail('unsupported-escape');
      pos += size;
    } else if (c === 'c') {
      if (!/^[a-z]$/i.test(pattern[pos] ?? '')) return fail('unsupported-escape');
      pos++;
    }
    return c === 'b' || c === 'B';
  }
  function sequence(depth: number): Shape {
    let result: Shape = { ...atom(), nodes: 0, width: 0 };
    while (pos < pattern.length && pattern[pos] !== ')' && pattern[pos] !== '|') {
      if (++tokens > 256) fail('syntax-complexity-limit');
      const atomStart = pos, c = pattern[pos++];
      let value: Shape;
      if (c === '(') {
        if (depth >= 8) fail('group-depth-limit');
        if (pattern[pos] === '?') {
          if (pattern[pos + 1] !== ':') fail('lookaround-or-named-group');
          pos += 2;
        }
        value = expression(depth + 1);
        if (pattern[pos++] !== ')') fail('invalid-native-regexp');
        value = { ...value, nodes: value.nodes + 2 };
      } else if (c === '[') {
        while (pos < pattern.length && pattern[pos] !== ']') {
          if (pattern[pos++] === '\\') escape();
        }
        if (pattern[pos++] !== ']') fail('unsupported-character-class');
        value = atom(false, atomSamples(pattern.slice(atomStart, pos)));
      } else if (c === '\\') {
        const assertion = escape();
        value = atom(assertion, assertion ? () => [''] : atomSamples(pattern.slice(atomStart, pos)));
      }
      else if (c === '^' || c === '$') value = atom(true);
      else if (c && '*+?{}'.includes(c)) return fail('unsupported-quantifier-syntax');
      else value = atom(false, c === '.' ? () => ['a'] : () => [c!]);
      let min: number | undefined, max = 0;
      const q = pattern[pos];
      if (q === '*' || q === '+' || q === '?') {
        pos++; min = q === '+' ? 1 : 0; max = q === '?' ? 1 : Infinity;
      } else if (q === '{') {
        const match = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(pos));
        if (!match) return fail('unsupported-quantifier-syntax');
        pos += match[0].length; min = Number(match[1]);
        max = match[2] === undefined ? min : match[2] === '' ? Infinity : Number(match[2]);
        if (!Number.isSafeInteger(min) || min > 1024 || max !== Infinity && (!Number.isSafeInteger(max) || max > 1024)) fail('repetition-size-limit');
      }
      if (min !== undefined) {
        const body = value, minimum = min, maximum = max;
        const samples = memoSamples(budget => {
          const texts: string[] = [];
          for (const text of body.samples(budget)) for (const count of [minimum, ...(maximum > minimum ? [minimum + 1] : [])]) {
            if (text.length * count > 1000) continue;
            if (!spendSampleWork(budget, text.length * count + 1)) return sampleLimit(texts);
            texts.push(text.repeat(count));
          }
          return sampleLimit(texts);
        });
        if (pattern[pos] === '?') pos++; // Greedy/lazy order does not change this Boolean bound.
        if (!value.width || value.assertion) fail('zero-width-repetition');
        if (value.repeats) fail('nested-variable-repetition');
        if (value.paths !== 1) fail('ambiguous-repeated-group');
        if (min === max) {
          if (max > 1024 || value.nodes * max > 2048) fail('repetition-size-limit');
          value = { ...value, nodes: Math.max(1, value.nodes * max), width: value.width * max, samples };
        } else { const limit = max; value = { ...value, width: value.width * min, repeats: 1, choices: length => Math.min(limit, length) + 1, samples }; }
      }
      result = add(result, value);
      if (result.nodes > 2048 || result.paths > 64 || result.repeats > 4) fail('syntax-complexity-limit');
    }
    return result;
  }
  function expression(depth: number): Shape {
    const branches = [sequence(depth)];
    while (pattern[pos] === '|') { pos++; branches.push(sequence(depth)); }
    if (branches.length === 1) return branches[0]!;
    const result = branches.reduce((a, b) => ({ nodes: a.nodes + b.nodes, width: Math.min(a.width, b.width),
      paths: a.paths + b.paths, repeats: Math.max(a.repeats, b.repeats), assertion: a.assertion || b.assertion,
      choices: (length: number) => cap(a.choices(length) + b.choices(length)), samples: memoSamples(budget => sampleLimit([...a.samples(budget), ...b.samples(budget)])) }));
    if (result.nodes > 2048 || result.paths > 64 || result.repeats > 4) fail('syntax-complexity-limit');
    return result;
  }
  try {
    const shape = expression(0);
    if (pos !== pattern.length) return reject('invalid-native-regexp');
    let regex: RegExp;
    try { regex = new RegExp(pattern, flags); } catch { return reject('invalid-native-regexp'); }
    return { regex, reason: 'supported', samples: shape.samples, work(length) {
      if (!Number.isSafeInteger(length) || length < 0 || length > 1000) return Infinity;
      return cap(4 * Math.max(1, shape.nodes) * shape.choices(length) * (length + 1));
    } };
  } catch (reason) { return reject(typeof reason === 'string' ? reason : 'syntax-unavailable'); }
}
