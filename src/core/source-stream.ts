import type { SourceMessage } from './types.ts';

export const SOURCE_CHUNK_ITEMS = 500;
export const SOURCE_CHUNK_BYTES = 256 * 1024;
export interface SourceChunk {
  revision: number; index: number; reset: boolean; complete: boolean;
  upserts: SourceMessage[]; removes: string[];
}
export function sameSource(a: SourceMessage, b: SourceMessage): boolean {
  return a.originalText === b.originalText && a.mediaTimeMs === b.mediaTimeMs && a.renderAtMs === b.renderAtMs &&
    a.translatable === b.translatable && a.sentAtEpochMs === b.sentAtEpochMs &&
    a.style.position === b.style.position && a.style.size === b.style.size && a.style.color === b.style.color &&
    a.style.font === b.style.font && (a.style.commands ?? []).join('\0') === (b.style.commands ?? []).join('\0');
}

/** Each delta is acknowledged before the next chunk; clocks do not carry comment text. */
export class SourcePublisher {
  private acknowledged = new Map<string, SourceMessage>();
  private target = new Map<string, SourceMessage>();
  private chunks: SourceChunk[] = [];
  private cursor = 0;
  private revision = 0;
  private initial = true;
  private sentAt = -Infinity;
  private send: (chunk: SourceChunk) => void;
  constructor(send: (chunk: SourceChunk) => void) { this.send = send; }
  get busy(): boolean { return this.cursor < this.chunks.length; }
  get complete(): boolean { return !this.initial && !this.busy; }
  reset(): void {
    this.acknowledged.clear(); this.target.clear(); this.chunks = []; this.cursor = 0;
    this.initial = true; this.sentAt = -Infinity;
  }
  update(rows: SourceMessage[], now: number): void {
    if (this.busy) { this.pump(now); return; }
    const next = new Map(rows.map(row => [row.id, row]));
    const upserts = rows.filter(row => !this.acknowledged.has(row.id) || !sameSource(this.acknowledged.get(row.id)!, row));
    const removes = [...this.acknowledged.keys()].filter(id => !next.has(id));
    if (!this.initial && !upserts.length && !removes.length) return;
    this.target = next; this.revision++; this.cursor = 0; this.chunks = [];
    const encoder = new TextEncoder();
    let chunk: SourceChunk = { revision: this.revision, index: 0, reset: this.initial, complete: false, upserts: [], removes: [] };
    let bytes = 1024;
    const push = () => {
      this.chunks.push(chunk);
      chunk = { revision: this.revision, index: this.chunks.length, reset: false, complete: false, upserts: [], removes: [] };
      bytes = 1024;
    };
    for (const row of upserts) {
      const size = encoder.encode(JSON.stringify(row)).length + 1;
      if (chunk.upserts.length + chunk.removes.length >= SOURCE_CHUNK_ITEMS || bytes + size > SOURCE_CHUNK_BYTES) push();
      chunk.upserts.push(row); bytes += size;
    }
    for (const id of removes) {
      const size = encoder.encode(JSON.stringify(id)).length + 1;
      if (chunk.upserts.length + chunk.removes.length >= SOURCE_CHUNK_ITEMS || bytes + size > SOURCE_CHUNK_BYTES) push();
      chunk.removes.push(id); bytes += size;
    }
    chunk.complete = true; this.chunks.push(chunk); this.sentAt = -Infinity;
    this.pump(now);
  }
  acknowledge(revision: number, index: number, now: number): void {
    const chunk = this.chunks[this.cursor];
    if (!chunk || chunk.revision !== revision || chunk.index !== index) return;
    this.cursor++; this.sentAt = -Infinity;
    if (!this.busy) { this.acknowledged = this.target; this.initial = false; this.chunks = []; this.cursor = 0; }
    else this.pump(now);
  }
  pump(now: number): void {
    if (this.busy && now - this.sentAt >= 1000) { this.sentAt = now; this.send(this.chunks[this.cursor]!); }
  }
}
