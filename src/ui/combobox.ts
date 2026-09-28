
import { t } from '../i18n';
import { onLocaleChange } from '../i18n/text.ts';
import { bindLocalizedAttribute, bindLocalizedText } from './localized-text';

export interface ComboOption { value: string; label: string; aliases?: readonly string[]; renderLabel?: () => string }

/** Editable value with a real, keyboard-accessible list; never requires a manual-mode switch. */
export function mountCombobox(input: HTMLInputElement, initial: readonly ComboOption[] = [], config: { displayValue?: 'value'; onSelect?(option: ComboOption, previousValue: string): void } = {}) {
  const host = document.createElement('div'); host.className = 'editable-combobox';
  input.before(host); host.append(input);
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'combobox-toggle';
  toggle.textContent = '⌄'; bindLocalizedAttribute(toggle, 'aria-label', () => t('m_2f412e28a962')); toggle.tabIndex = -1;
  const list = document.createElement('div'); list.className = 'combobox-list'; list.id = input.id + '-choices';
  list.setAttribute('role', 'listbox'); list.hidden = true; host.append(toggle, list);
  input.removeAttribute('list'); input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false'); input.autocomplete = 'off';
  let options = [...initial], shown: ComboOption[] = [], active = -1, selectedValue: string | undefined, choosing = false;
  const folded = (value: string) => value.trim().toLocaleLowerCase();
  const labelOf = (option: ComboOption) => option.renderLabel?.() ?? option.label;
  const matching = (value: string) => options.find(option => [option.value, option.label, labelOf(option), ...(option.aliases ?? [])].some(alias => folded(alias) === folded(value)));
  const initialSelection = matching(input.value);
  selectedValue = initialSelection?.value;
  if (initialSelection && config.displayValue !== 'value') input.value = labelOf(initialSelection);
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const highlight = () => {
    [...list.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === active)));
    const row = active >= 0 ? list.children[active] as HTMLElement | undefined : undefined;
    if (row) { input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = (option: ComboOption) => {
    const previousValue = input.value;
    selectedValue = option.value;
    input.value = config.displayValue === 'value' ? option.value : labelOf(option); close(); input.focus({ preventScroll: true });
    config.onSelect?.(option, previousValue);
    choosing = true;
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally { choosing = false; }
    close();
  };
  const open = (filter = false) => {
    if (input.disabled) return;
    const query = folded(input.value);
    shown = options.filter(option => !filter || !query || [option.label, labelOf(option), option.value, ...(option.aliases ?? [])].some(value => folded(value).includes(query)));
    list.replaceChildren(...shown.map((option, index) => {
      const row = document.createElement('div'); row.id = list.id + '-' + index; row.setAttribute('role', 'option');
      bindLocalizedText(row, () => labelOf(option)); row.setAttribute('aria-selected', 'false');
      row.addEventListener('pointerdown', event => event.preventDefault()); row.addEventListener('click', () => choose(option)); return row;
    }));
    if (!shown.length) { const empty = document.createElement('div'); empty.className = 'combobox-empty'; bindLocalizedText(empty, () => options.length ? t('m_e24bbd512445') : t('m_076eca258112')); list.append(empty); }
    active = shown.findIndex(option => option === matching(input.value));
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); highlight();
  };
  toggle.addEventListener('pointerdown', event => event.preventDefault());
  toggle.addEventListener('click', () => { if (list.hidden) { input.focus(); open(); } else close(); });
  input.addEventListener('input', () => { if (!choosing) selectedValue = undefined; open(true); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (list.hidden) open();
      else if (shown.length) { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; highlight(); }
    } else if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault(); if (shown[active]) choose(shown[active]!); else close();
    } else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close();
  });
  const outside = (event: Event) => { if (!host.contains(event.target as Node)) close(); };
  const stopLocale = onLocaleChange(() => {
    if (selectedValue && config.displayValue !== 'value') {
      const selected = options.find(option => option.value === selectedValue);
      if (selected) input.value = labelOf(selected);
    }
    // Existing option nodes update through bindings, retaining keyboard highlight and focus.
  });
  document.addEventListener('pointerdown', outside);
  input.addEventListener('blur', () => { if (!host.contains(document.activeElement)) close(); });
  return {
    value: () => matching(input.value)?.value ?? input.value.trim(),
    setValue(value: string) {
      const selected = matching(value);
      const current = matching(input.value)?.value ?? input.value.trim();
      if (current === (selected?.value ?? value.trim())) return;
      selectedValue = selected?.value;
      input.value = config.displayValue === 'value' ? value : selected ? labelOf(selected) : value; close();
    },
    setOptions(next: readonly ComboOption[]) { options = [...next]; if (!list.hidden) open(true); },
    setDisabled(disabled: boolean) { input.disabled = toggle.disabled = disabled; if (disabled) close(); },
    destroy() { stopLocale(); document.removeEventListener('pointerdown', outside); close(); },
  };
}
