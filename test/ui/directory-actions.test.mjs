import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = await readFile(new URL('../../entrypoints/options/directory-ui.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('directory-ui.ts', source, ts.ScriptTarget.Latest, true);
const declarations = ['formatBytes', 'mountDirectoryUI'].map(name => {
  const node = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${name} must exist`);
  return node.getText(file).replace(/^export /, '');
});
const code = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      this.children.push(node);
      node.parentElement = this;
    }
  }

  insertBefore(node, reference) {
    assert.equal(reference.parentElement, this);
    node.remove();
    this.children.splice(this.children.indexOf(reference), 0, node);
    node.parentElement = this;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(event, listener) { this.listeners.set(event, listener); }
  click() { this.listeners.get('click')?.(); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }

  querySelectorAll(selector) {
    const matches = node => selector === 'button' ? node.tag === 'button'
      : selector === '[data-model-id]' ? node.dataset.modelId !== undefined
        : selector === '[data-model-action="load"]' ? node.dataset.modelAction === 'load'
          : selector === '.local-model-state' ? node.className.split(' ').includes('local-model-state') : false;
    const result = [];
    const visit = node => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } };
    visit(this);
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function harness() {
  const elements = new Map();
  const buttonIds = new Set(['local-folder-refresh', 'local-scan-cancel', 'local-folder-add', 'local-file-add', 'local-stop']);
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(buttonIds.has(id) ? 'button' : 'div'));
    return elements.get(id);
  };
  const stop = get('local-stop'), stopSlot = get('local-stop-slot');
  stopSlot.hidden = true;
  stopSlot.append(stop);
  let stopClicks = 0;
  stop.addEventListener('click', () => { stopClicks++; });
  const actions = [];
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag) },
    sourceProgressText: () => '', directoryErrorMessage: value => value,
    formatNumber: value => String(value), localizeMessage: value => value,
    t: key => key,
    bindLocalizedText: (target, render) => { target.textContent = render(); },
    bindLocalizedAttribute: (target, name, render) => { target.setAttribute(name, render()); },
  });
  vm.runInContext(`${code}\nglobalThis.mount = mountDirectoryUI`, context);
  const ui = context.mount(async (action, id) => { actions.push([action, id]); });
  const row = id => get('local-model-entries').querySelectorAll('[data-model-id]').find(entry => entry.dataset.modelId === id);
  const load = id => row(id).querySelector('[data-model-action="load"]');
  return { ui, get, stop, stopSlot, row, load, actions, stopClicks: () => stopClicks };
}

const models = [
  { id: 'a', name: 'Alpha', bytes: 2048, architecture: 'llama', quantization: 'Q4', availability: 'ready' },
  { id: 'b', name: 'Beta', bytes: 4096, architecture: 'llama', quantization: 'Q4', availability: 'ready' },
];

test('the existing stop control follows the loaded or loading row and survives list redraws', () => {
  const h = harness();
  h.ui.render([], undefined, false, models, { selectedId: 'b', loadedId: 'a' });
  assert.equal(h.stop.parentElement, h.load('a').parentElement);
  assert.equal(h.stop.parentElement.children.indexOf(h.stop) + 1, h.stop.parentElement.children.indexOf(h.load('a')));
  assert.equal(h.load('a').hidden, true);
  assert.equal(h.load('b').hidden, false, 'selection alone does not hide load');
  h.stop.click();
  assert.equal(h.stopClicks(), 1);

  h.ui.render([], undefined, false, models, { selectedId: 'b' });
  assert.equal(h.stop.parentElement, h.stopSlot);
  assert.equal(h.stopSlot.hidden, true);
  assert.equal(h.load('a').hidden, false);
  assert.equal(h.load('b').hidden, false);

  h.stop.disabled = false;
  h.ui.render([], undefined, true, models, { selectedId: 'b', loadingId: 'b', busy: true });
  assert.equal(h.stop.parentElement, h.load('b').parentElement);
  assert.equal(h.stop.disabled, false, 'busy loading still permits the main handler to cancel');
  assert.equal(h.load('b').hidden, true);
  assert.equal(h.load('a').disabled, true);
  assert.equal(h.row('b').querySelectorAll('button').find(button => button.dataset.modelAction === 'remove').disabled, true);
  h.stop.click();
  assert.equal(h.stopClicks(), 2);

  h.ui.render([], undefined, true, [{ ...models[0], name: 'Alpha renamed' }, models[1]], { loadingId: 'b', busy: true });
  assert.equal(h.stop.parentElement, h.load('b').parentElement);
  assert.equal(h.get('local-model-entries').querySelectorAll('button').filter(button => button === h.stop).length, 1);
  h.stop.click();
  assert.equal(h.stopClicks(), 3, 'the original click listener remains attached after replaceChildren');

  h.ui.render([], undefined, false, models, { loadedId: 'b', selectedId: 'a' });
  assert.equal(h.stop.parentElement, h.load('b').parentElement);
  assert.equal(h.load('b').hidden, true);
  assert.equal(h.load('a').hidden, false);

  h.ui.render([], undefined, false, [models[0]], { selectedId: 'a' });
  assert.equal(h.stop.parentElement, h.stopSlot);
  assert.equal(h.load('a').hidden, false);
  h.load('a').click();
  assert.equal(h.actions.at(-1)[0], 'load-model');
  assert.equal(h.actions.at(-1)[1], 'a');
});
