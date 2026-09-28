import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { PERFORMANCE_HISTORY_KEY, performanceRecord } from '../src/translation/performance-history.ts';

const sourceRoot = resolve(process.cwd());
const artifactsRoot = resolve(sourceRoot, '.artifacts/service-a-ui');
await mkdir(artifactsRoot, { recursive: true });
const runDir = await mkdtemp(resolve(artifactsRoot, 'run-'));
const report = {
  evidence: 'BUILT_EXTENSION_ISOLATED_PROFILE_UI_FIXTURES',
  profile: 'fresh temporary profile; existing browser profiles are not read',
  providerTransport: 'all HTTP(S) requests blocked; model list and test RPCs use fixtures',
  locale: 'zh-CN',
  checks: {},
  screenshots: [],
  copiedOptionsCssAssets: [],
  errors: [],
  blockedHttpRequests: 0,
};

const sample = {
  endpoint: 'https://api.minimax.cn/v1',
  model: 'MiniMax-M3',
  profile: 'minimax',
  reasoningProfileOverride: 'minimax',
  thinkingEffort: 'off',
};
const historyConfig = {
  count: 2, mode: 'load', concurrency: 2, batchSize: 2, arrivalIntervalMs: 10, strategy: 'normal', budgetMs: 800,
};
const historyMeasurement = {
  corpus: 'danlingo-fixed-v1', sourceLanguage: 'ja', sampleLanguage: 'ja', targetLanguage: 'zh-Hans',
  profile: 'deepseek', thinkingEffort: 'off', requestTimeoutMs: 12000, budgetMs: 800,
  batchSize: 2, maxBatchChars: 4000, translationStream: false,
};
const historyTiming = {
  firstValidMs: 70, readyWithin1s: 2, readyWithin2s: 2, readyWithin5s: 2, validItems: 2, plannedItems: 2,
  itemsPerSecond: 4, meanItemReadyMs: 120, p95ItemReadyMs: 160, peakRequests: 2,
};
function makeHistoryFixture(id, model, wallStartedAt) {
  const record = performanceRecord({
    id, state: 'completed', config: { ...historyConfig }, model, backend: 'online',
    startedAt: 100, finishedAt: 600, wallStartedAt, measurement: { ...historyMeasurement }, timing: { ...historyTiming },
    planned: 2, admitted: 2, completed: 2, actualRequests: 2, successRequests: 2, failed: 0, timeout: 0,
    cancelled: 0, unsent: 0, meanMs: 200, p50Ms: 180, p95Ms: 250, successRate: 1,
    meanQueueMs: 10, meanReadyMs: 300, withinBudgetRate: 1, throughput: 4,
    firstRequestMs: 200, stableMeanMs: 180, usageReports: 2,
  });
  assert.ok(record, 'synthetic history fixture should satisfy the production record contract');
  return record;
}
const historyFixtures = [
  makeHistoryFixture('history-fixture-one', 'Fixture Alpha', 1000),
  makeHistoryFixture('history-fixture-two', 'Fixture Beta', 2000),
  makeHistoryFixture('history-fixture-three', 'Fixture Gamma', 3000),
];
const legacySettingsFixture = {
  backend: 'online', enabled: true, endpoint: sample.endpoint, endpointInput: sample.endpoint, model: sample.model,
  profile: sample.profile, reasoningProfileOverride: sample.reasoningProfileOverride, thinkingEffort: sample.thinkingEffort,
  endpointMode: 'base', protocolOverride: 'chat-completions',
  connectionOverride: { endpointMode: 'base', protocol: 'chat-completions' },
  bilibiliShadowScheduler: true, bilibiliNativeTranslationOnly: true,
  bilibiliOwnedRelease: true, bilibiliUserFilters: true,
};
const keyWhenNotRemembered = 'service-a-ui-fixture-session-key';
const keyWhenRemembered = 'service-a-ui-fixture-remembered-key';
let context;
let page;

const safeError = error => String(error?.stack ?? error).replaceAll(keyWhenNotRemembered, '[fixture-key]').replaceAll(keyWhenRemembered, '[fixture-key]');
const check = async (name, run) => {
  await run();
  report.checks[name] = 'PASS';
  console.log('PASS', name);
};

