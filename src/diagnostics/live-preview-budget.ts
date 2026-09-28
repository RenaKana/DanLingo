import type { Usage } from '../core/types.ts';

export type LivePreviewPhase = 'main' | 'repair' | 'supplement';
export type LivePreviewSettlement = 'sent' | 'not-sent' | 'uncertain' | 'completed' | 'failed' | 'cancelled';

export interface LivePreviewItem {
  id: string;
  text: string;
}

export interface LivePreviewBudgetStore {
  read(): unknown | Promise<unknown>;
  write(record: LivePreviewBudgetRecord): void | Promise<void>;
}

export interface LivePreviewBudgetRecord {
  schema: 'danlingo-local-preview-budget';
  version: 1;
  taskId: string;
  modelIdentity: string;
  configIdentity: string;
  phaseRuns: { main: string | null; repair: string | null; supplement?: string | null };
  attempts: LivePreviewAttemptRecord[];
}

export interface LivePreviewAttemptRecord {
  attemptId: string;
  phase: LivePreviewPhase;
  runId: string;
  items: Array<{ id: string; utf16Length: number }>;
  status: 'reserved' | LivePreviewSettlement;
  usage?: Usage;
}

export interface LivePreviewPermit {
  readonly schema: 'danlingo-local-preview-permit';
  readonly taskId: string;
  readonly attemptId: string;
  readonly phase: LivePreviewPhase;
  readonly runId: string;
  readonly requestCount: 1;
  readonly itemCount: number;
  readonly utf16Chars: number;
}

type Counts = { requests: number; items: number; utf16Chars: number };
export interface LivePreviewBudgetLimits { total: Counts; phases: Record<LivePreviewPhase, Counts> }
type TokenField = keyof Usage;

const RECORD_SCHEMA = 'danlingo-local-preview-budget' as const;
const PERMIT_SCHEMA = 'danlingo-local-preview-permit' as const;
const TOKEN_FIELDS: readonly TokenField[] = [
  'promptTokens', 'completionTokens', 'totalTokens',
  'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens',
];
const PRIMARY_TOKEN_FIELDS: readonly TokenField[] = ['promptTokens', 'completionTokens', 'totalTokens'];
const PHASE_LIMITS: Record<LivePreviewPhase, Counts> = {
  main: { requests: 100, items: 100, utf16Chars: 10_000 },
  repair: { requests: 40, items: 40, utf16Chars: 4_000 },
  supplement: { requests: 100, items: 100, utf16Chars: 10_000 },
};
const TOTAL_LIMITS: Counts = { requests: 140, items: 140, utf16Chars: 14_000 };
const DEFAULT_LIMITS: LivePreviewBudgetLimits = { total: TOTAL_LIMITS, phases: PHASE_LIMITS };
const SENT_STATUSES = new Set<LivePreviewAttemptRecord['status']>(['sent', 'completed', 'failed', 'cancelled']);

const storeQueues = new WeakMap<object, Promise<void>>();

export class LivePreviewBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivePreviewBudgetError';
  }
}

function fail(message: string): never {
  throw new LivePreviewBudgetError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('Invalid local preview budget record.');
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('Invalid local preview budget record.');
}

function checkedString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim().length === 0) {
    fail(`Invalid ${label}.`);
  }
  return value;
}

function cloneUsage(value: unknown): Usage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('Invalid usage report.');
  const normalized: Usage = {};
  for (const key of Object.keys(value)) {
    if (!(TOKEN_FIELDS as readonly string[]).includes(key)) fail('Invalid usage report.');
    const count = value[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail('Invalid usage report.');
    normalized[key as TokenField] = count;
  }
  if (Object.keys(normalized).length === 0) fail('Invalid usage report.');
  return normalized;
}

