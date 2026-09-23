export type LocalBenchmarkWorkload = 'short' | 'normal' | 'long';
export type LocalBenchmarkStatus = 'success' | 'failed' | 'timeout' | 'cancelled';

export interface LocalBenchmarkCorpusItem {
  id: string;
  workload: LocalBenchmarkWorkload;
  text: string;
}

/** Fixed, meaningful prompts for local runtime measurements. Workload labels are intentional bins, not token-count claims. */
export const LOCAL_BENCHMARK_CORPUS: readonly LocalBenchmarkCorpusItem[] = [
  { id: 'short-ja-01', workload: 'short', text: 'すごい、今の判断は完璧だった！' },
  { id: 'short-ja-02', workload: 'short', text: 'えっ、ここで来るの？' },
  { id: 'short-ja-03', workload: 'short', text: 'その音楽、すごく好きです。' },
  { id: 'short-ja-04', workload: 'short', text: '初見ですが、もう夢中です。' },
  { id: 'short-ja-05', workload: 'short', text: 'ナイスプレイ、助かりました！' },
  { id: 'short-ja-06', workload: 'short', text: '次の展開が楽しみです。' },
  { id: 'short-en-01', workload: 'short', text: 'That timing was perfect!' },
  { id: 'short-en-02', workload: 'short', text: 'Wait, did that just happen?' },
  { id: 'short-en-03', workload: 'short', text: 'I love the music in this scene.' },
  { id: 'short-en-04', workload: 'short', text: 'First time here, and I am hooked.' },
  { id: 'short-en-05', workload: 'short', text: 'Great save, thank you!' },
  { id: 'short-en-06', workload: 'short', text: 'I cannot wait to see what happens next.' },
  { id: 'short-ko-01', workload: 'short', text: '방금 판단이 정말 좋았어요!' },
  { id: 'short-ko-02', workload: 'short', text: '잠깐, 지금 무슨 일이죠?' },
  { id: 'short-ko-03', workload: 'short', text: '이 장면의 음악이 정말 좋아요.' },
  { id: 'short-ko-04', workload: 'short', text: '처음 왔는데 벌써 빠져들었어요.' },
  { id: 'short-ko-05', workload: 'short', text: '멋진 플레이였어요, 고마워요!' },
  { id: 'short-ko-06', workload: 'short', text: '다음 전개가 기대돼요.' },
  { id: 'short-ja-07', workload: 'short', text: '草' },
  { id: 'short-zh-01', workload: 'short', text: '真的假的' },
  { id: 'short-zh-02', workload: 'short', text: '好可爱' },
  { id: 'short-zh-03', workload: 'short', text: '笑死了' },
  { id: 'short-ko-07', workload: 'short', text: 'ㅋㅋㅋㅋ' },
  { id: 'normal-ja-01', workload: 'normal', text: '今日は仕事を早く終えられたので、配信を最初から見られてうれしいです。' },
  { id: 'normal-ja-02', workload: 'normal', text: 'この場面の伏線がここでつながるとは思いませんでした。' },
  { id: 'normal-ja-03', workload: 'normal', text: '失敗してもすぐに立て直すところが本当にかっこいいです。' },
  { id: 'normal-ja-04', workload: 'normal', text: 'コメントを読んでくれてありがとうございます、次も楽しみにしています。' },
  { id: 'normal-ja-05', workload: 'normal', text: 'この曲のタイトルを知っている方がいたら教えてください。' },
  { id: 'normal-ja-06', workload: 'normal', text: '初めて見る人にも分かるように説明してくれて助かります。' },
  { id: 'normal-en-01', workload: 'normal', text: 'I finished work early today, so I am glad I could watch the stream from the beginning.' },
  { id: 'normal-en-02', workload: 'normal', text: 'I did not expect the clue from that earlier scene to connect here so neatly.' },
  { id: 'normal-en-03', workload: 'normal', text: 'It is impressive how quickly you recover and try a different approach after a mistake.' },
  { id: 'normal-en-04', workload: 'normal', text: 'Thanks for reading the comments, and I am already looking forward to the next stream.' },
  { id: 'normal-en-05', workload: 'normal', text: 'If anyone knows the title of this song, please share it because the melody is beautiful.' },
  { id: 'normal-en-06', workload: 'normal', text: 'Your explanation makes this easy to follow even for someone watching it for the first time.' },
  { id: 'normal-ko-01', workload: 'normal', text: '오늘은 일을 일찍 끝내서 방송을 처음부터 볼 수 있어 정말 기뻐요.' },
  { id: 'normal-ko-02', workload: 'normal', text: '앞에서 나온 단서가 여기서 이렇게 자연스럽게 이어질 줄은 몰랐어요.' },
  { id: 'normal-ko-03', workload: 'normal', text: '실수한 뒤에도 바로 다시 일어나는 모습이 정말 멋있어요.' },
  { id: 'normal-ko-04', workload: 'normal', text: '댓글을 읽어 줘서 고마워요, 다음 방송도 벌써 기대하고 있어요.' },
  { id: 'normal-ko-05', workload: 'normal', text: '이 노래 제목을 아는 분이 있다면 멜로디가 좋아서 알려 주세요.' },
  { id: 'normal-ko-06', workload: 'normal', text: '처음 보는 사람도 이해할 수 있게 설명해 줘서 정말 도움이 됐어요.' },
  { id: 'long-ja-01', workload: 'long', text: 'この配信を見始めたころは、難しい場面になるたびに何を選べばよいのか迷っていました。でも、状況を一つずつ整理して、失敗した理由を言葉にしながら進める姿を見ているうちに、私も考え方を学べるようになりました。今日は結果だけでなく、途中の判断や小さな工夫まで丁寧に説明してくれたので、最後まで集中して楽しめました。' },
  { id: 'long-ja-02', workload: 'long', text: '前の章で何気なく出てきた人物の言葉が、ここで重要な意味を持つとは思いませんでした。最初は別の伏線だと思っていたので、場面が切り替わった瞬間にすべてがつながって驚きました。物語の展開が速いのに、登場人物の気持ちの変化も置き去りにされていないところが好きです。次の配信では今回の選択がどんな結果を生むのか、みんなで予想しながら見たいです。' },
  { id: 'long-ja-03', workload: 'long', text: '今日は音声の調子が少し不安定でしたが、状況を確認しながら無理に進めず、必要な場面では説明を止めてくれたので安心して見られました。視聴者のコメントから問題の手がかりを見つけて、試した内容と結果を順番に共有してくれたのも分かりやすかったです。次回は今回見つかった原因を確かめて、もっと安定した状態で続きを楽しめることを期待しています。' },
  { id: 'long-en-01', workload: 'long', text: 'When I first joined this stream, I expected a quick playthrough and did not understand why everyone kept discussing the small choices. After watching the reasoning unfold, I realized that each decision changes the resources available later, so a fast solution is not always the best one. I appreciate that you explain both the successful attempts and the ideas that failed, because those details make the process useful for people who are learning. The final result was exciting, but the careful route to get there was even more interesting. During the next attempt, you paused before each risky choice and asked the chat to identify what information was still missing. That conversation showed why the same mistake can look different when the surrounding circumstances change. I left with a better understanding of the strategy and a reason to watch the next chapter live.' },
  { id: 'long-en-02', workload: 'long', text: 'The connection problem at the start looked like it would end the session, yet you checked each possibility in a calm order instead of changing several settings at once. That made it possible to see which adjustment actually helped and which one only seemed related. The chat also shared useful observations, and you repeated the important steps so anyone who arrived late could follow along. By the time the stream resumed, we had a clearer explanation of the cause and a practical checklist for the next session. I wrote down the sequence while listening, since the order mattered more than any single setting. That record should make future troubleshooting faster and should also help separate a temporary network interruption from a problem in the local setup. The session ended with everyone knowing what to test first.' },
  { id: 'long-en-03', workload: 'long', text: 'This chapter works because the quiet conversations matter as much as the dramatic event near the end. Earlier details about trust, responsibility, and the cost of taking shortcuts return in ways that feel connected rather than forced. I changed my prediction several times while watching, and the final reveal still gave enough information to make sense without explaining every mystery immediately. A slower discussion after the scene would be worthwhile, since there are several character choices that could lead to very different interpretations. The discussion afterward also made me notice how each person protects a different part of the group, even when their choices create conflict. I hope the next chapter gives those relationships room to develop before another major reveal changes the situation. For now, the unresolved questions feel deliberate rather than unfinished.' },
  { id: 'long-ko-01', workload: 'long', text: '처음 방송을 보기 시작했을 때는 어려운 장면이 나오면 정답을 빨리 고르는 것이 가장 중요하다고 생각했어요. 그런데 선택하기 전에 상황을 정리하고, 실패한 이유를 확인한 뒤에 다른 방법을 시도하는 과정을 보면서 생각이 달라졌어요. 결과만 보여 주는 것보다 어떤 정보를 근거로 판단했는지 설명해 줘서 배우는 점이 많았고, 채팅에서 나온 의견을 실제로 확인해 보는 과정도 재미있었어요. 다음에는 오늘 발견한 단서가 어떤 결과로 이어질지 함께 예상해 보고 싶어요.' },
  { id: 'long-ko-02', workload: 'long', text: '오늘 초반에는 소리가 잠시 끊겨서 방송을 계속할 수 있을지 걱정했지만, 여러 설정을 한꺼번에 바꾸지 않고 하나씩 확인해 줘서 원인을 찾는 과정을 이해할 수 있었어요. 시청자들이 남긴 관찰을 정리하고, 이미 확인한 내용과 아직 모르는 내용을 구분해 준 것도 큰 도움이 됐어요. 문제가 해결된 뒤에는 남은 시간을 서두르지 않고 중요한 장면을 다시 설명해 줘서 늦게 들어온 사람도 흐름을 따라갈 수 있었어요. 다음 방송에서는 오늘 정리한 방법이 처음부터 잘 작동하는지 확인해 보면 좋겠어요.' },
] as const;

