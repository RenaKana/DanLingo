import type { Usage } from '../core/types.ts';

/** Completed-request timing, not a prediction of first streamed output or billable usage. */
export interface LiveTimingEstimate {
  expectedMs: number;
  samples: number;
  charsBucket: 0 | 1 | 2;
  loadBucket: 0 | 1 | 2;
}
export interface LiveDispatchDecision {
  trigger: 'batch-limit' | 'candidate-limit' | 'deadline-margin' | 'aggregation-limit';
  queuedMs: number;
  estimate: LiveTimingEstimate;
  /** At most one row per API task (batchSize <= 200), using engine IDs only. */
  budgets: { taskId: string; earliestMs: number; latestMs: number; subscribers: number }[];
  declined: { characters: number; inputTokens: number; outputTokens: number; deadlineRegression: number; quota: number };
  /** First rejected timing expansion only; counts above include all candidates. */
  timingDecline?: { current: LiveTimingEstimate; expanded: LiveTimingEstimate; budgetMs: number };
  /** Same-count/bucket forecast, not a guarantee. Skipped tasks keep their deadlines. */
  backfill?: { items: number; forecast: LiveTimingEstimate;
    replacements: { skippedTaskId: string; selectedTaskId: string }[] };
}

/** Local, bounded diagnostics. IDs are engine-generated; no text, keys, URLs or user IDs. */
export type TranslationTrace =
  | { type: 'arrival'; at: number; occurrenceId: number; deadlineAt: number }
  | { type: 'bind'; at: number; occurrenceId: number; taskId: string; reused: boolean }
  | { type: 'queued'; at: number; taskId: string }
  | { type: 'ready'; at: number; occurrenceId: number; taskId?: string; status: string; reason?: string }
  | { type: 'attempt'; at: number; batchId: number; taskIds: string[]; items: number; attempt: number;
      inputTokenUpperEstimate: number; outputTokenEstimate: number; activeRequests: number; liveDispatch?: LiveDispatchDecision }
  | { type: 'settled'; at: number; batchId: number; durationMs: number; status: string; usage?: Usage;
      usageKnown: boolean; duplicateIds: number };

/** A conservative byte-based sizing bound, NOT a tokenizer or billable usage measurement. */
export function liveTokenEstimate(text: string): { input: number; output: number } {
  const bytes = new TextEncoder().encode(text).byteLength;
  const framedBytes = new TextEncoder().encode(JSON.stringify([199, text]) + '\n').byteLength;
  return { input: framedBytes, output: Math.max(32, bytes * 2 + 12) };
}
