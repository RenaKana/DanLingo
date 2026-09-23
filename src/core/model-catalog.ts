import { resolveConnection } from './connection.ts';
import type { ProviderSettings } from './types.ts';
export const MODEL_CATALOG_KEY = 'modelCatalog.v1';
export interface ModelCatalog { models: string[]; fetchedAt: number }
type Storage = { get(key: string): Promise<Record<string, any>>; set(value: Record<string, unknown>): Promise<void> };
/** Only a one-way, destination-bound identifier is persisted. Never store the submitted Key here. */
export async function modelCatalogScope(settings: ProviderSettings, apiKey: string): Promise<string> {
  const connection = resolveConnection(settings);
  const bytes = new TextEncoder().encode(JSON.stringify([connection.protocol, connection.configuredCompletionEndpoint, apiKey]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export class ModelCatalogStore {
  private writing: Promise<void> = Promise.resolve();
  private storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  async read(scope: string): Promise<ModelCatalog | undefined> {
    const entry = (await this.storage.get(MODEL_CATALOG_KEY))[MODEL_CATALOG_KEY]?.[scope];
    if (!entry || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.models)) return;
    const models = entry.models.filter((value: unknown): value is string => typeof value === 'string' && !!value.trim()).slice(0, 1000);
    return models.length ? { models, fetchedAt: entry.fetchedAt } : undefined;
  }
  write(scope: string, models: string[], fetchedAt = Date.now()): Promise<void> {
    const entry = { models: [...new Set(models.filter(value => typeof value === 'string' && !!value.trim()))].slice(0, 1000), fetchedAt };
    if (!entry.models.length) return Promise.resolve();
    const operation = this.writing.catch(() => {}).then(async () => {
      const raw = (await this.storage.get(MODEL_CATALOG_KEY))[MODEL_CATALOG_KEY];
      const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      await this.storage.set({ [MODEL_CATALOG_KEY]: { ...entries, [scope]: entry } });
    });
    this.writing = operation; return operation;
  }
}