/** Chinese source coverage for target-Japanese runs, separate from the historical mixed corpus. */
export const LOCAL_CHINESE_BENCHMARK_CORPUS: readonly LocalBenchmarkCorpusItem[] = [
  ...LOCAL_BENCHMARK_CORPUS.filter(item => item.id.includes('-zh-')),
  { id: 'normal-zh-01', workload: 'normal', text: '今天下班比较早，很高兴能从头开始看你的直播。' },
  { id: 'normal-zh-02', workload: 'normal', text: '有人知道这首歌叫什么名字吗？我很喜欢这段旋律。' },
  { id: 'normal-zh-03', workload: 'normal', text: '谢谢你认真回答观众的问题，下次直播我还会来。' },
  { id: 'long-zh-01', workload: 'long', text: '刚开始看这个直播的时候，我总觉得遇到困难就应该尽快做出选择。后来看到你先整理已有的信息，分析失败的原因，再尝试不同的方法，我才发现认真思考过程比只看最终结果更重要。谢谢你把每一步判断都解释清楚，希望下次还能和大家一起讨论。' },
  { id: 'long-zh-02', workload: 'long', text: '今天开头的声音有点断断续续，我还担心直播会提前结束。你没有一次修改所有设置，而是逐个确认问题，还把观众提供的线索整理出来，这样我们都能理解到底是哪一步起了作用。问题解决后你又重新解释了刚才的内容，照顾到后来进入直播间的人，真的很贴心。' },
];

