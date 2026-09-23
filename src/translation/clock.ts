/** Deadlines use the background's monotonic clock; persisted TTLs use wall time. */
export interface TranslationClock {
  now(): number;
  wallNow(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function createClock(input?: Partial<TranslationClock> | (() => number)): TranslationClock {
  const source = typeof input === 'function' ? { now: input } : input;
  return {
    now: source?.now?.bind(source) ?? (() => performance.now()),
    wallNow: source?.wallNow?.bind(source) ?? (() => Date.now()),
    setTimeout: source?.setTimeout?.bind(source) ?? ((callback, delay) => setTimeout(callback, delay)),
    clearTimeout: source?.clearTimeout?.bind(source) ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  };
}
