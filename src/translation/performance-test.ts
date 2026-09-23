import { strategySettings, providerTimeoutMs } from '../core/config.ts';
import type { Settings, Usage } from '../core/types.ts';
import { TranslationEngine } from './engine.ts';
import { addUsage, ChatCompletionsProvider, ProviderError } from './provider.ts';
import type { ProviderOptions, ProviderRequest } from './provider.ts';
import { modelTestSource } from './model-test.ts';
import { translationLanguageIssue } from '../local/translation-profile.ts';

export interface PerformanceConfig {
  count: number;
  mode: 'latency' | 'load';
  concurrency: number;
  batchSize: number;
  arrivalIntervalMs: number;
  strategy: 'normal' | 'superchat';
}
export interface PerformanceAttempt {
  sentAt: number | null; readyAt: number | null; finishedAt: number;
  items: number; validItems: number; status: 'success' | 'failed' | 'timeout' | 'cancelled';
  reason?: string;
}
export interface PerformanceJob {
  index: number; arrivedAt: number; finishedAt?: number; validItems: number; items: number;
  withinBudget: number; cancelled: boolean;
}
export interface PerformanceReport {
  id: string; state: 'running' | 'completed' | 'stopped'; stopReason?: string;
  config: PerformanceConfig; model: string; backend: string;
  startedAt: number; finishedAt?: number; planned: number; admitted: number; completed: number;
  actualRequests: number; successRequests: number; failed: number; timeout: number; cancelled: number; unsent: number;
  meanMs: number | null; p50Ms: number | null; p95Ms: number | null; successRate: number | null;
  meanQueueMs: number | null; meanReadyMs: number | null; withinBudgetRate: number | null;
  throughput: number; firstRequestMs: number | null; stableMeanMs: number | null;
  usage?: Usage; usageReports: number; samples: PerformanceAttempt[]; jobs: PerformanceJob[];
  localInferenceCalls?: number | null;
  notes: string[];
}
const samples: Record<string, string[]> = {
  zh: ['太厉害了！', '等一下，刚刚发生了什么？😂', '这操作太极限了！', '谢谢你的直播！', '第一次来，期待今天的直播。', '谢谢你坚持到最后，明天也会继续支持你！', '没想到会在这里跳起来哈哈', '有人知道这首歌叫什么名字吗？'],
  ja: ['すごい！', '今の動き、もう一度見たいです 😂', 'ちょっと待って、何が起きたの？', 'ナイス！ありがとう', '初見です。今日も配信を楽しみにしていました。', '最後まで諦めずに挑戦してくれてありがとう。明日も応援しています！', 'ここでジャンプするとは思わなかったｗ', 'この曲の名前を知っている人はいますか？'],
  en: ['Awesome!', 'Wait, what just happened? 😂', 'That was so close, nice save!', 'Thanks for the stream!', 'First time here. I have been looking forward to watching this.', 'Thank you for keeping at it until the end. I will be cheering you on tomorrow too!', 'I did not expect that jump lol', 'Does anyone know the name of this song?'],
  ko: ['대단해요!', '잠깐, 방금 무슨 일이 있었나요? 😂', '정말 아슬아슬했어요!', '방송해 줘서 고마워요', '처음 왔어요. 오늘 방송을 기다리고 있었어요.', '끝까지 포기하지 않고 도전해 줘서 고마워요. 내일도 응원할게요!', '여기서 점프할 줄 몰랐어요', '이 노래 제목을 아는 분 있나요?'],
};
const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;
}
export function validatePerformanceConfig(value: PerformanceConfig): PerformanceConfig {
  for (const [key, min, max] of [['count', 1, 1000], ['concurrency', 1, 64], ['batchSize', 1, 200], ['arrivalIntervalMs', 0, 5000]] as const)
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error('invalid-performance-config');
  if (!['latency', 'load'].includes(value.mode) || !['normal', 'superchat'].includes(value.strategy)) throw new Error('invalid-performance-config');
  return { ...value };
}
/** Explicitly started, cache-free translation replay. No warmups and no hidden retries. */
export class PerformanceTest {
  private readonly controller = new AbortController();
  private engine?: TranslationEngine;
  readonly report: PerformanceReport;
  private readonly requestJobs = new Map<string, PerformanceJob>();
  private readonly sentByJob = new Map<number, number>();
  private readonly now: () => number;
  private readonly settings: Settings;
  private readonly apiKey: string;
  private readonly options: ProviderOptions;
  constructor(config: PerformanceConfig, settings: Settings, apiKey: string, options: ProviderOptions = {}) {
    this.apiKey = apiKey; this.options = options;
    config = validatePerformanceConfig(config);
    this.now = typeof options.clock === 'function' ? options.clock : options.clock?.now?.bind(options.clock) ?? (() => performance.now());
    this.settings = { ...strategySettings(settings, config.strategy), enabled: true, displayMode: 'translated',
      sourceLanguage: settings.liveSourceLanguage, concurrency: config.concurrency };
    const languageIssue = this.settings.backend === 'local'
      ? translationLanguageIssue(this.settings.localTranslationProfile, this.settings.sourceLanguage, this.settings.targetLanguage) : undefined;
    if (languageIssue) throw new ProviderError(languageIssue);
    modelTestSource(this.settings.sourceLanguage, this.settings.targetLanguage); // Reject same-language or unsupported built-in corpus.
    this.report = { id: crypto.randomUUID(), state: 'running', config, model: this.settings.model, backend: settings.backend ?? 'online',
      startedAt: this.now(), planned: config.count, admitted: 0, completed: 0, actualRequests: 0, successRequests: 0,
      failed: 0, timeout: 0, cancelled: 0, unsent: config.count, meanMs: null, p50Ms: null, p95Ms: null, successRate: null,
      meanQueueMs: null, meanReadyMs: null, withinBudgetRate: null, throughput: 0, firstRequestMs: null, stableMeanMs: null,
      usageReports: 0, samples: [], jobs: [], notes: [
        '使用正式直播提示词、解析器与所选语言/思考设置；预热请求 0。样本编号用于避免重复结果缓存。',
        '完整译文延迟只统计格式与已启用语言初检通过的请求，不代表语义正确；未发送、失败、超时和取消单列。',
        '服务端前缀/响应缓存不可确认关闭；未测物理展示延迟。已发出后取消仍可能产生用量。',
        '本地首次文件加载耗时在模型状态中单列；首个测试请求与后续稳定请求分别统计。',
        ...(config.count <= 10 ? ['10 次及以下分位数为小样本结果。'] : []),
        ...(config.mode === 'load' ? ['回放按到达间隔进入正式调度器；批量/字符/预算约束可能拆分请求，实际发出数单列。'] : []),
      ] };
  }
  stop(reason = '用户停止') { if (this.report.state !== 'running') return; this.report.stopReason = reason; this.controller.abort(); }
  private async complete(request: ProviderRequest) {
    if (this.controller.signal.aborted) throw new ProviderError('cancelled');
    const attempt: PerformanceAttempt = { sentAt: null, readyAt: null, finishedAt: 0, items: request.items.length, validItems: 0, status: 'failed' };
    this.report.samples.push(attempt);
    const valid = new Set<string>();
    try {
      const result = await new ChatCompletionsProvider({ ...this.options, fetch: async (url, init) => {
        attempt.sentAt = this.now(); this.report.actualRequests++;
        for (const item of request.items) { const job = this.requestJobs.get(item.id); if (job && !this.sentByJob.has(job.index)) this.sentByJob.set(job.index, attempt.sentAt); }
        return (this.options.fetch ?? globalThis.fetch)(url, init);
      } }).complete({ ...request, onItem: (id, output) => {
        if (output.text !== undefined) valid.add(id);
        if (valid.size === request.items.length) attempt.readyAt ??= this.now();
        request.onItem?.(id, output);
      } });
      for (const [id, output] of result.items) if (output.text !== undefined && !output.reason) valid.add(id);
      if (valid.size === request.items.length) { attempt.readyAt ??= this.now(); attempt.status = 'success'; }
      else attempt.reason = [...result.items.values()].find(output => output.reason)?.reason ?? 'invalid-response';
      if (result.usage) { this.report.usage = addUsage(this.report.usage, result.usage); this.report.usageReports++; }
      return result;
    } catch (error) {
      const reason = error instanceof ProviderError ? error.message : 'provider-error';
      if (reason === 'online-daily-limit-reached' || reason === 'online-budget-storage-unavailable') {
        this.stop(reason === 'online-daily-limit-reached' ? '今日在线请求已达上限' : '在线请求计数不可用，已停止发送');
      }
      attempt.status = reason === 'cancelled' ? this.controller.signal.aborted ? 'cancelled' : 'timeout' : reason === 'timeout' ? 'timeout' : 'failed'; attempt.reason = reason;
      throw error;
    } finally { attempt.validItems = valid.size; attempt.finishedAt = this.now(); this.summarize(); }
  }
  snapshot(): PerformanceReport { this.summarize(); return structuredClone(this.report); }
  private summarize() {
    const report = this.report, sent = report.samples.filter(row => row.sentAt !== null);
    const successful = sent.filter(row => row.status === 'success' && row.readyAt !== null);
    const latencies = successful.map(row => row.readyAt! - row.sentAt!);
    report.successRequests = successful.length;
    report.failed = sent.filter(row => row.finishedAt && row.status === 'failed').length;
    report.timeout = sent.filter(row => row.finishedAt && row.status === 'timeout').length;
    report.cancelled = sent.filter(row => row.finishedAt && row.status === 'cancelled').length;
    report.unsent = report.planned - report.jobs.filter(job => this.sentByJob.has(job.index)).length;
    report.meanMs = avg(latencies); report.p50Ms = percentile(latencies, .5); report.p95Ms = percentile(latencies, .95);
    report.successRate = sent.length ? successful.length / sent.length : null;
    const readyJobs = report.jobs.filter(job => job.finishedAt !== undefined && job.validItems === job.items);
    report.meanReadyMs = avg(readyJobs.map(job => job.finishedAt! - job.arrivedAt));
    report.meanQueueMs = avg(report.jobs.filter(job => this.sentByJob.has(job.index)).map(job => this.sentByJob.get(job.index)! - job.arrivedAt));
    const totalItems = report.jobs.reduce((sum, job) => sum + job.items, 0);
    report.withinBudgetRate = totalItems && report.config.mode === 'load' ? report.jobs.reduce((sum, job) => sum + job.withinBudget, 0) / totalItems : null;
    report.throughput = successful.length / Math.max(.001, ((report.finishedAt ?? this.now()) - report.startedAt) / 1000);
    const first = sent[0]; report.firstRequestMs = first?.status === 'success' && first.readyAt !== null ? first.readyAt - first.sentAt! : null;
    report.stableMeanMs = avg(successful.filter(row => row !== first).map(row => row.readyAt! - row.sentAt!));
  }
  private async pause(ms: number) {
    if (this.controller.signal.aborted || ms <= 0) return;
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); this.controller.signal.addEventListener('abort', done, { once: true }); });
  }
  async run(): Promise<PerformanceReport> {
    const { config } = this.report;
    const budget = config.strategy === 'superchat' ? this.settings.superChatTimeoutMs ?? 15000 : this.settings.liveBufferMs;
    let submitting: PerformanceJob | undefined;
    const taskJobs = new Map<string, PerformanceJob>();
    if (config.mode === 'load') this.engine = new TranslationEngine({ provider: { complete: request => {
      for (const item of request.items) { const job = taskJobs.get(item.id); if (job) this.requestJobs.set(item.id, job); }
      return this.complete(request);
    } }, onTrace: event => { if (event.type === 'bind' && submitting) taskJobs.set(event.taskId, submitting); } });
    const perform = async (index: number) => {
      if (this.controller.signal.aborted) return;
      const count = config.mode === 'latency' ? 1 : Math.min(config.batchSize, this.settings.batchSize);
      const job: PerformanceJob = { index, arrivedAt: this.now(), items: count, validItems: 0, withinBudget: 0, cancelled: false };
      this.report.jobs.push(job); this.report.admitted++;
      const sourceKey = this.settings.sourceLanguage === 'auto' ? this.settings.targetLanguage.startsWith('ja') ? 'zh' : 'ja' : this.settings.sourceLanguage.split('-')[0]!;
      const source = samples[sourceKey]!;
      const items = Array.from({ length: count }, (_, item) => ({ id: `bench-${index}-${item}`, text: `${source[(index + item) % source.length]} (${index + 1}-${item + 1})`, deadlineAt: job.arrivedAt + budget, strategy: config.strategy }));
      try {
        if (this.engine) {
          submitting = job;
          const pending = this.engine.translate({ resourceId: `benchmark:${this.report.id}`, namespace: `${this.report.id}:${index}`, bypassCache: true,
            settings: this.settings, apiKey: this.apiKey, items, signal: this.controller.signal, mode: 'deadline', onResult: output => {
              if (output.status === 'translated') { job.validItems++; if (this.now() <= job.arrivedAt + budget) job.withinBudget++; }
            } });
          submitting = undefined; await pending;
        } else {
          items.forEach(item => this.requestJobs.set(item.id, job));
          const result = await this.complete({ settings: this.settings, apiKey: this.apiKey, items, signal: this.controller.signal,
            mode: 'deadline', strategy: config.strategy, benchmark: true, budgetMs: providerTimeoutMs(this.settings) });
          job.validItems = [...result.items.values()].filter(item => item.text !== undefined && !item.reason).length;
        }
      } catch { /* Attempt records contain only fixed failure codes. */ }
      finally { job.finishedAt = this.now(); job.cancelled = this.controller.signal.aborted; this.report.completed++; this.summarize(); }
    };
    try {
      if (config.mode === 'load') {
        const work: Promise<void>[] = [];
        for (let i = 0; i < config.count && !this.controller.signal.aborted; i++) {
          await this.pause(this.report.startedAt + i * config.arrivalIntervalMs - this.now());
          if (!this.controller.signal.aborted) work.push(perform(i));
        }
        await Promise.all(work);
      } else {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(this.settings.concurrency, config.count) }, async () => {
          while (!this.controller.signal.aborted && next < config.count) await perform(next++);
        }));
      }
    } finally { this.engine?.dispose(); this.report.state = this.controller.signal.aborted ? 'stopped' : 'completed'; this.report.finishedAt = this.now(); }
    return this.snapshot();
  }
}
