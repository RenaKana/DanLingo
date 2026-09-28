import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/ui/combobox.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.id = ''; this.value = ''; this.children = []; this.attributes = new Map();
    this.listeners = new Map(); this.parent = null; this.hidden = false; this.valueWrites = 0;
  }
  get value() { return this._value; }
  set value(value) { this._value = value; this.valueWrites++; }
  before(node) {
    const siblings = this.parent.children;
    siblings.splice(siblings.indexOf(this), 0, node);
    node.parent = this.parent;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener); this.listeners.set(type, handlers);
  }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  focus() {
    const previous = this.document.activeElement;
    if (previous === this) return;
    this.document.activeElement = this;
    previous?.dispatchEvent({ type: 'blur' });
  }
  scrollIntoView() { this.document.scrolls++; }
}

function harness({ initialValue = '', displayValue } = {}) {
  const listeners = new Map();
  const localeListeners = new Set();
  const document = {
    activeElement: null, scrolls: 0,
    createElement(tag) { const element = new Element(tag); element.document = document; return element; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const root = document.createElement('div');
  const input = document.createElement('input'); input.id = 'language'; input.value = initialValue; root.append(input);
  let locale = 'en';
  const context = {
    document,
    Event: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    t: key => key,
    onLocaleChange(callback) { localeListeners.add(callback); return () => localeListeners.delete(callback); },
    bindLocalizedAttribute(element, name, render) { element.setAttribute(name, render()); },
    bindLocalizedText(element, render) { element.textContent = render(); },
  };
  vm.runInNewContext(code + '\nglobalThis.mountCombobox = mountCombobox;', context, { filename: 'combobox.ts' });
  const options = [
    { value: 'en', label: 'English', renderLabel: () => locale === 'en' ? 'English' : 'Anglais', aliases: ['ENGLISH'] },
    { value: 'fr', label: 'French', renderLabel: () => locale === 'en' ? 'French' : 'Français' },
    { value: 'zh-Hans', label: 'Simplified Chinese', renderLabel: () => locale === 'en' ? 'Simplified Chinese' : 'Chinois simplifié' },
  ];
  const combo = context.mountCombobox(input, options, { displayValue });
  const toggle = root.children[0].children[1];
  const list = root.children[0].children[2];
  const key = name => input.dispatchEvent({ type: 'keydown', key: name, preventDefault() {}, stopPropagation() {} });
  const pressToggle = () => {
    const pointerdown = { type: 'pointerdown', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    toggle.dispatchEvent(pointerdown);
    document.dispatchEvent({ type: 'pointerdown', target: toggle });
    // Browser order: an uncancelled press focuses the button, blurring the input, before click.
    if (!pointerdown.defaultPrevented) toggle.focus();
    toggle.dispatchEvent({ type: 'click' });
  };
  return { combo, document, input, toggle, list, key, pressToggle, changeLocale(next) { locale = next; for (const callback of localeListeners) callback(); } };
}

test('pointer presses alternate open and closed while preserving input focus and editing', () => {
  const h = harness();
  h.pressToggle();
  assert.equal(h.list.hidden, false);
  assert.equal(h.input.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, h.input);

  h.pressToggle();
  assert.equal(h.list.hidden, true, 'the second press closes before click can reopen it');
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, h.input);

  h.input.value = 'fr';
  h.input.dispatchEvent({ type: 'input' });
  assert.equal(h.list.hidden, false);
  assert.equal(h.list.children.length, 1);
  h.key('Enter');
  assert.equal(h.combo.value(), 'fr');
  assert.equal(h.list.hidden, true);

  h.pressToggle();
  assert.equal(h.list.hidden, false);
  h.pressToggle();
  assert.equal(h.list.hidden, true);
  h.combo.destroy();
});

test('initial preset code displays its localized label unless value display is requested', () => {
  const h = harness({ initialValue: 'zh-Hans' });
  assert.equal(h.input.value, 'Simplified Chinese');
  assert.equal(h.combo.value(), 'zh-Hans');
  const writes = h.input.valueWrites;
  h.combo.setValue('zh-Hans');
  assert.equal(h.input.valueWrites, writes);
  h.changeLocale('fr');
  assert.equal(h.input.value, 'Chinois simplifié');
  h.combo.destroy();

  const raw = harness({ initialValue: 'zh-Hans', displayValue: 'value' });
  assert.equal(raw.input.value, 'zh-Hans');
  raw.combo.destroy();
});

test('unchanged normalized preset retains open list, active option, scroll, and localized label', () => {
  const h = harness();
  h.combo.setValue('en');
  assert.equal(h.input.value, 'English');
  h.toggle.dispatchEvent({ type: 'click' });
  h.key('ArrowDown');
  assert.equal(h.input.getAttribute('aria-expanded'), 'true');
  const active = h.input.getAttribute('aria-activedescendant');
  assert.equal(active, 'language-choices-1');
  const writes = h.input.valueWrites;
  const scrolls = h.document.scrolls;
  h.combo.setValue('  EN  ');
  assert.equal(h.input.valueWrites, writes);
  assert.equal(h.input.value, 'English');
  assert.equal(h.input.getAttribute('aria-expanded'), 'true');
  assert.equal(h.input.getAttribute('aria-activedescendant'), active);
  assert.equal(h.list.hidden, false);
  assert.equal(h.document.scrolls, scrolls);

  h.changeLocale('fr');
  assert.equal(h.input.value, 'Anglais');
  assert.equal(h.input.getAttribute('aria-activedescendant'), active);
  h.key('Escape');
  assert.equal(h.list.hidden, true);
  h.combo.destroy();
});

test('unchanged custom draft is preserved; changed setting fills and closes', () => {
  const h = harness();
  h.input.value = ' fr-CA ';
  h.input.dispatchEvent({ type: 'input' });
  assert.equal(h.list.hidden, false);
  const writes = h.input.valueWrites;
  h.combo.setValue('fr-CA');
  assert.equal(h.input.valueWrites, writes);
  assert.equal(h.input.value, ' fr-CA ');
  assert.equal(h.list.hidden, false);
  h.changeLocale('fr');
  assert.equal(h.input.value, ' fr-CA ');

  h.combo.setValue('FR-ca');
  assert.equal(h.input.value, 'FR-ca', 'unknown values keep case-sensitive identity');
  assert.equal(h.list.hidden, true);

  h.toggle.dispatchEvent({ type: 'click' });
  h.combo.setValue('en');
  assert.equal(h.input.value, 'Anglais');
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  assert.equal(h.input.getAttribute('aria-activedescendant'), null);
  assert.equal(h.list.hidden, true);
  h.toggle.dispatchEvent({ type: 'click' });
  h.key('Tab');
  assert.equal(h.list.hidden, true);
  h.toggle.dispatchEvent({ type: 'click' });
  h.document.dispatchEvent({ type: 'pointerdown', target: h.document.createElement('div') });
  assert.equal(h.list.hidden, true);
  h.toggle.dispatchEvent({ type: 'click' });
  h.list.children[1].dispatchEvent({ type: 'click' });
  assert.equal(h.combo.value(), 'fr');
  assert.equal(h.list.hidden, true);
  h.combo.destroy();
});
