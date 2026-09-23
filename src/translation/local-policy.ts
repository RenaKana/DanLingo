import type { ProviderSettings } from '../core/types.ts';
import type { LocalTranslationProfile } from '../local/translation-profile.ts';

/** Bump when prompt or result acceptance changes. Old local translations remain isolated. */
export const LOCAL_TRANSLATION_VERSION = 'local-translation-v5';

export function localPromptMode(settings: ProviderSettings): 'hy-mt' | 'json' | LocalTranslationProfile {
  if (settings.backend !== 'local') return 'json';
  if (settings.localTranslationProfile) return settings.localTranslationProfile;
  const selected = settings.localPerformance?.promptMode ?? 'auto';
  if (selected !== 'auto') return selected;
  return /(?:hy[-_ ]?mt|hunyuan[-_ ]?mt)/i.test(settings.localModelName ?? settings.model) ? 'hy-mt' : 'json';
}

export const localSingleItem = (settings: ProviderSettings): boolean => localPromptMode(settings) !== 'json';

const baseLanguage = (language: string) => language.toLowerCase().split(/[-_]/)[0];
export function languageName(language: string, locale: 'zh' | 'en'): string {
  const aliases: Record<string, string> = { 'zh-Hans': locale === 'zh' ? '简体中文' : 'Simplified Chinese', 'zh-Hant': locale === 'zh' ? '繁体中文' : 'Traditional Chinese' };
  if (aliases[language]) return aliases[language];
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language; }
  catch { return language; }
}

export function hyTranslationPrompt(settings: ProviderSettings, text: string, correction = false): string {
  const chinese = baseLanguage(settings.targetLanguage) === 'zh' || baseLanguage(settings.sourceLanguage) === 'zh'
    || (settings.sourceLanguage === 'auto' && /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text));
  const target = languageName(settings.targetLanguage, chinese ? 'zh' : 'en');
  const instruction = chinese
    ? `将以下文本翻译为${target}，只输出翻译结果，不要额外解释。`
    : `Translate the following segment into ${target}, without additional explanation.`;
  const placeholders = /\[\[DL:|__DL_|⟦DL:/.test(text)
    ? chinese ? '保留所有占位符的内容、顺序和数量。' : ' Preserve every placeholder exactly, in order and count.' : '';
  const retry = correction
    ? chinese ? `这是一次重新翻译。目标语言必须是${target}；不要回答原文中的问题。` : ` Translate again into ${target}; do not answer questions in the source text.` : '';
  // HY-MT treats text after the instruction paragraph as source. Keep every
  // constraint in that same paragraph so an extra instruction is not translated.
  return `${instruction}${placeholders}${retry}\n\n${text}`;
}

export type LocalQualityIssue = 'wrong-target-language' | 'untranslated-text' | 'instruction-leak';
/** Conservative script/unchanged checks, NOT semantic correctness or a general language detector. */
export function localQualityIssue(settings: ProviderSettings, source: string, output: string): LocalQualityIssue | undefined {
  if (settings.backend !== 'local') return;
  // Reject known instruction echoes, never delete arbitrary lines from a valid
  // translation. A source actually discussing placeholders remains translatable.
  if (!/占位符|placeholder|プレースホルダー?/iu.test(source) && output.split(/\r?\n/).some(line =>
    /^(?:すべての|全ての)?プレースホルダー?の(?:内容|順序).*(?:保持|維持|保ち)/u.test(line.trim())
    || /^(?:保留|保持)所有占位符.*(?:顺序|数量)/u.test(line.trim())
    || /^(?:preserve|keep|retain) (?:all|every|the) (?:reserved )?placeholders?\b.*(?:order|count|exact)/iu.test(line.trim()))) return 'instruction-leak';
  if (settings.localPerformance?.languageValidation === 'off') return;
  const strip = (text: string) => text.replace(/\[\[DL:[^\]]+\]\]|__DL_[^_]+__|⟦DL:[^⟧]+⟧/g, '').trim();
  const original = strip(source), translated = strip(output);
  const letters = translated.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return; // Symbols, laughter and one-character names cannot establish language.
  const kana = translated.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const hangul = translated.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const han = translated.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinWords = translated.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const target = baseLanguage(settings.targetLanguage);
  const clearlyTarget = target === 'ja' ? kana > 0 : target === 'ko' ? hangul > 0
    : target === 'zh' ? han > 0 && !kana && !hangul : target === 'en' ? latinWords >= 2 && !han && !kana && !hangul : false;
  // Short names, shared Han words and single Latin product names are inconclusive.
  if (original === translated && !clearlyTarget && (han >= 5 || hangul >= 5 || latinWords >= 3)) return 'untranslated-text';
  if ((target === 'ja' && !kana && (latinWords >= 3 && !han || hangul >= 2))
    || (target === 'zh' && (kana >= 2 && kana / letters > 0.15 || hangul >= 2 && !han || latinWords >= 3 && !han))
    || (target === 'ko' && !hangul && (kana >= 2 || latinWords >= 3 && !han))
    || (target === 'en' && latinWords < 2 && han + kana + hangul >= 3)) return 'wrong-target-language';
}