export interface LocalBenchmarkSample {
  id: string;
  workload: LocalBenchmarkWorkload;
  admittedAt: number;
  startedAt?: number;
  finishedAt: number;
  status: LocalBenchmarkStatus;
  queueMs?: number;
  promptMs?: number;
  decodeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  gpuExecutionMs?: number | null;
  gpuAllocatedBytes?: number;
  reason?: string;
}

export interface LocalBenchmarkMetricSummary {
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  samples: number;
  coverage: number;
}

export interface LocalBenchmarkTokenSummary {
  total: number | null;
  perSecond: number | null;
  measured: number;
  missing: number;
  coverage: number;
}

export interface LocalBenchmarkStats {
  total: number;
  success: number;
  failed: number;
  timeout: number;
  cancelled: number;
  totalDurationMs: number | null;
  successRate: number | null;
  timeoutRate: number | null;
  requestsPerSecond: number | null;
  endToEndMs: LocalBenchmarkMetricSummary;
  queueMs: LocalBenchmarkMetricSummary;
  promptMs: LocalBenchmarkMetricSummary;
  decodeMs: LocalBenchmarkMetricSummary;
  inputTokens: LocalBenchmarkTokenSummary;
  outputTokens: LocalBenchmarkTokenSummary;
  gpuExecutionMs: LocalBenchmarkMetricSummary | null;
  gpuAllocatedBytes: number | null;
  gpuAllocationSamples: number;
}

