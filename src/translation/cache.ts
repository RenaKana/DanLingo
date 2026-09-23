import { localGenerationProfile, normalizeReasoningEffort, PROMPT_VERSION } from '../core/config.ts';
import { LOCAL_TRANSLATION_VERSION, localPromptMode } from './local-policy.ts';
import { resolveConnection } from '../core/connection.ts';
import type { ProviderSettings } from '../core/types.ts';

export interface CachePolicy { ttlMs?: number; maxEntries?: number }
export interface CacheWriteOptions extends CachePolicy { resourceId: string }
export interface CacheWrite { key: string; text: string; resourceId: string }
export interface CacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
}
export interface TranslationCache {
  get(key: string, policy?: CachePolicy): Promise<string | undefined>;
  set(key: string, text: string, options: CacheWriteOptions): Promise<void>;
  getMany?(keys: string[], policy?: CachePolicy): Promise<Map<string, string>>;
  setMany?(entries: CacheWrite[], policy?: CachePolicy): Promise<void>;
  clear(resourceId?: string): Promise<void>;
  stats(): Promise<CacheStats>;
}
export interface CacheOptions extends CachePolicy {
  maxBytes?: number;
  /** Epoch milliseconds, never performance.now(): this timestamp survives worker restarts. */
  now?: () => number;
}
interface Entry {
  key: string;
  text: string;
  resourceId: string;
  createdAt: number;
  expiresAt: number;
  accessed: number;
  bytes: number;
}
interface Totals { key: 'totals'; entries: number; bytes: number; sequence: number }
const freshTotals = (): Totals => ({ key: 'totals', entries: 0, bytes: 0, sequence: 0 });
const encoder = new TextEncoder();
const DAY = 86_400_000;

/** Exact text and resource scope are deliberately retained; no credentials enter this key. */
export function translationCacheKey(
  resourceId: string, text: string, settings: ProviderSettings, promptVersion = PROMPT_VERSION,
): string {
  return JSON.stringify([
    promptVersion, resourceId, settings.backend === 'local' ? ['local', settings.localModelId] : resolveConnection(settings).configuredCompletionEndpoint, settings.model, settings.profile,
    settings.sourceLanguage, settings.targetLanguage,
    settings.backend === 'local' ? [LOCAL_TRANSLATION_VERSION, localPromptMode(settings), settings.localPerformance?.languageValidation ?? 'strict', localGenerationProfile(settings)] : normalizeReasoningEffort(settings, settings.thinkingEffort), text,
  ]);
}

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

