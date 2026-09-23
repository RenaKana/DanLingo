import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

const stripImports = source => source.replace(/^\s*import[^;]+;\s*/gm, '');
const stripExports = source => source.replace(/\bexport\s+(?=(?:const|function|class|let|var))/g, '');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const [popupSource, statusSource, themeSource, diagnosticSource] = await Promise.all([
  readFile(new URL('entrypoints/popup/main.ts', root), 'utf8'),
  readFile(new URL('src/ui/live-status.ts', root), 'utf8'),
  readFile(new URL('src/ui/theme.ts', root), 'utf8'),
  readFile(new URL('src/core/adapter-diagnostic.ts', root), 'utf8'),
]);

const popupCode = [
  'const browser = globalThis.browser;',
  stripExports(stripImports(transpile(statusSource))),
  stripExports(stripImports(transpile(themeSource))),
  stripExports(stripImports(transpile(diagnosticSource))),
  stripImports(transpile(popupSource)),
].join('\n');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

class FakeClassList {
  values = new Set();
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : force;
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.parentElement = null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) {
    return selector === '[data-theme-control]' && this.themeControl ? this.themeControl : null;
  }
  querySelector(selector) {
    if (selector === '[data-theme-status]' && this.themeStatus) return this.themeStatus;
    return null;
  }
}

class FakeSelect extends FakeElement {
  constructor(id, options = []) {
    super(id);
    this.options = options.map(([value, text = value]) => ({ value, textContent: text }));
    this.value = this.options[0]?.value ?? '';
  }
  add(option) { this.options.push(option); }
}

class FakeEventTarget {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(...args) { for (const listener of [...this.listeners]) listener(...args); }
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function overview({ scenario, state = 'ready', hasKey = true, settings = {} } = {}) {
  return {
    ok: true,
    hasKey,
    settings: { enabled: true, displayMode: 'translated', targetLanguage: 'zh-Hans', ...settings },
    status: scenario || state !== 'ready' ? {
      scenario,
      state,
      connection: scenario === 'live' ? 'connected' : undefined,
      coverage: scenario === 'live' ? 'all' : undefined,
      messages: 4,
      translated: 3,
      original: 1,
      cacheHits: 0,
      queued: 1,
      prepared: 3,
      nearPrepared: 3,
      nearTotal: 4,
      recentEligible: 4,
      recentTranslated: 3,
      timedOut: 1,
      overloaded: 0,
      dropped: 0,
    } : undefined,
  };
}

function createHarness({ initialOverview = overview({ scenario: 'video' }), toggleResponse = null, themeStored = { theme: 'system' }, deferInitialOverview = false, deferToggle = false, deferThemeGet = false, settingsResponse = { ok: true } } = {}) {
  const elements = new Map();
  const enabled = new FakeElement('enabled');
  const language = new FakeSelect('language', [['zh-Hans', '简体中文'], ['en', '英语']]);
  const mode = new FakeSelect('mode', [['translated', '译文优先'], ['original', '原文']]);
  const theme = new FakeSelect('theme', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]);
  const status = new FakeElement('status');
  const metrics = new FakeElement('metrics');
  const coverage = new FakeElement('coverage');
  const scenario = new FakeElement('scenario');
  const settings = new FakeElement('settings');
  const popupControls = new FakeElement('popup-controls');
  const themeControl = new FakeElement('theme-control');
  const themeStatus = new FakeElement('theme-status');
  theme.parentElement = themeControl;
  theme.themeControl = themeControl;
  themeControl.themeStatus = themeStatus;
  for (const element of [enabled, language, mode, theme, status, metrics, coverage, scenario, settings]) elements.set(element.id, element);

  const pageListeners = new Map();
  const windowListeners = new Map();
  const storageChanged = new FakeEventTarget();
  const themeGet = deferred();
  const initial = deferInitialOverview ? deferred() : null;
  const toggle = deferToggle ? deferred() : null;
  const toggleCalls = [];
  const storageWrites = [];
  const intervals = [];
  const overviewQueue = [];
  const toggleQueue = [];
  let openOptions = 0;
  let settingsRequests = 0, closed = 0;
  if (initial) overviewQueue.push(initial.promise);
  else overviewQueue.push(Promise.resolve(initialOverview));
  if (toggle) toggleQueue.push(toggle.promise);
  else if (toggleResponse) toggleQueue.push(Promise.resolve(toggleResponse));

