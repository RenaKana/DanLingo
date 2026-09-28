export type VideoEligibilityState = 'eligible' | 'filtered' | 'unknown';
export type VideoDisplayState = 'visible' | 'hidden' | 'unknown';

interface Observation {
  id: string;
  originalText: string;
  state: VideoEligibilityState;
}

export class VideoEligibilityPublisher {
  private revision = 0;
  private observed = new Map<string, Observation>();
  private pending = new Map<string, Observation>();
  private queued = false;
  private display: VideoDisplayState = 'unknown';
  private readonly encoder = new TextEncoder();
  private readonly send: (update: { revision: number; reset: boolean;
    capability: 'unknown'; display: VideoDisplayState; items: Observation[] }) => void;

  constructor(send: (update: { revision: number; reset: boolean;
    capability: 'unknown'; display: VideoDisplayState; items: Observation[] }) => void) { this.send = send; }

  setDisplay(display: VideoDisplayState): void {
    if (this.display === display) return;
    this.display = display;
    this.reset();
  }

  reset(): void {
    this.observed.clear(); this.pending.clear();
    this.send({ revision: ++this.revision, reset: true, capability: 'unknown', display: this.display, items: [] });
  }

  observe(id: string, originalText: string, state: VideoEligibilityState): void {
    if (!id || id.length > 400 || !originalText || originalText.length > 1000) return;
    const prior = this.observed.get(id);
    if (prior?.originalText === originalText && prior.state === state) return;
    // Bound retained observations. Unobserved rows remain unknown, never filtered.
    if (!prior && this.observed.size >= 5000) return;
    const item = { id, originalText, state };
    this.observed.set(id, item); this.pending.set(id, item);
    if (!this.queued) {
      this.queued = true;
      queueMicrotask(() => { this.queued = false; this.flush(); });
    }
  }

  private flush(): void {
    const items = [...this.pending.values()]; this.pending.clear();
    let batch: Observation[] = []; let bytes = 1024;
    const publish = () => {
      if (batch.length) this.send({ revision: ++this.revision, reset: false, capability: 'unknown', display: this.display, items: batch });
      batch = []; bytes = 1024;
    };
    for (const item of items) {
      const size = this.encoder.encode(JSON.stringify(item)).length + 1;
      if (batch.length >= 200 || bytes + size > 256 * 1024) publish();
      batch.push(item); bytes += size;
    }
    publish();
  }
}
