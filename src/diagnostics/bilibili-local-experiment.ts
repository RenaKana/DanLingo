// Explicit, session-only Bilibili experiment. No settings, persistent cache or model lifecycle writes.
import type { Settings, TranslationInput, TranslationOutput, TranslationResponse, Usage } from '../core/types.ts';
import type { LocalModelInfo, LocalState } from '../local/types.ts';
import { withLocalRuntime } from '../local/provider-settings.ts';
import { MemoryTranslationCache, translationCacheKey } from '../translation/cache.ts';
import { TranslationEngine, type TranslationEngineStats } from '../translation/engine.ts';
import { localQualityIssue } from '../translation/local-policy.ts';
import { protectText } from '../translation/text.ts';
import { addUsage, ChatCompletionsProvider, ProviderError, type ProviderRequest } from '../translation/provider.ts';

export interface LocalExperimentBudget {
  maxInputItems: number;
  maxInputChars: number;
  maxAttempts: number;
}

export interface CacheReplay {
  resourceId: string;
  localModelId: string;
  sourceLanguage: string;
  targetLanguage: string;
  entries: { text: string; translatedText: string; sourceRunId: string; sourceId: string }[];
}

export interface LocalExperimentOptions {
  /** A frozen snapshot of the saved, disabled local configuration. Never written back. */
  settings: Readonly<Settings>;
  configVersion: number;
  /** A trusted local snapshot; cache replay may use an unloaded idle state. */
  localState: LocalState;
  resourceId: string;
  runId: string;
  /** Exact original texts from the selected segment and window-only dry run. */
  allowTexts: ReadonlySet<string> | readonly string[];
  budget: Readonly<LocalExperimentBudget>;
  cacheReplay?: CacheReplay;
  /** Must check tab/document/session/config, local state and ordinary-engine idle state. */
  assertCurrent: () => Promise<void>;
  /** Trusted createLocalFetch; cache replay never calls it. No global/network fetch fallback. */
  createLocalFetch: (modelId: string) => typeof fetch;
}

type BudgetReason = 'max-input-items' | 'max-input-chars' | 'max-attempts';
type StopReason = 'range-complete' | 'manual' | 'context-changed' | 'cancelled';
export interface LocalExperimentAttempt {
  startedAt: number;
  finishedAt: number | null;
  inputs: { text: string; chars: number; repeat: boolean }[];
  status: 'running' | 'completed' | 'failed';
  reason: string | null;
  usage: Usage | null;
}
export interface LocalExperimentReport {
  runId: string;
  resourceId: string;
  state: 'created' | 'running' | 'stopped';
  startedAt: number | null;
  finishedAt: number | null;
  stopReason: StopReason | null;
  incomplete: boolean;
  budgetReason: BudgetReason | null;
  /** Exactly reaching a limit is distinct from rejecting a later provider request. */
  budgetAtLimit: BudgetReason | null;
  budget: LocalExperimentBudget;
  sentInputItems: number;
  sentInputChars: number;
  providerCalls: number;
  repeatedInputs: number;
  uniqueOriginalTexts: number;
  failedResults: number;
  usage: Usage | null;
  providerAttempts: LocalExperimentAttempt[];
  cacheReplay: { seededEntries: number; cacheMisses: number;
    sources: { sourceRunId: string; sourceId: string }[] } | null;
  engine: TranslationEngineStats | null;
  safety: {
    configVersion: number; modelGeneration: number; modelMatched: boolean;
    savedBackend: 'local'; savedEnabled: false; effectiveEnabled: true;
    scope: 'window'; cache: 'memory-only'; transport: 'local-ipc-only' | 'cache-only';
    savedSettingsWrites: 0; persistentCacheWrites: 0; modelLoads: 0;
    runtimeParallel: number | null; runtimeContextTokens: number | null;
  };
}

