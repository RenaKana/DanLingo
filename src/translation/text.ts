const PLACEHOLDERS = /\[\[DL:[A-Za-z0-9_.:-]+\]\]|__DL_[A-Za-z0-9_]+__|⟦DL:[A-Za-z0-9_.:-]+⟧/g;
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20e3]/u;
// These strong face/art markers outside a recognized face are ambiguous; keep the whole item original.
const UNCERTAIN_FACE = /[ωД∀益皿ヮಠಥ‿╯╰┻┳┬┴︵¯ᴗᴥʕʔ❛❜◕╹]/u;
const FACE_FEATURE = /[ωД∀▽△□益皿ヮｪ‿﹏︿∇ΦΘツಠಥ눈•°´｀＾^;；ᴗᴥ❛❜◕╹]|[TtOoQqXx0><][_.~][TtOoQqXx0><]/u;
interface Span { start: number; end: number; value: string; literal: boolean }
export interface ProtectedText {
  text: string;
  replacements: Map<string, string>;
  reason?: 'unsupported-emoticon';
}

export function placeholderTokens(text: string): string[] { return text.match(PLACEHOLDERS) ?? []; }
export function placeholdersIntact(original: string, translated: string): boolean {
  const before = placeholderTokens(original);
  const after = placeholderTokens(translated);
  return before.length === after.length && before.every((token, index) => token === after[index]);
}

/** Protect emoji by Unicode grapheme cluster, plus a deliberately bounded set of common kaomoji. */
export function protectText(original: string): ProtectedText {
  const spans: Span[] = [];
  const add = (start: number, value: string, literal = true) => {
    const end = start + value.length;
    if (!spans.some((span) => start < span.end && end > span.start)) spans.push({ start, end, value, literal });
  };
  for (const match of original.matchAll(PLACEHOLDERS)) add(match.index, match[0], false);
  // Platform emoji aliases are safe text fragments, never HTML or remote images.
  for (const match of original.matchAll(/:[A-Za-z0-9_-]{1,80}:/g)) add(match.index, match[0]);
  const shrug = '¯\\_(ツ)_/¯';
  for (let at = original.indexOf(shrug); at !== -1; at = original.indexOf(shrug, at + shrug.length)) add(at, shrug);
  // Parenthesized faces (including full-width parentheses and common attached arms).
  const bracketed = /[\\/ヾヽ٩وᕦᕤ┐┌╰╯୧୨っづ]*[（(][^()（）\r\n]{1,32}[)）][\\/ノﾉヾヽ٩۶وᕦᕤ┘└╰╯୧୨っづつ✧♪~～!]*/gu;
  for (const match of original.matchAll(bracketed)) if (FACE_FEATURE.test(match[0])) add(match.index, match[0]);
  // Unbracketed eye-mouth-eye forms and conventional ASCII smileys; not substrings of words/URLs.
  for (const expression of [
    /(?<![\p{L}\p{N}])[TtOoQqXx0^;:><-][_.~][TtOoQqXx0^;:><-](?![\p{L}\p{N}])/gu,
    /(?<![A-Za-z0-9/:])[;:=8][-^']?[)(DPp](?![A-Za-z0-9])/g,
    // Strong eye-mouth-eye forms can adjoin prose. Preserve invisible word joiners verbatim.
    /[ಠಥ눈]\u2060{0,2}[_.﹏‿益皿]\u2060{0,2}[ಠಥ눈]/gu,
  ]) for (const match of original.matchAll(expression)) add(match.index, match[0]);
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const { segment, index } of segmenter.segment(original)) if (EMOJI.test(segment)) add(index, segment);
  spans.sort((a, b) => a.start - b.start);
  let namespace = 0;
  while (original.includes(`[[DL:auto${namespace}_`)) namespace++;
  const replacements = new Map<string, string>();
  let result = '';
  let uncovered = '';
  let at = 0;
  for (const span of spans) {
    const gap = original.slice(at, span.start);
    result += gap; uncovered += gap;
    if (span.literal) {
      const token = `[[DL:auto${namespace}_${replacements.size}]]`;
      replacements.set(token, span.value); result += token;
    } else result += span.value;
    at = span.end;
  }
  result += original.slice(at); uncovered += original.slice(at);
  return UNCERTAIN_FACE.test(uncovered)
    ? { text: original, replacements: new Map(), reason: 'unsupported-emoticon' }
    : { text: result, replacements };
}

/** Validate before restoration. Invented raw emoji/faces also violate the protected-text protocol. */
export function restoreText(prepared: ProtectedText, translated: string): string | undefined {
  if (prepared.reason || !placeholdersIntact(prepared.text, translated)) return undefined;
  const output = protectText(translated);
  if (output.reason || output.replacements.size) return undefined;
  return translated.replace(PLACEHOLDERS, (token) => prepared.replacements.get(token) ?? token);
}
