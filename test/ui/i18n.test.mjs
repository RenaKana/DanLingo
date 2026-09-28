import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { LOCALES, localePreference, matchLocale, resolveLocale } from '../../src/i18n/locale.ts';
import { catalogs } from '../../src/i18n/catalogs.ts';
import { attachUiMessages, messageFromSource } from '../../src/i18n/wire.ts';
import * as text from '../../src/i18n/text.ts';
import { onlineBudgetText } from '../../src/ui/online-budget.ts';

test('browser locale matching keeps scripts and supported regional fallbacks', () => {
  for (const language of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-US']) assert.equal(matchLocale(language), 'zh-TW');
  for (const language of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans']) assert.equal(matchLocale(language), 'zh-CN');
  assert.equal(matchLocale('pt-PT'), 'pt-BR'); assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(resolveLocale('auto', 'ja-JP'), 'ja'); assert.equal(resolveLocale('auto', 'sv-SE'), 'en');
  assert.equal(resolveLocale('de', 'zh-CN'), 'de'); assert.equal(localePreference({ locale: 'ar' }), 'auto');
  assert.equal(localePreference('unsupported'), 'auto');
});

test('all twenty offline catalogs have identical nonempty keys and interpolation parameters', () => {
  const source = catalogs['zh-CN']; const keys = Object.keys(source).sort();
  assert.equal(LOCALES.length, 20); assert.ok(keys.length > 300);
  const parameters = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]).sort();
  for (const { code } of LOCALES) {
    assert.deepEqual(Object.keys(catalogs[code]).sort(), keys, code);
    for (const key of keys) {
      assert.equal(typeof catalogs[code][key], 'string', `${code}:${key}`);
      assert.ok(catalogs[code][key].trim(), `${code}:${key}`);
      assert.deepEqual(parameters(catalogs[code][key]), parameters(source[key]), `${code}:${key}`);
      assert.doesNotMatch(catalogs[code][key], /ZXQPH|DANLINGO\d{5}|⟦\d{5}⟧/, `${code}:${key}`);
    }
  }
});

test('every source message is included in all packaged catalogs, including new named UI keys', async () => {
  const directory = new URL('../../src/i18n/', import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('-messages.json'))) {
    const messages = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(catalogs['zh-CN'][key], value, `${file}:${key} source catalog must be regenerated`);
      for (const { code } of LOCALES) assert.ok(catalogs[code][key]?.trim(), `${code}:${key}`);
    }
  }
});

test('new feature descriptions are translated rather than copied wholesale from English', () => {
  const keys = ['performance.historyNote', 'performance.windowNote', 'performance.draftNote',
    'progress.supply.hybridScope', 'hybrid.note', 'userFilter.uncovered',
    'performance.controls.onlineNote', 'settings.bilibiliOwnedReleaseHint'];
  for (const { code } of LOCALES.filter(item => item.code !== 'en')) {
    for (const key of keys) {
      assert.ok(catalogs[code][key]?.trim(), `${code}:${key}`);
      assert.notEqual(catalogs[code][key], catalogs.en[key], `${code}:${key}`);
    }
    if (!['zh-CN', 'zh-TW', 'ja'].includes(code)) {
      for (const [key, value] of Object.entries(catalogs[code])) {
        if (/^(?:performance\.|hybrid\.|userFilter\.|progress\.supply\.)/.test(key)) {
          assert.doesNotMatch(value, /\p{Script=Han}/u, `${code}:${key} contains untranslated Chinese`);
        }
      }
    }
  }
});

test('video preparation labels stay localized with distinct candidate, scope and native-stage counts', () => {
  for (const key of ['settings.videoScopeAuto', 'settings.videoScopeNote', 'settings.videoBatchSize', 'settings.sharedBatchSize',
    'progress.prepared', 'progress.coverage', 'progress.filtered', 'progress.nativeStage', 'progress.hidden', 'progress.autoWindow']) {
    assert.ok(catalogs.en[key], key);
    assert.doesNotMatch(catalogs.en[key], /\p{Script=Han}/u, key);
  }
  const coverage = catalogs.en['progress.coverage'];
  for (const parameter of ['{candidates}', '{range}', '{eligible}', '{pending}']) assert.ok(coverage.includes(parameter));
  assert.ok(catalogs.en['progress.nativeStage'].includes('{original}'));
  assert.match(catalogs.en['progress.nativeStage'], /not actual visible/);
});

