import type { LocalGpuInfo } from './types.ts';

/** Metadata-only native logger. No prompt, template, message or generated text is retained. */
export class NativeTelemetry {
  slots = new Set<number>();
  active = new Set<number>();
  peakActive = 0;
  contextTokens?: number;
  warmup = false;
  timings = new Map<number, { promptMs?: number; decodeMs?: number; task?: number }>();
  evidence: string[] = [];
  observe(value: unknown, gpu: LocalGpuInfo): boolean {
    if (typeof value !== 'string' || value.length > 2048) return false;
    let changed = false;
    for (const line of value.split('\n')) {
      const slot = line.match(/\bslot\s+(\w+):?\s+id\s+(\d+)\s*\|\s*task\s+(-?\d+)\s*\|\s*(.*)/);
      if (slot) {
        const id = Number(slot[2]), task = Number(slot[3]), status = slot[4]!;
        this.slots.add(id);
        if (/new prompt|processing task|prompt done|generating/.test(status)) this.active.add(id);
        if (/stop processing|released|release/.test(slot[1]! + ' ' + status)) this.active.delete(id);
        this.peakActive = Math.max(this.peakActive, this.active.size);
        const ms = status.match(/(prompt eval|eval) time\s*=\s*([\d.]+)\s*ms/);
        if (ms) {
          const timing = this.timings.get(id) ?? {};
          timing[ms[1] === 'prompt eval' ? 'promptMs' : 'decodeMs'] = Number(ms[2]);
          timing.task = task; this.timings.set(id, timing);
        }
        changed = true;
      }
      const seq = line.match(/\bn_seq_max\s*=\s*(\d+)/);
      if (seq) { for (let i = 0; i < Number(seq[1]); i++) this.slots.add(i); changed = true; }
      const ctx = line.match(/\bn_ctx\s*=\s*(\d+)/);
      if (ctx) { this.contextTokens = Number(ctx[1]); changed = true; }
      const fa = line.match(/\bflash_attn\s*=\s*(\w+)/);
      if (fa && ['1', '0', 'enabled', 'disabled', 'true', 'false'].includes(fa[1]!)) { gpu.flashAttention = ['1', 'enabled', 'true'].includes(fa[1]!); changed = true; }
      const faResolved = line.match(/^llama_context:.*[Ff]lash [Aa]ttention.*(?:set to |is )(enabled|disabled)/);
      if (faResolved) { gpu.flashAttention = faResolved[1] === 'enabled'; changed = true; this.evidence.push('flash_attention_actual=' + faResolved[1]); }
      if (/^(llama_context|ggml_webgpu\w*):.*(?:flash_attn|[Ff]lash [Aa]ttention)/.test(line)) this.evidence.push(line.trim().slice(0, 240));
      const buffer = line.match(/\bWebGPU\d*\s+(KV|compute) buffer size\s*=\s*([\d.]+) MiB/i);
      if (buffer) { gpu[buffer[1]!.toLowerCase() === 'kv' ? 'kvBufferMiB' : 'computeBufferMiB'] = Number(buffer[2]); changed = true; }
      if (/warming up|warmup.*running|running.*warmup/i.test(line)) { this.warmup = true; changed = true; }
      // Only numeric configuration and scheduling lines; never include trailing free text.
      if (seq || ctx || fa || buffer || slot) {
        const safe = slot ? `slot=${slot[2]} task=${slot[3]} active=${this.active.has(Number(slot[2]))}`
          : seq ? `n_seq_max=${seq[1]}` : ctx ? `n_ctx=${ctx[1]}` : fa ? `flash_attn=${gpu.flashAttention ?? 'unknown'}`
          : `${buffer![1]}_buffer_MiB=${buffer![2]}`;
        if (this.evidence.at(-1) !== safe) { this.evidence.push(safe); if (this.evidence.length > 256) this.evidence.shift(); }
      }
    }
    return changed;
  }
}
