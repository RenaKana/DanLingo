import { resolveConnection } from './connection.ts';
import type { ProviderSettings } from './types.ts';

export const SERVICE_HISTORY_KEY = 'serviceHistory.v1';
export const SERVICE_PRESETS = [
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
  { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1' },
  { name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'MiniMax', endpoint: 'https://api.minimax.io/v1' },
] as const;
export interface ServiceAddress { endpoint: string; endpointMode: 'base' | 'completion'; protocol: 'chat-completions'; allowLocalHttp: boolean; verifiedAt: number }
type Storage = { get(key: string): Promise<Record<string, any>>; set(value: Record<string, unknown>): Promise<void> };

/** Address-only history, recorded after a successful discovery/test, never while typing. */
export class ServiceHistory {
  private writing: Promise<void> = Promise.resolve();
  private storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  async read(): Promise<ServiceAddress[]> {
    const rows = (await this.storage.get(SERVICE_HISTORY_KEY))[SERVICE_HISTORY_KEY];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(row => {
      try {
        if (!Number.isFinite(row?.verifiedAt) || !['base', 'completion'].includes(row.endpointMode) || row.protocol !== 'chat-completions') return [];
        const url = new URL(row.endpoint);
        if (url.username || url.password || url.search || url.hash) return [];
        resolveConnection({ ...row, backend: 'online' });
        return [{ endpoint: url.href.replace(/\/$/, ''), endpointMode: row.endpointMode, protocol: 'chat-completions' as const,
          allowLocalHttp: row.allowLocalHttp === true, verifiedAt: row.verifiedAt }];
      } catch { return []; }
    }).sort((a, b) => b.verifiedAt - a.verifiedAt).slice(0, 30);
  }
  async record(settings: ProviderSettings): Promise<void> {
    if (settings.backend === 'local') return Promise.resolve();
    const connection = resolveConnection(settings), url = new URL(connection.configuredCompletionEndpoint);
    // Query parameters may contain opaque credentials even when their names are not recognized.
    if (url.search || url.username || url.password || url.hash) return Promise.resolve();
    const row: ServiceAddress = { endpoint: (connection.baseEndpoint ?? connection.configuredCompletionEndpoint).replace(/\/$/, ''),
      endpointMode: connection.baseEndpoint ? 'base' : 'completion', protocol: connection.protocol,
      allowLocalHttp: url.protocol === 'http:', verifiedAt: Date.now() };
    const write = this.writing.catch(() => {}).then(async () => {
      const rows = await this.read();
      const next = rows.filter(item => resolveConnection(item).configuredCompletionEndpoint !== connection.configuredCompletionEndpoint);
      await this.storage.set({ [SERVICE_HISTORY_KEY]: [row, ...next].slice(0, 30) });
    }); this.writing = write; return write;
  }
}