test('every UI message reference has an offline catalog entry', async () => {
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(ts|html)$/.test(entry.name)) {
        const source = await readFile(path, 'utf8');
        const keys = [...source.matchAll(/\bm_[a-f0-9]{12}\b/g)].map(match => match[0]);
        for (const match of source.matchAll(/\bt\(\s*['"]([^'"\n]+)['"]\s*[,)]/g)) keys.push(match[1]);
        for (const match of source.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?=['"]([^'"${}\n]+)['"]/g)) keys.push(match[1]);
        for (const key of keys) assert.ok(Object.hasOwn(catalogs.en, key), path.pathname + ':' + key);
      }
    }
  }
  await inspect(new URL('../../entrypoints/', import.meta.url));
  await inspect(new URL('../../src/ui/', import.meta.url));
});

test('wire descriptors preserve machine state and never rewrite translated user content', () => {
  const reply = { ok: false, error: '请先配置 API Key', items: [{ text: '请先配置 API Key' }], status: { note: '请求已取消' } };
  const result = attachUiMessages(reply);
  assert.equal(result.error, reply.error); assert.strictEqual(result.items, reply.items);
  assert.ok(result.errorMessage?.id); assert.ok(result.status.noteMessage?.id);
  assert.equal('errorMessage' in reply, false);
  assert.equal(messageFromSource('unrecognized provider output'), undefined);
  text.setLocale('en');
  assert.equal(text.localizeMessage('a-private-provider-secret'), text.t('error.unknown'));
  assert.equal(text.localizeMessage({ id: 'not-an-owned-message', params: { secret: 'private' } }), text.t('error.unknown'));
  assert.equal(text.localizeMessage(result.errorMessage), text.t(result.errorMessage.id));
});

test('formatting uses locale rules without changing stored numeric values', () => {
  text.setLocale('de'); assert.equal(text.formatNumber(1234.5), '1.234,5');
  text.setLocale('en'); assert.equal(text.formatNumber(1234.5), '1,234.5');
  assert.equal(text.tCount('count.tasks', 1), '1 task'); assert.equal(text.tCount('count.tasks', 2), '2 tasks');
  text.setLocale('ru'); assert.equal(text.tCount('count.tasks', 2), '2 задачи'); assert.equal(text.tCount('count.tasks', 5), '5 задач');
});

test('a retained UI error renders in the current language after switching', () => {
  text.setLocale('en');
  const error = new text.UiError('m_fb5089735051', { p0: 'fixture detail' });
  const english = text.localizeMessage(error);
  text.setLocale('ja');
  assert.equal(text.localizeMessage(error), text.t('m_fb5089735051', { p0: 'fixture detail' }));
  assert.notEqual(text.localizeMessage(error), english);
  assert.equal(error.uiMessage.params.p0, 'fixture detail');
});

test('online budget renders unknown counters as unavailable instead of null values', () => {
  text.setLocale('en');
  assert.equal(onlineBudgetText({ day: '2026-09-24', limit: 10, used: null, remaining: null, status: 'available' }), text.t('m_0d5d7207cfdf'));
  assert.equal(onlineBudgetText({ day: '2026-09-24', limit: 10, used: 0, remaining: null, status: 'available' }), text.t('m_0d5d7207cfdf'));
  text.setLocale('zh-CN');
});

test('a disabled daily cap renders as unlimited even when usage is unknown', () => {
  text.setLocale('zh-CN');
  for (const used of [null, 0, 99]) {
    const rendered = onlineBudgetText({ day: '2026-09-24', limit: 0, used, remaining: null, status: 'available' });
    assert.match(rendered, /不限制/);
    assert.doesNotMatch(rendered, /null|不可用|已达/);
  }
});

