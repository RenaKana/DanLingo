import { placeholderTokens, placeholdersIntact } from '../../translation/text.ts';

type NativeRecord = Record<string, unknown>;

type Fragment =
  | { kind: 'run'; value: NativeRecord }
  | { kind: 'line-break'; value: string };

interface SegmentText { kind: 'text'; value: string }
interface SegmentFragment { kind: 'fragment'; fragment: Fragment }
type Segment = SegmentText | SegmentFragment;

interface TokenPlan {
  text: string;
  tokens: string[];
  fragments: Fragment[];
  sourceText: string;
  original: NativeRecord;
  translatable: boolean;
}

interface RunPlan extends TokenPlan {}
interface SimplePlan extends TokenPlan {}

export interface PreparedNativeChatText {
  text: string;
  translatable: boolean;
  restore(translated: string): NativeRecord | null;
}

const MAX_SOURCE_TEXT = 1000;
const MAX_RESTORED_TEXT = 2000;
const MAX_RUNS = 200;
const MAX_PREPARED_TEXT = 10000;
const TOKEN_PREFIX = '[[DL:ytchat_v1_';
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/gu;
// Keep malformed placeholder-shaped text stable as well as the syntax used by the
// shared placeholder validator. The delimiters make this narrower than a prose regex.
const PLACEHOLDER_LIKE = /\[\[DL:[^\]\r\n]{0,256}\]\]|__DL_[^\r\n]{1,256}?__|⟦DL:[^⟧\r\n]{0,256}⟧/gu;

function isRecord(value: unknown): value is NativeRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(value: unknown): NativeRecord | null {
  try {
    const clone = structuredClone(value);
    return isRecord(clone) ? clone : null;
  } catch {
    return null;
  }
}

function ownKeys(value: NativeRecord): PropertyKey[] {
  return Reflect.ownKeys(value);
}

function isPlainTextRun(value: NativeRecord): value is NativeRecord & { text: string } {
  const keys = ownKeys(value);
  return typeof value.text === 'string' && keys.length === 1 && keys[0] === 'text';
}

function rawPlaceholderTokens(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_LIKE)].map(match => match[0]);
}

function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function placeholdersPreserved(original: string, translated: string): boolean {
  return placeholdersIntact(original, translated) &&
    sameSequence(rawPlaceholderTokens(original), rawPlaceholderTokens(translated));
}

function stripKnownPlaceholders(text: string): string {
  let result = text;
  for (const token of placeholderTokens(text)) {
    const index = result.indexOf(token);
    if (index >= 0) result = result.slice(0, index) + result.slice(index + token.length);
  }
  return result;
}

function hasProse(text: string): boolean {
  return stripKnownPlaceholders(text).trim().length > 0;
}

