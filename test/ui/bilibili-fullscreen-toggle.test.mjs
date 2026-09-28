import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/ui/bilibili-fullscreen-toggle.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.id = '';
    this.className = '';
    this.type = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { cssText: '' };
    this._textContent = '';
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.document.body;
  }
  get parentElement() { return this.parentNode; }
  getBoundingClientRect() { return { left: 80, top: 300, width: 30, height: 30 }; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name) };
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  insertBefore(node, reference) {
    if (node === reference) return;
    node.remove();
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error('reference node is not a child');
    node.parentNode = this;
    this.children.splice(index, 0, node);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === 'id') this.id = text;
    if (name.startsWith('data-')) {
      const property = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[property] = text;
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      const property = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete this.dataset[property];
    }
  }
  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value.startsWith('#')) return this.id === value.slice(1);
      if (value.startsWith('.')) return this.classList.contains(value.slice(1));
      const dataMatch = value.match(/^\[data-([a-z0-9-]+)\]$/i);
      if (dataMatch) {
        const property = dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return Object.hasOwn(this.dataset, property);
      }
      return this.tagName.toLowerCase() === value.toLowerCase();
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function harness({ markerSession = 'video-a', onToggle = async () => {}, readShortcut } = {}) {
  const documentListeners = new Map();
  const localeListeners = new Set();
  const observers = [];
  const document = {
    body: null,
    documentElement: { clientWidth: 1200 },
    fullscreenElement: null,
    createElement(tag) { return new Element(tag, document); },
    querySelectorAll(selector) { return document.body?.querySelectorAll(selector) ?? []; },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) ?? []) listener(event);
    },
  };
  document.body = document.createElement('body');

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
    trigger() { if (this.targets.length) this.callback([], this); }
  }

  const player = document.createElement('div');
  player.id = 'playerWrap';
  const surface = document.createElement('div');
  surface.className = 'bpx-player-container';
  const marker = document.createElement('div');
  if (markerSession !== null) marker.setAttribute('data-danlingo-player', markerSession);
  const video = document.createElement('video');
  const toolbar = document.createElement('div');
  const region = document.createElement('div');
  region.className = 'bpx-player-dm-root';
  const anchor = document.createElement('button');
  anchor.className = 'bpx-player-dm-switch';
  region.append(anchor);
  toolbar.append(region);
  surface.append(marker, video, toolbar);
  player.append(surface);
  document.body.append(player);

  const translations = {
    'watch.translationOn': '翻译已开启，点击关闭',
    'watch.translationOff': '翻译已关闭，点击开启',
    'watch.enableTranslation': '开启翻译',
    'watch.disableTranslation': '关闭翻译',
    'watch.actionWithShortcut': '{action}（{shortcut}）',
    'm_6ade7baf8737': '保存失败：',
    'm_6bdb4435095e': '正在保存…',
  };
  const context = {
    document,
    getComputedStyle: () => ({ width: '24px', height: '24px', margin: '0px 24px 0px 0px' }),
    MutationObserver: FakeMutationObserver,
    t: (key, params = {}) => (translations[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match),
    localizeMessage: error => error instanceof Error ? error.message : '',
    onLocaleChange(callback) { localeListeners.add(callback); return () => localeListeners.delete(callback); },
  };
  vm.runInNewContext(code + '\nglobalThis.mountBilibiliFullscreenToggle = mountBilibiliFullscreenToggle;', context, { filename: 'bilibili-fullscreen-toggle.ts' });
  const toggle = context.mountBilibiliFullscreenToggle(onToggle, readShortcut);

  return {
    toggle, document, player, surface, marker, video, region, anchor, observers, localeListeners, documentListeners,
    getButton() { return document.body.querySelector('#danlingo-fullscreen-toggle'); },
    setSessionOnMarker(session) { marker.setAttribute('data-danlingo-player', session); },
    enterFullscreen(element) {
      document.fullscreenElement = element;
      document.dispatchEvent({ type: 'fullscreenchange' });
    },
    leaveFullscreen() {
      document.fullscreenElement = null;
      document.dispatchEvent({ type: 'fullscreenchange' });
    },
    flushMutations() { for (const observer of observers) observer.trigger(); },
  };
}

