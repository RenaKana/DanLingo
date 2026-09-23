import { placeholdersIntact } from '../../translation/text.ts';

export type InlineEmotes = Record<string, string>;
const ALIAS = /^\[[^\[\]\s]{1,64}\]$/u;
const ALIASES = /\[[^\[\]\s]{1,64}\]/gu;

export function emoteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    // The native renderer upgrades registered image URLs to HTTPS.
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}

/** Only registered inline aliases; a big-picture message is handled separately. */
export function inlineEmotes(value: unknown): InlineEmotes | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 50) return null;
  const result: InlineEmotes = {};
  for (const [alias, metadata] of entries) {
    if (!ALIAS.test(alias) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const url = emoteUrl((metadata as Record<string, unknown>).url);
    if (!url) return null;
    result[alias] = url;
  }
  return result;
}

export function emoteAliases(text: string, tokens: readonly string[]): string[] {
  const known = new Set(tokens);
  return [...text.matchAll(ALIASES)].map(match => match[0]).filter(alias => known.has(alias));
}

export function emoteTokens(value: unknown, original: string): string[] | null {
  if (!Array.isArray(value) || value.length > 50 || value.some(token => typeof token !== 'string' || !ALIAS.test(token)) || new Set(value).size !== value.length) return null;
  return value.every(token => original.includes(token)) ? [...value] : null;
}

/** Tokenization happens before the shared engine; raw originals stay in the ledger/UI.
 * No image URL or HTML is sent to the translation service. */
export function prepareEmoteText(original: string, value: unknown) {
  const tokens = emoteTokens(value, original);
  if (!tokens) return null;
  const known = new Set(tokens), occurrences = [...original.matchAll(ALIASES)].filter(match => known.has(match[0]));
  let namespace = 0;
  while (original.includes(`[[DL:bili${namespace}_`)) namespace++;
  const replacements = new Map<string, string>();
  let text = '', prose = '', at = 0;
  for (const match of occurrences) {
    const gap = original.slice(at, match.index), token = `[[DL:bili${namespace}_${replacements.size}]]`;
    text += gap + token; prose += gap; replacements.set(token, match[0]); at = match.index + match[0].length;
  }
  text += original.slice(at); prose += original.slice(at);
  return { text, prose, hasProse: /[\p{L}\p{N}]/u.test(prose), restore(translated: string): string | undefined {
    if (!translated.trim() || translated.length > 2000 || !placeholdersIntact(text, translated)) return;
    let restored = translated;
    for (const [token, alias] of replacements) restored = restored.replace(token, alias);
    return emotesIntact(original, restored, tokens) ? restored : undefined;
  } };
}

export function emotesIntact(original: string, translated: string, tokens: readonly string[]): boolean {
  const before = emoteAliases(original, tokens), after = emoteAliases(translated, tokens);
  return before.length === after.length && before.every((alias, index) => after[index] === alias);
}

/** Eligibility must inspect prose, not image aliases (which may contain face/art markers). */
export function emoteProse(original: string, emotes?: InlineEmotes): string {
  return emotes ? prepareEmoteText(original, Object.keys(emotes))?.prose ?? '' : original;
}
