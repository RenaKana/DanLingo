import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = await readFile(new URL('../../entrypoints/watch.content.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('watch.content.ts', source, ts.ScriptTarget.ES2022, true);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'presentDisabledTranslation');
assert.ok(declaration, 'video presentation function is present');
const code = ts.transpileModule(declaration.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const context = {};
vm.runInNewContext(`${code}\nglobalThis.presentDisabledTranslation = presentDisabledTranslation;`, context);
const present = context.presentDisabledTranslation;

function elements() {
  const parent = { children: [] };
  const notice = {
    parent: null,
    remove() {
      if (!this.parent) return;
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
  };
  const display = { value: '', priority: '' };
  const progress = {
    parent, isConnected: true,
    style: {
      setProperty(name, value, priority) { if (name === 'display') Object.assign(display, { value, priority }); },
      removeProperty(name) { if (name === 'display') Object.assign(display, { value: '', priority: '' }); },
    },
    get nextElementSibling() { return parent.children[parent.children.indexOf(this) + 1] ?? null; },
    after(node) {
      node.remove();
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
      node.parent = parent;
    },
  };
  parent.children.push(progress);
  return { parent, progress, notice, display };
}

test('disabled translation hides every progress and diagnostic child through the outer host, then restores it', () => {
  const h = elements();
  present(h.progress, h.notice, true, false);
  assert.equal(h.display.value, 'none');
  assert.equal(h.display.priority, 'important');
  assert.deepEqual(h.parent.children, [h.progress, h.notice]);

  // A later diagnostic update can reveal its own children without revealing the outer host.
  present(h.progress, h.notice, true, false);
  assert.deepEqual(h.parent.children, [h.progress, h.notice]);
  assert.equal(h.display.value, 'none');

  present(h.progress, h.notice, true, true);
  assert.deepEqual(h.parent.children, [h.progress], 'fullscreen hides the under-player notice');
  present(h.progress, h.notice, true, false);
  assert.deepEqual(h.parent.children, [h.progress, h.notice]);

  present(h.progress, h.notice, false, false);
  assert.deepEqual(h.parent.children, [h.progress]);
  assert.equal(h.display.value, '', 'the progress component resumes its own normal visibility rules');
});

test('detached video progress does not leave a floating disabled notice', () => {
  const h = elements();
  present(h.progress, h.notice, true, false);
  h.progress.isConnected = false;
  present(h.progress, h.notice, true, false);
  assert.equal(h.notice.parent, null);
});