try {
  const { chromium } = await loadPlaywright();
  const extension = resolve(runDir, 'extension');
  await cp(resolve(process.env.DANLINGO_TEST_EXTENSION || '.output/chrome-mv3'), extension, { recursive: true });
  const manifestPath = resolve(extension, 'manifest.json');
  report.copiedOptionsCssAssets = (await readdir(resolve(extension, 'assets')).catch(() => []))
    .filter(name => /^options.*\.css$/iu.test(name))
    .map(name => `assets/${name}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const permission = new URL(sample.endpoint).origin + '/*';
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), permission, 'https://gateway.example.com/*'])];
  await writeFile(manifestPath, JSON.stringify(manifest));

  context = await chromium.launchPersistentContext(resolve(runDir, 'profile'), {
    headless: true,
    ...browserLaunchOptions('chromium'),
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'allow',
    args: [
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
      '--disable-background-networking',
      '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  await context.route(/^https?:/u, async route => {
    report.blockedHttpRequests++;
    await route.abort('blockedbyclient');
  });

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  await worker.evaluate(async ({ settings, historyKey, historyRecords }) => {
    const stored = await chrome.storage.local.get('settings.v1');
    await chrome.storage.local.set({
      'settings.v1': { ...(stored['settings.v1'] ?? {}), ...settings },
      [historyKey]: historyRecords,
    });
  }, { settings: legacySettingsFixture, historyKey: PERFORMANCE_HISTORY_KEY, historyRecords: historyFixtures });
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.id) return;
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const fixture = globalThis.__serviceAFixture = { calls: [] };
    if (globalThis.chrome.permissions) chrome.permissions.request = async () => true;
    chrome.runtime.sendMessage = async (message, ...rest) => {
      const settings = message?.settings;
      fixture.calls.push({
        type: message?.type,
        settings: settings ? {
          backend: settings.backend,
          endpoint: settings.endpoint,
          endpointInput: settings.endpointInput,
          model: settings.model,
          profile: settings.profile,
          reasoningProfileOverride: settings.reasoningProfileOverride,
          superChatThinkingEffort: settings.superChatThinkingEffort,
          endpointMode: settings.endpointMode,
          protocolOverride: settings.protocolOverride,
          connectionOverride: settings.connectionOverride,
          thinkingEffort: settings.thinkingEffort,
          onlineRequestLimitPerDay: settings.onlineRequestLimitPerDay,
        } : undefined,
        keyProvided: typeof message?.apiKey === 'string' && message.apiKey.length > 0,
        remember: typeof message?.remember === 'boolean' ? message.remember : undefined,
        text: message?.type === 'test-model' ? message.text : undefined,
        context: message?.type === 'test-model' ? message.context : undefined,
      });

      if (message?.type === 'model-catalog') {
        return { ok: true, catalog: { models: ['MiniMax-M3'], fetchedAt: Date.now() } };
      }
      if (message?.type === 'models') {
        return { ok: true, models: ['MiniMax-M3'], fetchedAt: Date.now() };
      }
      if (message?.type === 'test-model') {
        return {
          ok: true,
          model: settings?.model ?? 'fixture-model',
          elapsedMs: 42,
          sourceText: message.text || 'fixture source',
          text: 'fixture translated text',
          targetLanguage: settings?.targetLanguage ?? 'zh-CN',
          promptMode: 'fixture',
        };
      }
      return originalSendMessage(message, ...rest);
    };
  });

  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(safeError(error)));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin + '/options.html');
  await page.locator('#backend').waitFor({ state: 'attached' });
  await page.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
  await page.reload();
  await page.locator('#backend').waitFor({ state: 'attached' });
  const rpc = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);

  const goTo = async section => {
    const category = page.locator('#category');
    if (await category.count() && await category.isVisible()) await category.selectOption(section);
    else await page.locator(`nav a[href="#${section}"]`).click();
    await page.waitForFunction(id => {
      const panel = document.querySelector(`[data-section="${id}"]`);
      return Boolean(panel && !panel.hidden && panel.getClientRects().length);
    }, section);
  };
  const reveal = async id => page.locator(`#${id}`).evaluate(element => {
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  });
  const setUiLocale = async locale => {
    await page.evaluate(value => chrome.storage.local.set({ 'ui.locale.v1': value }), locale);
    await page.reload();
    await page.locator('#backend').waitFor({ state: 'attached' });
    await page.waitForFunction(value => document.documentElement.lang.toLowerCase() === value.toLowerCase(), locale);
    await goTo('service');
  };
  const waitForSave = async previousCount => {
    await page.waitForFunction(count => {
      const fixture = globalThis.__serviceAFixture;
      const saves = fixture?.calls.filter(call => call.type === 'save').length ?? 0;
      const save = document.querySelector('#save');
      return saves > count && save && !save.disabled;
    }, previousCount);
    assert.equal(await page.locator('#result').evaluate(element => element.classList.contains('error')), false, 'save should succeed');
    assert.notEqual((await page.locator('#result').textContent()).trim(), '', 'save should provide visible feedback');
  };
  const saveFromUi = async () => {
    const before = await page.evaluate(() => globalThis.__serviceAFixture.calls.filter(call => call.type === 'save').length);
    await page.locator('#save').click();
    await waitForSave(before);
  };
  const readStored = async () => {
    const response = await rpc({ type: 'settings' });
    assert.equal(response?.ok, true, 'settings RPC should respond');
    return response;
  };
  const screenshot = async name => {
    const path = resolve(runDir, `${name}-1280x900.png`);
    await page.screenshot({ path, fullPage: false });
    report.screenshots.push({ name, width: 1280, height: 900, path });
  };
  const screenshotAt = async (name, width, height) => {
    const path = resolve(runDir, name + '-' + width + 'x' + height + '.png');
    await page.screenshot({ path, fullPage: false });
    report.screenshots.push({ name, width, height, path });
  };
  const layoutMetrics = () => page.evaluate(() => {
    const main = document.querySelector('main');
    const shell = main?.querySelector('.settings-shell') ?? main;
    const measure = element => element ? { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth } : null;
    return {
      viewportWidth: innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      main: measure(main),
      shell: measure(shell),
    };
  });
  const assertNoHorizontalOverflow = async label => {
    const metrics = await layoutMetrics();
    assert.ok(metrics.documentScrollWidth <= metrics.viewportWidth + 1, `${label}: document overflow ${JSON.stringify(metrics)}`);
    for (const [name, size] of [['main', metrics.main], ['settings shell', metrics.shell]]) {
      if (size) assert.ok(size.scrollWidth <= size.clientWidth + 1, `${label}: ${name} overflow ${JSON.stringify(metrics)}`);
    }
  };
  const ownership = async id => page.locator(`#${id}`).evaluate(element => element.closest('[data-section]')?.dataset.section ?? null);
  const storedSnapshot = async () => {
    const response = await readStored();
    return {
      settings: response.settings,
      hasOnlineKey: response.hasOnlineKey,
      remembered: response.remembered,
    };
  };
  const focusMetrics = async selector => page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return {
      focused: document.activeElement === element,
      mode: document.documentElement.dataset.focusInput,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
    };
  });
  const assertPointerHasNoOutline = async (selector, label) => {
    const metrics = await focusMetrics(selector);
    assert.equal(metrics.focused, true, label + ': pointer action should leave the target focused');
    assert.equal(metrics.mode, 'pointer', label + ': pointer input mode should be recorded');
    assert.ok(metrics.outlineStyle === 'none' || metrics.outlineWidth === 0,
      label + ': pointer focus should not draw an outline ' + JSON.stringify(metrics));
  };
  const tabTo = async selector => {
    await page.locator(selector).evaluate(target => {
      const focusable = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length > 0);
      const index = focusable.indexOf(target);
      if (index <= 0) throw new Error('target has no visible preceding tab stop');
      focusable[index - 1].focus({ preventScroll: true });
    });
    await page.keyboard.press('Tab');
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), selector);
    const metrics = await focusMetrics(selector);
    assert.equal(metrics.mode, 'keyboard', selector + ': keyboard navigation mode should be recorded');
    assert.ok(metrics.outlineStyle !== 'none' && metrics.outlineWidth > 0,
      selector + ': keyboard focus should draw an outline ' + JSON.stringify(metrics));
  };

  await check('source-control-ids-retained-once-and-category-ownership', async () => {
    const html = await readFile(resolve(sourceRoot, 'entrypoints/options/index.html'), 'utf8');
    const sourceIds = [...html.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]);
    assert.equal(new Set(sourceIds).size, sourceIds.length, 'source index.html ids must be unique');
    const liveCounts = await page.locator('[id]').evaluateAll(elements => elements.reduce((counts, element) => {
      counts[element.id] = (counts[element.id] ?? 0) + 1;
      return counts;
    }, {}));
    for (const id of sourceIds) assert.equal(liveCounts[id], 1, `original id #${id} should appear exactly once`);

    const sections = await page.locator('[data-section]').evaluateAll(elements => [...new Set(elements.map(element => element.dataset.section))].sort());
    assert.deepEqual(sections, ['advanced', 'data', 'live', 'performance', 'service', 'watching']);
    const serviceIds = [
      'backend', 'endpoint', 'local-http', 'model', 'thinking-effort', 'api-key', 'remember',
      'online-request-limit', 'model-test-text', 'model-test-context', 'get-models', 'test-model',
      'translation-shortcut', 'customize-shortcut', 'shortcut-result',
    ];
    for (const id of serviceIds) assert.equal(await ownership(id), 'service', `#${id} belongs to the service category`);
    for (const [id, section] of [
      ['target-language', 'watching'], ['live-buffer', 'live'], ['lp-superChatReasoning', 'live'],
      ['lp-parallel', 'advanced'], ['lb-start', 'performance'], ['clear-cache', 'data'],
    ]) assert.equal(await ownership(id), section, `#${id} belongs to ${section}`);
    await goTo('service');
  });

  await check('retired-settings-hidden-and-legacy-values-disabled', async () => {
    for (const id of ['bilibili-shadow-scheduler', 'bilibili-native-translation-only']) {
      assert.equal(await page.locator('#' + id).count(), 0, 'retired setting #' + id + ' should be absent');
    }
    const state = await readStored();
    assert.equal(state.settings.bilibiliShadowScheduler, false);
    assert.equal(state.settings.bilibiliNativeTranslationOnly, false);
    assert.equal(state.settings.bilibiliOwnedRelease, true, 'five-second planning remains enabled');
    assert.equal(state.settings.bilibiliUserFilters, true, 'user filters remain enabled');
    assert.equal(state.settings.enabled, true, 'translation setting remains enabled');
    await goTo('watching');
    assert.equal(await page.locator('#enabled').isChecked(), true);
    assert.equal(await page.locator('#bilibili-user-filters').isChecked(), true);
    assert.equal(await page.locator('#bilibili-owned-release').isChecked(), true);
    await goTo('service');
  });

  await check('advanced-controls-open-and-hidden-connection-overrides-auto', async () => {
    const rawBefore = await page.evaluate(() => chrome.storage.local.get('settings.v1'));
    assert.equal(rawBefore['settings.v1'].reasoningProfileOverride, 'minimax');
    assert.equal(rawBefore['settings.v1'].connectionOverride.endpointMode, 'base');
    await goTo('advanced');
    for (const id of ['profile', 'endpoint-mode', 'protocol-override']) {
      assert.equal(await page.locator('#' + id).isVisible(), false);
      assert.equal(await page.locator('#' + id).inputValue(), 'auto');
    }
    assert.equal(await page.locator('#profile').evaluate(el => el.closest('.card').hidden), true);
    for (const id of ['profile', 'urgent', 'lp-capacity', 'lp-temperature']) {
      assert.equal(await page.locator('#' + id).evaluate(el => el.closest('details').open), true, `#${id} group opens by default`);
    }
    assert.equal(await page.locator('#urgent').isVisible(), true);
    assert.equal(await page.locator('#superchat-timeout').isVisible(), false, 'Super Chat belongs to the live page');
    await screenshot('advanced-online-open');
    await goTo('service');
    await page.locator('#backend').selectOption('local');
    await goTo('advanced');
    await page.locator('#lp-capacity').scrollIntoViewIfNeeded();
    await screenshot('advanced-local-open');
    await goTo('service');
    await page.locator('#backend').selectOption('online');
    const effective = await readStored();
    assert.equal(effective.settings.profile, 'minimax');
    assert.equal(effective.settings.reasoningProfileOverride, 'minimax');
    assert.equal(effective.settings.endpointMode, 'base');
    assert.equal(effective.settings.protocolOverride, 'chat-completions');
    assert.deepEqual(effective.settings.connectionOverride, legacySettingsFixture.connectionOverride);
    assert.equal(effective.settings.thinkingEffort, 'off');
    const rawAfter = await page.evaluate(() => chrome.storage.local.get('settings.v1'));
    assert.deepEqual(rawAfter, rawBefore, 'opening the settings page must not rewrite the saved configuration');
    await goTo('service');
  });

  await check('legacy-incompatible-reasoning-uses-auto-draft-without-saving', async () => {
    const previous = await readStored();
    const customEndpoint = 'https://gateway.example.com/custom/v1';
    const old = { ...previous.settings, ...legacySettingsFixture, endpoint: customEndpoint + '/chat/completions',
      endpointInput: customEndpoint, model: 'deepseek-v4-flash', profile: 'deepseek',
      reasoningProfileOverride: 'deepseek', thinkingEffort: 'high', superChatThinkingEffort: 'high' };
    assert.equal((await rpc({ type: 'save', settings: old })).ok, true);
    const rawBefore = await page.evaluate(() => chrome.storage.local.get('settings.v1'));
    await page.reload();
    await page.waitForFunction(endpoint => document.querySelector('#endpoint')?.value === endpoint, customEndpoint);
    assert.equal(await page.locator('#profile').inputValue(), 'auto');
    assert.equal(await page.locator('#endpoint-mode').inputValue(), 'auto');
    assert.equal(await page.locator('#protocol-override').inputValue(), 'auto');
    assert.equal(await page.locator('#thinking-effort').inputValue(), 'default');
    assert.equal(await page.locator('#superchat-thinking').inputValue(), 'inherit');
    assert.equal(rawBefore['settings.v1'].superChatThinkingEffort, 'high');
    assert.deepEqual(await page.evaluate(() => chrome.storage.local.get('settings.v1')), rawBefore);
    await page.locator('#test-model').click();
    await page.waitForFunction(() => !document.querySelector('#test-model').disabled &&
      document.querySelector('#test-result').textContent.includes('fixture translated text'));
    const tested = await page.evaluate(() => globalThis.__serviceAFixture.calls.filter(call => call.type === 'test-model').at(-1));
    assert.equal(tested.settings.endpointInput, customEndpoint);
    assert.equal(tested.settings.endpoint, customEndpoint + '/chat/completions', 'auto recognizes a versioned gateway base');
    assert.equal(tested.settings.profile, 'chat-completions');
    assert.equal(tested.settings.reasoningProfileOverride, 'auto');
    assert.equal(tested.settings.thinkingEffort, 'default');
    assert.equal(tested.settings.superChatThinkingEffort, 'inherit');
    assert.deepEqual(await page.evaluate(() => chrome.storage.local.get('settings.v1')), rawBefore,
      'testing the automatic draft must leave legacy settings untouched');
    assert.equal((await rpc({ type: 'save', settings: previous.settings })).ok, true);
    await page.reload();
    await page.waitForFunction(model => document.querySelector('#model')?.value === model, sample.model);
  });

  await check('service-layout-locales', async () => {
    for (const locale of ['zh-CN', 'en', 'ar']) {
      await setUiLocale(locale);
      for (const width of [1280, 390]) {
        await check(`service-overflow-${locale}-${width}`, async () => {
          await page.setViewportSize({ width, height: 900 });
          await assertNoHorizontalOverflow(`${locale} service at ${width}px`);
        });
      }
    }
    await setUiLocale('zh-CN');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await check('translation-shortcut-in-backend-card-responsive', async () => {
    await goTo('service');
    await page.setViewportSize({ width: 1280, height: 900 });
    const inspectShortcutRow = () => page.evaluate(() => {
      const card = document.querySelector('.backend-card');
      const row = document.querySelector('#translation-shortcut')?.closest('.shortcut-row');
      const backend = document.querySelector('#backend');
      const rect = element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, height: box.height };
      };
      const cardRect = rect(card);
      const rowRect = rect(row);
      const backendRect = rect(backend);
      return {
        parentMatches: row?.parentElement === card,
        childIds: [...row.children].map(element => element.id),
        cardRect,
        rowRect,
        backendRect,
        controlsWithinRow: [...row.children].every(element => {
          const box = element.getBoundingClientRect();
          return box.left >= rowRect.left - 1 && box.right <= rowRect.right + 1;
        }),
        duplicateCount: ['translation-shortcut', 'customize-shortcut', 'shortcut-result']
          .reduce((count, id) => count + document.querySelectorAll(`#${id}`).length, 0),
      };
    });
    const desktop = await inspectShortcutRow();
    assert.equal(desktop.parentMatches, true, 'the original shortcut row belongs to the backend card');
    assert.deepEqual(desktop.childIds, ['', 'customize-shortcut', 'shortcut-result'], 'existing controls stay together in their original order');
    assert.equal(desktop.duplicateCount, 3, 'each original shortcut control appears once');
    assert.ok(Math.abs(desktop.rowRect.right - desktop.cardRect.right) <= 1, 'shortcut row is aligned to the backend card right edge');
    assert.ok(Math.abs((desktop.rowRect.top + desktop.rowRect.height / 2) - (desktop.backendRect.top + desktop.backendRect.height / 2)) <= 1,
      'wide shortcut row shares the backend selector line');
    for (const id of ['translation-shortcut', 'customize-shortcut']) assert.equal(await page.locator('#' + id).isVisible(), true);
    await screenshot('service-shortcut-online');

    await page.locator('#backend').selectOption('local');
    await page.waitForFunction(() => document.querySelector('#local-settings')?.hidden === false);
    assert.equal(await page.locator('#translation-shortcut').isVisible(), true, 'shortcut remains visible with local translation selected');
    await screenshot('service-shortcut-local');

    await page.setViewportSize({ width: 390, height: 900 });
    await assertNoHorizontalOverflow('shortcut row at 390px');
    const narrow = await inspectShortcutRow();
    assert.equal(narrow.parentMatches, true);
    assert.equal(narrow.controlsWithinRow, true, 'shortcut controls stay inside the wrapping row');
    assert.ok(narrow.rowRect.left >= narrow.cardRect.left - 1 && narrow.rowRect.right <= narrow.cardRect.right + 1,
      'narrow shortcut row remains inside the backend card');
    await screenshotAt('service-shortcut-narrow-local', 390, 900);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#backend').selectOption('online');
    await page.waitForFunction(() => document.querySelector('#local-settings')?.hidden === true);
  });

  await check('online-fields-and-fixture-sample', async () => {
    await page.locator('#backend').selectOption('online');
    await page.locator('#endpoint').fill(sample.endpoint);
    await page.locator('#model').fill(sample.model);
    await page.locator('#thinking-effort').selectOption(sample.thinkingEffort);
    await page.locator('#local-http').uncheck();
    await page.locator('#remember').uncheck();
    await page.locator('#online-request-limit').fill('8');
    await reveal('model-test-text');
    await page.locator('#model-test-text').fill('A fixture sample for service settings.');
    await page.locator('#model-test-context').selectOption('video');

    const before = await page.evaluate(() => Object.fromEntries(
      ['backend', 'endpoint', 'local-http', 'model', 'profile', 'thinking-effort', 'api-key', 'remember', 'online-request-limit', 'model-test-text', 'model-test-context']
        .map(id => [id, document.querySelector(`#${id}`).type === 'checkbox' ? document.querySelector(`#${id}`).checked : document.querySelector(`#${id}`).value]),
    ));
    await page.locator('#backend').selectOption('local');
    await page.waitForFunction(() => document.querySelector('#local-settings')?.hidden === false);
    await page.locator('#backend').selectOption('online');
    await page.waitForFunction(() => document.querySelector('#local-settings')?.hidden === true);
    const after = await page.evaluate(() => Object.fromEntries(
      ['backend', 'endpoint', 'local-http', 'model', 'profile', 'thinking-effort', 'api-key', 'remember', 'online-request-limit', 'model-test-text', 'model-test-context']
        .map(id => [id, document.querySelector(`#${id}`).type === 'checkbox' ? document.querySelector(`#${id}`).checked : document.querySelector(`#${id}`).value]),
    ));
    assert.deepEqual(after, before, 'online and local switching must preserve service fields');
    assert.equal(after.endpoint, sample.endpoint);
    assert.equal(after.model, sample.model);
    assert.equal(after.profile, 'auto');
    assert.equal(after['thinking-effort'], sample.thinkingEffort);
  });

  await check('light-dark-screenshots-and-narrow-shell-layout', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#theme').selectOption('light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot('service-light');
    await page.locator('#theme').selectOption('dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await screenshot('service-dark');

    await page.setViewportSize({ width: 390, height: 900 });
    await assertNoHorizontalOverflow('390px narrow viewport');
    await page.setViewportSize({ width: 700, height: 900 });
    await assertNoHorizontalOverflow('700px embedded-width shell');
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator('#theme').inputValue(), 'dark', 'theme choice should survive viewport changes');
  });

  await check('real-isolated-save-remember-off-and-key-cleared', async () => {
    await page.locator('#api-key').fill(keyWhenNotRemembered);
    await page.locator('#remember').uncheck();
    await saveFromUi();
    assert.equal(await page.locator('#api-key').inputValue(), '', 'API Key input should clear after save');
    const state = await storedSnapshot();
    assert.equal(state.settings.model, sample.model);
    assert.equal(state.settings.profile, sample.profile);
    assert.equal(state.settings.reasoningProfileOverride, 'auto');
    assert.equal(state.settings.endpointMode, 'auto');
    assert.equal(state.settings.protocolOverride, 'auto');
    assert.equal(state.settings.connectionOverride, undefined);
    assert.equal(state.settings.thinkingEffort, sample.thinkingEffort);
    assert.equal(state.settings.endpointInput, sample.endpoint, 'saved settings should retain the endpoint as entered');
    assert.equal(state.settings.endpoint, sample.endpoint + '/chat/completions', 'saved endpoint should be normalized for requests');
    assert.equal(state.settings.onlineRequestLimitPerDay, 8);
    assert.equal(state.hasOnlineKey, true);
    assert.equal(state.remembered, false);

    await page.locator('#theme').selectOption('light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.locator('#model-test-options').evaluate(element => { element.open = false; });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await screenshot('service-light-collapsed');
  });

  await check('zero-request-limit-and-remembered-key-persist', async () => {
    await page.locator('#online-request-limit').fill('0');
    await page.locator('#api-key').fill(keyWhenRemembered);
    await page.locator('#remember').check();
    await saveFromUi();
    assert.equal(await page.locator('#api-key').inputValue(), '', 'API Key input should clear after remembered save');
    let state = await storedSnapshot();
    assert.equal(state.settings.onlineRequestLimitPerDay, 0, 'zero means no daily request cap');
    assert.equal(state.hasOnlineKey, true);
    assert.equal(state.remembered, true);

    await saveFromUi();
    state = await storedSnapshot();
    assert.equal(state.hasOnlineKey, true, 'saving again with the cleared key must retain the same-origin key');
    assert.equal(state.remembered, true);
  });

  await check('model-list-and-test-actions-return-explicit-fixtures-without-saving', async () => {
    await page.locator('#get-models').click();
    await page.waitForFunction(() => !document.querySelector('#get-models').disabled);
    assert.equal(await page.locator('#models-result').evaluate(element => element.classList.contains('error')), false);
    assert.notEqual((await page.locator('#models-result').textContent()).trim(), '', 'model list action should report a result');
    assert.ok(await page.evaluate(() => globalThis.__serviceAFixture.calls.some(call => call.type === 'models')),
      'Get models must call the expected RPC; its response is mocked');
    await page.locator('#model').press('ArrowDown');
    assert.ok((await page.locator('#model-choices [role="option"]').allTextContents()).includes(sample.model), 'fixture model list should offer MiniMax-M3');

    const draftEndpoint = sample.endpoint + '/unsaved-test';
    await page.locator('#model-test-options').evaluate(element => { element.open = true; });
    await page.locator('#endpoint').fill(draftEndpoint);
    await page.locator('#model').fill(sample.model);
    await page.locator('#model-test-text').fill('Fixture test source text.');
    await page.locator('#model-test-context').selectOption('video');
    const saveCount = await page.evaluate(() => globalThis.__serviceAFixture.calls.filter(call => call.type === 'save').length);
    await page.locator('#test-model').click();
    await page.waitForFunction(() => !document.querySelector('#test-model').disabled && document.querySelector('#test-result').textContent.includes('fixture translated text'));
    const tested = await page.evaluate(() => globalThis.__serviceAFixture.calls.filter(call => call.type === 'test-model').at(-1));
    assert.equal(tested.settings.endpointInput, draftEndpoint);
    // Auto path mode preserves an unrecognized explicit path (connection.ts).
    assert.equal(tested.settings.endpoint, draftEndpoint);
    assert.equal(tested.settings.model, sample.model);
    assert.equal(tested.settings.profile, sample.profile);
    assert.equal(tested.settings.reasoningProfileOverride, 'auto');
    assert.equal(tested.settings.endpointMode, 'auto');
    assert.equal(tested.settings.protocolOverride, 'auto');
    assert.equal(tested.settings.thinkingEffort, sample.thinkingEffort);
    assert.equal(tested.text, 'Fixture test source text.');
    assert.equal(tested.context, 'video');
    const state = await storedSnapshot();
    assert.equal(state.settings.endpointInput, sample.endpoint, 'testing an unsaved endpoint draft must not persist it');
    assert.equal(state.settings.endpoint, sample.endpoint + '/chat/completions', 'testing an unsaved endpoint draft must not change the normalized saved endpoint');
    assert.equal(state.settings.model, sample.model, 'the supported MiniMax-M3 model remains saved');
    assert.equal(state.settings.onlineRequestLimitPerDay, 0);
    assert.equal(state.remembered, true);
    assert.equal(await page.evaluate(() => globalThis.__serviceAFixture.calls.filter(call => call.type === 'save').length), saveCount,
      'test-model must not issue a save RPC');
  });

  await check('other-category-drafts-theme-and-backend-choice-retain', async () => {
    await page.locator('#theme').selectOption('dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const savedBeforeDraft = await storedSnapshot();
    const savedTargetLanguage = savedBeforeDraft.settings.targetLanguage;
    const savedLiveBufferMs = savedBeforeDraft.settings.liveBufferMs;
    await goTo('watching');
    await page.locator('#target-language').selectOption('fr');
    assert.equal(await page.locator('#target-language').inputValue(), 'fr');
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    await goTo('live');
    await page.locator('#live-buffer').fill('4700');
    assert.equal(await page.locator('#live-buffer').inputValue(), '4700');
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    for (const section of ['advanced', 'performance', 'data', 'service']) {
      await goTo(section);
      await page.setViewportSize({ width: 390, height: 900 });
      await assertNoHorizontalOverflow(`390px ${section} section`);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    assert.equal(await page.locator('#model').inputValue(), sample.model);
    assert.equal(await page.locator('#endpoint').inputValue(), sample.endpoint + '/unsaved-test');
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    await page.locator('#backend').selectOption('local');
    await page.waitForFunction(() => document.querySelector('#local-settings')?.hidden === false);
    await page.locator('#backend').selectOption('online');
    await page.waitForFunction(() => document.querySelector('#local-settings')?.hidden === true);
    assert.equal(await page.locator('#model').inputValue(), sample.model);
    assert.equal(await page.locator('#endpoint').inputValue(), sample.endpoint + '/unsaved-test');
    assert.equal(await page.locator('#online-request-limit').inputValue(), '0');
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    const state = await storedSnapshot();
    assert.equal(state.settings.targetLanguage, savedTargetLanguage, 'unsaved watching draft must not alter saved settings');
    assert.equal(state.settings.liveBufferMs, savedLiveBufferMs, 'unsaved live draft must not alter saved settings');
    await page.locator('#theme').selectOption('light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await page.locator('#theme').inputValue(), 'light');
  });

  await check('local-service-title-refreshes-on-switch-and-reload', async () => {
    await goTo('service');
    await page.locator('#backend').selectOption('local');
    await page.waitForFunction(() => document.querySelector('#page-title')?.textContent.includes('本地模型'));
    const current = await readStored();
    const localSave = await rpc({
      type: 'save',
      settings: { ...current.settings, backend: 'local' },
      apiKey: '',
      remember: current.remembered,
    });
    assert.equal(localSave?.ok, true, 'isolated settings RPC should save local mode');
    await page.reload();
    await page.locator('#backend').waitFor({ state: 'attached' });
    await goTo('service');
    assert.equal(await page.locator('#backend').inputValue(), 'local');
    await page.waitForFunction(() => document.querySelector('#page-title')?.textContent.includes('本地模型'));

    const local = await readStored();
    const onlineSave = await rpc({
      type: 'save',
      settings: { ...local.settings, backend: 'online' },
      apiKey: '',
      remember: local.remembered,
    });
    assert.equal(onlineSave?.ok, true, 'isolated profile should be restored to online mode');
    await page.reload();
    await page.locator('#backend').waitFor({ state: 'attached' });
    await goTo('service');
    await page.waitForFunction(() => document.querySelector('#page-title')?.textContent.includes('在线服务'));
    const restored = await storedSnapshot();
    assert.equal(restored.settings.backend, 'online');
    assert.equal(restored.hasOnlineKey, true);
    assert.equal(restored.remembered, true);
  });

  await check('editable-arrow-toggles-and-keyboard-selection', async () => {
    await goTo('service');
    for (const id of ['endpoint', 'model']) {
      const field = page.locator('#' + id), host = field.locator('..');
      await field.press('Escape');
      for (let n = 0; n < 3; n++) {
        await host.locator('.combobox-toggle').click();
        assert.equal(await field.getAttribute('aria-expanded'), 'true');
        await host.locator('.combobox-toggle').click();
        assert.equal(await field.getAttribute('aria-expanded'), 'false');
      }
      await field.press('ArrowDown');
      assert.equal(await field.getAttribute('aria-expanded'), 'true');
      await field.press('Escape');
      assert.equal(await field.getAttribute('aria-expanded'), 'false');
    }
    await page.locator('#model').fill('fixture-custom-model');
    assert.equal(await page.locator('#model').inputValue(), 'fixture-custom-model');
    await page.locator('#model').fill('MiniMax');
    await page.locator('#model').press('ArrowDown');
    await page.locator('#model').press('Enter');
    assert.equal(await page.locator('#model').inputValue(), sample.model);
  });

  await check('pointer-focus-quiet-keyboard-focus-visible', async () => {
    for (const selector of ['#api-key', '#thinking-effort', '#remember', '#model-test-options > summary']) {
      await page.locator(selector).click();
      await assertPointerHasNoOutline(selector, selector);
      await page.keyboard.press('Escape');
    }
    await goTo('data');
    await page.locator('#clear-cache').click();
    await assertPointerHasNoOutline('[data-confirm="clear-cache"]', 'confirmation button');
    await page.locator('[data-dismiss="clear-cache"]').click();
    await goTo('service');
    for (const selector of ['#api-key', '#get-models', '#model-test-options > summary']) await tabTo(selector);
    await page.locator('nav a[href="#watching"]').click();
    await page.waitForFunction(() => document.activeElement?.id === 'page-title');
    assert.equal((await focusMetrics('#page-title')).outlineStyle, 'none');
  });

  await check('history-overall-collapse-retains-records-and-inner-expansion', async () => {
    await goTo('performance');
    await page.waitForFunction(() => document.querySelectorAll('.history-record').length === 3);
    const disclosure = page.locator('#performance-history-disclosure');
    assert.equal(await disclosure.evaluate(el => el.open), false);
    assert.match(await page.locator('#performance-history-status').textContent(), /3/);
    await disclosure.scrollIntoViewIfNeeded();
    await screenshot('performance-history-collapsed');
    await disclosure.locator(':scope > summary').click();
    const record = page.locator('.history-record').first();
    const recordDetails = record.locator('details');
    const recordSummary = record.locator('summary');
    const remove = record.locator('.history-delete');
    assert.equal(await recordDetails.evaluate(el => el.open), false);
    assert.equal(await remove.isVisible(), true);
    assert.equal(await remove.evaluate(el => el.closest('summary') !== null), true);
    assert.equal(await remove.evaluate(el => el.previousElementSibling?.classList.contains('history-time')), true);
    assert.equal(await remove.evaluate(el => {
      const date = el.previousElementSibling.getBoundingClientRect();
      const button = el.getBoundingClientRect();
      return button.left >= date.right - 1 && Math.abs((button.top + button.height / 2) - (date.top + date.height / 2)) <= 2;
    }), true);
    await recordSummary.click();
    assert.equal(await recordDetails.evaluate(el => el.open), true);
    assert.equal(await page.locator('#performance-export').isVisible(), true);
    assert.equal(await record.locator('.history-delete').isVisible(), true);
    await screenshot('performance-history-expanded');
    const historyPath = resolve(runDir, 'performance-history-detail.png');
    await page.locator('.performance-history').screenshot({ path: historyPath });
    report.screenshots.push({ name: 'performance-history-detail', path: historyPath });
    await disclosure.locator(':scope > summary').click();
    assert.equal(await record.isVisible(), false);
    await goTo('watching'); await goTo('performance');
    assert.equal(await disclosure.evaluate(el => el.open), false);
    await disclosure.locator(':scope > summary').click();
    assert.equal(await record.locator('details').evaluate(el => el.open), true);
    const retained = await page.evaluate(key => chrome.storage.local.get(key), PERFORMANCE_HISTORY_KEY);
    assert.deepEqual(retained[PERFORMANCE_HISTORY_KEY], historyFixtures);
    await page.setViewportSize({ width: 390, height: 900 });
    await assertNoHorizontalOverflow('expanded performance history at 390px');
    await screenshotAt('performance-history-expanded', 390, 900);
    await page.setViewportSize({ width: 1280, height: 900 });
    await disclosure.locator(':scope > summary').click();
  });

  await check('all-settings-sections-use-flat-containers', async () => {
    for (const section of ['service', 'watching', 'live', 'performance', 'advanced', 'data']) {
      await goTo(section);
      const cards = await page.locator(`[data-section="${section}"] .card:visible`).evaluateAll(elements => elements.map(el => {
        const style = getComputedStyle(el);
        return { left: style.borderLeftWidth, right: style.borderRightWidth, radius: style.borderRadius };
      }));
      for (const card of cards) assert.deepEqual(card, { left: '0px', right: '0px', radius: '0px' });
      await assertNoHorizontalOverflow(section);
      if (section === 'watching' || section === 'live') await screenshot('flat-' + section);
    }
    await goTo('live'); await page.setViewportSize({ width: 390, height: 900 });
    await assertNoHorizontalOverflow('live at 390px');
    await screenshotAt('flat-live', 390, 900);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#theme').selectOption('dark');
    await screenshot('flat-live-dark');
  });

  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.errors.push(safeError(error));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  const reportPath = resolve(runDir, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log('REPORT', reportPath);
}