class CacheBounds {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlMs: number;
  readonly now: () => number;
  hits = 0;
  misses = 0;
  evictions = 0;
  constructor(options: CacheOptions = {}) {
    this.maxEntries = limit(options.maxEntries, 20_000);
    this.maxBytes = limit(options.maxBytes, 8 * 1024 * 1024);
    this.ttlMs = limit(options.ttlMs, 90 * DAY);
    this.now = options.now ?? (() => Date.now());
  }
  capacity(policy?: CachePolicy): number { return Math.min(this.maxEntries, limit(policy?.maxEntries, this.maxEntries)); }
  lifetime(policy?: CachePolicy): number { return Math.min(this.ttlMs, limit(policy?.ttlMs, this.ttlMs)); }
  expired(entry: Entry, policy?: CachePolicy): boolean {
    return this.now() >= Math.min(entry.expiresAt, entry.createdAt + this.lifetime(policy));
  }
  entry(key: string, text: string, options: CacheWriteOptions): Entry {
    const now = this.now();
    return {
      key, text, resourceId: options.resourceId, createdAt: now,
      expiresAt: now + this.lifetime(options), accessed: 0,
      // Conservative logical UTF-8 payload budget, including key/context and record overhead.
      bytes: encoder.encode(key).byteLength + encoder.encode(text).byteLength + encoder.encode(options.resourceId).byteLength + 128,
    };
  }
  snapshot(entries: number, bytes: number): CacheStats {
    return { entries, bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes,
      hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
}

/** Async interface matches IndexedDB; Map insertion order supplies LRU ordering. */
export class MemoryTranslationCache extends CacheBounds implements TranslationCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private remove(key: string, evicted = false): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
    if (evicted) this.evictions++;
  }
  private prune(): void {
    for (const [key, entry] of this.entries) if (this.expired(entry)) this.remove(key, true);
  }
  private trim(capacity: number): void {
    while (this.entries.size > capacity || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest, true);
    }
  }
  async get(key: string, policy?: CachePolicy): Promise<string | undefined> {
    return (await this.getMany([key], policy)).get(key);
  }
  async getMany(keys: string[], policy?: CachePolicy): Promise<Map<string, string>> {
    this.prune(); this.trim(this.capacity(policy));
    const result = new Map<string, string>();
    for (const key of new Set(keys)) {
      const entry = this.entries.get(key);
      if (!entry || this.expired(entry, policy)) {
        if (entry) this.remove(key, true);
        this.misses++;
        continue;
      }
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, entry);
      result.set(key, entry.text);
    }
    return result;
  }
  async set(key: string, text: string, options: CacheWriteOptions): Promise<void> {
    return this.setMany([{ key, text, resourceId: options.resourceId }], options);
  }
  async setMany(entries: CacheWrite[], policy?: CachePolicy): Promise<void> {
    this.prune();
    const capacity = this.capacity(policy);
    for (const { key, text, resourceId } of entries) {
      this.remove(key);
      const entry = this.entry(key, text, { ...policy, resourceId });
      if (capacity > 0 && entry.bytes <= this.maxBytes && !this.expired(entry)) {
        this.entries.set(key, entry);
        this.bytes += entry.bytes;
      }
    }
    this.trim(capacity);
  }
  async clear(resourceId?: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (resourceId === undefined || entry.resourceId === resourceId) this.remove(key);
    }
  }
  async stats(): Promise<CacheStats> { this.prune(); return this.snapshot(this.entries.size, this.bytes); }
}

export interface IndexedDbCacheOptions extends CacheOptions {
  dbName?: string;
  indexedDB?: IDBFactory;
}