function click(button, isTrusted = true) {
  let prevented = false, stopped = false;
  button.dispatchEvent({
    type: 'click', isTrusted,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  return { prevented, stopped };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('requires the matching session and follows controls in normal and fullscreen modes', () => {
  const h = harness();
  h.toggle.update(false, '');
  assert.equal(h.getButton(), null);

  h.toggle.update(false, 'video-b');
  h.enterFullscreen(h.player);
  assert.equal(h.getButton(), null, 'a different player session must not receive the toggle');

  h.toggle.update(false, 'video-a');
  h.leaveFullscreen();
  assert.ok(h.getButton(), 'normal playback also provides the translation toggle');

  h.enterFullscreen(h.player);
  const button = h.getButton();
  assert.ok(button);
  assert.equal(button.nextSibling, h.anchor);
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  h.enterFullscreen(h.surface);
  assert.equal(h.getButton(), button, 'the inner player surface also qualifies');
  h.enterFullscreen(h.video);
  assert.equal(h.getButton(), null, 'fullscreen video alone does not contain the native control');
  h.toggle.dispose();
});

test('reconciles rebuilt native controls without duplicates, survives fullscreen exit and disposes', () => {
  const h = harness();
  h.toggle.update(false, 'video-a');
  h.enterFullscreen(h.player);
  const button = h.getButton();
  assert.ok(button);

  for (let index = 0; index < 4; index++) h.toggle.update(false, 'video-a');
  h.flushMutations();
  assert.equal(h.document.body.querySelectorAll('#danlingo-fullscreen-toggle').length, 1);

  const replacement = h.document.createElement('button');
  replacement.className = 'bpx-player-dm-switch';
  h.anchor.remove();
  h.region.append(replacement);
  h.flushMutations();
  assert.equal(button.parentNode, h.region);
  assert.equal(button.nextSibling, replacement);
  assert.equal(h.document.body.querySelectorAll('#danlingo-fullscreen-toggle').length, 1);

  h.leaveFullscreen();
  assert.equal(h.getButton(), button);
  h.toggle.dispose();
  assert.equal(h.getButton(), null);
  assert.equal(h.documentListeners.get('fullscreenchange')?.size ?? 0, 0);
  assert.equal(h.localeListeners.size, 0);
  assert.ok(h.observers.every(observer => observer.targets.length === 0));
  h.toggle.update(false, 'video-a');
  h.enterFullscreen(h.player);
  assert.equal(h.getButton(), null);
});

test('custom tooltip follows hover, keyboard, fullscreen and disposal without a browser title', () => {
  const h = harness();
  h.toggle.update(false, 'video-a');
  const button = h.getButton();
  const tip = () => h.document.body.querySelector('#danlingo-translation-tooltip');
  assert.equal(button.getAttribute('title'), null);
  button.dispatchEvent({ type: 'mouseenter' });
  assert.equal(tip().textContent, '开启翻译');
  assert.equal(tip().parentNode, h.document.body);
  h.toggle.update(true, 'video-a');
  assert.equal(tip().textContent, '关闭翻译');
  button.dispatchEvent({ type: 'mouseleave' });
  assert.equal(tip(), null);
  button.dispatchEvent({ type: 'focus' });
  assert.ok(tip());
  button.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation() {} });
  assert.equal(tip(), null);
  h.enterFullscreen(h.player);
  button.dispatchEvent({ type: 'mouseenter' });
  assert.equal(tip().parentNode, h.player);
  h.toggle.dispose();
  assert.equal(tip(), null);
  assert.equal(h.documentListeners.get('scroll')?.size ?? 0, 0);
});

test('only trusted clicks toggle, busy requests resist duplicates, and success updates the pressed state', async () => {
  let resolveRequest;
  let calls = 0;
  const h = harness({
    onToggle: () => {
      calls++;
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  h.toggle.update(false, 'video-a');
  h.enterFullscreen(h.player);
  const button = h.getButton();

  click(button, false);
  assert.equal(calls, 0);
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  const result = click(button);
  assert.equal(result.prevented, true);
  assert.equal(result.stopped, true);
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  click(button);
  assert.equal(calls, 1, 'a second click cannot start a parallel save');
  resolveRequest();
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), '翻译已开启，点击关闭');
  h.toggle.dispose();
});

test('tooltip refreshes the assigned shortcut and omits unset or unavailable bindings', async () => {
  let assigned = 'Alt+T';
  const h = harness({ readShortcut: async () => {
    if (assigned === null) throw new Error('commands unavailable');
    return assigned;
  } });
  h.toggle.update(false, 'video-a');
  await flush();
  const button = h.getButton();
  const tip = () => h.document.body.querySelector('#danlingo-translation-tooltip');
  button.dispatchEvent({ type: 'mouseenter' });
  await flush();
  assert.equal(tip().textContent, '开启翻译（Alt+T）');
  assigned = 'Ctrl+Shift+Y';
  h.toggle.update(true, 'video-a');
  h.enterFullscreen(h.player);
  button.dispatchEvent({ type: 'mouseenter' });
  await flush();
  assert.equal(tip().textContent, '关闭翻译（Ctrl+Shift+Y）');
  assigned = '';
  button.dispatchEvent({ type: 'focus' });
  await flush();
  assert.equal(tip().textContent, '关闭翻译');
  assigned = null;
  button.dispatchEvent({ type: 'mouseenter' });
  await flush();
  assert.equal(tip().textContent, '关闭翻译');
  h.toggle.dispose();
});

test('keeps localized save errors through same-value updates, then clears them on retry or fullscreen exit', async () => {
  let calls = 0;
  const h = harness({
    onToggle: async () => {
      calls++;
      if (calls <= 2) throw new Error('请先填写服务地址');
    },
  });
  h.toggle.update(false, 'video-a');
  h.enterFullscreen(h.player);
  const button = h.getButton();

  click(button);
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.getAttribute('aria-label'), /保存失败：.*请先填写服务地址/);

  const failedTitle = button.getAttribute('aria-label');
  for (let index = 0; index < 4; index++) h.toggle.update(false, 'video-a');
  assert.equal(button.getAttribute('aria-label'), failedTitle, 'periodic same-state publishing preserves the error');

  h.toggle.update(true, 'video-a');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), '翻译已开启，点击关闭', 'an externally changed setting clears the error');

  click(button);
  await flush();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.getAttribute('aria-label'), /保存失败：.*请先填写服务地址/);

  h.leaveFullscreen();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(button.getAttribute('aria-label'), /服务地址/);
  h.enterFullscreen(h.player);
  assert.doesNotMatch(button.getAttribute('aria-label'), /服务地址/);

  click(button);
  assert.equal(button.disabled, true);
  assert.doesNotMatch(button.getAttribute('aria-label'), /服务地址/, 'a retry replaces the prior error with busy status');
  await flush();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.getAttribute('aria-label'), '翻译已关闭，点击开启');
  h.toggle.dispose();
});

test('a pending request from an old session cannot overwrite the current session state', async () => {
  let resolveRequest;
  const h = harness({
    onToggle: () => new Promise(resolve => { resolveRequest = resolve; }),
  });
  h.toggle.update(false, 'video-a');
  h.enterFullscreen(h.player);
  const button = h.getButton();

  click(button);
  assert.equal(button.disabled, true);
  h.setSessionOnMarker('video-b');
  h.toggle.update(false, 'video-b');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.disabled, false);

  resolveRequest();
  await flush();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.getButton(), button);
  h.toggle.dispose();
});
