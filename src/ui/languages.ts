import { LOCALES } from '../i18n/locale.ts';
import { t } from '../i18n/text.ts';
import { bindLocalizedText } from './localized-text.ts';
import type { ComboOption } from './combobox.ts';

const legacyAliases: Record<string, readonly string[]> = {
  'zh-Hans': ['zh-CN', '中文', 'Chinese', 'Simplified Chinese'],
  'zh-Hant': ['zh-TW', '繁体中文', 'Traditional Chinese'],
  ja: ['日文／日本語', '日文', '日语', 'Japanese', 'Japanese／日本语'],
  en: ['英语／English', '英语', '英文', 'English／English'],
  ko: ['韩语／한국어', '韩语', '韩文', 'Korean', 'Korean／한국어'],
  fr: ['法语／Français', '法语', 'French', 'French／Français'],
  de: ['德语／Deutsch', '德语', 'German', 'German／Deutsch'],
  es: ['西班牙语／Español', '西班牙语', 'Spanish', 'Spanish／Español'],
  ru: ['俄语／Русский', '俄语', 'Russian', 'Russian／Русский'],
};

export const TARGET_LANGUAGES: readonly ComboOption[] = LOCALES.map(locale => {
  const value = locale.code === 'zh-CN' ? 'zh-Hans' : locale.code === 'zh-TW' ? 'zh-Hant' : locale.code;
  return { value, label: locale.name, renderLabel: () => locale.name, aliases: legacyAliases[value] };
});

const fold = (value: string) => value.trim().toLocaleLowerCase();
const matching = (value: string) => TARGET_LANGUAGES.find(option =>
  [option.value, option.label, ...(option.aliases ?? [])].some(alias => fold(alias) === fold(value)));

export function mountTargetLanguageSelect(select: HTMLSelectElement) {
  select.replaceChildren(...TARGET_LANGUAGES.map(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  if (select.value !== 'zh-Hans') select.value = 'zh-Hans';

  let legacyOption: HTMLOptionElement | undefined;
  select.addEventListener('change', () => {
    if (!TARGET_LANGUAGES.some(option => option.value === select.value)) return;
    if (legacyOption) { legacyOption.remove(); legacyOption = undefined; }
  });

  return {
    value: () => TARGET_LANGUAGES.some(option => option.value === select.value) || legacyOption?.value === select.value
      ? select.value : '',
    setValue(value: string) {
      const selected = matching(value);
      const next = selected?.value ?? value;
      if (next === select.value) return;
      if (legacyOption) { legacyOption.remove(); legacyOption = undefined; }
      if (!selected) {
        legacyOption = document.createElement('option');
        legacyOption.value = value;
        legacyOption.disabled = true;
        bindLocalizedText(legacyOption, () => `${value} · ${t('m_1bd91a7d0c53')}`);
        select.append(legacyOption);
      }
      select.value = next;
    },
    setDisabled(disabled: boolean) { if (select.disabled !== disabled) select.disabled = disabled; },
  };
}
