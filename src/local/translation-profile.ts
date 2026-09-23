import { TRANSLATEGEMMA_LANGUAGES } from './translategemma-languages.ts';

export type LocalTranslationProfile = 'seed-x' | 'translategemma';

/** Use embedded model identity, not the user-controlled file name. */
export function detectTranslationProfile(metadata: Record<string, unknown>): LocalTranslationProfile | undefined {
  const architecture = metadata['general.architecture'];
  const identity = [metadata['general.name'], metadata['general.basename']].filter(value => typeof value === 'string').join(' ');
  if (architecture === 'llama' && /\bseed[-_ ]x[-_ ]ppo\b/i.test(identity)) return 'seed-x';
  if (architecture === 'gemma3' && /\btranslategemma\b/i.test(identity)) return 'translategemma';
}

/** The server initializes a chat parser even for raw completions. This built-in
 * template is only for server startup; all profile requests use createCompletion
 * with the official rendered prompt below, never a chat wrapper. */
export function translationLoadOptions(profile?: LocalTranslationProfile) {
  return profile ? { jinja: false, chat_template: 'chatml' } : { jinja: true };
}

function languageCode(value: string): string {
  try { return Intl.getCanonicalLocales(value.trim().replaceAll('_', '-'))[0] ?? ''; }
  catch { throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED'); }
}

export function translationPrompt(profile: LocalTranslationProfile, source: string, target: string, text: string): string {
  const targetCode = languageCode(target);
  if (profile === 'seed-x') {
    const tag = targetCode.split('-')[0]!;
    if (!/^[a-z]{2}$/.test(tag)) throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const from = source === 'auto' ? '' : `${names.of(languageCode(source))} `;
    const targetName = targetCode === 'zh-Hans' ? 'Chinese' : names.of(targetCode);
    return `Translate the following ${from}sentence into ${targetName}:\n ${text} <${tag}>`;
  }
  if (source === 'auto') throw new Error('LOCAL_TRANSLATION_SOURCE_REQUIRED');
  const sourceCode = languageCode(source);
  const sourceName = TRANSLATEGEMMA_LANGUAGES[sourceCode], targetName = TRANSLATEGEMMA_LANGUAGES[targetCode];
  if (!sourceName || !targetName) throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
  // Text branch of Google's TranslateGemma template, including its turn tokens.
  // BOS is supplied by the GGUF tokenizer; do not prepend a second BOS token.
  return `<start_of_turn>user\nYou are a professional ${sourceName} (${sourceCode}) to ${targetName} (${targetCode}) translator. Your goal is to accurately convey the meaning and nuances of the original ${sourceName} text while adhering to ${targetName} grammar, vocabulary, and cultural sensitivities.\n`
    + `Produce only the ${targetName} translation, without any additional explanations or commentary. Please translate the following ${sourceName} text into ${targetName}:\n\n\n${text.trim()}<end_of_turn>\n<start_of_turn>model\n`;
}

export function translationRawOptions(profile: LocalTranslationProfile, messages: unknown) {
  if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user' || typeof messages[0]?.content !== 'string') {
    throw new Error('LOCAL_REQUEST_INVALID');
  }
  return { prompt: messages[0].content as string, stop: profile === 'translategemma' ? ['<end_of_turn>', '<eos>'] : ['</s>'] };
}

/** Loading weights does not validate the language settings used by requests. */
export function translationLanguageIssue(profile: LocalTranslationProfile | undefined, source: string, target: string): string | undefined {
  if (!profile) return;
  try { translationPrompt(profile, source, target, ''); }
  catch (error) {
    if (error instanceof Error && /^LOCAL_TRANSLATION_[A-Z_]+$/.test(error.message)) return error.message;
    throw error;
  }
}

export function translationLanguageMessage(code: string): string | undefined {
  if (code === 'LOCAL_TRANSLATION_SOURCE_REQUIRED') return 'TranslateGemma 需要明确的源语言：视频翻译请在“观看设置”选择源语言；直播和性能测试请在“直播聊天”选择直播源语言，不能使用“自动判断”。修改后保存。';
  if (code === 'LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED') return '此模型的翻译格式不支持所填语言代码，请检查源语言和目标语言。';
}
