// Controlled Node public-chain observation only. Import/argument checking never reads credentials.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CONCURRENCY, LIVE_PROMPT_VERSION, normalizeSettings } from '../src/core/config.ts';
import { readAuthorizedLiveConfig } from './authorized-live-config.mjs';
import { runChainCondition, makeOccurrences, summarizeChain } from './benchmark-live-chain.mjs';
import { distribution, selectCorpus } from './benchmark-live-provider.mjs';

export const NATIVE_C32_LOAD = Object.freeze({ feedMs: 60000, rate: 60, plannedOccurrences: 3600,
  concurrency: 32, bufferMs: 2000, maxPosts: 800, perCellPosts: 400, totalTimeMs: 180000 });
const hash = value => createHash('sha256').update(value).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const check = (value, code) => { if (!value) throw new Error(code); };
const safeCode = value => /^[a-z0-9-]{1,80}$/.test(value ?? '') ? value : 'unspecified-error';
const COMPLETE = 'COMPLETE_CONTROLLED_NODE_C32_OBSERVATION';

export function parseNativeC32Args(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    check(['--config-file', '--check-args', '--help'].includes(name) && !values.has(name), 'invalid-or-duplicate-argument');
    if (name === '--config-file') {
      const path = args[++index];
      check(typeof path === 'string' && path.trim() && !path.startsWith('--'), 'explicit-config-file-required');
      values.set(name, path);
    } else values.set(name, true);
  }
  check(values.has('--help') || values.has('--config-file'), 'explicit-config-file-required');
  return { configFile: values.get('--config-file'), checkArgs: values.has('--check-args'), help: values.has('--help'),
    model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off' };
}

/** Actual translatable sentences; no timestamps, random strings or irrelevant uniqueness suffixes. */
export function makeNativeC32Corpora() {
  const repeated = [
    '今日の配信を楽しみにしていました。', '次の試合ではどの作戦を選びますか。', 'この音楽をもう一度聴きたいです。', '最後まで諦めない姿が印象的でした。',
    '今の場面をゆっくり説明してください。', '背景の色がとてもきれいですね。', 'チームの連携が前より良くなりました。', '新しい地図には秘密の道がありそうです。',
    '休憩中に水を飲むのを忘れないでください。', 'この物語の続きが気になります。', '主人公の声が場面によく合っています。', 'もう少し音量を上げてもらえますか。',
    'その判断にはどんな理由がありますか。', '昨日の練習が今日の結果につながりました。', '初めて見る人にも分かりやすい説明でした。', '次の配信でも一緒に応援しましょう。',
    'I have been looking forward to this stream.', 'Which strategy will you choose in the next match?', 'I would love to hear this music again.', 'It was impressive that the team never gave up.',
    'Could you explain that scene more slowly?', 'The colors in the background look beautiful.', 'The team is working together much better now.', 'There might be a secret path on the new map.',
    'Please remember to drink some water during the break.', 'I wonder what happens next in this story.', 'The main character has a voice that fits this scene.', 'Could you turn the volume up a little?',
    'What was the reason behind that decision?', 'Yesterday’s practice really helped the team today.', 'That explanation was easy for a new viewer to follow.', 'Let us cheer for the team again next time.',
  ];
  const topics = ['新しいゲーム', '今日の配信', '次の大会', 'この映画', '昨日の試合', '今回の物語', '最新の更新', '練習の計画', 'チームの作戦', '音楽の演奏',
    '次の企画', 'この作品', '会場の準備', '初心者向けの説明', '次回のイベント', '映像の編集', '新しい地図', '番組の構成', '週末の活動', '今回の挑戦'];
  const aspects = ['内容', '目的', '進め方', '背景', '特徴', '難しさ', '面白さ', '改善点', '準備', '変更点', '全体像', '細かい部分', '見どころ', '今後の予定', '重要な部分', '新しい要素', '工夫', '期待できる点', '注意点', '他との違い'];
  const comments = ['について詳しく教えてください。', 'をもう少し知りたいです。', 'について皆さんの意見を聞きたいです。', 'を次の配信でも説明してほしいです。',
    'について友達と話していました。', 'を初めて知って驚きました。', 'を理解するために見直しています。', 'について後で質問してもいいですか。', 'を考えると続きが楽しみになります。'];
  const unique = Array.from({ length: 3600 }, (_, index) => {
    // 137 is coprime to 3600: cover every topic/aspect/comment combination once, spread across the feed.
    const ordinal = index * 137 % 3600;
    return `${topics[Math.floor(ordinal / 180)]}の${aspects[Math.floor(ordinal / 9) % 20]}${comments[ordinal % 9]}`;
  });
  return Object.fromEntries([['repeat', repeated], ['low-repeat', unique]].map(([name, texts]) => {
    const selected = selectCorpus(texts.map(originalText => ({ originalText, translatable: true })), 'auto', 'zh-Hans');
    check(selected.items.length === texts.length && Object.keys(selected.excluded).length === 0, 'synthetic-corpus-not-eligible');
    return [name, { items: selected.items, metadata: { kind: 'deterministic-composed-sentences', corpusItems: texts.length,
      uniqueTexts: new Set(texts).size, orderedCorpusSha256: hash(JSON.stringify(texts)),
      maximumSourceChars: Math.max(...texts.map(text => text.length)), excluded: selected.excluded } }];
  }));
}

