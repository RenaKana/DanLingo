import { normalizeLocalConfig } from './config.ts';
import type { ProviderSettings } from '../core/types.ts';
import type { LocalControl, LocalReply, LocalState } from './types.ts';

export const LOCAL_AUTOLOAD_KEY = 'localAutoLoad.v1';
type Policy = { revision: number; paused: boolean; failure?: { identity: string; error: string } };
export interface LocalRuntimeStatus { phase: LocalState['phase']; paused: boolean; modelId?: string; modelName?: string; stage?: string; error?: string;
  normalThinking?: string; superChatThinking?: string }
type Control = LocalControl & { policyRevision?: number };
interface Options {
  storage: { get(key: string): Promise<Record<string, any>>; set(value: Record<string, unknown>): Promise<void> };
  control(control: Control): Promise<LocalReply>;
  changed(status: LocalRuntimeStatus): void;
  keepAlive?(): () => void;
}
export const localLoadIdentity = (settings: Pick<ProviderSettings, 'localModelId' | 'localPerformance'>) =>
  JSON.stringify([settings.localModelId, normalizeLocalConfig(settings.localPerformance)]);
const codeOf = (error: unknown) => error instanceof Error && /^LOCAL_[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_LOAD_FAILED';

/** Background policy. Shared loading itself lives in the offscreen controller and survives worker restarts. */
export class LocalAutoLoader {
  private policy?: Policy;
  private initializing?: Promise<Policy>;
  private writing: Promise<void> = Promise.resolve();
  private loading?: { identity: string; revision: number; promise: Promise<LocalState> };
  private state?: LocalState;
  private published = '';
  private options: Options;
  constructor(options: Options) { this.options = options; }
  private async readPolicy(): Promise<Policy> {
    if (this.policy) return this.policy;
    if (!this.initializing) this.initializing = this.options.storage.get(LOCAL_AUTOLOAD_KEY).then(stored => {
      const value = stored[LOCAL_AUTOLOAD_KEY];
      return this.policy = { revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
        paused: value?.paused === true, ...(typeof value?.failure?.identity === 'string' && /^LOCAL_[A-Z0-9_]+$/.test(value?.failure?.error) ? { failure: value.failure } : {}) };
    });
    return this.initializing;
  }
  private persist() {
    const value = structuredClone(this.policy!);
    this.writing = this.writing.catch(() => {}).then(() => this.options.storage.set({ [LOCAL_AUTOLOAD_KEY]: value }));
    return this.writing;
  }
  async status(): Promise<LocalRuntimeStatus> {
    const policy = await this.readPolicy();
    const capability = this.state?.model?.templateCapability;
    const reasoning = this.state?.runtime?.superChatReasoning;
    return { phase: this.state?.phase ?? 'idle', paused: policy.paused,
      ...(this.state?.model?.id ? { modelId: this.state.model.id } : {}),
      ...(this.state?.model?.name ? { modelName: this.state.model.name } : {}),
      ...(capability?.status === 'verified' && capability.supported.includes('off') ? { normalThinking: 'off' } : {}),
      ...(capability?.status === 'verified' && reasoning && reasoning !== 'auto' && capability.supported.includes(reasoning) ? { superChatThinking: reasoning } : {}),
      ...(this.state?.stage ? { stage: this.state.stage } : {}),
      ...(this.state?.error || policy.failure?.error ? { error: this.state?.error ?? policy.failure?.error } : {}) };
  }
  async observe(state?: LocalState) {
    if (state) this.state = state;
    const status = await this.status(), next = JSON.stringify(status);
    if (this.published !== next) { this.published = next; this.options.changed(status); }
  }
  /** Revocations are persisted before IPC; offscreen rejects an older, delayed ensure message. */
  async setPaused(paused: boolean): Promise<number> {
    const policy = await this.readPolicy();
    policy.revision++; policy.paused = paused; delete policy.failure; this.loading = undefined;
    await this.persist(); await this.observe(); return policy.revision;
  }
  async invalidate(): Promise<number> {
    const policy = await this.readPolicy(); return this.setPaused(policy.paused);
  }
  async ready(settings: ProviderSettings, waitForLoad = false): Promise<LocalState> {
    if (!settings.localModelId) throw new Error('LOCAL_MODEL_NOT_SELECTED');
    const policy = await this.readPolicy(), identity = localLoadIdentity(settings), revision = policy.revision;
    if (policy.paused) throw new Error('LOCAL_AUTOLOAD_PAUSED');
    if (policy.failure?.identity === identity) throw new Error(policy.failure.error);
    const existing = this.loading;
    if (existing?.identity === identity && existing.revision === revision) {
      if (waitForLoad) return existing.promise;
      throw new Error('LOCAL_MODEL_LOADING');
    }
    // A real admission reserves a fresh idle window before provider IPC begins.
    const reply = await this.options.control({ action: 'state', demand: true });
    if (policy.paused || revision !== policy.revision) throw new Error('LOCAL_AUTOLOAD_PAUSED');
    if (!reply.ok) throw new Error(reply.error ?? 'LOCAL_OFFSCREEN_UNAVAILABLE');
    const state = reply.state;
    if (state?.phase === 'error' && state.model?.id === settings.localModelId
      && localLoadIdentity({ localModelId: state.model.id, localPerformance: state.requested }) === identity) {
      policy.failure = { identity, error: state.error ?? 'LOCAL_LOAD_FAILED' };
      await this.persist(); await this.observe(state); throw new Error(policy.failure.error);
    }
    if (state?.model?.id === settings.localModelId && ['ready', 'generating'].includes(state.phase)
      && localLoadIdentity({ localModelId: state.model.id, localPerformance: state.requested }) === identity) {
      await this.observe(state); return state;
    }
    // Another admission may have reached the load while this state read was pending.
    if (this.loading?.identity === identity && this.loading.revision === revision) {
      if (waitForLoad) return this.loading.promise;
      throw new Error('LOCAL_MODEL_LOADING');
    }
    this.state = { ...state, phase: 'loading', stage: 'reading-file', error: undefined, model: { id: settings.localModelId } } as LocalState;
    const stopKeepAlive = this.options.keepAlive?.() ?? (() => {});
    let polling = false;
    const timer = setInterval(() => {
      if (polling || policy.revision !== revision) return;
      polling = true;
      void this.options.control({ action: 'state' }).then(next => {
        if (policy.revision === revision && next.state?.model?.id === settings.localModelId) void this.observe(next.state);
      }).catch(() => {}).finally(() => { polling = false; });
    }, 750);
    const pending = { identity, revision, promise: undefined as unknown as Promise<LocalState> };
    this.loading = pending;
    pending.promise = (async () => {
      try {
        await this.observe();
        if (policy.paused || policy.revision !== revision) throw new Error('LOCAL_AUTOLOAD_PAUSED');
        const result = await this.options.control({ action: 'ensure', modelId: settings.localModelId!, config: settings.localPerformance, policyRevision: revision });
        if (policy.paused || policy.revision !== revision) throw new Error('LOCAL_MODEL_CHANGED');
        if (!result.ok || !result.state) throw new Error(result.error ?? 'LOCAL_LOAD_FAILED');
        delete policy.failure; await this.persist(); await this.observe(result.state); return result.state;
      } catch (error) {
        const code = codeOf(error);
        if (policy.revision === revision && !['LOCAL_BENCHMARK_BUSY', 'LOCAL_MODEL_CHANGED', 'LOCAL_AUTOLOAD_PAUSED'].includes(code)) {
          policy.failure = { identity, error: code }; this.state = { ...this.state!, phase: 'error', error: code };
          await this.persist(); await this.observe();
        }
        throw error;
      } finally { clearInterval(timer); stopKeepAlive(); if (this.loading === pending) this.loading = undefined; }
    })();
    if (waitForLoad) return pending.promise;
    void pending.promise.catch(() => {}); throw new Error('LOCAL_MODEL_LOADING');
  }
}