export interface LocalBenchmarkCandidateRow {
  parallel: number;
  requestsPerSecond: number | null;
  p95Ms: number | null;
  meanMs?: number | null;
  meanQueueMs: number | null;
  gpuAllocatedBytes: number | null;
  successRate: number | null;
  timeoutRate: number | null;
}

export interface LocalBenchmarkRecommendation {
  recommendedParallel: number | null;
  recommended: LocalBenchmarkCandidateRow | null;
  ranked: LocalBenchmarkCandidateRow[];
  eligible: LocalBenchmarkCandidateRow[];
  reason: string;
  algorithm: string;
}

export const LOCAL_BENCHMARK_PARALLELS = [1, 2, 4, 8, 16] as const;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const observed = (value: unknown): value is number => finite(value) && value >= 0;
const average = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Nearest-rank percentile: rank is ceil(n * fraction), one-indexed. */
export function benchmarkPercentile(values: readonly number[], fraction: number): number | null {
  const sorted = values.filter(observed).sort((a, b) => a - b);
  if (!sorted.length || !finite(fraction)) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * fraction)));
  return sorted[rank - 1]!;
}

export const percentile = benchmarkPercentile;

function metric(values: number[], denominator: number): LocalBenchmarkMetricSummary {
  const clean = values.filter(observed);
  return {
    meanMs: average(clean),
    p50Ms: benchmarkPercentile(clean, 0.5),
    p95Ms: benchmarkPercentile(clean, 0.95),
    p99Ms: benchmarkPercentile(clean, 0.99),
    minMs: clean.length ? Math.min(...clean) : null,
    maxMs: clean.length ? Math.max(...clean) : null,
    samples: clean.length,
    coverage: denominator > 0 ? clean.length / denominator : 0,
  };
}

function tokenSummary(values: Array<number | undefined>, durationMs: number | null): LocalBenchmarkTokenSummary {
  const clean = values.filter(observed);
  const total = clean.length ? clean.reduce((sum, value) => sum + value, 0) : null;
  return {
    total,
    perSecond: total !== null && durationMs !== null && durationMs > 0 ? total / (durationMs / 1000) : null,
    measured: clean.length,
    missing: values.length - clean.length,
    coverage: values.length ? clean.length / values.length : 0,
  };
}

export function aggregateLocalBenchmark(samples: readonly LocalBenchmarkSample[]): LocalBenchmarkStats {
  const rows = Array.isArray(samples) ? samples : [];
  const total = rows.length;
  const success = rows.filter(row => row.status === 'success').length;
  const failed = rows.filter(row => row.status === 'failed').length;
  const timeout = rows.filter(row => row.status === 'timeout').length;
  const cancelled = rows.filter(row => row.status === 'cancelled').length;
  const admitted = rows.map(row => row.admittedAt).filter(finite);
  const finished = rows.map(row => row.finishedAt).filter(finite);
  const totalDurationMs = admitted.length && finished.length ? Math.max(...finished) - Math.min(...admitted) : null;
  const durations = rows.filter(row => row.status === 'success' && finite(row.admittedAt) && finite(row.finishedAt))
    .map(row => row.finishedAt - row.admittedAt).filter(observed);
  const queues = rows.map(row => observed(row.queueMs) ? row.queueMs : observed(row.startedAt) && finite(row.admittedAt) ? row.startedAt - row.admittedAt : undefined);
  const gpuExecution = rows.map(row => row.gpuExecutionMs).filter(observed);
  const allocations = rows.map(row => row.gpuAllocatedBytes).filter(observed);

  return {
    total,
    success,
    failed,
    timeout,
    cancelled,
    totalDurationMs: totalDurationMs !== null && observed(totalDurationMs) ? totalDurationMs : null,
    successRate: total ? success / total : null,
    timeoutRate: total ? timeout / total : null,
    requestsPerSecond: success && totalDurationMs !== null && totalDurationMs > 0 ? success / (totalDurationMs / 1000) : null,
    endToEndMs: metric(durations, success),
    queueMs: metric(queues.filter((value): value is number => observed(value)), total),
    promptMs: metric(rows.map(row => row.promptMs).filter((value): value is number => observed(value)), total),
    decodeMs: metric(rows.map(row => row.decodeMs).filter((value): value is number => observed(value)), total),
    inputTokens: tokenSummary(rows.map(row => row.inputTokens), totalDurationMs),
    outputTokens: tokenSummary(rows.map(row => row.outputTokens), totalDurationMs),
    gpuExecutionMs: gpuExecution.length ? metric(gpuExecution, total) : null,
    gpuAllocatedBytes: allocations.length ? Math.max(...allocations) : null,
    gpuAllocationSamples: allocations.length,
  };
}

