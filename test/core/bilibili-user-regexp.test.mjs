import test from 'node:test';
import assert from 'node:assert/strict';
import { describeUserRegexp, compileUserRegexp, USER_REGEXP_WORK_LIMIT } from '../../src/platforms/bilibili/user-regexp.ts';
import { compileBilibiliUserRules, parseNativeUserRegexp } from '../../src/platforms/bilibili/user-filters.ts';
import { parseUserFilterSummary } from '../../src/platforms/bilibili/user-filter-wire.ts';
import { BilibiliUserFilterSession } from '../../src/platforms/bilibili/user-filter-session.ts';
import { SOURCE_CHUNK_BYTES } from '../../src/core/source-stream.ts';

test('syntax report identifies unsupported nodes without retaining rule literals', () => {
  const text = 'private-synthetic-literal';
  const cases = [[`${text}|other`, 'alternation'], [`(${text})`, 'group'], [`${text}+`, 'quantifier'], ['[', 'invalid-native-regexp'], ['x'.repeat(257), 'pattern-size-limit']];
  for (const [pattern, reason] of cases) {
    const report = describeUserRegexp(pattern, '');
    assert.equal(report.oldReason, reason);
    assert.ok(!JSON.stringify(report).includes(text));
  }
});

test('wire keeps only bounded syntax summaries and drops unapproved rule fields', () => {
  const compiled = compileBilibiliUserRules({ scope: 'fixture', revision: 1, complete: true, verified: true, enabled: true,
    rules: [{ type: 1, opened: true, filter: 'private-literal|other' }] });
  const value = { ...compiled.summary, featureEnabled: true, secret: 'hidden',
    categories: structuredClone(compiled.summary.categories) };
  value.categories.regexp.details[0].pattern = 'private-literal|other';
  const wire = parseUserFilterSummary(value);
  assert.equal(wire.categories.regexp.details[0].oldReason, 'alternation');
  assert.ok(!JSON.stringify(wire).includes('private-literal'));
  value.categories.regexp.details = Array(33).fill(value.categories.regexp.details[0]);
  assert.equal(parseUserFilterSummary(value), null);
});

test('rule transactions split multibyte long texts within the unchanged receiver limit', () => {
  const emitted = [];
  const session = new BilibiliUserFilterSession({ player: {}, danmaku: {}, documentScope: 'fixture', now: () => 0,
    emit: value => emitted.push(value) });
  const rows = Array.from({ length: 500 }, (_, index) => ({ id: `event-${index}`, sourceId: String(index), originalText: '中'.repeat(1000) }));
  session.refresh(rows, []);
  assert.ok(emitted.length > 3);
  assert.equal(emitted.flatMap(value => value.items).length, 500);
  for (const [index, value] of emitted.entries()) {
    assert.equal(value.index, index);
    assert.equal(value.complete, index === emitted.length - 1);
    assert.ok(new TextEncoder().encode(JSON.stringify(value)).length + 1000 < SOURCE_CHUNK_BYTES);
  }
  session.stop();
});

const compiled = rules => compileBilibiliUserRules({ scope: 'fixture', revision: 1, complete: true, verified: true, enabled: true,
  rules: rules.map(filter => ({ type: 1, opened: true, filter })) });

test('deidentified real syntax families preserve native booleans, flags, empty matches and order', () => {
  // Syntax families observed in R1-R6, with synthetic literals; these are not the user's rules.
  const patterns = ['甲{2,4}|乙{3,}', '.*ALPHA|\\d+$', '草+', '.*alpha.*|beta+',
    '^([甲乙]+|word\\s*)$', '^(ab)+$', '/^(A+|中{2,})$/img', '/^x$/m', '/a/u', '/a/ii', '//g', 'a*', '(?:ab)?c'];
  const texts = ['', '甲', '甲甲', '甲甲甲甲甲', '乙乙乙', 'word ', 'word\n', '中中', 'AA', 'aa',
    'alpha', 'zalpha!', '123', 'x\nx', 'axb', '草草', '草!', 'abab', 'aba', 'abc', 'c', '/a/u', '/a/ii', '//g', '😀中'];
  for (const pattern of patterns) {
    const matcher = compiled([pattern]);
    assert.equal(matcher.summary.categories.regexp.supported, 1, pattern);
    const parsed = parseNativeUserRegexp(pattern), native = new RegExp(parsed.pattern, parsed.flags);
    for (const text of [...texts, ...texts.toReversed()]) {
      native.lastIndex = 0;
      const result = matcher.match({ text, mode: 1 });
      assert.notEqual(result.state, 'unknown', `${pattern}: synthetic short input should fit work bound`);
      assert.equal(result.state === 'exclude', native.test(text), pattern);
      matcher.auditText(text);
    }
    assert.equal(matcher.auditSummary()[0].differences, 0);
    const generated = matcher.auditGenerated()[0];
    assert.ok(generated.positive > 0, `private local witness exists for ${pattern}`);
    assert.equal(generated.differences, 0);
  }
});

