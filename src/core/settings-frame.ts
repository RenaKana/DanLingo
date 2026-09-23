export const SETTINGS_HOST_ORIGINS = ['https://www.nicovideo.jp', 'https://live.nicovideo.jp', 'https://www.youtube.com', 'https://www.bilibili.com', 'https://live.bilibili.com'] as const;
export const SETTINGS_FRAME_KEY = 'settingsFrames.v1';
export function settingsHostOrigin(url: string): string | undefined {
  try { const origin = new URL(url).origin; return SETTINGS_HOST_ORIGINS.includes(origin as typeof SETTINGS_HOST_ORIGINS[number]) ? origin : undefined; } catch { return; }
}
export function settingsFrameToken(url: string, extensionOrigin: string): string | undefined {
  try {
    const parsed = new URL(url), expected = new URL(extensionOrigin);
    if (parsed.protocol !== expected.protocol || parsed.host !== expected.host || parsed.pathname !== '/options.html') return;
    if ([...parsed.searchParams.keys()].length !== 1) return;
    const token = parsed.searchParams.get('embedded'); return token && /^[a-f0-9-]{36}$/.test(token) ? token : undefined;
  } catch { return; }
}
export interface SettingsFrameGrant { token: string; tabId: number; origin: string; hostDocument: string; createdAt: number; frameId?: number; documentId?: string }
type Storage = { get(key: string): Promise<Record<string, any>>; set(value: Record<string, unknown>): Promise<void> };
/** Only a popup-issued grant can authorize a web-embedded extension settings document. */
export class SettingsFrameGrants {
  private changes: Promise<void> = Promise.resolve();
  private storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  async get(tabId: number): Promise<SettingsFrameGrant | undefined> { return (await this.storage.get(SETTINGS_FRAME_KEY))[SETTINGS_FRAME_KEY]?.[tabId]; }
  async put(grant: SettingsFrameGrant) { return this.update(grant.tabId, grant); }
  async remove(tabId: number) { return this.update(tabId); }
  private update(tabId: number, grant?: SettingsFrameGrant) {
    const write = this.changes.catch(() => {}).then(async () => {
      const stored = (await this.storage.get(SETTINGS_FRAME_KEY))[SETTINGS_FRAME_KEY];
      const grants = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
      if (grant) grants[tabId] = grant; else delete grants[tabId];
      await this.storage.set({ [SETTINGS_FRAME_KEY]: grants });
    }); this.changes = write; return write;
  }
}