export const summarizeLocalBenchmark = aggregateLocalBenchmark;

const candidateNumber = (value: number | null): number => finite(value) ? value : Number.POSITIVE_INFINITY;

export function recommendLocalBenchmark(rows: readonly LocalBenchmarkCandidateRow[], options: {
  minSuccessRate?: number;
  throughputBand?: number;
  marginalGain?: number;
  latencyRatio?: number;
} = {}): LocalBenchmarkRecommendation {
  const minSuccessRate = options.minSuccessRate ?? 0.95;
  const throughputBand = options.throughputBand ?? 0.05;
  const marginalGain = options.marginalGain ?? 0.10;
  const latencyRatio = options.latencyRatio ?? 2;
  const clean = rows.filter(row => Number.isInteger(row.parallel) && row.parallel >= 1 && row.parallel <= 0x7fffffff);
  const eligible = clean.filter(row => row.successRate !== null && row.successRate >= minSuccessRate
    && row.timeoutRate === 0 && row.requestsPerSecond !== null && row.requestsPerSecond > 0);
  const ranked = [...eligible].sort((a, b) => candidateNumber(b.requestsPerSecond) - candidateNumber(a.requestsPerSecond)
    || candidateNumber(a.p95Ms) - candidateNumber(b.p95Ms)
    || candidateNumber(a.meanMs ?? null) - candidateNumber(b.meanMs ?? null)
    || candidateNumber(a.meanQueueMs) - candidateNumber(b.meanQueueMs)
    || candidateNumber(a.gpuAllocatedBytes) - candidateNumber(b.gpuAllocatedBytes)
    || a.parallel - b.parallel);
  const best = ranked[0] ?? null;
  let recommended = best;
  let reason = best ? `parallel=${best.parallel} has the highest eligible throughput.` : 'No candidate meets the success and timeout gates.';

  if (best) {
    for (const candidate of [...eligible].sort((a, b) => a.parallel - b.parallel)) {
      if (candidate.parallel >= best.parallel || candidate.requestsPerSecond === null || best.requestsPerSecond === null) continue;
      const gain = (best.requestsPerSecond - candidate.requestsPerSecond) / candidate.requestsPerSecond;
      const withinBand = candidate.requestsPerSecond >= best.requestsPerSecond * (1 - throughputBand);
      const materiallyLowerLatency = candidate.p95Ms !== null && best.p95Ms !== null
        && best.p95Ms > candidate.p95Ms && best.p95Ms >= candidate.p95Ms * latencyRatio;
      if (materiallyLowerLatency && (withinBand || gain <= marginalGain)) {
        recommended = candidate;
        reason = `parallel=${candidate.parallel} keeps ${((candidate.requestsPerSecond / best.requestsPerSecond) * 100).toFixed(1)}% of best throughput while its P95 is at least ${latencyRatio}x lower; the throughput gap is ${(gain * 100).toFixed(1)}%.`;
        break;
      }
    }
  }

  return {
    recommendedParallel: recommended?.parallel ?? null,
    recommended,
    ranked,
    eligible,
    reason,
    algorithm: `Require successRate >= ${minSuccessRate} and timeoutRate === 0. Rank eligible rows by throughput, then P95, mean latency, mean queue, GPU allocation, and lower parallel. Prefer a smaller parallel when its throughput is within ${(throughputBand * 100).toFixed(0)}% of best and P95 is at least ${latencyRatio}x lower; allow a marginal throughput gap up to ${(marginalGain * 100).toFixed(0)}% for that latency improvement.`,
  };
}