  const browser = {
    runtime: {
      sendMessage(message) {
        if (message.type === 'overview') return overviewQueue.shift() ?? Promise.resolve(initialOverview);
        if (message.type === 'toggle') {
          toggleCalls.push(message);
          return toggleQueue.shift() ?? Promise.resolve(toggleResponse ?? { ok: true, settings: message });
        }
        if (message.type === 'open-settings') { settingsRequests++; return Promise.resolve(settingsResponse); }
        return Promise.resolve({ ok: true });
      },
      openOptionsPage() { openOptions++; },
      onMessage: new FakeEventTarget(),
    },
    storage: {
      local: {
        get() { return themeGet.promise; },
        set(value) { storageWrites.push(value); return Promise.resolve(); },
      },
      onChanged: storageChanged,
    },
  };

  const document = {
    body: { dataset: {} },
    documentElement: { dataset: {} },
    getElementById(id) { return elements.get(id) ?? null; },
    querySelector(selector) { return selector === '.popup-controls' ? popupControls : null; },
  };
  const window = {
    close() { closed++; },
    matchMedia() {
      const media = new FakeEventTarget();
      media.matches = false;
      media.addEventListener = media.addListener.bind(media);
      media.removeEventListener = media.removeListener.bind(media);
      return media;
    },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type) { windowListeners.delete(type); },
  };
  const context = vm.createContext({
    browser,
    document,
    window,
    Option: class {
      constructor(text, value) { this.textContent = text; this.value = value; }
    },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(popupCode, context, { filename: 'popup-main.ts' });
  if (!deferThemeGet) themeGet.resolve({ 'ui.preferences.v1': themeStored });

  return {
    elements: { enabled, language, mode, theme, status, metrics, coverage, scenario, settings, popupControls, themeStatus },
    browser,
    document,
    window,
    initial,
    toggle,
    themeGet,
    toggleCalls,
    storageWrites,
    intervals,
    openOptions: () => openOptions,
    settingsRequests: () => settingsRequests,
    closed: () => closed,
    enqueueOverview(response) { overviewQueue.push(Promise.resolve(response)); },
    enqueueToggle(response) { toggleQueue.push(Promise.resolve(response)); },
    async settle() { await flush(); await flush(); },
  };
}

test('popup opens in-page settings and closes only after successful connection without navigation', async () => {
  const response = deferred();
  const h = createHarness({ settingsResponse: response.promise });
  await h.settle();
  h.elements.settings.dispatchEvent({ type: 'click' });
  h.elements.settings.dispatchEvent({ type: 'click' });
  assert.equal(h.settingsRequests(), 1);
  assert.equal(h.closed(), 0);
  response.resolve({ ok: true }); await h.settle();
  assert.equal(h.closed(), 1);
  assert.equal(h.openOptions(), 0);
});

test('recognized live room waits for native readiness without claiming connection or unsupported URL', async () => {
  const response = { ...overview({ scenario: 'live' }), status: null, bilibiliLiveCandidate: true };
  const h = createHarness({ initialOverview: response }); await h.settle();
  assert.equal(h.elements.status.textContent, '已识别 Bilibili 直播，正在等待原生直播间就绪');
  assert.equal(h.elements.scenario.textContent, '直播');
  assert.equal(h.elements.metrics.textContent, '');
  h.enqueueOverview({ ...response, bilibiliLiveCandidate: false }); h.intervals[0](); await h.settle();
  assert.equal(h.elements.status.textContent, '打开视频或直播页面开始观看');
  assert.equal(h.elements.scenario.textContent, '视频与直播');
});

test('settings open failure retains an actionable popup error across status polling', async () => {
  const h = createHarness({ settingsResponse: { ok: false, error: '无法打开设置，请重试' } });
  await h.settle(); h.elements.settings.dispatchEvent({ type: 'click' }); await h.settle();
  h.intervals[0](); await h.settle();
  assert.equal(h.elements.status.textContent, '无法打开设置，请重试');
  assert.equal(h.closed(), 0);
  assert.equal(h.openOptions(), 0);
  h.elements.settings.dispatchEvent({ type: 'click' }); await h.settle();
  assert.equal(h.settingsRequests(), 2, 'the failed action remains retryable');
});

test('popup preserves user quick settings while an older overview is still pending', async () => {
  const h = createHarness({ deferInitialOverview: true, deferToggle: true });
  await flush();
  h.elements.enabled.checked = false;
  h.elements.language.value = 'fr-CA';
  h.elements.mode.value = 'original';
  h.elements.language.dispatchEvent({ type: 'change' });
  assert.equal(h.toggleCalls[0].type, 'toggle');
  assert.equal(h.toggleCalls[0].enabled, false);
  assert.equal(h.toggleCalls[0].targetLanguage, 'fr-CA');
  assert.equal(h.toggleCalls[0].displayMode, 'original');
  assert.equal(h.elements.enabled.disabled, true);
  assert.equal(h.elements.status.textContent, '正在应用设置…');

  h.initial.resolve(overview({ scenario: 'video', settings: { enabled: true, targetLanguage: 'zh-Hans' } }));
  await h.settle();
  assert.equal(h.elements.enabled.checked, false);
  assert.equal(h.elements.language.value, 'fr-CA');
  assert.equal(h.elements.mode.value, 'original');
  assert.equal(h.elements.status.textContent, '正在应用设置…');

  h.enqueueOverview(overview({ scenario: 'video', settings: { enabled: false, displayMode: 'original', targetLanguage: 'fr-CA' } }));
  h.toggle.resolve({ ok: true, settings: { enabled: false, displayMode: 'original', targetLanguage: 'fr-CA' } });
  await h.settle();
  assert.equal(h.elements.enabled.disabled, false);
  assert.equal(h.elements.enabled.checked, false);
  assert.equal(h.elements.language.value, 'fr-CA');
});

test('popup applies a successful toggle, keeps custom language, and renders video status', async () => {
  const h = createHarness({
    initialOverview: overview({ scenario: 'video' }),
    toggleResponse: { ok: true, settings: { enabled: false, displayMode: 'original', targetLanguage: 'fr-CA' } },
  });
  await h.settle();
  h.enqueueOverview(overview({ scenario: 'video', settings: { enabled: false, displayMode: 'original', targetLanguage: 'fr-CA' } }));
  h.elements.enabled.checked = false;
  h.elements.language.value = 'fr-CA';
  h.elements.mode.value = 'original';
  h.elements.enabled.dispatchEvent({ type: 'change' });
  await h.settle();
  assert.equal(h.elements.enabled.disabled, false);
  assert.equal(h.elements.enabled.checked, false);
  assert.equal(h.elements.language.value, 'fr-CA');
  assert.equal(h.elements.mode.value, 'original');
  assert.equal(h.elements.scenario.textContent, '视频');
  assert.match(h.elements.status.textContent, /翻译已关闭|原生弹幕翻译已就绪/);
});

test('popup preserves attempted values after toggle failure and ignores refresh overwrite', async () => {
  const h = createHarness({
    initialOverview: overview({ scenario: 'video', settings: { enabled: false } }),
    toggleResponse: { ok: false, error: '服务暂时不可用' },
  });
  await h.settle();
  h.elements.enabled.checked = true;
  h.elements.enabled.dispatchEvent({ type: 'change' });
  await h.settle();
  assert.equal(h.elements.enabled.checked, true);
  assert.equal(h.elements.enabled.disabled, false);
  assert.equal(h.elements.status.textContent, '服务暂时不可用');

  h.enqueueOverview(overview({ scenario: 'video', settings: { enabled: false } }));
  h.intervals[0]();
  await h.settle();
  assert.equal(h.elements.enabled.checked, true);
  assert.equal(h.elements.status.textContent, '服务暂时不可用');
});

test('popup renders live coverage and unsupported states without losing controls', async () => {
  const live = createHarness({ initialOverview: overview({ scenario: 'live' }) });
  await live.settle();
  assert.equal(live.elements.scenario.textContent, '直播');
  assert.equal(live.elements.coverage.hidden, false);
  assert.match(live.elements.coverage.textContent, /范围：全部聊天/);

  const unsupported = createHarness({ initialOverview: overview({ state: 'unsupported', hasKey: true }) });
  await unsupported.settle();
  assert.equal(unsupported.elements.scenario.textContent, '视频与直播');
  assert.equal(unsupported.elements.status.textContent, '请打开支持的视频或直播页面');
});

test('popup prioritizes configuration, runtime, adapter failure, and recognized unresponsive page', async () => {
  const adapterDiagnostic = { platform: 'bilibili', scenario: 'video', urlResourceId: 'BV1SQbW6dELM:p1',
    code: 'unsupported-version', nativeVersion: '9.9.9', nativeCompiled: '2026-07-14T14:26:03+08:00' };
  const failed = { ...overview(), status: null, adapterDiagnostic };
  const configured = createHarness({ initialOverview: { ...failed, hasKey: false } });
  await configured.settle();
  assert.equal(configured.elements.status.textContent, '请先配置翻译服务');
  const active = createHarness({ initialOverview: { ...overview({ scenario: 'video' }), adapterDiagnostic } });
  await active.settle();
  assert.equal(active.elements.status.textContent, '原生弹幕翻译已就绪');
  const failure = createHarness({ initialOverview: failed });
  await failure.settle();
  assert.match(failure.elements.status.textContent, /9\.9\.9.*尚未支持.*2026-07-14/);
  assert.equal(failure.elements.scenario.textContent, '视频');
  assert.equal(failure.elements.metrics.textContent, '');
  failure.enqueueOverview({ ...failed, adapterDiagnostic: { ...adapterDiagnostic, code: 'content-unresponsive' } });
  failure.intervals[0](); await failure.settle();
  assert.equal(failure.elements.status.textContent, '已识别 Bilibili 视频，但页面脚本未响应');
  failure.enqueueOverview(overview({ scenario: 'video' }));
  failure.intervals[0](); await failure.settle();
  assert.equal(failure.elements.status.textContent, '原生弹幕翻译已就绪');
  const unsupported = createHarness({ initialOverview: { ...failed, adapterDiagnostic: null } });
  await unsupported.settle();
  assert.equal(unsupported.elements.status.textContent, '打开视频或直播页面开始观看');
});

test('theme interaction wins over late storage load, then accepts external changes', async () => {
  const h = createHarness({ themeStored: { theme: 'light' } });
  h.elements.theme.value = 'dark';
  h.elements.theme.dispatchEvent({ type: 'change' });
  await h.settle();
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.equal(h.storageWrites.length, 1);
  assert.equal(h.storageWrites[0]['ui.preferences.v1'].theme, 'dark');

  h.browser.storage.onChanged.emit({ 'ui.preferences.v1': { newValue: { theme: 'light' } } }, 'local');
  await h.settle();
  assert.equal(h.elements.theme.value, 'light');
  assert.equal(h.document.documentElement.dataset.theme, 'light');
});

test('theme external update wins over an older initial storage read', async () => {
  const h = createHarness({ themeStored: { theme: 'light' }, deferThemeGet: true });
  await h.settle();
  h.browser.storage.onChanged.emit({ 'ui.preferences.v1': { newValue: { theme: 'dark' } } }, 'local');
  await h.settle();
  assert.equal(h.elements.theme.value, 'dark');
  assert.equal(h.document.documentElement.dataset.theme, 'dark');

  h.themeGet.resolve({ 'ui.preferences.v1': { theme: 'light' } });
  await h.settle();
  assert.equal(h.elements.theme.value, 'dark');
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
});
