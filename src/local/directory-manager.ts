import type { DirectoryScanResult, DirectoryScanStatus } from './directory-types.ts';

interface ScanWorker { onmessage: ((event: MessageEvent) => void) | null; onerror: ((event: ErrorEvent) => void) | null; postMessage(message: unknown): void; terminate(): void }
interface Job { id: string; requestId: string; resolve(result: DirectoryScanResult): void; reject(error: Error): void; promise: Promise<DirectoryScanResult> }
const idle = (): DirectoryScanStatus => ({ phase: 'idle', checkedFiles: 0, modelsFound: 0, elapsedMs: 0, issues: [] });

/** One bounded worker and one queue shared by all settings windows. */
export class DirectoryScanManager {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active?: Job;
  private worker?: ScanWorker;
  private status: DirectoryScanStatus = idle();
  private createWorker: () => ScanWorker;
  private changed: (result: DirectoryScanResult) => Promise<void>;
  constructor(createWorker: () => ScanWorker, changed: (result: DirectoryScanResult) => Promise<void>) {
    this.createWorker = createWorker; this.changed = changed;
  }
  snapshot(): DirectoryScanStatus { return structuredClone(this.status); }
  busy(): boolean { return this.jobs.size > 0; }
  scan(id: string): Promise<DirectoryScanResult> {
    const existing = this.jobs.get(id); if (existing) return existing.promise;
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const promise = new Promise<DirectoryScanResult>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { id, requestId: crypto.randomUUID(), resolve, reject, promise };
    this.jobs.set(id, job); this.queue.push(job); this.next(); return promise;
  }
  cancel(id?: string): void {
    const retained: Job[] = [];
    for (const job of this.queue) {
      if (id && job.id !== id) { retained.push(job); continue; }
      this.jobs.delete(job.id); job.resolve({ invalidatedIds: [], status: { ...idle(), directoryId: job.id, phase: 'cancelled' } });
    }
    this.queue = retained;
    if (this.active && (!id || this.active.id === id)) this.worker?.postMessage({ cancel: true, requestId: this.active.requestId });
  }
  private next(): void {
    if (this.active) return;
    const job = this.queue.shift(); if (!job) return;
    this.active = job; this.status = { ...idle(), phase: 'scanning', directoryId: job.id };
    let settled = false;
    const finish = async (result?: DirectoryScanResult, error?: string) => {
      if (settled) return; settled = true;
      this.worker?.terminate(); this.worker = undefined;
      this.status = result?.status ?? { ...this.status, phase: ['LOCAL_SCAN_CANCELLED', 'LOCAL_DIRECTORY_SCAN_CANCELLED'].includes(error ?? '') ? 'cancelled' : 'error', error };
      const outcome = result ?? { invalidatedIds: [], status: this.status };
      try { await this.changed(outcome); job.resolve(outcome); }
      catch (failure) { job.reject(failure instanceof Error ? failure : new Error('LOCAL_DIRECTORY_SCAN_FAILED')); }
      finally { this.jobs.delete(job.id); this.active = undefined; this.next(); }
    };
    try {
      this.worker = this.createWorker();
      this.worker.onmessage = event => {
        const message = event.data;
        if (message.requestId !== job.requestId || settled) return;
        if (message.progress) { this.status = message.progress; if (message.ok === undefined) return; }
        void finish(message.ok ? message.result : undefined, message.error);
      };
      this.worker.onerror = () => { void finish(undefined, 'LOCAL_DIRECTORY_SCAN_FAILED'); };
      this.worker.postMessage({ requestId: job.requestId, directoryId: job.id });
    } catch { void finish(undefined, 'LOCAL_DIRECTORY_SCAN_FAILED'); }
  }
}