function cloneRecord(input: unknown, limits: LivePreviewBudgetLimits = DEFAULT_LIMITS): LivePreviewBudgetRecord {
  if (!isRecord(input)) fail('Invalid local preview budget record.');
  checkKeys(input, ['schema', 'version', 'taskId', 'modelIdentity', 'configIdentity', 'phaseRuns', 'attempts']);
  if (input.schema !== RECORD_SCHEMA || input.version !== 1) fail('Unsupported local preview budget record.');
  const taskId = checkedString(input.taskId, 'task identity');
  const modelIdentity = checkedString(input.modelIdentity, 'model identity');
  const configIdentity = checkedString(input.configIdentity, 'configuration identity');
  if (!isRecord(input.phaseRuns)) fail('Invalid local preview budget record.');
  checkKeys(input.phaseRuns, ['main', 'repair'], ['supplement']);
  const main = input.phaseRuns.main === null ? null : checkedString(input.phaseRuns.main, 'main run identity');
  const repair = input.phaseRuns.repair === null ? null : checkedString(input.phaseRuns.repair, 'repair run identity');
  const supplement = Object.hasOwn(input.phaseRuns, 'supplement') ?
    input.phaseRuns.supplement === null ? null : checkedString(input.phaseRuns.supplement, 'supplement run identity') : undefined;
  if (repair !== null && main === null) fail('Invalid local preview budget record.');
  if (supplement !== null && supplement !== undefined && (main === null || repair === null)) {
    fail('Invalid local preview budget record.');
  }
  if (!Array.isArray(input.attempts)) fail('Invalid local preview budget record.');

  const seenAttempts = new Set<string>();
  const attempts: LivePreviewAttemptRecord[] = input.attempts.map(rawAttempt => {
    if (!isRecord(rawAttempt)) fail('Invalid local preview budget record.');
    checkKeys(rawAttempt, ['attemptId', 'phase', 'runId', 'items', 'status'], ['usage']);
    const attemptId = checkedString(rawAttempt.attemptId, 'attempt identity');
    if (seenAttempts.has(attemptId)) fail('Invalid local preview budget record.');
    seenAttempts.add(attemptId);
    if (rawAttempt.phase !== 'main' && rawAttempt.phase !== 'repair' && rawAttempt.phase !== 'supplement') {
      fail('Invalid local preview budget record.');
    }
    const phase = rawAttempt.phase;
    const runId = checkedString(rawAttempt.runId, 'run identity');
    if ((phase === 'main' ? main : phase === 'repair' ? repair : supplement) !== runId) {
      fail('Invalid local preview budget record.');
    }
    if (!['reserved', 'sent', 'not-sent', 'uncertain', 'completed', 'failed', 'cancelled'].includes(String(rawAttempt.status))) {
      fail('Invalid local preview budget record.');
    }
    if (!Array.isArray(rawAttempt.items) || rawAttempt.items.length === 0) fail('Invalid local preview budget record.');
    const seenItems = new Set<string>();
    const items = rawAttempt.items.map(rawItem => {
      if (!isRecord(rawItem)) fail('Invalid local preview budget record.');
      checkKeys(rawItem, ['id', 'utf16Length']);
      const id = checkedString(rawItem.id, 'item identity');
      if (seenItems.has(id)) fail('Invalid local preview budget record.');
      seenItems.add(id);
      if (typeof rawItem.utf16Length !== 'number' || !Number.isSafeInteger(rawItem.utf16Length) || rawItem.utf16Length < 0) {
        fail('Invalid local preview budget record.');
      }
      return { id, utf16Length: rawItem.utf16Length };
    });
    const status = rawAttempt.status as LivePreviewAttemptRecord['status'];
    const usage = cloneUsage(rawAttempt.usage);
    if (status === 'not-sent' && usage !== undefined) fail('Invalid local preview budget record.');
    const result: LivePreviewAttemptRecord = { attemptId, phase, runId, items, status };
    if (usage !== undefined) result.usage = usage;
    return result;
  });

  const normalized: LivePreviewBudgetRecord = {
    schema: RECORD_SCHEMA,
    version: 1,
    taskId,
    modelIdentity,
    configIdentity,
    phaseRuns: { main, repair, ...(supplement === undefined ? {} : { supplement }) },
    attempts,
  };
  assertWithinLimits(normalized, limits);
  return normalized;
}