export function makeNativeC32Plan() {
  return ['repeat', 'low-repeat'].map(corpus => ({ id: `controlled-${corpus}-b2000-c32`, corpus,
    scope: 'controlled-node-c32', bufferMs: 2000, concurrency: 32, postQuota: 400 }));
}

/** Keep cached/duplicate successes visible without adding overlapping categories together. */
export function summarizeNativeC32(condition) {
  const summary = summarizeChain(condition), events = condition.occurrences;
  const ready = events.filter(row => row.validTranslation && finite(row.readyAt) && finite(row.displayAt) && row.readyAt < row.displayAt);
  const unique = new Set(events.map(row => row.uniqueId)), readyUnique = new Set(ready.map(row => row.uniqueId));
  const nonCached = ready.filter(row => !row.cached), nonCachedUnique = new Set(nonCached.map(row => row.uniqueId));
  const reasons = {}, blocked = {}, http = {}, attemptStates = {};
  for (const event of events) for (const reason of new Set(event.failures)) reasons[safeCode(reason)] = (reasons[safeCode(reason)] ?? 0) + 1;
  for (const attempt of condition.attempts) {
    if (attempt.blockedReason) blocked[safeCode(attempt.blockedReason)] = (blocked[safeCode(attempt.blockedReason)] ?? 0) + 1;
    if (finite(attempt.httpStatus)) http[attempt.httpStatus] = (http[attempt.httpStatus] ?? 0) + 1;
    attemptStates[safeCode(attempt.status)] = (attemptStates[safeCode(attempt.status)] ?? 0) + 1;
  }
  const released = events.filter(row => finite(row.receivedAt) && finite(row.releasedAt));
  const translatedReleased = released.filter(row => row.releasedTranslated);
  const callbackSequenceObserved = released.length > 0 && released.every(row => finite(row.releaseSequence))
    && new Set(released.map(row => row.releaseSequence)).size === released.length;
  const releaseOrder = released.slice().sort((a, b) => callbackSequenceObserved ? a.releaseSequence - b.releaseSequence
    : a.releasedAt - b.releasedAt || a.scheduledArrivalAt - b.scheduledArrivalAt);
  const orderRegressions = releaseOrder.filter((row, index) => index > 0 && row.scheduledArrivalAt < releaseOrder[index - 1].scheduledArrivalAt).length;
  return { ...summary, plannedWindowSeconds: (condition.feedMs ?? 60000) / 1000,
    byText: { denominator: unique.size, onTimeReadyUniqueTexts: readyUnique.size,
      uniqueTextCoverage: unique.size ? readyUnique.size / unique.size : null, repeatedInputOccurrences: events.length - unique.size },
    contribution: { cacheHitOnTimeItems: ready.filter(row => row.cached).length,
      duplicateTextOnTimeItems: ready.length - readyUnique.size,
      nonCachedOnTimeItems: nonCached.length, nonCachedOnTimeUniqueTexts: nonCachedUnique.size,
      nonCachedDuplicateTextOnTimeItems: nonCached.length - nonCachedUnique.size,
      note: 'Cache hits and duplicate-text occurrences overlap; noncached repeated results can include in-flight deduplication and are not separate provider translations.' },
    orderedSimulatedRelease: { population: 'Node scheduler release callbacks only; no browser IPC, website renderer or physical display',
      releasedItems: released.length, translatedReleasedItems: translatedReleased.length,
      arrivalToReleaseMs: distribution(released.map(row => row.releasedAt - row.receivedAt)),
      translatedArrivalToReleaseMs: distribution(translatedReleased.map(row => row.releasedAt - row.receivedAt)),
      readyToReleaseMs: distribution(translatedReleased.filter(row => finite(row.readyAt)).map(row => row.releasedAt - row.readyAt)),
      callbackSequenceObserved, orderRegressions: callbackSequenceObserved ? orderRegressions : null,
      timestampOrderRegressions: callbackSequenceObserved ? null : orderRegressions,
      orderEvidence: callbackSequenceObserved ? 'Observed callback sequence' : 'Callback sequence unavailable; timestamp ties do not establish callback order' },
    failureCounts: { occurrenceReasons: reasons, quotaExceededOccurrences: reasons['quota-exceeded'] ?? 0,
      schedulerTimedOut: condition.schedulerStats?.timedOut ?? 0, blockedAttempts: blocked, httpStatuses: http, attemptStates,
      denominatorPolicy: 'All planned occurrences, including quota, timeout, error, not-run and budget-blocked outcomes, remain in coverage and fixed-window throughput denominators.' } };
}