test('nested repetition, repeated choices, assertions and huge counts are never executed', () => {
  for (const [pattern, reason] of [['(a+)+$', 'nested-variable-repetition'], ['(a|aa)+$', 'ambiguous-repeated-group'],
    ['(?=a)a', 'lookaround-or-named-group'], ['(a)\\1', 'backreference'], ['a{999999999}', 'repetition-size-limit'],
    ['(?:^a)+', 'zero-width-repetition']]) {
    const result = compileUserRegexp(pattern, '');
    assert.equal(result.regex, null, pattern);
    assert.equal(result.reason, reason, pattern);
    assert.equal(compiled([pattern]).match({ text: 'a'.repeat(1000), mode: 1 }).state, 'unknown');
  }
});

test('private fixture generation has shared work limits and preserves high Unicode witnesses', () => {
  const sparse = compileUserRegexp('^[\\uFFFE-\\uFFFF]$', '');
  const budget = { remaining: 1000, limited: 0 };
  const samples = sparse.samples(budget);
  assert.ok(samples.some(text => sparse.regex.test(text)));
  assert.ok(budget.remaining >= 0);
  const empty = compileUserRegexp('[^\\s\\S]'.repeat(100), '');
  const tiny = { remaining: 10, limited: 0 };
  assert.deepEqual(empty.samples(tiny), []);
  assert.ok(tiny.limited > 0);
  assert.ok(tiny.remaining >= 0);
  const matcher = compiled(Array(32).fill('^a{100}$'));
  const audit = matcher.auditGenerated();
  assert.equal(audit.length, 32);
  assert.ok(audit.some(row => row.positive > 0));
  assert.ok(audit.some(row => row.limited > 0), 'comparison work is capped across rules');
  assert.ok(audit.every(row => row.differences === 0));
  assert.deepEqual(matcher.auditGenerated(), audit, 'summary reads reuse the completed bounded audit');
});

test('work limit degrades only the input and preserves independent keyword exclusion', () => {
  const matcher = compileBilibiliUserRules({ scope: 'fixture', revision: 1, complete: true, verified: true, enabled: true,
    rules: [{ type: 1, opened: true, filter: 'a+a+b' }, { type: 0, opened: true, filter: 'known' }] });
  assert.equal(matcher.match({ text: 'a'.repeat(1000), mode: 1 }).state, 'unknown');
  assert.equal(matcher.summary.categories.regexp.degraded, 1);
  assert.equal(matcher.match({ text: 'a'.repeat(950) + 'known', mode: 1 }).state, 'exclude');
  assert.equal(matcher.match({ text: 'ordinary', mode: 1 }).state, 'retain');
  assert.equal(matcher.match({ text: 'aab', mode: 1 }).state, 'exclude');
  assert.equal(matcher.match({ text: 'aab', mode: 1, border: 1 }).state, 'retain');
  assert.equal(matcher.match({ text: 'a'.repeat(1001), mode: 1 }).state, 'unknown');
  const finite = compileUserRegexp('a{1000}', '');
  assert.ok(finite.work(1000) > USER_REGEXP_WORK_LIMIT, 'fixed repeat traversal is included');
});

test('frozen old predicate cannot acquire new regex support from the current classifier', () => {
  const matcher = compiled(['草{2,}|甲+']);
  assert.equal(matcher.match({ text: '草草', mode: 1 }).state, 'exclude');
  assert.equal(matcher.matchLegacy({ text: '草草', mode: 1 }).state, 'unknown');
});
