type Message = Record<string, any>;

export function nativeMessageText(message: Message): string {
  return typeof message?.simpleText === 'string' ? message.simpleText
    : (message?.runs || []).map((run: Message) => typeof run.text === 'string' ? run.text : '').join('');
}
export function comparableChatText(text: string): string {
  return text.replace(/[\u200b\ufeff]/gu, '').replace(/\s+/gu, ' ').trim();
}
/** A warning, not a language-quality verdict. Never changes the shared cache policy. */
export function unchangedChatTranslation(original: Message, result: Message, eligible: boolean): boolean {
  return eligible && comparableChatText(nativeMessageText(original)) === comparableChatText(nativeMessageText(result));
}
export function latestChatRecords<T extends { time: number; order: number }>(rows: T[], count: number): T[] {
  if (!Number.isInteger(count) || count < 1 || count > 2000) return [];
  return [...rows].sort((a, b) => b.time - a.time || b.order - a.order).slice(0, count);
}
