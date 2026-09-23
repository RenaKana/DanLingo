import { emoteProse, emotesIntact, type InlineEmotes } from './emotes.ts';
import type { BilibiliDecision } from './queue.ts';

type Data = Record<string, any>;
export interface RepairRecord {
  sourceId: string; nativeId?: string; originalText: string; strategy: 'manual' | 'superchat';
  capturedAt: number; lastSeenAt?: number; expiresAt?: number; text?: string; state: 'unprocessed' | 'translating' | 'translated' | 'failed' | 'expired' | 'unneeded';
  manualPriority: boolean;
  inlineEmotes?: InlineEmotes;
  timeoutRetried?: boolean;
  automaticUpdate?: boolean;
  displayedText?: string;
  submittedText?: string;
  resultVersion: number;
  application: 'generated' | 'native-updated' | 'recent-only';
  request?: { id: string; manual: boolean; force: boolean; deadline: number; purpose?: 'timeout' };
}
interface Options { now(): number; active(): boolean; eligible(text: string): boolean; timeoutMs(): number; send(payload: Data): void }

/** The saved wire original is the only repair source. DOM and translated bodies are never inputs. */
export class BilibiliRepairs {
  readonly records = new Map<string, RepairRecord>();
  private removed = new Set<string>();
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  capture(source: { sourceId: string; nativeId?: string; originalText: string; inlineEmotes?: InlineEmotes }, sc?: { expiresAt?: number }): RepairRecord | undefined {
    this.prune();
    if (this.removed.has(source.sourceId) || !source.originalText || source.originalText.length > 1000) return;
    const previous = this.records.get(source.sourceId);
    if (previous) return previous.originalText === source.originalText ? previous : undefined;
    const record: RepairRecord = { sourceId: source.sourceId, nativeId: source.nativeId, originalText: source.originalText,
      strategy: sc ? 'superchat' : 'manual', capturedAt: this.options.now(),
      ...(sc ? { expiresAt: sc.expiresAt } : {}), state: 'unprocessed', manualPriority: false,
      resultVersion: 0, application: 'recent-only', ...(source.inlineEmotes ? { inlineEmotes: { ...source.inlineEmotes } } : {}) };
    this.records.set(source.sourceId, record); this.publish(record); this.prune(); return record;
  }
  get(id: string): RepairRecord | undefined { this.prune(); return this.records.get(id); }
  seen(id: string) { const record=this.records.get(id); if(record?.strategy==='superchat')record.lastSeenAt=this.options.now(); }
  normal(id: string, text?: string, outcome?: Pick<BilibiliDecision, 'eligible' | 'reason'>) {
    const record = this.get(id);
    if (!record) return;
    record.submittedText = text ?? record.originalText;
    if (record.request || record.manualPriority || record.automaticUpdate) return;
    if (text) { record.text = text; record.state = 'translated'; record.resultVersion++; record.application = 'generated'; }
    // No translation is not itself a timeout. Reuse the native queue's admission
    // and release decision, including skips that waited behind a translated head.
    else record.state = outcome?.eligible === false ? 'unneeded' : outcome?.reason === 'timeout' ? 'expired' : 'failed';
    this.publish(record);
  }
  private publish(record: RepairRecord) {
    this.options.send({ type: 'repair-record', sourceId: record.sourceId, originalText: record.originalText,
      strategy: record.strategy, state: record.state, resultVersion: record.resultVersion, application: record.application,
      ...(record.inlineEmotes ? { emoteTokens: Object.keys(record.inlineEmotes) } : {}),
      requestId: record.request?.id, ...(record.text ? { text: record.text } : {}) });
  }
  /** Called only after identity-correlated native body observation, not on submission. */
  confirm(id: string, text: string) {
    const record = this.get(id);
    if (!record || ![record.originalText, record.text, record.displayedText, record.submittedText].includes(text)) return;
    record.displayedText = text;
  }
  applied(id: string, version: number, nativeUpdated: boolean): boolean {
    const record = this.get(id);
    if (!record?.text || record.resultVersion !== version) return false;
    const application = nativeUpdated ? 'native-updated' : 'recent-only';
    if (record.application === application) return false;
    record.application = application;
    this.options.send({ type: 'repair-applied', sourceId: id, resultVersion: version, application });
    return true;
  }
  /** Reserve a token also for a request originating in the isolated recent-record UI. */
  start(id: string, original: string, requestId: string, manual: boolean, force: boolean, authoritative = false, purpose?: 'timeout', timeoutMs?: number): boolean {
    const record = this.get(id);
    if (!record || record.originalText !== original || !this.options.active() || !requestId || requestId.length > 100 || force && !manual) return false;
    if (record.request?.id === requestId) return true;
    if (purpose === 'timeout' && (manual || force || record.strategy !== 'manual' || !Number.isFinite(timeoutMs) || timeoutMs! <= 0 || timeoutMs! > 33000)) return false;
    if (record.request) {
      if (!force && !authoritative) return false;
      this.cancel(record);
    }
    record.request = { id: requestId, manual, force, deadline: this.options.now() + (purpose === 'timeout' ? timeoutMs! : record.strategy === 'superchat' ? this.options.timeoutMs() : 15000), ...(purpose ? { purpose } : {}) };
    record.state = 'translating'; record.manualPriority ||= manual; this.publish(record); return true;
  }
  request(id: string, manual: boolean, force = false): string | undefined {
    const record = this.get(id);
    if (!record || !this.options.active()) return;
    if (record.request && (!force || record.request.force)) return record.request.id;
    if (!manual && (!this.options.eligible(emoteProse(record.originalText, record.inlineEmotes)) || record.text ||
        record.expiresAt !== undefined && this.options.now() >= record.expiresAt)) return;
    const requestId = crypto.randomUUID();
    if (!this.start(id, record.originalText, requestId, manual, force)) return;
    this.options.send({ type: 'repair-request', sourceId: id, originalText: record.originalText,
      requestId, strategy: record.strategy, manual, force });
    return requestId;
  }
  /** Automatic ordinary retry never bypasses successful cache or borrows the manual/SC budget. */
  requestTimeout(id: string, remainingMs: number): boolean {
    const record = this.get(id);
    if (!record || record.strategy !== 'manual' || record.timeoutRetried || record.request || record.text || !this.options.eligible(emoteProse(record.originalText, record.inlineEmotes))) return false;
    const requestId = crypto.randomUUID();
    if (!this.start(id, record.originalText, requestId, false, false, false, 'timeout', remainingMs)) return false;
    record.timeoutRetried = true;
    this.options.send({ type: 'repair-request', sourceId: id, originalText: record.originalText, requestId,
      strategy: 'manual', purpose: 'timeout', manual: false, force: false, retryDeadlineAt: record.request!.deadline });
    return true;
  }
  cancelTimeout(id: string) {
    const record = this.records.get(id);
    if (record?.request?.purpose !== 'timeout') return;
    this.cancel(record); record.state = 'expired'; this.publish(record);
  }
  result(value: Data): boolean {
    const record = typeof value.sourceId === 'string' ? this.get(value.sourceId) : undefined;
    if (!record?.request || record.request.id !== value.requestId) return false;
    const expired = this.options.now() >= record.request.deadline;
    const timeoutRetry = record.request.purpose === 'timeout';
    record.request = undefined;
    if (!expired && ['translated', 'cached'].includes(value.status) && typeof value.text === 'string' && value.text.trim() && value.text.length <= 2000 &&
        emotesIntact(record.originalText, value.text, Object.keys(record.inlineEmotes ?? {}))) {
      record.text = value.text; record.state = 'translated'; record.resultVersion++; record.application = 'generated';
      if (timeoutRetry) record.automaticUpdate = true;
    } else record.state = expired || value.status === 'expired' ? 'expired' : 'failed';
    this.publish(record); return true;
  }
  private cancel(record: RepairRecord) {
    if (!record.request) return;
    this.options.send({ type: 'repair-cancel', sourceId: record.sourceId, requestId: record.request.id });
    record.request = undefined;
  }
  abort(id: string, requestId: string) {
    const record = this.records.get(id);
    if (!record?.request || record.request.id !== requestId) return;
    record.request = undefined; record.state = record.text ? 'translated' : 'failed'; this.publish(record);
  }
  remove(ids: string[]) {
    for (const id of ids) {
      const record = this.records.get(id); if (record) this.cancel(record);
      this.records.delete(id); this.removed.add(id);
      this.options.send({ type: 'repair-record', sourceId: id, state: 'removed' });
    }
    while (this.removed.size > 2000) this.removed.delete(this.removed.values().next().value!);
  }
  prune() {
    const now = this.options.now();
    for (const record of this.records.values()) {
      if (now - (record.lastSeenAt ?? record.capturedAt) > 300000 || this.records.size > 300) {
        this.remove([record.sourceId]); continue;
      }
      // A pin's display lifetime is not the lifetime of its chat-history original.
      // Stop its automatic request, but keep manual retranslation available.
      if (record.expiresAt !== undefined && now >= record.expiresAt && record.request && !record.request.manual) {
        this.cancel(record); record.state = 'expired'; this.publish(record);
      }
      if (record.request && now >= record.request.deadline) { this.cancel(record); record.state = 'expired'; this.publish(record); }
    }
  }
  dispose() { for (const record of this.records.values()) this.cancel(record); this.records.clear(); this.removed.clear(); }
}