/** One instance per A/B run: even the in-memory cache is never shared between runs. */
export class LocalExperiment {
  private readonly options: LocalExperimentOptions;
  private readonly savedSettings: Settings;
  private readonly allowed: Set<string>;
  private readonly budget: LocalExperimentBudget;
  private readonly modelId: string;
  private readonly modelGeneration: number;
  private readonly runtime: LocalState['runtime'];
  private readonly runtimeIdentity: string | undefined;
  private readonly localPhase: LocalState['phase'];
  private readonly localModelId: string | undefined;
  private readonly modelMatched: boolean;
  private readonly modelName: string | undefined;
  private readonly translationProfile: LocalModelInfo['translationProfile'];
  private readonly cacheReplay: CacheReplay | undefined;
  private readonly abort = new AbortController();
  private readonly seenTexts = new Set<string>();
  private readonly attempts: LocalExperimentAttempt[] = [];
  private readonly cache = new MemoryTranslationCache();
  private engine?: TranslationEngine;
  private localFetch?: typeof fetch;
  private settings?: Settings;
  private state: LocalExperimentReport['state'] = 'created';
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private stopReason: StopReason | null = null;
  private budgetReason: BudgetReason | null = null;
  private incomplete = false;
  private sentInputItems = 0;
  private sentInputChars = 0;
  private repeatedInputs = 0;
  private failedResults = 0;
  private cacheMisses = 0;
  private activeTranslations = 0;
  private usage?: Usage;

  constructor(options: LocalExperimentOptions) {
    const { settings, localState, budget } = options;
    const replay = options.cacheReplay !== undefined;
    const modelMatched = localState.phase === 'ready' && !!localState.runtime &&
      localState.model?.id === settings.localModelId;
    if (!Object.isFrozen(settings) || settings.backend !== 'local' || settings.enabled !== false ||
        !settings.localModelId || (!modelMatched && (!replay || localState.phase !== 'idle')) ||
        !Number.isSafeInteger(localState.generation) ||
        !Number.isSafeInteger(options.configVersion) || options.configVersion < 0 ||
        typeof options.resourceId !== 'string' || !options.resourceId || options.resourceId.length > 1000 ||
        typeof options.runId !== 'string' || !options.runId || options.runId.length > 100 ||
        typeof options.assertCurrent !== 'function' || typeof options.createLocalFetch !== 'function')
      throw new Error('invalid-local-experiment-context');
    for (const [name, ceiling] of [['maxInputItems', 5000], ['maxInputChars', 500_000], ['maxAttempts', 500]] as const)
      if (!Number.isSafeInteger(budget[name]) || budget[name] < (replay ? 0 : 1) || budget[name] > (replay ? 0 : ceiling))
        throw new Error('invalid-local-experiment-budget');
    if (!Array.isArray(options.allowTexts) && !(options.allowTexts instanceof Set))
      throw new Error('invalid-local-experiment-allowlist');
    const allowed = new Set(options.allowTexts);
    if (!allowed.size || allowed.size > 5000 || [...allowed].some(text => typeof text !== 'string' ||
        !text.length || text.length > settings.maxBatchChars)) throw new Error('invalid-local-experiment-allowlist');
    let cacheReplay: CacheReplay | undefined;
    if (replay) {
      const input = options.cacheReplay!;
      if (!input || input.resourceId !== options.resourceId || input.localModelId !== settings.localModelId ||
          input.sourceLanguage !== settings.sourceLanguage || input.targetLanguage !== settings.targetLanguage ||
          !Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 100)
        throw new Error('invalid-local-experiment-cache-replay');
      const effective = withLocalRuntime({ ...settings, enabled: true, translationScope: 'window' }, localState);
      const entries = new Map<string, CacheReplay['entries'][number]>();
      for (const entry of input.entries) {
        if (!entry || typeof entry.text !== 'string' || !allowed.has(entry.text) ||
            typeof entry.translatedText !== 'string' || !entry.translatedText.trim() ||
            entry.translatedText.length > 2000 || localQualityIssue(effective, entry.text, entry.translatedText) ||
            typeof entry.sourceRunId !== 'string' || !entry.sourceRunId.trim() || entry.sourceRunId.length > 100 ||
            typeof entry.sourceId !== 'string' || !entry.sourceId.trim() || entry.sourceId.length > 1000)
          throw new Error('invalid-local-experiment-cache-replay');
        const previous = entries.get(entry.text);
        if (previous && previous.translatedText !== entry.translatedText)
          throw new Error('conflicting-local-experiment-cache-replay');
        if (!previous) entries.set(entry.text, { ...entry });
      }
      if (settings.cacheMaxEntries < entries.size || settings.cacheTtlDays <= 0)
        throw new Error('invalid-local-experiment-cache-replay');
      cacheReplay = { resourceId: input.resourceId, localModelId: input.localModelId,
        sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, entries: [...entries.values()] };
    }
    this.options = options;
    this.savedSettings = structuredClone(settings) as Settings;
    this.allowed = allowed;
    this.budget = { ...budget };
    this.modelId = settings.localModelId;
    this.modelGeneration = localState.generation;
    this.runtime = localState.runtime ? structuredClone(localState.runtime) : undefined;
    this.runtimeIdentity = JSON.stringify(this.runtime);
    this.localPhase = localState.phase;
    this.localModelId = localState.model?.id;
    this.modelMatched = modelMatched;
    this.modelName = localState.model?.name;
    this.translationProfile = localState.model?.translationProfile;
    this.cacheReplay = cacheReplay;
  }

