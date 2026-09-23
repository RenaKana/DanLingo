export type OnlineBudgetState = {
  day: string;
  limit: number;
  used: number | null;
  remaining: number | null;
  status: 'available' | 'exhausted' | 'unavailable';
  reason?: 'online-daily-limit-reached' | 'online-budget-storage-unavailable';
};

export type OnlineBudgetErrorCode = 'online-daily-limit-reached' | 'online-budget-storage-unavailable' | 'cancelled';

export class OnlineBudgetError extends Error {
  readonly code: OnlineBudgetErrorCode;

  constructor(code: OnlineBudgetErrorCode) {
    super(code);
    this.name = 'OnlineBudgetError';
    this.code = code;
  }
}

export const ONLINE_BUDGET_STORE_NAME = 'daily-usage';

type OnlineBudgetRecord = { day: string; used: number };

export function onlineBudgetDayKey(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError('Invalid online budget date');
  const year = date.getFullYear();
  if (year < 0 || year > 9999) throw new RangeError('Online budget date is outside the supported year range');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
}

export function validOnlineBudgetLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertLimit(limit: number): void {
  if (!validOnlineBudgetLimit(limit)) throw new RangeError('Online budget limit must be a positive safe integer');
}

function isBudgetRecord(value: unknown, day: string): value is OnlineBudgetRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<OnlineBudgetRecord>;
  return record.day === day && typeof record.used === 'number' && Number.isSafeInteger(record.used) && record.used >= 0;
}

function budgetState(day: string, limit: number, used: number): OnlineBudgetState {
  const exhausted = used >= limit;
  return {
    day,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    status: exhausted ? 'exhausted' : 'available',
    ...(exhausted ? { reason: 'online-daily-limit-reached' as const } : {}),
  };
}

function unavailableState(day: string, limit: number): OnlineBudgetState {
  return {
    day,
    limit,
    used: null,
    remaining: null,
    status: 'unavailable',
    reason: 'online-budget-storage-unavailable',
  };
}