function hashNamespace(text: string, fragmentCount: number): string {
  let hash = 2166136261;
  const input = `${text}\u0000${fragmentCount}`;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function chooseTokens(sourceText: string, fragmentCount: number): string[] | null {
  if (!fragmentCount) return [];
  const base = hashNamespace(sourceText, fragmentCount);
  for (let attempt = 0; attempt < 4096; attempt++) {
    const namespace = attempt ? `${base}_${attempt}` : base;
    const tokens = Array.from({ length: fragmentCount }, (_, index) => `${TOKEN_PREFIX}${namespace}_${index}]]`);
    if (tokens.every(token => !sourceText.includes(token))) return tokens;
  }
  return null;
}

function splitPlainText(value: string, segments: Segment[], fragments: Fragment[]): void {
  let cursor = 0;
  for (const match of value.matchAll(LINE_BREAK)) {
    const index = match.index;
    if (index > cursor) segments.push({ kind: 'text', value: value.slice(cursor, index) });
    const fragment: Fragment = { kind: 'line-break', value: match[0] };
    fragments.push(fragment);
    segments.push({ kind: 'fragment', fragment });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) segments.push({ kind: 'text', value: value.slice(cursor) });
}

function renderSegments(segments: Segment[], tokens: string[]): string {
  let fragmentIndex = 0;
  return segments.map(segment => {
    if (segment.kind === 'text') return segment.value;
    const token = tokens[fragmentIndex++];
    return token ?? '';
  }).join('');
}

function restoreSimple(plan: SimplePlan, translated: string): NativeRecord | null {
  const pieces = splitTranslated(plan, translated);
  if (!pieces) return null;
  let restoredText = '';
  for (let index = 0; index < plan.fragments.length; index++) {
    const piece = pieces[index];
    const fragment = plan.fragments[index];
    if (piece) restoredText += piece;
    if (!fragment || fragment.kind !== 'line-break') return null;
    restoredText += fragment.value;
  }
  restoredText += pieces[plan.fragments.length] ?? '';
  if (!restoredText.trim() || restoredText.length > MAX_RESTORED_TEXT) return null;
  const restored = cloneRecord(plan.original);
  if (!restored) return null;
  restored.simpleText = restoredText;
  return restored;
}

function splitTranslated(plan: TokenPlan, translated: string): string[] | null {
  if (typeof translated !== 'string' || !translated.trim() || translated.length > MAX_RESTORED_TEXT ||
      !placeholdersPreserved(plan.text, translated) || !hasProse(translated)) return null;
  const pieces: string[] = [];
  let cursor = 0;
  for (const token of plan.tokens) {
    const index = translated.indexOf(token, cursor);
    if (index < 0) return null;
    pieces.push(translated.slice(cursor, index));
    cursor = index + token.length;
  }
  pieces.push(translated.slice(cursor));
  return pieces;
}

function restoreRuns(plan: RunPlan, translated: string): NativeRecord | null {
  const pieces = splitTranslated(plan, translated);
  if (!pieces) return null;
  const runs: NativeRecord[] = [];
  let restoredTextLength = 0;
  const appendText = (value: string | undefined) => {
    if (value) {
      restoredTextLength += value.length;
      runs.push({ text: value });
    }
  };
  for (let index = 0; index < plan.fragments.length; index++) {
    appendText(pieces[index]);
    const fragment = plan.fragments[index];
    if (!fragment) return null;
    if (fragment.kind === 'line-break') {
      restoredTextLength += fragment.value.length;
      runs.push({ text: fragment.value });
    }
    else {
      const clone = cloneRecord(fragment.value);
      if (!clone) return null;
      if (typeof clone.text === 'string') restoredTextLength += clone.text.length;
      runs.push(clone);
    }
  }
  appendText(pieces[plan.fragments.length]);
  if (restoredTextLength > MAX_RESTORED_TEXT) return null;
  const restored = cloneRecord(plan.original);
  if (!restored) return null;
  restored.runs = runs;
  return restored;
}

function prepareSimple(message: NativeRecord): PreparedNativeChatText | null {
  if (typeof message.simpleText !== 'string') return null;
  const sourceText = message.simpleText;
  if (!sourceText.trim() || sourceText.length > MAX_SOURCE_TEXT) return null;
  const segments: Segment[] = [];
  const fragments: Fragment[] = [];
  splitPlainText(sourceText, segments, fragments);
  const tokens = chooseTokens(sourceText, fragments.length);
  if (!tokens) return null;
  const text = renderSegments(segments, tokens);
  if (text.length > MAX_PREPARED_TEXT) return null;
  const original = cloneRecord(message);
  if (!original) return null;
  const plan: SimplePlan = { text, tokens, fragments, sourceText, original, translatable: hasProse(sourceText) };
  return { text, translatable: plan.translatable, restore: translated => plan.translatable ? restoreSimple(plan, translated) : cloneRecord(plan.original) };
}

function prepareRuns(message: NativeRecord): PreparedNativeChatText | null {
  if (!Array.isArray(message.runs) || message.runs.length === 0 || message.runs.length > MAX_RUNS) return null;
  const segments: Segment[] = [];
  const fragments: Fragment[] = [];
  let sourceLength = 0;
  let collisionText = '';
  for (const input of message.runs) {
    if (!isRecord(input)) return null;
    if (typeof input.text === 'string') {
      sourceLength += input.text.length;
      collisionText += input.text;
      if (sourceLength > MAX_SOURCE_TEXT) return null;
    }
    if (isPlainTextRun(input)) {
      splitPlainText(input.text, segments, fragments);
      continue;
    }
    const clone = cloneRecord(input);
    if (!clone) return null;
    const fragment: Fragment = { kind: 'run', value: clone };
    fragments.push(fragment);
    segments.push({ kind: 'fragment', fragment });
  }
  const sourceText = segments.filter((segment): segment is SegmentText => segment.kind === 'text').map(segment => segment.value).join('');
  if (!sourceText.trim() && fragments.length === 0) return null;
  const tokens = chooseTokens(collisionText, fragments.length);
  if (!tokens) return null;
  const text = renderSegments(segments, tokens);
  if (text.length > MAX_PREPARED_TEXT) return null;
  const original = cloneRecord(message);
  if (!original) return null;
  const plan: RunPlan = { text, tokens, fragments, sourceText, original, translatable: hasProse(sourceText) };
  return { text, translatable: plan.translatable, restore: translated => plan.translatable ? restoreRuns(plan, translated) : cloneRecord(plan.original) };
}

/** Prepare a YouTube native chat message while retaining rich runs locally. */
export function prepareNativeChatText(message: unknown): PreparedNativeChatText | null {
  try {
    if (!isRecord(message)) return null;
    const hasSimpleText = Object.hasOwn(message, 'simpleText') && typeof message.simpleText === 'string';
    const hasRuns = Object.hasOwn(message, 'runs') && Array.isArray(message.runs);
    if (hasSimpleText === hasRuns) return null;
    return hasSimpleText ? prepareSimple(message) : prepareRuns(message);
  } catch {
    return null;
  }
}
