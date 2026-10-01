import { resolveConnection } from './connection.ts';
import type { ProviderSettings } from './types.ts';
import { sanitizeModelEffortMetadata } from './model-capabilities.ts';
import type { ModelEffortMetadata } from './model-capabilities.ts';
export const MODEL_CATALOG_KEY = 'modelCatalog.v1';
export interface ModelCatalog { models: string[]; fetchedAt: number; capabilities?: Record<string, ModelEffortMetadata> }
type Storage = { get(key: string): Promise<Record<string, any>>; set(value: Record<string, unknown>): Promise<void> };
function safeCapabilities(models: string[], value: unknown): Record<string, ModelEffortMetadata> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const capabilities: Record<string, ModelEffortMetadata> = Object.create(null);
  for (const model of models) {
    if (!Object.hasOwn(source, model)) continue;
    const metadata = sanitizeModelEffortMetadata(source[model]);
    if (metadata) capabilities[model] = metadata;
  }
  return Object.keys(capabilities).length ? capabilities : undefined;
}

/** Keep the last successful discovery until it is replaced for this destination/key.
 * Elapsed time alone is not evidence that a saved model stopped supporting an effort.
 */
export function selectModelEffort(catalog: ModelCatalog | undefined, model: string, now = Date.now()): ModelEffortMetadata | undefined {
  if (!catalog || !Number.isFinite(now) || !Number.isFinite(catalog.fetchedAt)
      || now < catalog.fetchedAt
      || !Array.isArray(catalog.models) || !catalog.models.includes(model)
      || !catalog.capabilities || typeof catalog.capabilities !== 'object' || !Object.hasOwn(catalog.capabilities, model)) return;
  return sanitizeModelEffortMetadata(catalog.capabilities[model]);
}
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
    if (!models.length) return;
    const capabilities = safeCapabilities(models, entry.capabilities);
    return { models, fetchedAt: entry.fetchedAt, ...(capabilities ? { capabilities } : {}) };
  }
  write(scope: string, models: string[], fetchedAt = Date.now(), capabilities?: Record<string, ModelEffortMetadata>): Promise<void> {
    const names = [...new Set(models.filter(value => typeof value === 'string' && !!value.trim()))].slice(0, 1000);
    const validated = safeCapabilities(names, capabilities);
    const entry = { models: names, fetchedAt, ...(validated ? { capabilities: validated } : {}) };
    if (!entry.models.length) return Promise.resolve();
    const operation = this.writing.catch(() => {}).then(async () => {
      const raw = (await this.storage.get(MODEL_CATALOG_KEY))[MODEL_CATALOG_KEY];
      const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      await this.storage.set({ [MODEL_CATALOG_KEY]: { ...entries, [scope]: entry } });
    });
    this.writing = operation; return operation;
  }
}