function cloneForWrite(record: LivePreviewBudgetRecord): LivePreviewBudgetRecord {
  return {
    schema: RECORD_SCHEMA,
    version: 1,
    taskId: record.taskId,
    modelIdentity: record.modelIdentity,
    configIdentity: record.configIdentity,
    phaseRuns: { ...record.phaseRuns },
    attempts: record.attempts.map(attempt => ({
      attemptId: attempt.attemptId,
      phase: attempt.phase,
      runId: attempt.runId,
      items: attempt.items.map(item => ({ ...item })),
      status: attempt.status,
      ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
    })),
  };
}

function countsFor(attempts: readonly LivePreviewAttemptRecord[]): Counts {
  return attempts.reduce<Counts>((counts, attempt) => ({
    requests: counts.requests + 1,
    items: counts.items + attempt.items.length,
    utf16Chars: counts.utf16Chars + attempt.items.reduce((sum, item) => sum + item.utf16Length, 0),
  }), { requests: 0, items: 0, utf16Chars: 0 });
}

function fits(counts: Counts, limits: Counts): boolean {
  return counts.requests <= limits.requests && counts.items <= limits.items && counts.utf16Chars <= limits.utf16Chars;
}

function assertWithinLimits(record: LivePreviewBudgetRecord, limits: LivePreviewBudgetLimits): void {
  for (const phase of ['main', 'repair', 'supplement'] as const) {
    if (!fits(countsFor(record.attempts.filter(attempt => attempt.phase === phase)), limits.phases[phase])) {
      fail('Stored local preview budget exceeds its limit.');
    }
  }
  if (!fits(countsFor(record.attempts), limits.total)) fail('Stored local preview budget exceeds its limit.');
}

async function withStoreLock<T>(store: object, operation: () => Promise<T>): Promise<T> {
  const previous = storeQueues.get(store) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  storeQueues.set(store, current.then(() => undefined, () => undefined));
  return current;
}

function validateStore(store: unknown): asserts store is LivePreviewBudgetStore {
  if (store === null || typeof store !== 'object' || typeof (store as LivePreviewBudgetStore).read !== 'function' ||
      typeof (store as LivePreviewBudgetStore).write !== 'function') {
    fail('A readable and writable local preview budget store is required.');
  }
}

function sumUsage(attempts: readonly LivePreviewAttemptRecord[]): { totals: Usage; reportedAttempts: number } {
  const totals: Usage = {};
  let reportedAttempts = 0;
  for (const attempt of attempts) {
    if (!attempt.usage || attempt.status === 'not-sent') continue;
    reportedAttempts += 1;
    for (const field of TOKEN_FIELDS) {
      const value = attempt.usage[field];
      if (value === undefined) continue;
      const next = (totals[field] ?? 0) + value;
      if (!Number.isSafeInteger(next)) fail('Usage total exceeds the supported range.');
      totals[field] = next;
    }
  }
  return { totals, reportedAttempts };
}

function sameItems(recorded: readonly { id: string; utf16Length: number }[], items: readonly LivePreviewItem[]): boolean {
  if (!Array.isArray(items) || recorded.length !== items.length) return false;
  try {
    return items.every((item, index) => {
      const prior = recorded[index];
      return prior !== undefined && isRecord(item) && typeof item.id === 'string' && typeof item.text === 'string' &&
        item.id === prior.id && item.text.length === prior.utf16Length;
    });
  } catch {
    return false;
  }
}

