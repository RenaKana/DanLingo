import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Built live content + Bilibili adapter + real idle timer; model/background and visibility are fixtures.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { liveHtml } from '../test/fixtures/bilibili-live-native.mjs';

const root = resolve('.artifacts/local-autoload');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'idle-return-browser-'));
const report = {
  evidence: 'BUILT_LIVE_CONTENT_AND_NATIVE_ADAPTER_WITH_REAL_IDLE_TIMER_AND_MOCK_MODEL',
  limitations: 'Synthetic Bilibili DOM and visibility; accelerated idle timer; no real background, platform, model, or GPU.',
  checks: [], errors: [], screenshots: [],
};
const idleSource = ts.transpileModule(await readFile(resolve('src/local/idle-unload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settings = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', localModelId: 'fixture-model',
  liveSourceLanguage: 'auto', targetLanguage: 'zh-Hans', liveBufferMs: 300 };

function installFixture(settings) {
  const listeners = new Set();
  const fixture = window.__IDLE_RETURN__ = { hidden: false, requests: [], loadStarts: 0, unloads: 0, bridge: [] };
  let state = { phase: 'ready', model: { id: settings.localModelId }, generation: 1, active: 0, queued: 0 };
  let runtime = { phase: 'ready', paused: false, modelId: settings.localModelId, modelName: 'Fixture model' };
  const emit = () => {
    fixture.runtime = { ...runtime };
    for (const listener of listeners) listener({ type: 'local-runtime-updated', localRuntime: runtime }, { id: 'idle-return-fixture' });
  };
  const idle = new window.__LocalIdleUnloader({
    snapshot: () => state,
    blocked: () => !fixture.hidden,
    canUnload: async () => fixture.hidden,
    timeoutMs: 100,
    unload: () => state = { ...state, phase: 'idle', generation: state.generation + 1 },
    unloaded: () => { fixture.unloads++; runtime = { phase: 'idle', paused: false }; emit(); },
  });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => fixture.hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => fixture.hidden ? 'hidden' : 'visible' });
  fixture.visible = visible => {
    fixture.hidden = !visible;
    document.dispatchEvent(new Event('visibilitychange'));
    idle.changed();
  };
  fixture.setRuntime = next => {
    runtime = { ...next }; state = { ...state, phase: next.phase }; emit(); idle.changed();
  };
  fixture.finishLoad = () => fixture.setRuntime({ phase: 'ready', paused: false, modelId: settings.localModelId, modelName: 'Fixture model' });
  window.browser = { runtime: {
    id: 'idle-return-fixture',
    onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    sendMessage: async message => {
      if (message.type === 'settings') return { ok: true, settings, hasKey: true, localRuntime: runtime, configVersion: 1 };
      if (message.type === 'translate') {
        fixture.requests.push({ phase: runtime.phase, texts: message.items.map(row => row.text) });
        if (runtime.phase === 'idle' && !runtime.paused && !runtime.error) {
          fixture.loadStarts++;
          fixture.setRuntime({ phase: 'loading', paused: false, modelId: settings.localModelId });
          return { ok: false, error: 'LOCAL_MODEL_LOADING', configVersion: 1 };
        }
        if (runtime.phase !== 'ready') return { ok: false, error: 'LOCAL_MODEL_LOADING', configVersion: 1 };
        return { ok: true, configVersion: 1, items: message.items.map(row => ({ id: row.id, text: '【模拟译文】' + row.text, status: 'translated' })) };
      }
      return { ok: true, configVersion: 1 };
    },
  } };
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.bridge === 'danlingo-live-v1') fixture.bridge.push(event.data);
  });
  emit();
}

