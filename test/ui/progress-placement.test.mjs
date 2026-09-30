import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/ui/progress.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('progress.ts', source, ts.ScriptTarget.ES2022, true);
const create = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createProgress');
const returned = create?.body?.statements.find(ts.isReturnStatement)?.expression;
const attach = returned?.properties.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'attach');
const visibility = create?.body?.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'visibility');
assert.ok(attach && visibility, 'real progress attach and visibility methods are available');
const code = ts.transpileModule(`${visibility.getText(file)}\nconst controller = { ${attach.getText(file)} }; globalThis.attach = controller.attach; globalThis.visibility = visibility;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

class Element {
  constructor(tag = 'div', { id = '', classes = [], height = 0, dataset = {}, style = {} } = {}) {
    this.tag = tag;
    this.id = id;
    this.classes = classes;
    this.height = height;
    this.dataset = dataset;
    this.style = { display: 'block', flexDirection: 'row', position: 'static', ...style };
    this.parentElement = null;
    this.children = [];
    this.hidden = false;
    this.connectedRoot = false;
  }
  append(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  after(child) {
    child.remove();
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, child);
    child.parentElement = this.parentElement;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get isConnected() { return this.connectedRoot || !!this.parentElement?.isConnected; }
  matches(selector) {
    return selector.split(',').some(part => {
      const name = part.trim();
      return name.startsWith('.') ? this.classes.includes(name.slice(1))
        : name.startsWith('#') ? this.id === name.slice(1)
          : name === '[data-danlingo-player]' && this.dataset.danlingoPlayer !== undefined;
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (selector === 'video' ? child.tag === 'video' : child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() {
    const height = typeof this.height === 'function' ? this.height() : this.height;
    const siblings = this.parentElement?.children ?? [];
    const top = (this.parentElement?.getBoundingClientRect().top ?? 0)
      + siblings.slice(0, siblings.indexOf(this)).reduce((sum, sibling) => sum + sibling.getBoundingClientRect().height, 0);
    return { top, bottom: top + height, height, width: 640 };
  }
}

function harness() {
  const root = new Element('main'); root.connectedRoot = true;
  const column = root.append(new Element('div', { classes: ['grid-left'] }));
  const details = { open: false };
  const host = new Element('div', { id: 'danlingo-progress', height: () => details.open ? 270 : 48 });
  const displayPlanUpdates = [];
  const resize = { observed: [], disconnects: 0,
    observe(node) { this.observed.push(node); }, disconnect() { this.disconnects++; } };
  const context = { document: { querySelectorAll: selector => root.querySelectorAll(selector), fullscreenElement: null },
    getComputedStyle: node => node.style, resourceId: '', details, dirty: false, localError: '',
    displayPlan: { update: view => displayPlanUpdates.push(view) }, userFilterView: null,
    bilibili: false, anchor: null, host, resize, userFilterHost: { hidden: false },
    displayPlanHost: { hidden: false }, nativeSupplyHost: { hidden: true }, active: true };
  vm.runInNewContext(code, context);
  function player(mode, session, options = {}) {
    const outer = mode === 'festival'
      ? new Element('div', { classes: ['video-player-box'], height: 556, style: options.style })
      : new Element('div', { id: mode === 'normal' ? 'playerWrap' : '',
        classes: mode === 'presenter' ? ['PlayerPresenter'] : [], height: 420, style: options.style });
    let surface = outer;
    if (mode === 'festival') {
      surface = outer.append(new Element('div', { classes: ['festival-video-player'], height: 556 }))
        .append(new Element('div', { id: 'bilibili-player', height: 556 }))
        .append(new Element('div', { classes: ['bpx-docker'], height: 556 }))
        .append(new Element('div', { classes: ['bpx-player-container'], height: 556 }));
    } else surface = outer.append(new Element('div'));
    surface.dataset.danlingoPlayer = session;
    const video = surface.append(new Element('video', { height: 556 }));
    column.append(outer);
    return { outer, surface, video };
  }
  return { root, column, context, host, details, resize, player, displayPlanUpdates };
}

test('festival mounts after the fixed-height outer player and details push following content', () => {
  const h = harness();
  const { outer, surface, video } = h.player('festival', 'festival-session');
  const banner = h.column.append(new Element('section', { classes: ['festival-main-panel'], height: 150 }));
  const originalStyles = [h.column, outer, surface, video, banner].map(node => ({ node, value: { ...node.style } }));
  h.context.attach('festival-session', 'festival-resource', 'bilibili');
  assert.equal(h.context.anchor, outer);
  assert.equal(h.host.parentElement, h.column);
  assert.equal(outer.nextElementSibling, h.host);
  assert.equal(h.host.nextElementSibling, banner);
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.getBoundingClientRect().top, 556);
  const collapsedBannerTop = banner.getBoundingClientRect().top;
  h.details.open = true;
  h.context.visibility();
  assert.equal(h.host.hidden, false);
  assert.equal(banner.getBoundingClientRect().top - collapsedBannerTop, 222);
  assert.ok(h.host.getBoundingClientRect().top >= video.getBoundingClientRect().bottom);
  h.details.open = false;
  assert.equal(banner.getBoundingClientRect().top, collapsedBannerTop);
  for (const { node, value } of originalStyles) assert.deepEqual(node.style, value, 'site inline style remains unchanged');
});

test('normal Bilibili and Niconico players retain their in-flow mounting positions', () => {
  for (const [mode, platform] of [['normal', 'bilibili'], ['presenter', 'niconico']]) {
    const h = harness();
    const { outer } = h.player(mode, 'session');
    h.context.attach('session', 'resource', platform);
    assert.equal(h.context.anchor, outer);
    assert.equal(outer.nextElementSibling, h.host);
    assert.equal(h.host.hidden, false);
  }
});

test('player replacement moves the one host and a missing or mismatched session detaches it', () => {
  const h = harness();
  const old = h.player('festival', 'first');
  h.context.attach('first', 'resource-1', 'bilibili');
  h.details.open = true;
  old.outer.remove();
  h.context.visibility();
  assert.equal(h.host.hidden, true);
  const fresh = h.player('festival', 'second');
  h.context.attach('second', 'resource-2', 'bilibili');
  assert.equal(h.host.parentElement, h.column);
  assert.equal(fresh.outer.nextElementSibling, h.host);
  assert.equal(h.details.open, false, 'new resource resets expansion');
  assert.equal(h.host.hidden, false);
  assert.deepEqual(h.resize.observed, [old.outer, fresh.outer]);
  assert.equal(h.resize.disconnects, 2);
  h.context.attach('wrong-session', 'resource-2', 'bilibili');
  assert.equal(h.host.isConnected, false);
  assert.equal(h.context.anchor, null);
  assert.equal(h.host.hidden, true);
});

test('absolute player and non-flow parent fail closed without styling or inserting the host', () => {
  for (const [style, parentStyle] of [
    [{ position: 'absolute' }, {}],
    [{}, { display: 'grid' }],
    [{}, { display: 'flex', flexDirection: 'row' }],
  ]) {
    const h = harness();
    Object.assign(h.column.style, parentStyle);
    const { outer } = h.player('festival', 'session', { style });
    h.context.attach('session', 'resource', 'bilibili');
    assert.equal(h.context.anchor, null);
    assert.equal(h.host.parentElement, null);
    assert.equal(h.host.hidden, true);
    assert.equal(outer.nextElementSibling, null);
  }
});
