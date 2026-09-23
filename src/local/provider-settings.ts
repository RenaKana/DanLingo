import type { ProviderSettings } from '../core/types.ts';
import type { LocalState } from './types.ts';

/** Only trusted runtime observations, never persisted metadata from a page request. */
export function withLocalRuntime<T extends ProviderSettings>(settings: T, state: LocalState): T {
  return { ...settings, localCapacity: state.runtime?.parallel ?? 1,
    localContextTokens: state.runtime?.contextTokens ?? 2048, localPerformance: { ...state.runtime,
      ...(settings.localPerformance?.promptMode === undefined ? {} : { promptMode: settings.localPerformance.promptMode }),
      ...(settings.localPerformance?.languageValidation === undefined ? {} : { languageValidation: settings.localPerformance.languageValidation }) },
    localModelName: state.model?.name, localTranslationProfile: state.model?.translationProfile };
}
