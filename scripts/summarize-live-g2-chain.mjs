// Derive per-window evidence from one finished chain report; no credentials or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (value, from, until) => finite(value) && value >= from && value < until;
const chars = rows => rows.reduce((sum, row) => sum + row.outputUnicodeChars, 0);
const latency = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
};

export function summarizeG2Condition(condition) {
  if (!condition.occurrences || !condition.summary) return { id: condition.id, status: condition.status, gate: condition.gate };
  const events = condition.occurrences, attempts = condition.attempts;
  assert.equal(condition.summary.denominator, events.length, 'full denominator mismatch');
  assert.equal(condition.summary.onTimeReadyItems, events.filter(row => row.validTranslation).length, 'ready ledger mismatch');
  const firstProviderReady = new Map();
  for (const row of events.filter(row => row.validTranslation && !row.cached).sort((a, b) => a.readyAt - b.readyAt)) {
    assert.ok(row.engineTaskId, 'uncached ready task association required');
    if (!firstProviderReady.has(row.engineTaskId)) firstProviderReady.set(row.engineTaskId, row);
  }
  const windows = condition.summary.readyTimeBuckets.map(window => {
    const { fromMs, untilMs } = window;
    const ready = events.filter(row => row.validTranslation && inside(row.readyAt, fromMs, untilMs));
    const released = events.filter(row => inside(row.releasedAt, fromMs, untilMs));
    const settled = attempts.filter(row => finite(row.postedAt) && inside(row.settledAt, fromMs, untilMs));
    const successfulPosts = settled.filter(row => row.status === 'completed');
    const unique = [...firstProviderReady.values()].filter(row => inside(row.readyAt, fromMs, untilMs));
    // Exact POST intervals, half-open at settlement; sampling frequency cannot inflate a peak.
    const times = [fromMs, ...attempts.filter(row => inside(row.postedAt, fromMs, untilMs)).map(row => row.postedAt)];
    const peakActualConcurrency = Math.max(0, ...times.map(at => attempts.filter(row => finite(row.postedAt)
      && row.postedAt <= at && (!finite(row.settledAt) || row.settledAt > at)).length));
    return { fromMs, untilMs, durationSeconds: (untilMs - fromMs) / 1000,
      serviceCompletedPosts: successfulPosts.length, servicePartialPosts: settled.filter(row => row.status === 'partial').length,
      serviceTimeoutPosts: settled.filter(row => row.status === 'timeout').length,
      serviceCancelledPosts: settled.filter(row => row.status === 'cancelled').length,
      serviceCompletedPostLatency: latency(successfulPosts.map(row => row.settledAt - row.postedAt)),
      allSettledPostLatencyCensored: latency(settled.map(row => row.settledAt - row.postedAt)),
      readyEvents: ready.length, readyUnicodeChars: chars(ready), cachedReadyEvents: ready.filter(row => row.cached).length,
      readyLatency: latency(ready.map(row => row.readyAt - row.receivedAt)),
      firstTimelyProviderTasks: unique.length, firstTimelyProviderTaskUnicodeChars: chars(unique),
      releasedEvents: released.length, releasedTranslatedEvents: released.filter(row => row.releasedTranslated).length,
      releasedOriginalEvents: released.filter(row => !row.releasedTranslated).length,
      peakActualConcurrency, actualPlatformDisplay: null };
  });
  assert.equal(windows.reduce((sum, row) => sum + row.readyEvents, 0), condition.summary.onTimeReadyItems);
  assert.equal(windows.reduce((sum, row) => sum + row.firstTimelyProviderTasks, 0), firstProviderReady.size);
  assert.equal(windows.reduce((sum, row) => sum + row.releasedEvents, 0), events.filter(row => finite(row.releasedAt)).length,
    'release windows must retain every recorded release');
  return { id: condition.id, status: condition.status, bufferMs: condition.bufferMs, concurrency: condition.concurrency,
    denominator: events.length, readyEvents: condition.summary.onTimeReadyItems, onTimeCoverage: condition.summary.onTimeCoverage,
    cachedReadyEvents: condition.summary.localCacheItems, timelyProviderTasks: firstProviderReady.size,
    timelyProviderTaskUnicodeChars: chars([...firstProviderReady.values()]), actualPosts: condition.actualPosts,
    backfilledPosts: attempts.filter(row => row.liveDispatch?.backfill).length,
    sameEventReleaseVerified: condition.accountingErrors.length === 0 && events.every(row => row.releaseCallbackCount === 1),
    escalation: condition.escalation, arrivalCohorts: condition.summary.twoSecondBuckets, windows };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/summarize-live-g2-chain.mjs --report PATH\nOffline summary into a unique .artifacts/live/goals/g2/measurement-* directory.');
    return;
  }
  assert.ok(args.length === 2 && args[0] === '--report', 'one explicit --report PATH required');
  const input = resolve(args[1]), bytes = await readFile(input), source = JSON.parse(bytes);
  assert.ok(source.finishedAt, 'only finished observations can be summarized');
  const parent = resolve('.artifacts/live/goals/g2'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'measurement-'));
  const report = { capturedAt: new Date().toISOString(), input: { path: input, sha256: hash(bytes) },
    observerSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceHashes: source.sourceHashes,
    sourceStatus: source.status, actualPosts: source.actualPosts, conditions: source.conditions.map(summarizeG2Condition),
    limitations: ['Completed POST counts describe received responses, not all remote computation or billable work.',
      'Unique task counts/chars include only tasks accepted before at least one subscriber deadline; late or unreceived output is unknown.',
      'Provider uniqueness excludes local cache and deduplicates same-text subscribers; input uses a controlled repeated recorded corpus.',
      'Ready and release windows differ; original arrival cohorts retain every eligible failure. No bucket is removed for zero output.',
      'Latency of all settled requests includes timeout/cancellation censoring; success-only latency excludes failures.',
      'No browser IPC, native platform rendering, semantic quality, model-only sustainable capacity or physical display is certified.'] };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['# G2 真实公共链路窗口记录', '', `来源状态：${source.status}；实际 POST：${source.actualPosts}。`,
    '', '“服务完成”按成功完整 POST 返回计；“唯一任务”只计期限内被接受的首次非缓存任务。全部分母和原文回退保留。', ''];
  for (const condition of report.conditions) {
    lines.push(`## ${condition.id} — ${condition.status}`, '');
    if (!condition.windows) { lines.push('本档未执行；门控理由见 JSON。', ''); continue; }
    lines.push(`及时 ${condition.readyEvents}/${condition.denominator}；缓存 ${condition.cachedReadyEvents}；及时唯一服务任务 ${condition.timelyProviderTasks}。`, '',
      '|实际时间 ms|服务完成 POST|及时事件/字符|缓存事件|首次及时任务/字符|释放译文/原文|超时/取消 POST|并发峰值|及时准备 p95 ms|',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of condition.windows) lines.push(`|${row.fromMs.toFixed(1)}–${row.untilMs.toFixed(1)}|${row.serviceCompletedPosts}|${row.readyEvents}/${row.readyUnicodeChars}|${row.cachedReadyEvents}|${row.firstTimelyProviderTasks}/${row.firstTimelyProviderTaskUnicodeChars}|${row.releasedTranslatedEvents}/${row.releasedOriginalEvents}|${row.serviceTimeoutPosts}/${row.serviceCancelledPosts}|${row.peakActualConcurrency}|${row.readyLatency.p95Ms?.toFixed(1) ?? '—'}|`);
    lines.push('');
  }
  lines.push('实际上屏未测。完整到达分组、服务延迟分布和门控证据保存在 JSON；不同时间口径不可相加或混作模型吞吐。', '');
  await writeFile(resolve(directory, 'windows.md'), lines.join('\n'));
  console.log(JSON.stringify({ directory, sourceStatus: report.sourceStatus, actualPosts: report.actualPosts,
    conditions: report.conditions.map(({ windows, arrivalCohorts, escalation, ...row }) => row) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