  private async checkCurrent(): Promise<void> {
    if (this.abort.signal.aborted) throw new ProviderError('cancelled');
    try { await this.options.assertCurrent(); }
    catch {
      this.stop('context-changed');
      throw new ProviderError('local-experiment-context-changed');
    }
    if (this.abort.signal.aborted) throw new ProviderError('cancelled');
  }

  async start(): Promise<void> {
    if (this.state !== 'created') throw new Error('local-experiment-already-started');
    await this.checkCurrent();
    if (this.options.localState.generation !== this.modelGeneration || this.options.localState.model?.id !== this.localModelId ||
        this.options.localState.phase !== this.localPhase ||
        JSON.stringify(this.options.localState.runtime) !== this.runtimeIdentity ||
        this.options.localState.model?.name !== this.modelName ||
        this.options.localState.model?.translationProfile !== this.translationProfile) {
      this.stop('context-changed'); throw new Error('local-experiment-context-changed');
    }
    const state = { ...this.options.localState, runtime: this.runtime,
      model: this.options.localState.model ? { ...this.options.localState.model,
        name: this.modelName!, translationProfile: this.translationProfile } : undefined };
    this.settings = withLocalRuntime({ ...this.savedSettings, enabled: true, translationScope: 'window' }, state);
    if (this.cacheReplay) {
      await this.cache.setMany(this.cacheReplay.entries.map(entry => ({
        key: translationCacheKey(this.options.resourceId, entry.text, this.settings!),
        text: entry.translatedText, resourceId: this.options.resourceId,
      })));
    } else {
      this.localFetch = this.options.createLocalFetch(this.modelId);
      if (typeof this.localFetch !== 'function') throw new Error('local-experiment-local-fetch-unavailable');
    }
    this.engine = new TranslationEngine({ cache: this.cache,
      provider: { complete: request => this.complete(request) } });
    this.state = 'running'; this.startedAt = Date.now();
  }

  private budgetExceeded(items: number, chars: number): BudgetReason | null {
    if (this.attempts.length + 1 > this.budget.maxAttempts) return 'max-attempts';
    if (this.sentInputItems + items > this.budget.maxInputItems) return 'max-input-items';
    if (this.sentInputChars + chars > this.budget.maxInputChars) return 'max-input-chars';
    return null;
  }

  private reachBudget(reason: BudgetReason): void {
    this.budgetReason ??= reason;
    this.incomplete = true;
  }

  private async complete(request: ProviderRequest) {
    if (this.state !== 'running' || this.abort.signal.aborted) throw new ProviderError('cancelled');
    if (this.cacheReplay) {
      await this.checkCurrent();
      this.cacheMisses += request.items.length;
      throw new ProviderError('local-experiment-cache-miss');
    }
    if (request.items.some(item => !this.allowed.has(item.text))) {
      this.stop('context-changed'); throw new ProviderError('local-experiment-input-outside-allowlist');
    }
    let attempt: LocalExperimentAttempt | undefined;
    const provider = new ChatCompletionsProvider({ fetch: async (url, init) => {
      // ChatCompletionsProvider already prepared the payload. Only inputs surviving its
      // protection check reach this fetch boundary; count every retry and duplicate here.
      const sent = request.items.filter(item => !protectText(item.text).reason);
      await this.checkCurrent();
      if (this.budgetReason) throw new ProviderError('local-experiment-budget-exhausted');
      const chars = sent.reduce((sum, item) => sum + item.text.length, 0);
      const exceeded = this.budgetExceeded(sent.length, chars);
      if (exceeded) { this.reachBudget(exceeded); throw new ProviderError('local-experiment-budget-exhausted'); }
      const inputs = sent.map(({ text }) => {
        const repeat = this.seenTexts.has(text);
        this.seenTexts.add(text);
        if (repeat) this.repeatedInputs++;
        return { text, chars: text.length, repeat };
      });
      attempt = { startedAt: Date.now(), finishedAt: null,
        inputs, status: 'running', reason: null, usage: null };
      this.attempts.push(attempt);
      this.sentInputItems += sent.length; this.sentInputChars += chars;
      return this.localFetch!(url, init);
    } });
    try {
      const result = await provider.complete(request);
      if (attempt) { attempt.status = 'completed'; attempt.usage = result.usage ?? null; }
      this.usage = addUsage(this.usage, result.usage);
      return result;
    } catch (error) {
      if (attempt) {
        attempt.status = 'failed';
        attempt.reason = error instanceof ProviderError ? error.code : 'local-experiment-provider-error';
        attempt.usage = error instanceof ProviderError ? error.usage ?? null : null;
      }
      this.usage = addUsage(this.usage, error instanceof ProviderError ? error.usage : undefined);
      throw error;
    } finally {
      if (attempt) attempt.finishedAt = Date.now();
    }
  }

