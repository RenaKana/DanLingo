import { providerTimeoutMs } from '../core/config.ts';
import type { ProviderSettings } from '../core/types.ts';
import { createClock } from './clock.ts';
import { ChatCompletionsProvider, ProviderError } from './provider.ts';
import type { ProviderOptions } from './provider.ts';
import { localQualityIssue, localPromptMode } from './local-policy.ts';
import type { LocalInferenceMetrics } from '../local/types.ts';

export interface ModelTestResult {
  model: string; sourceText: string; text: string; elapsedMs: number;
  sourceLanguage: string; targetLanguage: string; promptMode: ReturnType<typeof localPromptMode>;
  verification: 'basic-language-check' | 'protocol-only';
  passed: boolean; rawText?: string; local?: LocalInferenceMetrics;
}

/** Rejected output is available only to the explicit test UI, never the translation engine/cache. */
export class ModelTestError extends ProviderError {
  readonly result: ModelTestResult;
  constructor(error: ProviderError, result: ModelTestResult) {
    super(error.code, error.retryable, error.status, error.retryAfterMs, error);
    this.result = result;
  }
}

const samples: Record<string, string> = {
  ja: 'この動画はとても面白いです。',
  en: 'This video is very interesting.',
  ko: '이 영상은 정말 재미있어요.',
  zh: '这个视频很有趣，我期待下一次直播。',
};

export function modelTestSource(sourceLanguage: string, targetLanguage: string): string {
  const source = sourceLanguage.split('-')[0]!, target = targetLanguage.split('-')[0]!;
  if (source !== 'auto' && source === target) throw new ProviderError('test-same-language');
  const sample = samples[source === 'auto' ? target === 'ja' ? 'zh' : 'ja' : source];
  if (!sample) throw new ProviderError('test-custom-text-required');
  return sample;
}

/** One real protocol attempt, independent of the video engine, cache and saved settings. */
export async function testModel(request: {
  settings: ProviderSettings; apiKey: string; signal?: AbortSignal; text?: string; mode?: 'vod' | 'deadline';
}, options: ProviderOptions = {}): Promise<ModelTestResult> {
  if (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 1000)) throw new ProviderError('invalid-test-text');
  const sourceText = request.text?.trim() || modelTestSource(request.settings.sourceLanguage, request.settings.targetLanguage);
  const clock = createClock(options.clock);
  const start = clock.now();
  const id = 'model-test';
  let rawText: string | undefined, local: LocalInferenceMetrics | undefined;
  const summary = (text: string, passed: boolean): ModelTestResult => ({
    model: request.settings.backend === 'local' ? request.settings.localModelName ?? request.settings.model : request.settings.model,
    sourceText, text, passed, rawText, elapsedMs: Math.max(0, Math.round(clock.now() - start)),
    sourceLanguage: request.settings.sourceLanguage, targetLanguage: request.settings.targetLanguage, promptMode: localPromptMode(request.settings),
    verification: request.settings.backend === 'local' && request.settings.localPerformance?.languageValidation !== 'off' ? 'basic-language-check' : 'protocol-only',
    ...(local ? { local } : {}),
  });
  try {
    const result = await new ChatCompletionsProvider(options).complete({
      ...request, items: [{ id, text: sourceText }], mode: request.mode ?? (request.settings.backend === 'local' ? 'deadline' : 'vod'),
      benchmark: true, budgetMs: providerTimeoutMs(request.settings),
      onResponseText: content => { rawText = (rawText ?? '') + content; },
    });
    local = result.local;
    const output = result.items.get(id);
    if (output?.reason || !output?.text?.trim()) throw new ProviderError(['wrong-target-language', 'untranslated-text', 'output-truncated', 'instruction-leak'].includes(output?.reason ?? '') ? output!.reason! : 'invalid-response');
    const issue = localQualityIssue(request.settings, sourceText, output.text);
    if (issue) throw new ProviderError(issue);
    if (output.text.trim() === sourceText.trim()) throw new ProviderError('test-unchanged');
    return summary(output.text, true);
  } catch (error) {
    if (error instanceof ProviderError) throw new ModelTestError(error, summary(rawText ?? '', false));
    throw error;
  }
}