/** Instantiate in the trusted extension background. All accounting and eviction is transactional. */
export class IndexedDbTranslationCache extends CacheBounds implements TranslationCache {
  private readonly factory: IDBFactory | undefined;
  private readonly dbName: string;
  private database?: Promise<IDBDatabase>;
  constructor(options: IndexedDbCacheOptions = {}) {
    super(options);
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'danlingo-translations-v1';
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new Error('cache-unavailable')); return; }
      const request = this.factory.open(this.dbName, 1);
      let abandoned = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        const entries = db.createObjectStore('entries', { keyPath: 'key' });
        entries.createIndex('expiresAt', 'expiresAt');
        entries.createIndex('accessed', 'accessed');
        entries.createIndex('resourceId', 'resourceId');
        db.createObjectStore('meta', { keyPath: 'key' }).put(freshTotals());
      };
      request.onerror = () => reject(new Error('cache-unavailable'));
      request.onblocked = () => { abandoned = true; reject(new Error('cache-blocked')); };
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.database = undefined; };
        resolve(db);
      };
    }).catch((error: unknown) => { this.database = undefined; throw error; });
    return this.database;
  }
  private async transaction<T>(work: (
    store: IDBObjectStore, meta: IDBObjectStore, totals: Totals, finish: (result: T) => void,
  ) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['entries', 'meta'], 'readwrite');
      const store = tx.objectStore('entries');
      const meta = tx.objectStore('meta');
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('cache-transaction-failed'));
      const request = meta.get('totals');
      request.onsuccess = () => {
        try { work(store, meta, request.result as Totals ?? freshTotals(), (value) => { result = value; }); }
        catch { tx.abort(); }
      };
    });
  }
  private deleteCursor(cursor: IDBCursorWithValue, totals: Totals, evicted: boolean): void {
    const entry = cursor.value as Entry;
    cursor.delete();
    totals.entries--;
    totals.bytes -= entry.bytes;
    if (evicted) this.evictions++;
  }
  private prune(store: IDBObjectStore, totals: Totals, done: () => void): void {
    const now = this.now();
    const request = store.index('expiresAt').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || (cursor.value as Entry).expiresAt > now) { done(); return; }
      this.deleteCursor(cursor, totals, true);
      cursor.continue();
    };
  }
  private maintain(store: IDBObjectStore, totals: Totals, capacity: number, done: () => void): void {
    this.prune(store, totals, () => {
      if (totals.entries <= capacity && totals.bytes <= this.maxBytes) { done(); return; }
      const request = store.index('accessed').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || (totals.entries <= capacity && totals.bytes <= this.maxBytes)) { done(); return; }
        this.deleteCursor(cursor, totals, true); cursor.continue();
      };
    });
  }
  async get(key: string, policy?: CachePolicy): Promise<string | undefined> {
    return (await this.getMany([key], policy)).get(key);
  }
  async getMany(keys: string[], policy?: CachePolicy): Promise<Map<string, string>> {
    const unique = [...new Set(keys)];
    if (!unique.length) return new Map();
    return this.transaction((store, meta, totals, finish) => {
      this.maintain(store, totals, this.capacity(policy), () => {
        const result = new Map<string, string>();
        let remaining = unique.length;
        for (const key of unique) {
          const request = store.get(key);
          request.onsuccess = () => {
            const entry = request.result as Entry | undefined;
            if (!entry || this.expired(entry, policy)) {
              this.misses++;
              if (entry) {
                store.delete(key); totals.entries--; totals.bytes -= entry.bytes; this.evictions++;
              }
            } else {
              this.hits++;
              entry.accessed = ++totals.sequence;
              store.put(entry); result.set(key, entry.text);
            }
            if (--remaining === 0) { meta.put(totals); finish(result); }
          };
        }
      });
    });
  }
  async set(key: string, text: string, options: CacheWriteOptions): Promise<void> {
    return this.setMany([{ key, text, resourceId: options.resourceId }], options);
  }
  async setMany(entries: CacheWrite[], policy?: CachePolicy): Promise<void> {
    // Last value wins for duplicate keys, with one metadata update per unique record.
    const byKey = new Map<string, Entry>();
    for (const { key, text, resourceId } of entries) {
      byKey.delete(key); // Last occurrence also establishes the newest LRU position.
      byKey.set(key, this.entry(key, text, { ...policy, resourceId }));
    }
    const unique = [...byKey.values()];
    if (!unique.length) return;
    const capacity = this.capacity(policy);
    return this.transaction<void>((store, meta, totals, finish) => {
      let remaining = unique.length;
      for (const entry of unique) {
        const request = store.get(entry.key);
        request.onsuccess = () => {
          const old = request.result as Entry | undefined;
          if (old) { store.delete(entry.key); totals.entries--; totals.bytes -= old.bytes; }
          if (capacity > 0 && entry.bytes <= this.maxBytes && !this.expired(entry)) {
            entry.accessed = ++totals.sequence;
            store.put(entry); totals.entries++; totals.bytes += entry.bytes;
          }
          if (--remaining === 0) this.maintain(store, totals, capacity, () => { meta.put(totals); finish(undefined); });
        };
      }
    });
  }
  async clear(resourceId?: string): Promise<void> {
    return this.transaction<void>((store, meta, totals, finish) => {
      if (resourceId === undefined) {
        store.clear(); meta.put(freshTotals()); finish(undefined); return;
      }
      const request = store.index('resourceId').openCursor(resourceId);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { meta.put(totals); finish(undefined); return; }
        this.deleteCursor(cursor, totals, false); cursor.continue();
      };
    });
  }
  async stats(): Promise<CacheStats> {
    return this.transaction((store, meta, totals, finish) => {
      this.maintain(store, totals, this.maxEntries, () => { meta.put(totals); finish(this.snapshot(totals.entries, totals.bytes)); });
    });
  }
  async close(): Promise<void> {
    const database = this.database;
    this.database = undefined;
    if (database) (await database).close();
  }
}