test('recognized error parameters redact credentials while unknown provider text stays private', () => {
  text.setLocale('en');
  const secret = 'synthetic' + 'OnlyCredential12345';
  for (const value of ['token=' + secret, 'api_key: ' + secret, 'Bearer ' + secret, 'https://user:' + secret + '@example.invalid']) {
    const result = text.localizeMessage({ id: 'm_fb5089735051', params: { p0: value } });
    assert.equal(result.includes(secret), false);
    assert.match(result, /\[redacted\]/);
  }
  assert.equal(text.localizeMessage('unrecognized response ' + secret), text.t('error.unknown'));
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function localeHarness(language = 'en-US') {
  const source = await readFile(new URL('../../src/i18n/index.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export \*[^;]+;\s*/gm, '').replace(/\bexport\s+(?=(?:function|const|class|async))/g, '');
  class Element {
    lang = ''; dir = ''; attrs = {}; children = []; handlers = new Map(); value = '';
    querySelectorAll() { return []; } hasAttribute(name) { return name in this.attrs; }
    getAttribute(name) { return this.attrs[name] ?? null; } setAttribute(name, value) { this.attrs[name] = value; }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) { return selector.includes('option') ? this.children.find(option => option.value === 'auto') : null; }
    addEventListener(type, fn) { this.handlers.set(type, fn); } removeEventListener(type) { this.handlers.delete(type); }
  }
  class Doc { documentElement = new Element(); querySelectorAll() { return []; } querySelector() { return null; } }
  class Shadow { host = new Element(); querySelectorAll() { return []; } querySelector() { return null; } }
  const document = new Doc(), select = new Element(), initial = deferred(), events = new Set(), writes = [];
  let locale = 'en'; const callbacks = new Set();
  const context = vm.createContext({
    browser: { i18n: { getUILanguage: () => language }, storage: { local: { get: () => initial.promise, set: async value => { writes.push(value); } },
      onChanged: { addListener: fn => events.add(fn), removeListener: fn => events.delete(fn) } } },
    Document: Doc, HTMLElement: Element, ShadowRoot: Shadow, document, navigator: { language },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    LOCALES, UI_LOCALE_KEY: 'ui.locale.v1', localePreference, resolveLocale,
    getLocale: () => locale, setLocale: next => { if (next !== locale) { locale = next; for (const fn of callbacks) fn(); } },
    onLocaleChange: fn => { callbacks.add(fn); return () => callbacks.delete(fn); }, t: key => key,
  });
  vm.runInContext(code + '\nglobalThis.start = initLocale;', context);
  return { document, select, initial, events, writes, start: context.start, locale: () => locale, Shadow };
}

test('stored language, cross-page updates and stale reads do not touch translation settings', async () => {
  const h = await localeHarness('ja-JP'); const pending = h.start(h.document, h.select);
  assert.equal(h.document.documentElement.lang, 'ja');
  h.select.value = 'de'; h.select.handlers.get('change')();
  h.initial.resolve({ 'ui.locale.v1': 'zh-CN' }); const dispose = await pending;
  assert.equal(h.locale(), 'de'); assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0])), { 'ui.locale.v1': 'de' });
  for (const fn of h.events) fn({ 'ui.preferences.v1': { newValue: { theme: 'dark' } } }, 'local');
  assert.equal(h.locale(), 'de');
  for (const fn of h.events) fn({ 'ui.locale.v1': { newValue: 'ar' } }, 'local');
  assert.equal(h.document.documentElement.dir, 'rtl'); assert.equal(h.select.value, 'ar');
  dispose(); assert.equal(h.events.size, 0);
});

test('injected controls set direction on their own host only', async () => {
  const h = await localeHarness('ar'); const shadow = new h.Shadow();
  const pending = h.start(shadow); h.initial.resolve({}); const dispose = await pending;
  assert.equal(shadow.host.dir, 'rtl'); assert.equal(h.document.documentElement.dir, ''); dispose();
});
