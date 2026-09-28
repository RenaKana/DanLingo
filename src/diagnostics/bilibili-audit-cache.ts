import { translationCacheKey } from '../translation/cache.ts';
import { localQualityIssue } from '../translation/local-policy.ts';
import { needsTranslation } from '../core/messages.ts';
import { protectText } from '../translation/text.ts';
import type { Settings } from '../core/types.ts';

export const AUDIT_PATH = '/video/BV1yvhW6sEzi/';
export const AUDIT_PATHS = [AUDIT_PATH, '/video/BV1RHaw6mEDR/'];
/** Read-only integrity receipt. Unlike cache.stats(), this never prunes or updates LRU metadata. */
export async function auditCacheState(factory = globalThis.indexedDB) {
  if (!factory || typeof factory.databases !== 'function') return { available: false };
  if (!(await factory.databases()).some(db => db.name === 'danlingo-translations-v1'))
    return { available: true, databaseExists: false, entries: 0, metadataHash: null };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('danlingo-translations-v1');
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => reject(new Error('audit-cache-state-unavailable'));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    const stores = ['entries', 'meta'].filter(name => db.objectStoreNames.contains(name));
    if (stores.length !== 2) return { available: false };
    const state = await new Promise<{ entries: number; metadata: unknown[] }>((resolve, reject) => {
      const tx = db.transaction(stores, 'readonly');
      const count = tx.objectStore('entries').count(), metadata = tx.objectStore('meta').getAll();
      tx.oncomplete = () => resolve({ entries: count.result, metadata: metadata.result });
      tx.onabort = tx.onerror = () => reject(new Error('audit-cache-state-read-failed'));
    });
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(state.metadata)));
    return { available: true, databaseExists: true, entries: state.entries,
      metadataHash: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  } finally { db.close(); }
}
export function auditUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.bilibili.com' && AUDIT_PATHS.includes(`${url.pathname.replace(/\/$/, '')}/`) &&
      (url.searchParams.get('p') ?? '1') === '1' && url.hash === '#danlingo-audit';
  } catch { return false; }
}

/** Separate from the cache's getMany: no LRU, counters, pruning, writes or provider. */
export async function auditCache(settings: Settings, resourceId: string, texts: string[], factory = indexedDB) {
  const resource = JSON.stringify(['bilibili', 'video', resourceId]);
  const keys = texts.map(text => translationCacheKey(resource, text, settings));
  const entries = new Map<string, { text: string; createdAt: number; expiresAt: number }>();
  if ((await factory.databases()).some(db => db.name === 'danlingo-translations-v1')) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('danlingo-translations-v1');
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = () => reject(new Error('audit-cache-unavailable'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (keys.length) await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('entries', 'readonly');
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(new Error('audit-cache-read-failed'));
        for (const key of new Set(keys)) {
          const read = tx.objectStore('entries').get(key);
          read.onsuccess = () => { if (read.result) entries.set(key, read.result); };
        }
      });
    } finally { db.close(); }
  }
  const at = Date.now();
  return texts.map((text, index) => {
    const entry = entries.get(keys[index]!);
    const cached = !!entry && settings.cacheMaxEntries > 0 && at < Math.min(entry.expiresAt, entry.createdAt + Math.min(90, settings.cacheTtlDays) * 86400000) &&
      typeof entry.text === 'string' && !!entry.text.trim() && !localQualityIssue(settings, text, entry.text);
    const protectedText = protectText(text);
    return { cacheHit: cached, needsTranslation: needsTranslation(text, settings.targetLanguage, settings.sourceLanguage),
      textAllowed: !protectedText.reason && text.length <= settings.maxBatchChars && protectedText.text.length <= settings.maxBatchChars };
  });
}
