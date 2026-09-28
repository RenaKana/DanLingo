import { reasoningCapabilities } from './config.ts';
import type { Settings } from './types.ts';
import type { LocalRuntimeStatus } from '../local/auto-load.ts';

const effortLabel = (value?: string) => value === 'off' ? '关闭' : value === 'on' ? '开启'
  : ['minimal','low','medium','high','max','xhigh'].includes(value ?? '') ? value : '';

/** Saved online configuration or matching loaded local model; never disclose endpoint/credentials. */
export function translationModelSummary(settings: Settings, local?: LocalRuntimeStatus, render: (source: string) => string = value => value): string {
  let model: string | undefined, normal: string | undefined, superchat: string | undefined;
  if (settings.backend === 'local') {
    if (!local || local.modelId !== settings.localModelId || !['ready','generating'].includes(local.phase)) return '';
    model = local.modelName; normal = effortLabel(local.normalThinking); superchat = effortLabel(local.superChatThinking);
  } else {
    model = settings.model?.trim();
    const capability = reasoningCapabilities(settings);
    if (capability.verified) {
      if (capability.efforts.includes(settings.thinkingEffort)) normal = effortLabel(settings.thinkingEffort);
      const sc = settings.superChatThinkingEffort;
      if (sc && sc !== 'inherit' && capability.efforts.includes(sc)) superchat = effortLabel(sc);
    }
  }
  if (!model) return '';
  return [`${render(settings.backend === 'local' ? '本地' : '在线')} · ${model}`, normal ? render(`思考 ${render(normal)}`) : '', superchat && superchat !== normal ? render(`SC 思考 ${render(superchat)}`) : ''].filter(Boolean).join(' · ');
}
