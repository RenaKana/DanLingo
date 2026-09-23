import type { LocalState } from './types.ts';

export const LOCAL_IDLE_TIMEOUT_MS = 5 * 60_000;
interface Options {
  snapshot(): LocalState;
  unload(): LocalState;
  canUnload(): Promise<boolean>;
  unloaded(state: LocalState): void;
  blocked?(): boolean;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(timer: unknown): void;
  timeoutMs?: number;
}

/** Offscreen-owned timer: reading status never extends the model's idle lifetime. */
export class LocalIdleUnloader {
  private options: Options;
  private holds = 0;
  private epoch = 0;
  private idle?: { since: number; generation: number; modelId?: string };
  private timer?: unknown;
  private checkingEpoch?: number;
  private disposed = false;
  constructor(options: Options) { this.options = options; }
  private now() { return this.options.now?.() ?? performance.now(); }
  private eligible(state: LocalState) {
    return !this.disposed && !this.holds && !this.options.blocked?.()
      && state.phase === 'ready' && state.active === 0 && state.queued === 0;
  }
  private clear() {
    if (this.timer !== undefined) {
      if (this.options.cancel) this.options.cancel(this.timer);
      else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    }
    this.timer = undefined; this.idle = undefined; this.epoch++;
  }
  hold(): () => void {
    this.holds++; this.clear();
    let released = false;
    return () => { if (released) return; released = true; this.holds--; this.changed(); };
  }
  changed(): void {
    const state = this.options.snapshot();
    if (!this.eligible(state)) { this.clear(); return; }
    if (!this.idle || this.idle.generation !== state.generation || this.idle.modelId !== state.model?.id) {
      this.clear(); this.idle = { since: this.now(), generation: state.generation, modelId: state.model?.id };
    }
    if (this.timer !== undefined || this.checkingEpoch === this.epoch) return;
    const epoch = this.epoch;
    const delay = Math.max(0, this.idle.since + (this.options.timeoutMs ?? LOCAL_IDLE_TIMEOUT_MS) - this.now());
    const callback = () => { if (epoch !== this.epoch) return; this.timer = undefined; void this.expire(epoch); };
    this.timer = this.options.schedule ? this.options.schedule(callback, delay) : setTimeout(callback, delay);
  }
  private async expire(epoch: number) {
    const before = this.options.snapshot();
    if (!this.eligible(before) || this.idle?.generation !== before.generation || this.idle.modelId !== before.model?.id) { this.changed(); return; }
    this.checkingEpoch = epoch;
    let allowed = false;
    try { allowed = await this.options.canUnload(); } catch { /* Retry later if background admission cannot be checked. */ }
    if (this.checkingEpoch === epoch) this.checkingEpoch = undefined;
    if (epoch !== this.epoch || this.disposed) return;
    const current = this.options.snapshot();
    if (!this.eligible(current) || current.generation !== before.generation || current.model?.id !== before.model?.id) { this.changed(); return; }
    if (!allowed) { this.idle!.since = this.now(); this.changed(); return; }
    this.clear();
    this.options.unloaded(this.options.unload());
  }
  dispose(): void { this.disposed = true; this.clear(); }
}