  async translate(items: TranslationInput[], signal?: AbortSignal,
    priority: 'near' | 'buffered' | 'background' = 'near',
    onResult?: (output: TranslationOutput) => void): Promise<TranslationResponse> {
    if (this.state !== 'running' || !this.engine || !this.settings) throw new Error('local-experiment-not-running');
    if (this.budgetReason) throw new ProviderError('local-experiment-budget-exhausted');
    if (!Array.isArray(items) || items.some(item => !this.allowed.has(item.text)))
      throw new Error('local-experiment-input-outside-allowlist');
    await this.checkCurrent();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    this.abort.signal.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted || this.abort.signal.aborted) cancel();
    this.activeTranslations++;
    try {
      return await this.engine.translate({ resourceId: this.options.resourceId, settings: this.settings,
        apiKey: 'local-experiment', mode: 'vod', priority, items, signal: controller.signal, onResult: output => {
          if (output.status !== 'translated' && output.status !== 'cached') {
            this.failedResults++; this.incomplete = true;
          }
          onResult?.(output);
        } });
    } finally {
      this.activeTranslations--;
      signal?.removeEventListener('abort', cancel);
      this.abort.signal.removeEventListener('abort', cancel);
    }
  }

  stop(reason: StopReason = 'manual'): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped'; this.stopReason = reason; this.finishedAt = Date.now();
    if (reason !== 'range-complete' || this.failedResults > 0 || this.activeTranslations > 0) this.incomplete = true;
    this.abort.abort(); this.engine?.dispose();
  }

  snapshot(): LocalExperimentReport {
    const budgetAtLimit: BudgetReason | null = this.cacheReplay ? null
      : this.attempts.length === this.budget.maxAttempts ? 'max-attempts'
      : this.sentInputItems === this.budget.maxInputItems ? 'max-input-items'
        : this.sentInputChars === this.budget.maxInputChars ? 'max-input-chars' : null;
    return structuredClone({ runId: this.options.runId, resourceId: this.options.resourceId,
      state: this.state, startedAt: this.startedAt, finishedAt: this.finishedAt,
      stopReason: this.stopReason, incomplete: this.incomplete || budgetAtLimit !== null,
      budgetReason: this.budgetReason, budgetAtLimit,
      budget: this.budget, sentInputItems: this.sentInputItems, sentInputChars: this.sentInputChars,
      providerCalls: this.attempts.length, repeatedInputs: this.repeatedInputs,
      uniqueOriginalTexts: this.seenTexts.size, failedResults: this.failedResults, usage: this.usage ?? null,
      providerAttempts: this.attempts, cacheReplay: this.cacheReplay ? {
        seededEntries: this.cacheReplay.entries.length, cacheMisses: this.cacheMisses,
        sources: this.cacheReplay.entries.map(({ sourceRunId, sourceId }) => ({ sourceRunId, sourceId })),
      } : null, engine: this.engine?.stats() ?? null,
      safety: { configVersion: this.options.configVersion, modelGeneration: this.modelGeneration, modelMatched: this.modelMatched,
        savedBackend: 'local', savedEnabled: false, effectiveEnabled: true, scope: 'window',
        cache: 'memory-only', transport: this.cacheReplay ? 'cache-only' : 'local-ipc-only', savedSettingsWrites: 0,
        persistentCacheWrites: 0, modelLoads: 0, runtimeParallel: this.runtime?.parallel ?? null,
        runtimeContextTokens: this.runtime?.contextTokens ?? null } });
  }
}