export function nativeC32CompletionStatus(conditions, stop) {
  const plan = makeNativeC32Plan();
  return !stop && conditions.length === plan.length && plan.every(cell => conditions.some(row => row.id === cell.id
    && row.status === 'COMPLETE_CONTROLLED_CHAIN' && row.feedMs === 60000 && row.rate === 60 && row.concurrency === 32
    && row.bufferMs === 2000 && row.releasePolicy === 'ready-in-order' && row.summary.denominator === 3600))
    ? COMPLETE : 'INCOMPLETE_CONTROLLED_NODE_C32_OBSERVATION';
}

function aggregateCondition(condition, corpus) {
  return { id: condition.id, corpus: condition.corpus, corpusMetadata: corpus.metadata, scope: condition.scope,
    status: condition.status, feedMs: condition.feedMs, rate: condition.rate, concurrency: condition.concurrency,
    bufferMs: condition.bufferMs, releasePolicy: condition.releasePolicy, postQuota: condition.postQuota,
    actualPosts: condition.actualPosts, peakActualConcurrency: condition.peakActualConcurrency, durationMs: condition.durationMs,
    budgetBlocked: condition.budgetBlocked, accountingErrors: condition.accountingErrors,
    ...(condition.error ? { error: safeCode(condition.error) } : {}), summary: summarizeNativeC32(condition) };
}

