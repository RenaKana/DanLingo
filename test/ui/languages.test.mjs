import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { LOCALES } from '../../src/i18n/locale.ts';

const source = await readFile(new URL('../../src/ui/languages.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');

class Option {
  value = '';
  textContent = '';
  disabled = false;
  parent = null;
  remove() { this.parent?.remove(this); }
}

class Select {
  options = [];
  selected = null;
  disabled = false;
  listeners = new Map();
  valueWrites = 0;
  replacements = 0;
  appends = 0;
  get value() { return this.selected?.value ?? ''; }
  set value(value) {
    this.valueWrites++;
    this.selected = this.options.find(option => option.value === value) ?? null;
  }
  replaceChildren(...options) {
    this.replacements++;
    this.options.forEach(option => { option.parent = null; });
    this.options = options;
    this.options.forEach(option => { option.parent = this; });
    this.selected = options[0] ?? null;
  }
  append(option) { this.appends++; option.parent = this; this.options.push(option); }
  remove(option) {
    this.options.splice(this.options.indexOf(option), 1);
    option.parent = null;
    if (this.selected === option) this.selected = this.options[0] ?? null;
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback); this.listeners.set(type, callbacks);
  }
  dispatch(type) { for (const callback of this.listeners.get(type) ?? []) callback(); }
}

function harness() {
  const bindings = new Map();
  let locale = 'zh-CN';
  const context = {
    LOCALES,
    document: { createElement(tag) { assert.equal(tag, 'option'); return new Option(); } },
    t: () => locale === 'zh-CN' ? '已保存' : 'Saved',
    bindLocalizedText(option, render) { bindings.set(option, render); option.textContent = render(); },
  };
  vm.runInNewContext(code + '\nglobalThis.exports = { TARGET_LANGUAGES, mountTargetLanguageSelect };', context, { filename: 'languages.ts' });
  const select = new Select();
  const control = context.exports.mountTargetLanguageSelect(select);
  return {
    select, control, languages: context.exports.TARGET_LANGUAGES,
    changeLocale(next) { locale = next; for (const [option, render] of bindings) if (option.parent) option.textContent = render(); },
  };
}

test('native choices use all twenty UI autonyms in the same order with canonical translation codes', () => {
  const { select, control, languages } = harness();
  const expected = LOCALES.map(locale => ({
    value: locale.code === 'zh-CN' ? 'zh-Hans' : locale.code === 'zh-TW' ? 'zh-Hant' : locale.code,
    label: locale.name,
  }));
  assert.equal(select.options.length, 20);
  assert.deepEqual(select.options.map(option => ({ value: option.value, label: option.textContent })), expected);
  assert.deepEqual(languages.map(option => ({ value: option.value, label: option.label })), expected);
  assert.equal(control.value(), 'zh-Hans');
  control.setDisabled(true); assert.equal(select.disabled, true);
  control.setDisabled(false); assert.equal(select.disabled, false);
});

test('old codes and bilingual labels resolve without adding a legacy choice', () => {
  const { select, control } = harness();
  for (const [old, canonical] of [
    ['zh-CN', 'zh-Hans'], ['zh-cn', 'zh-Hans'], ['zh-TW', 'zh-Hant'], ['zh-tw', 'zh-Hant'],
    ['日文／日本語', 'ja'], ['英语／English', 'en'], ['韩语／한국어', 'ko'],
    ['法语／Français', 'fr'], ['德语／Deutsch', 'de'], ['西班牙语／Español', 'es'], ['俄语／Русский', 'ru'],
    ['ja', 'ja'], ['en', 'en'], ['ko', 'ko'], ['fr', 'fr'], ['de', 'de'], ['es', 'es'], ['ru', 'ru'],
    ['Português (Brasil)', 'pt-BR'],
  ]) {
    control.setValue(old);
    assert.equal(control.value(), canonical, old);
    assert.equal(select.options.length, 20, old);
  }
});

test('unknown saved value remains selectable only as a disabled legacy choice', () => {
  const { select, control, changeLocale } = harness();
  control.setValue('pt-PT');
  assert.equal(control.value(), 'pt-PT');
  assert.equal(select.options.length, 21);
  assert.equal(select.options[20].disabled, true);
  assert.equal(select.options[20].textContent, 'pt-PT · 已保存');
  changeLocale('en');
  assert.equal(select.options[20].textContent, 'pt-PT · Saved');
  assert.equal(control.value(), 'pt-PT');

  const writes = select.valueWrites, replacements = select.replacements, appends = select.appends;
  const option = select.options[20];
  control.setValue('pt-PT');
  assert.equal(select.valueWrites, writes);
  assert.equal(select.replacements, replacements);
  assert.equal(select.appends, appends);
  assert.equal(select.options[20], option);
});

test('switching to a supported choice removes the old legacy option without a second change', () => {
  const { select, control } = harness();
  control.setValue('fr-CA');
  const previousOption = select.options[20];
  let changes = 0;
  select.addEventListener('change', () => { changes++; });
  select.value = 'fr';
  select.dispatch('change');
  assert.equal(changes, 1);
  assert.equal(control.value(), 'fr');
  assert.equal(select.options.length, 20);
  assert.equal(previousOption.parent, null);

  select.value = 'new-script-value';
  assert.equal(control.value(), '');
  assert.equal(select.options.length, 20);
});

test('a new authoritative unknown setting is accepted after the user picked a supported choice', () => {
  const { select, control } = harness();
  control.setValue('fr-CA');
  select.value = 'fr';
  select.dispatch('change');
  control.setValue('fr-CA');
  assert.equal(control.value(), 'fr-CA');
  assert.equal(select.options.length, 21);
  assert.equal(select.options[20].disabled, true);
  const option = select.options[20], writes = select.valueWrites, appends = select.appends;
  control.setValue('fr-CA');
  assert.equal(select.options[20], option);
  assert.equal(select.valueWrites, writes);
  assert.equal(select.appends, appends);

  control.setValue('pt-PT');
  assert.equal(control.value(), 'pt-PT');
  assert.equal(option.parent, null);
  assert.equal(select.options.length, 21);
  assert.equal(select.options[20].disabled, true);
});
