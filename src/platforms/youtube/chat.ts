import type { ChatCoverage } from '../../core/types.ts';

type Data = Record<string, any>;
export interface ChatContinuation { token: string; timeoutMs: number; kind: string }
export interface YoutubeLiveEvent { sourceId: string; originalText: string; receivedAt: number; sentAtEpochMs?: number; translatable: boolean; authorId?: string }
export const MAX_CHAT_TEXT = 1000;

/** Only inspect bounded structured page/response data; never execute page-provided text. */
export function findChatObject(value: unknown, key: string): Data | null {
  const seen = new Set<object>(); let budget = 5000;
  const find = (item: any, depth: number): Data | null => {
    if (!item || typeof item !== 'object' || seen.has(item) || depth > 24 || --budget < 0) return null;
    seen.add(item);
    if (item[key] && typeof item[key] === 'object') return item[key];
    for (const child of Object.values(item)) { const match = find(child, depth + 1); if (match) return match; }
    return null;
  };
  return find(value, 0);
}
export function continuationFrom(renderer: Data | null | undefined): ChatContinuation | null {
  for (const kind of ['invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData']) {
    for (const row of Array.isArray(renderer?.continuations) ? renderer.continuations.slice(0, 10) : []) {
      const item = row?.[kind];
      if (typeof item?.continuation !== 'string' || !item.continuation || item.continuation.length > 10000) continue;
      const supplied = Number(item.timeoutMs);
      return { token: item.continuation, kind, timeoutMs: Number.isFinite(supplied) && supplied >= 0 ? Math.max(1000, supplied) : 10000 };
    }
  }
  return null;
}
export function chatSelection(renderer: Data | null | undefined): { coverage: ChatCoverage; reload: ChatContinuation | null } {
  const items = findChatObject(renderer?.header, 'sortFilterSubMenuRenderer')?.subMenuItems;
  if (!Array.isArray(items) || items.length !== 2 || items.some(item => !item?.continuation?.reloadContinuationData)) return { coverage: 'unknown', reload: null };
  const selected = items.findIndex(item => item.selected === true);
  if (selected < 0 || items.filter(item => item.selected === true).length !== 1) return { coverage: 'unknown', reload: null };
  return { coverage: selected === 0 ? 'top' : 'all', reload: continuationFrom({ continuations: [items[selected].continuation] }) };
}

function ordinaryMessage(item: Data | undefined, receivedAt: number): YoutubeLiveEvent | null {
  // Paid messages, gifts, membership announcements, tickers and banners are deliberately excluded.
  const value = item?.liveChatTextMessageRenderer;
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 300) return null;
  let originalText = '', translatable = true;
  if (typeof value.message?.simpleText === 'string') originalText = value.message.simpleText;
  else if (Array.isArray(value.message?.runs)) {
    for (const run of value.message.runs.slice(0, 200)) {
      if (typeof run?.text === 'string') originalText += run.text;
      else if (run?.emoji) {
        const shortcuts = Array.isArray(run.emoji.shortcuts) ? run.emoji.shortcuts : [];
        const shortcut = shortcuts.find((s: unknown) => typeof s === 'string' && /^:[A-Za-z0-9_-]{1,80}:$/.test(s));
        const unicode = [run.emoji.emojiId, ...shortcuts].find(s => typeof s === 'string' && s.length <= 40 && /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20e3]/u.test(s));
        // Keep the actual glyph when supplied. Aliases are only a fallback for custom emoji.
        if (unicode || shortcut) originalText += unicode || shortcut;
        else {
          // Unknown/custom image emoji has no safe translation representation. Preserve an accessible label.
          const label = run.emoji.accessibility?.accessibilityData?.label || run.emoji.image?.accessibility?.accessibilityData?.label;
          originalText += typeof label === 'string' && label.length <= 100 ? label : '[emoji]';
          translatable = false;
        }
      }
    }
  }
  if (!originalText.trim() || originalText.length > MAX_CHAT_TEXT) return null;
  const usec = typeof value.timestampUsec === 'string' && /^\d{10,18}$/.test(value.timestampUsec) ? Number(value.timestampUsec) : NaN;
  const authorId = typeof value.authorExternalChannelId === 'string' && value.authorExternalChannelId.length <= 100 ? value.authorExternalChannelId : undefined;
  return { sourceId: value.id, originalText, receivedAt, translatable, ...(authorId ? { authorId } : {}), ...(Number.isSafeInteger(usec) ? { sentAtEpochMs: usec / 1000 } : {}) };
}

/** One ledger per connection/filter generation. Initial and recovered snapshots never become display events. */
export class YoutubeChatLedger {
  private seen = new Map<string, { authorId?: string; visible: boolean }>();
  clear(): void { this.seen.clear(); }
  read(renderer: Data, receivedAt: number, baseline: boolean): { events: YoutubeLiveEvent[]; removes: string[]; removeAuthors: string[] } {
    const events: YoutubeLiveEvent[] = [], removes = new Set<string>(), removeAuthors = new Set<string>();
    const remove = (id: unknown) => {
      if (typeof id !== 'string' || !id || id.length > 300) return;
      const old = this.seen.get(id); this.seen.set(id, { ...old, visible: false }); removes.add(id);
    };
    const add = (item: Data | undefined, mayEmit = true) => {
      const event = ordinaryMessage(item, receivedAt);
      if (!event || this.seen.has(event.sourceId)) return;
      const visible = !baseline && mayEmit && events.length < 500;
      this.seen.set(event.sourceId, { authorId: event.authorId, visible });
      if (visible) events.push(event);
    };
    for (const action of Array.isArray(renderer.actions) ? renderer.actions.slice(0, 2000) : []) {
      if (!action || typeof action !== 'object') continue;
      if (action.addChatItemAction) add(action.addChatItemAction.item);
      if (action.removeChatItemAction) remove(action.removeChatItemAction.targetItemId);
      if (action.markChatItemAsDeletedAction) remove(action.markChatItemAsDeletedAction.targetItemId);
      const replacement = action.replaceChatItemAction;
      if (replacement) {
        const wasVisible = this.seen.get(replacement.targetItemId)?.visible === true;
        remove(replacement.targetItemId);
        // Reusing an ID is never a second event. A new replacement ID can replace a previously displayed item.
        add(replacement.replacementItem, wasVisible);
      }
      const author = action.markChatItemsByAuthorAsDeletedAction?.externalChannelId;
      if (typeof author === 'string' && author.length <= 100) {
        removeAuthors.add(author);
        // This command removes the author's existing messages, not all their future messages.
        for (const [id, value] of this.seen) if (value.authorId === author) remove(id);
      }
    }
    while (this.seen.size > 20000) this.seen.delete(this.seen.keys().next().value!);
    // Author deletion already tombstones IDs known at that point in the action order.
    // Later additions by that author remain new events; the consumer removes old items before ingesting them.
    return { events: events.filter(e => !removes.has(e.sourceId)), removes: [...removes], removeAuthors: [...removeAuthors] };
  }
}
