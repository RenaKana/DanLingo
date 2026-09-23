import { reasoningCapabilities } from './config.ts';
import type { Settings } from './types.ts';
import type { LocalRuntimeStatus } from '../local/auto-load.ts';

const effortLabel = (value?: string) => value === 'off' ? '关闭' : value === 'on' ? '开启'
  : ['minimal','low','medium','high','max','xhigh'].includes(value ?? '') ? value : '';

/** Saved online configuration or matching loaded local model; never disclose endpoint/credentials. */
export function translationModelSummary(settings: Settings, local?: LocalRuntimeStatus): string {
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
  return [`${settings.backend === 'local' ? '本地' : '在线'} · ${model}`, normal ? `思考 ${normal}` : '', superchat && superchat !== normal ? `SC 思考 ${superchat}` : ''].filter(Boolean).join(' · ');
}