export async function main(args) {
  const options = parseNativeC32Args(args);
  if (options.help) {
    console.log('node --experimental-strip-types scripts/benchmark-youtube-native-c32.mjs --config-file PATH [--check-args]\nTwo serial controlled Node public-chain runs: repeat and low-repeat, each 60 seconds at 60 events/s (3600 planned), C32, 2000ms deadline, ready-in-order simulated release. Fixed deepseek-v4-flash/deepseek/off; configured endpoint/key preserved. Fresh cache per cell, production quotas intact. 400 POSTs/cell, 800 total including retries, 180s total guard. --check-args reads no credential file and makes no requests. Aggregate reports only. No real website/browser/physical-display acceptance.');
    return;
  }
  check(MAX_CONCURRENCY >= 32, 'production-cap-does-not-support-c32');
  const corpora = makeNativeC32Corpora(), plan = makeNativeC32Plan();
  if (options.checkArgs) {
    console.log(JSON.stringify({ status: 'ARGUMENTS_VALID_NO_CONFIG_READ_NO_REQUESTS', selected: {
      model: options.model, profile: options.profile, thinkingEffort: options.thinkingEffort }, load: NATIVE_C32_LOAD,
      plan, corpora: Object.fromEntries(Object.entries(corpora).map(([name, value]) => [name, value.metadata])) }));
    return;
  }
  const authorized = await readAuthorizedLiveConfig(options.configFile).catch(() => { throw new Error('authorized-config-invalid'); });
  const settings = normalizeSettings({ ...authorized.settings, enabled: true, displayMode: 'translated',
    model: options.model, profile: options.profile, thinkingEffort: options.thinkingEffort, concurrency: 32,
    sourceLanguage: 'auto', liveSourceLanguage: 'auto', targetLanguage: 'zh-Hans', translationStream: false });
  check(settings.endpoint === authorized.settings.endpoint && settings.model === 'deepseek-v4-flash'
    && settings.profile === 'deepseek' && settings.thinkingEffort === 'off', 'authorized-settings-not-preserved');
  const sourceHashes = {};
  for (const name of ['src/core/live-scheduler.ts', 'src/core/config.ts', 'src/core/messages.ts', 'src/translation/engine.ts',
    'src/translation/provider.ts', 'src/translation/cache.ts', 'src/translation/clock.ts', 'src/translation/text.ts',
    'scripts/authorized-live-config.mjs', 'scripts/benchmark-live-chain.mjs', 'scripts/benchmark-live-provider.mjs',
    'scripts/translation-cost-metrics.mjs', 'scripts/benchmark-youtube-native-c32.mjs']) sourceHashes[name] = hash(await readFile(name));
  const base = resolve('.artifacts/live/native-c32'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(resolve(base, 'run-')), reportPath = resolve(directory, 'report.json');
  const report = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(),
    evidence: 'REAL_PROVIDER_CONTROLLED_NODE_PUBLIC_ENGINE_SCHEDULER_COMPOSED_CORPUS', sourceHashes,
    selected: { model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off', promptVersion: LIVE_PROMPT_VERSION,
      batchSize: settings.batchSize, adaptiveConcurrency: settings.liveAdaptiveConcurrency },
    load: NATIVE_C32_LOAD, plan,
    limits: ['Controlled composed sentences in Node; no real website, browser IPC, native rendering or physical-display proof.',
      'Each cell has a fresh local memory cache; provider-side caching is unknown. Actual concurrency is measured separately from the configured ceiling.',
      'Production quotaScope admission (1200 new texts and 60000 characters per 60s), batching, adaptive concurrency and deadlines remain enabled.',
      'Each 60s planned denominator remains 3600 even if quota, timeouts, errors or POST budgets prevent translation. A POST-budget-blocked cell remains incomplete.',
      'Release callbacks always accept in this harness; arrival-to-release measures ordered simulated release, not displayed text. Semantic quality is unverified.',
      'The report omits endpoint, credentials, settings dumps, raw texts and individual source/output hashes. Only controlled corpus and implementation hashes are saved.'],
    conditions: [] };
  const run = { maxRequests: 800, actualPosts: 0, stop: null, deadlineAt: performance.now() + 180000 };
  const stop = reason => { run.stop ??= { reason, actualPostsAtStop: run.actualPosts }; };
  const interrupt = () => stop('interrupted');
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const watchdog = setTimeout(() => stop('total-time-budget'), 180000);
  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    for (const cell of plan) {
      const corpus = corpora[cell.corpus];
      let condition;
      if (run.stop) {
        condition = { ...cell, feedMs: 60000, rate: 60, releasePolicy: 'ready-in-order', status: 'INCOMPLETE_NOT_RUN',
          actualPosts: 0, peakActualConcurrency: 0, accountingErrors: [], attempts: [],
          occurrences: makeOccurrences(corpus.items, cell.id, 60, 60000) };
        condition.occurrences.forEach(row => { row.outcome = `not-run-${run.stop.reason}`; });
      } else {
        console.log(JSON.stringify({ condition: cell.id, status: 'STARTED' }));
        condition = await runChainCondition({ cell, corpus: corpus.items, settings, apiKey: authorized.apiKey, run,
          feedMs: 60000, rate: 60, releasePolicy: 'ready-in-order' });
      }
      report.conditions.push(aggregateCondition(condition, corpus));
      report.actualPosts = run.actualPosts; report.stop = run.stop;
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ condition: cell.id, status: condition.status, actualPosts: condition.actualPosts,
        denominator: 3600, onTimeReadyItems: report.conditions.at(-1).summary.onTimeReadyItems,
        peakActualConcurrency: condition.peakActualConcurrency }));
    }
    report.status = nativeC32CompletionStatus(report.conditions, run.stop);
  } catch { report.status = 'INCOMPLETE_RUNNER_ERROR'; }
  finally {
    clearTimeout(watchdog); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); authorized.apiKey = '';
    report.actualPosts = run.actualPosts; report.stop = run.stop; report.finishedAt = new Date().toISOString();
    report.checks = { postBudgetRespected: run.actualPosts <= 800 && report.conditions.every(row => row.actualPosts <= 400),
      noPostsAfterStop: !run.stop || run.actualPosts === run.stop.actualPostsAtStop,
      fixedDenominators: report.conditions.length === 2 && report.conditions.every(row => row.summary.denominator === 3600),
      accounting: report.conditions.every(row => !row.accountingErrors.length && !row.summary.missing),
      concurrencyWithinCap: report.conditions.every(row => row.peakActualConcurrency <= 32) };
    if (!Object.values(report.checks).every(Boolean)) report.status = 'INCOMPLETE_ACCOUNTING';
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ report: reportPath, status: report.status, actualPosts: run.actualPosts }));
  if (report.status !== COMPLETE) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error(JSON.stringify({ status: 'INCOMPLETE_BENCHMARK', error: 'benchmark-error' })); process.exitCode = 1; });
}
