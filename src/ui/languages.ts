import type { ComboOption } from './combobox.ts';
export const TARGET_LANGUAGES: readonly ComboOption[] = [
  { value: 'zh-Hans', label: '简体中文', aliases: ['zh-cn', '中文', 'Chinese'] },
  { value: 'zh-Hant', label: '繁體中文', aliases: ['zh-tw', '繁体中文'] },
  { value: 'ja', label: '日文／日本語', aliases: ['日文', '日语', '日本語', 'Japanese'] },
  { value: 'en', label: '英语／English', aliases: ['英语', '英文', 'English'] },
  { value: 'ko', label: '韩语／한국어', aliases: ['韩语', '韩文', '한국어', 'Korean'] },
  { value: 'fr', label: '法语／Français', aliases: ['法语', 'Français', 'French'] },
  { value: 'de', label: '德语／Deutsch', aliases: ['德语', 'Deutsch', 'German'] },
  { value: 'es', label: '西班牙语／Español', aliases: ['西班牙语', 'Español', 'Spanish'] },
  { value: 'ru', label: '俄语／Русский', aliases: ['俄语', 'Русский', 'Russian'] },
];