export class LivePreviewBudget {
  readonly #store: LivePreviewBudgetStore;
  readonly #limits: LivePreviewBudgetLimits;
  #taskId = '';
  #modelIdentity = '';
  #configIdentity = '';
  #record: LivePreviewBudgetRecord | null = null;
  readonly #permits = new WeakSet<object>();
  readonly #permitByAttempt = new Map<string, object>();

  constructor(store: LivePreviewBudgetStore, limits: LivePreviewBudgetLimits = DEFAULT_LIMITS) {
    validateStore(store);
    this.#store = store;
    for (const bound of [limits.total, limits.phases?.main, limits.phases?.repair, limits.phases?.supplement]) {
      if (!bound || ![bound.requests, bound.items, bound.utf16Chars].every(n => Number.isSafeInteger(n) && n >= 0))
        fail('Invalid local preview budget limits.');
    }
    this.#limits = structuredClone(limits);
  }

  /** Convenience form for callers that prefer opening in one expression. */
  static async open(
    store: LivePreviewBudgetStore,
    taskId: string,
    modelIdentity: string,
    configIdentity: string,
  ): Promise<LivePreviewBudget> {
    const budget = new LivePreviewBudget(store);
    return budget.open(taskId, modelIdentity, configIdentity);
  }

  async open(taskId: string, modelIdentity: string, configIdentity: string): Promise<this> {
    if (this.#record !== null) fail('This local preview budget is already open.');
    checkedString(taskId, 'task identity');
    checkedString(modelIdentity, 'model identity');
    checkedString(configIdentity, 'configuration identity');
    return withStoreLock(this.#store, async () => {
      let raw: unknown;
      try {
        raw = await this.#store.read();
      } catch {
        fail('Unable to read the local preview budget.');
      }
      let record: LivePreviewBudgetRecord;
      if (raw === null || raw === undefined) {
        record = {
          schema: RECORD_SCHEMA,
          version: 1,
          taskId,
          modelIdentity,
          configIdentity,
          phaseRuns: { main: null, repair: null, supplement: null },
          attempts: [],
        };
        await LivePreviewBudget.persist(this.#store, record);
      } else {
        record = cloneRecord(raw, this.#limits);
        if (record.taskId !== taskId) fail('The stored budget belongs to a different task.');
        if (record.modelIdentity !== modelIdentity || record.configIdentity !== configIdentity) {
          fail('The stored budget identity does not match the selected model and configuration.');
        }
        let recovered = false;
        for (const attempt of record.attempts) {
          if (attempt.status === 'reserved') {
            attempt.status = 'uncertain';
            recovered = true;
          }
        }
        if (recovered) await LivePreviewBudget.persist(this.#store, record);
      }
      this.#taskId = taskId;
      this.#modelIdentity = modelIdentity;
      this.#configIdentity = configIdentity;
      this.#record = record;
      return this;
    });
  }

  private static async persist(store: LivePreviewBudgetStore, record: LivePreviewBudgetRecord): Promise<void> {
    try {
      await store.write(cloneForWrite(record));
    } catch {
      fail('Unable to persist the local preview budget.');
    }
  }

  async #readLatest(): Promise<LivePreviewBudgetRecord> {
    if (this.#record === null) fail('The local preview budget is not open.');
    let raw: unknown;
    try {
      raw = await this.#store.read();
    } catch {
      fail('Unable to read the local preview budget.');
    }
    if (raw === null || raw === undefined) fail('The local preview budget record is missing.');
    const latest = cloneRecord(raw, this.#limits);
    if (latest.taskId !== this.#taskId) fail('The stored budget belongs to a different task.');
    if (latest.modelIdentity !== this.#modelIdentity || latest.configIdentity !== this.#configIdentity) {
      fail('The stored budget identity does not match the selected model and configuration.');
    }
    return latest;
  }

  async #commit<T>(change: (record: LivePreviewBudgetRecord) => { record: LivePreviewBudgetRecord; value: T }): Promise<T> {
    if (this.#record === null) fail('The local preview budget is not open.');
    return withStoreLock(this.#store, async () => {
      const latest = await this.#readLatest();
      const outcome = change(latest);
      if (outcome.record !== latest) await LivePreviewBudget.persist(this.#store, outcome.record);
      this.#record = outcome.record;
      return outcome.value;
    });
  }

  async beginPhase(phase: LivePreviewPhase, runId: string, repairReason?: string): Promise<ReturnType<LivePreviewBudget['snapshot']>> {
    if (phase !== 'main' && phase !== 'repair' && phase !== 'supplement') fail('Invalid local preview phase.');
    checkedString(runId, 'run identity');
    if (phase !== 'main' && (typeof repairReason !== 'string' || repairReason.trim().length === 0 || repairReason.length > 4096)) {
      fail(`A ${phase} reason is required.`);
    }
    return this.#commit(record => {
      if (phase === 'main') {
        if (record.phaseRuns.repair !== null || record.phaseRuns.supplement) fail('The main phase cannot begin after repair.');
        if (record.phaseRuns.main !== null) {
          if (record.phaseRuns.main !== runId) fail('The main phase already has a different run identity.');
          return { record, value: this.snapshotFrom(record) };
        }
        const next = cloneForWrite(record);
        next.phaseRuns.main = runId;
        return { record: next, value: this.snapshotFrom(next) };
      }
      if (record.phaseRuns.main === null) fail('Repair can begin only after the main phase.');
      if (phase === 'supplement') {
        if (record.phaseRuns.repair === null) fail('Supplement can begin only after the repair phase.');
        if (record.phaseRuns.supplement) {
          if (record.phaseRuns.supplement !== runId) fail('The supplement phase already has a different run identity.');
          return { record, value: this.snapshotFrom(record) };
        }
        const next = cloneForWrite(record);
        next.phaseRuns.supplement = runId;
        return { record: next, value: this.snapshotFrom(next) };
      }
      if (record.phaseRuns.supplement) fail('Repair cannot begin after supplement.');
      if (record.phaseRuns.repair !== null) {
        if (record.phaseRuns.repair !== runId) fail('The repair phase already has a different run identity.');
        return { record, value: this.snapshotFrom(record) };
      }
      const next = cloneForWrite(record);
      next.phaseRuns.repair = runId;
      return { record: next, value: this.snapshotFrom(next) };
    });
  }

  async reserve(input: { phase: LivePreviewPhase; runId: string; attemptId: string; items: readonly LivePreviewItem[] }): Promise<LivePreviewPermit> {
    if (!isRecord(input) || (input.phase !== 'main' && input.phase !== 'repair' && input.phase !== 'supplement')) {
      fail('Invalid local preview reservation.');
    }
    const phase = input.phase;
    const runId = checkedString(input.runId, 'run identity');
    const attemptId = checkedString(input.attemptId, 'attempt identity');
    if (!Array.isArray(input.items) || input.items.length === 0) fail('A reservation must contain at least one item.');
    const items: Array<{ id: string; utf16Length: number }> = [];
    const seen = new Set<string>();
    for (const rawItem of input.items) {
      if (!isRecord(rawItem)) fail('Invalid local preview item.');
      const id = checkedString(rawItem.id, 'item identity');
      if (seen.has(id)) fail('A reservation cannot contain duplicate item identities.');
      seen.add(id);
      if (typeof rawItem.text !== 'string') fail('Invalid local preview item text.');
      items.push({ id, utf16Length: rawItem.text.length });
    }
    const utf16Chars = items.reduce((sum, item) => sum + item.utf16Length, 0);
    if (!Number.isSafeInteger(utf16Chars)) fail('Reservation size exceeds the supported range.');
    const permit = await this.#commit(record => {
      if (record.phaseRuns[phase] !== runId) {
        fail('The reservation does not match the active phase run.');
      }
      if (phase === 'main' && record.phaseRuns.repair !== null) fail('Main reservations are closed after repair begins.');
      if (phase !== 'supplement' && record.phaseRuns.supplement) fail('Earlier reservations are closed after supplement begins.');
      if (record.attempts.some(attempt => attempt.attemptId === attemptId)) fail('Attempt identities cannot be reused.');
      const attempt: LivePreviewAttemptRecord = { attemptId, phase, runId, items, status: 'reserved' };
      const next = cloneForWrite(record);
      next.attempts.push(attempt);
      assertWithinLimits(next, this.#limits);
      const permit: LivePreviewPermit = Object.freeze({
        schema: PERMIT_SCHEMA,
        taskId: this.#taskId,
        attemptId,
        phase,
        runId,
        requestCount: 1,
        itemCount: items.length,
        utf16Chars,
      });
      return { record: next, value: permit };
    });
    this.#permits.add(permit);
    this.#permitByAttempt.set(attemptId, permit);
    return permit;
  }

  validatePermit(permit: unknown, items: readonly LivePreviewItem[]): boolean {
    if (this.#record === null || !isRecord(permit) || !this.#permits.has(permit)) return false;
    if (permit.schema !== PERMIT_SCHEMA || permit.taskId !== this.#taskId || typeof permit.attemptId !== 'string') return false;
    const attempt = this.#record.attempts.find(candidate => candidate.attemptId === permit.attemptId);
    return attempt !== undefined && attempt.status === 'reserved' && attempt.phase === permit.phase &&
      attempt.runId === permit.runId && sameItems(attempt.items, items);
  }

  async settle(attemptId: string, result: { status: LivePreviewSettlement; usage?: Usage }): Promise<ReturnType<LivePreviewBudget['snapshot']>> {
    checkedString(attemptId, 'attempt identity');
    if (!isRecord(result) || !['sent', 'not-sent', 'uncertain', 'completed', 'failed', 'cancelled'].includes(String(result.status))) {
      fail('Invalid local preview settlement.');
    }
    const status = result.status as LivePreviewSettlement;
    const usage = cloneUsage(result.usage);
    if (status === 'not-sent' && usage !== undefined) fail('A not-sent attempt cannot include token usage.');
    return this.#commit(record => {
      const index = record.attempts.findIndex(attempt => attempt.attemptId === attemptId);
      if (index < 0) fail('Unknown local preview attempt.');
      const existing = record.attempts[index];
      if (!existing) fail('Unknown local preview attempt.');
      const currentStatus = existing.status;
      const finalAfterSend = ['completed', 'failed', 'cancelled'].includes(status);
      if (currentStatus === 'sent' ? !finalAfterSend : currentStatus !== 'reserved') {
        fail('A local preview attempt has already been settled.');
      }
      if (status === 'not-sent' && currentStatus !== 'reserved') fail('A sent attempt cannot be marked not-sent.');
      if (currentStatus === 'sent' && status === 'uncertain') fail('A sent attempt cannot become uncertain.');
      const next = cloneForWrite(record);
      const settled = next.attempts[index];
      if (!settled) fail('Unknown local preview attempt.');
      settled.status = status;
      if (usage !== undefined) settled.usage = usage;
      sumUsage(next.attempts);
      return { record: next, value: this.snapshotFrom(next) };
    }).then(snapshot => {
      const permit = this.#permitByAttempt.get(attemptId);
      if (permit && status !== 'sent') {
        this.#permits.delete(permit);
        this.#permitByAttempt.delete(attemptId);
      }
      return snapshot;
    });
  }

  async readSnapshot(): Promise<ReturnType<LivePreviewBudget['snapshot']> | null> {
    return withStoreLock(this.#store, async () => {
      let raw: unknown;
      try {
        raw = await this.#store.read();
      } catch {
        fail('Unable to read the local preview budget.');
      }
      if (raw === null || raw === undefined) return null;
      const record = cloneRecord(raw, this.#limits);
      if (this.#record !== null && (record.taskId !== this.#taskId || record.modelIdentity !== this.#modelIdentity ||
          record.configIdentity !== this.#configIdentity)) {
        fail('The stored budget identity does not match the open task.');
      }
      return this.snapshotFrom(record);
    });
  }

  snapshot(): {
    taskId: string;
    phases: Record<LivePreviewPhase, { runId: string | null; limits: Counts; occupied: Counts; actualSent: Counts; remaining: Counts }>;
    total: { limits: Counts; occupied: Counts; actualSent: Counts; remaining: Counts };
    attempts: Array<{ attemptId: string; phase: LivePreviewPhase; runId: string; status: LivePreviewAttemptRecord['status']; items: number; utf16Chars: number }>;
    usage: { complete: boolean; sentAttempts: number; uncertainAttempts: number; reportedAttempts: number; totals: Usage };
  } {
    if (this.#record === null) fail('The local preview budget is not open.');
    return this.snapshotFrom(this.#record);
  }

  private snapshotFrom(record: LivePreviewBudgetRecord) {
    const summarize = (attempts: readonly LivePreviewAttemptRecord[], limits: Counts) => {
      const occupied = countsFor(attempts);
      const actualSent = countsFor(attempts.filter(attempt => SENT_STATUSES.has(attempt.status)));
      return {
        limits: { ...limits },
        occupied,
        actualSent,
        remaining: {
          requests: Math.max(0, limits.requests - occupied.requests),
          items: Math.max(0, limits.items - occupied.items),
          utf16Chars: Math.max(0, limits.utf16Chars - occupied.utf16Chars),
        },
      };
    };
    const mainAttempts = record.attempts.filter(attempt => attempt.phase === 'main');
    const repairAttempts = record.attempts.filter(attempt => attempt.phase === 'repair');
    const supplementAttempts = record.attempts.filter(attempt => attempt.phase === 'supplement');
    const total = summarize(record.attempts, this.#limits.total);
    const phaseSummary = (attempts: readonly LivePreviewAttemptRecord[], limits: Counts) => {
      const summary = summarize(attempts, limits);
      return { ...summary, remaining: {
        requests: Math.min(summary.remaining.requests, total.remaining.requests),
        items: Math.min(summary.remaining.items, total.remaining.items),
        utf16Chars: Math.min(summary.remaining.utf16Chars, total.remaining.utf16Chars),
      } };
    };
    const uncertainAttempts = record.attempts.filter(attempt => attempt.status === 'uncertain' || attempt.status === 'reserved').length;
    const sentAttempts = record.attempts.filter(attempt => SENT_STATUSES.has(attempt.status));
    const { totals, reportedAttempts } = sumUsage(record.attempts);
    const usageComplete = uncertainAttempts === 0 && sentAttempts.every(attempt =>
      attempt.usage !== undefined && PRIMARY_TOKEN_FIELDS.every(field => attempt.usage?.[field] !== undefined));
    return {
      taskId: record.taskId,
      phases: {
        main: { runId: record.phaseRuns.main, ...phaseSummary(mainAttempts, this.#limits.phases.main) },
        repair: { runId: record.phaseRuns.repair, ...phaseSummary(repairAttempts, this.#limits.phases.repair) },
        supplement: { runId: record.phaseRuns.supplement ?? null, ...phaseSummary(supplementAttempts, this.#limits.phases.supplement) },
      },
      total,
      attempts: record.attempts.map(attempt => ({
        attemptId: attempt.attemptId,
        phase: attempt.phase,
        runId: attempt.runId,
        status: attempt.status,
        items: attempt.items.length,
        utf16Chars: attempt.items.reduce((sum, item) => sum + item.utf16Length, 0),
      })),
      usage: {
        complete: usageComplete,
        sentAttempts: sentAttempts.length,
        uncertainAttempts,
        reportedAttempts,
        totals,
      },
    };
  }
}
