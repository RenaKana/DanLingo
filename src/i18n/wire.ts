import source from './locales/zh-CN.json' with { type: 'json' };
export type MessageParams = Readonly<Record<string, string | number>>;
export interface UiMessage { id: string; params?: MessageParams }
// Only our known UI strings are recognized. User content is never passed here.
const sourceKeys = new Map(Object.entries(source).filter(([, source]) => !/\{\w+\}/.test(source)).map(([id, source]) => [source, id]));
const sourcePatterns = Object.entries(source).filter(([, source]) => /\{\w+\}/.test(source)).map(([id, source]) => {
  const names: string[] = [];
  const escaped = source.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/g).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '(.*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { id, names, pattern: new RegExp('^' + escaped + '$', 's') };
});
export function messageFromSource(value: unknown): UiMessage | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096) return;
  const id = sourceKeys.get(value.trim());
  if (id) return { id };
  for (const entry of sourcePatterns) {
    const match = entry.pattern.exec(value);
    if (match) return { id: entry.id, params: Object.fromEntries(entry.names.map((name, i) => [name, match[i + 1] ?? ''])) };
  }
  return;
}

/** Add renderable message IDs without changing machine errors, settings or user data. */
export function attachUiMessages<T>(reply: T): T {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return reply;
  const result = { ...reply } as Record<string, unknown>;
  for (const field of ['error', 'engineNotice']) {
    const descriptor = messageFromSource(result[field]);
    if (descriptor) result[field + 'Message'] = descriptor;
  }
  if (result.status && typeof result.status === 'object') {
    const status = result.status as Record<string, unknown>;
    const noteMessage = messageFromSource(status.note);
    if (noteMessage) result.status = { ...status, noteMessage };
  }
  return result as T;
}