function cancelledError(): OnlineBudgetError {
  return new OnlineBudgetError('cancelled');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(cancelledError());
        else resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class OnlineRequestBudget {
  readonly #indexedDB: IDBFactory | undefined;
  readonly #now: () => Date;
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | null = null;

  constructor(options: { indexedDB?: IDBFactory; now?: () => Date; databaseName?: string } = {}) {
    this.#indexedDB = options.indexedDB ?? globalThis.indexedDB;
    this.#now = options.now ?? (() => new Date());
    this.#databaseName = options.databaseName ?? 'danlingo-online-request-budget';
  }

  async read(limit: number): Promise<OnlineBudgetState> {
    assertLimit(limit);
    let day = this.#today();
    try {
      const database = await this.#openDatabase();
      while (true) {
        day = this.#today();
        const state = await this.#readDay(database, day, limit);
        const currentDay = this.#today();
        if (state.day === currentDay) return state;
        day = currentDay;
      }
    } catch {
      try { day = this.#today(); } catch { /* Preserve the last valid day if the clock becomes invalid. */ }
      return unavailableState(day, limit);
    }
  }

  async reserve(limit: number, signal?: AbortSignal): Promise<OnlineBudgetState> {
    assertLimit(limit);
    const day = this.#today();
    throwIfAborted(signal);

    let database: IDBDatabase;
    try {
      database = await withAbort(this.#openDatabase(), signal);
    } catch (error) {
      if (error instanceof OnlineBudgetError && error.code === 'cancelled') throw error;
      throw new OnlineBudgetError('online-budget-storage-unavailable');
    }
    throwIfAborted(signal);
    return this.#reserveDay(database, day, limit, signal);
  }

  #today(): string {
    return onlineBudgetDayKey(this.#now());
  }

  #openDatabase(): Promise<IDBDatabase> {
    if (this.#database) return this.#database;
    if (!this.#indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));

    let shared: Promise<IDBDatabase>;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.#indexedDB!.open(this.#databaseName, 1);
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ONLINE_BUDGET_STORE_NAME)) {
          database.createObjectStore(ONLINE_BUDGET_STORE_NAME, { keyPath: 'day' });
        }
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('IndexedDB open was blocked'));
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        if (!database.objectStoreNames.contains(ONLINE_BUDGET_STORE_NAME)) {
          settled = true;
          database.close();
          reject(new Error('IndexedDB budget store is missing'));
          return;
        }
        try {
          const store = database.transaction(ONLINE_BUDGET_STORE_NAME, 'readonly').objectStore(ONLINE_BUDGET_STORE_NAME);
          if (store.keyPath !== 'day' || store.autoIncrement) {
            settled = true;
            database.close();
            reject(new Error('IndexedDB budget store has an incompatible schema'));
            return;
          }
        } catch (error) {
          settled = true;
          database.close();
          reject(error);
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          if (this.#database === shared) this.#database = null;
        };
        resolve(database);
      };
    });

    shared = attempt.catch(error => {
      if (this.#database === shared) this.#database = null;
      throw error;
    });
    this.#database = shared;
    return shared;
  }

  #readDay(database: IDBDatabase, day: string, limit: number): Promise<OnlineBudgetState> {
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(ONLINE_BUDGET_STORE_NAME, 'readonly');
      } catch (error) {
        reject(error);
        return;
      }

      let result: OnlineBudgetState | null = null;
      const store = transaction.objectStore(ONLINE_BUDGET_STORE_NAME);
      const readDay = (requestedDay: string) => {
        const request = store.get(requestedDay);
        request.onsuccess = () => {
          let currentDay: string;
          try { currentDay = this.#today(); }
          catch { return; }
          if (currentDay !== requestedDay) {
            readDay(currentDay);
            return;
          }
          const record: unknown = request.result;
          if (record === undefined) result = budgetState(requestedDay, limit, 0);
          else if (isBudgetRecord(record, requestedDay)) result = budgetState(requestedDay, limit, record.used);
        };
      };
      readDay(day);
      transaction.oncomplete = () => {
        if (result) resolve(result);
        else reject(new Error('Invalid online budget record'));
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB read transaction aborted'));
    });
  }

  #reserveDay(database: IDBDatabase, day: string, limit: number, signal?: AbortSignal): Promise<OnlineBudgetState> {
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(ONLINE_BUDGET_STORE_NAME, 'readwrite', { durability: 'strict' });
      } catch {
        reject(new OnlineBudgetError('online-budget-storage-unavailable'));
        return;
      }

      let result: OnlineBudgetState | null = null;
      let exhausted = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        try {
          transaction.abort();
        } catch {
          // The transaction has already completed or entered its commit phase.
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const store = transaction.objectStore(ONLINE_BUDGET_STORE_NAME);
      const readReservationDay = (requestedDay: string) => {
        const request = store.get(requestedDay);
        request.onsuccess = () => {
          if (signal?.aborted) {
            onAbort();
            return;
          }
          let actualDay: string;
          try { actualDay = this.#today(); }
          catch {
            onAbort();
            return;
          }
          if (actualDay !== requestedDay) {
            readReservationDay(actualDay);
            return;
          }
          const stored: unknown = request.result;
          if (stored !== undefined && !isBudgetRecord(stored, requestedDay)) {
            onAbort();
            return;
          }
          const used = stored === undefined ? 0 : (stored as OnlineBudgetRecord).used;
          if (used >= limit) {
            exhausted = true;
            return;
          }

          const nextUsed = used + 1;
          result = budgetState(requestedDay, limit, nextUsed);
          store.put({ day: requestedDay, used: nextUsed } satisfies OnlineBudgetRecord);
        };
      };
      readReservationDay(day);
      transaction.oncomplete = () => {
        cleanup();
        // A late abort cannot undo a committed charge; reject so the caller skips sending.
        if (signal?.aborted) reject(cancelledError());
        else if (exhausted) reject(new OnlineBudgetError('online-daily-limit-reached'));
        else if (result) resolve(result);
        else reject(new OnlineBudgetError('online-budget-storage-unavailable'));
      };
      transaction.onabort = () => {
        cleanup();
        if (signal?.aborted) reject(cancelledError());
        else reject(new OnlineBudgetError('online-budget-storage-unavailable'));
      };
    });
  }
}