const { chromium } = await loadPlaywright();
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...browserLaunchOptions("chromium"),
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === 'https://live.bilibili.com'
    ? route.fulfill({ contentType: 'text/html', body: liveHtml }) : route.abort());
  await context.addInitScript({ content: `(() => { const exports = {}; ${idleSource}\nwindow.__LocalIdleUnloader = exports.LocalIdleUnloader; })(); (${installFixture.toString()})(${JSON.stringify(settings)});` });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('https://live.bilibili.com/777');
  await page.addScriptTag({ path: resolve('.output/chrome-mv3/content-scripts/bilibili-live-main.js') });
  await page.addScriptTag({ path: resolve('.output/chrome-mv3/content-scripts/live.js') });
  const connected = () => page.waitForFunction(() => window.__IDLE_RETURN__.bridge
    .findLast(row => row.type === 'snapshot')?.presentationActive === true, undefined, { timeout: 8000 });
  const fire = (id, text) => page.evaluate(({ id, text }) => window.__BILI_FIXTURE__.fire(id, text), { id, text });
  const rowText = id => page.locator(`[data-id_str="${id}"] .danmaku-item-right`).textContent();
  const waitRow = id => page.locator(`[data-id_str="${id}"] .danmaku-item-right`).waitFor();
  const stateText = () => page.locator('#danlingo-live-status #state').textContent();
  const waitState = text => page.waitForFunction(value => document.querySelector('#danlingo-live-status')
    ?.shadowRoot?.getElementById('state')?.textContent.includes(value), text);
  const capture = async name => { const path = resolve(directory, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path); };

  await connected();
  await fire('initial', '最初の翻訳です'); await waitRow('initial');
  assert.match(await rowText('initial'), /^【模拟译文】/);
  report.checks.push('initial-ready-translates-in-native-chat');

  for (let cycle = 1; cycle <= 2; cycle++) {
    await page.evaluate(() => window.__IDLE_RETURN__.visible(false));
    await page.waitForFunction(value => window.__IDLE_RETURN__.unloads === value, cycle);
    await page.evaluate(() => window.__IDLE_RETURN__.visible(true));
    await connected();
    await waitState('本地模型未加载');
    assert.match(await stateText(), /本地模型未加载/);
    assert.doesNotMatch(await stateText(), /加载中/);
    // Observe an actual content heartbeat, then prove it did not start a load.
    const controls = await page.evaluate(() => window.__IDLE_RETURN__.bridge.filter(row => row.type === 'control').length);
    await page.waitForFunction(value => window.__IDLE_RETURN__.bridge.filter(row => row.type === 'control').length > value, controls);
    assert.equal(await page.evaluate(() => window.__IDLE_RETURN__.loadStarts), cycle - 1);
    await fire('same-' + cycle, '这条无需翻译'); await waitRow('same-' + cycle);
    await fire('symbols-' + cycle, '!!!'); await waitRow('symbols-' + cycle);
    assert.equal(await rowText('same-' + cycle), '这条无需翻译');
    assert.equal(await page.evaluate(() => window.__IDLE_RETURN__.loadStarts), cycle - 1);
    if (cycle === 1) await capture('unloaded-and-connected');

    await fire('wake-' + cycle, 'モデルを起こします');
    await page.waitForFunction(value => window.__IDLE_RETURN__.loadStarts === value, cycle);
    await waitRow('wake-' + cycle);
    assert.equal(await rowText('wake-' + cycle), 'モデルを起こします');
    await waitState('加载中');
    assert.match(await stateText(), /加载中/);
    if (cycle === 1) await capture('loading-keeps-original');
    await page.evaluate(() => window.__IDLE_RETURN__.finishLoad());
    await connected();
    await fire('resumed-' + cycle, '翻訳が戻りました'); await waitRow('resumed-' + cycle);
    assert.match(await rowText('resumed-' + cycle), /^【模拟译文】/);
    report.checks.push(`idle-return-cycle-${cycle}-heartbeats-noop-demand-loads-and-chat-recovers`);
  }
  await capture('translation-recovered');

  for (const [id, runtime] of [
    ['manual', { phase: 'idle', paused: true }],
    ['error', { phase: 'idle', paused: false, error: 'LOCAL_LOAD_FAILED' }],
  ]) {
    await page.evaluate(value => window.__IDLE_RETURN__.setRuntime(value), runtime);
    await page.waitForFunction(() => window.__IDLE_RETURN__.bridge.findLast(row => row.type === 'control')?.enabled === false);
    const requests = await page.evaluate(() => window.__IDLE_RETURN__.requests.length);
    await fire(id, '自動再開しないでください'); await waitRow(id);
    assert.equal(await rowText(id), '自動再開しないでください');
    assert.equal(await page.evaluate(() => window.__IDLE_RETURN__.requests.length), requests);
    report.checks.push(`${id}-stays-original-without-autoload`);
  }
  report.fixture = await page.evaluate(() => ({ loadStarts: window.__IDLE_RETURN__.loadStarts, unloads: window.__IDLE_RETURN__.unloads, requests: window.__IDLE_RETURN__.requests }));
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await browser?.close();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks, errors: report.errors, report: resolve(directory, 'report.json') }, null, 2));
}
