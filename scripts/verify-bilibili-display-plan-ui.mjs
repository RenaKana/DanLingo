// Isolated source-widget fixture. It never visits a real Bilibili page or settings UI.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

const source = process.argv[2];
if (!source) throw Error('Usage: node scripts/verify-bilibili-display-plan-ui.mjs <built-extension-directory>');
const root = resolve('.artifacts/bilibili-display-plan-ui'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(directory, 'extension');
const report = { status: 'RUNNING', evidence: 'ISOLATED_EXTENSION_LOCAL_WIDGET_SOURCE_FIXTURE',
  runDirectory: directory, checks: [], screenshots: [], blockedHttpRequests: 0, errors: [],
  limitations: ['The widget is bundled from current source into an isolated copy of the extension.',
    'The plan data is a fixture, not a native Bilibili admission result or model run.',
    'No real page, provider, account, or personal browser profile is used.'] };
const secret = 'PRIVATE_FIXTURE_ORIGINAL_<img src=x onerror=alert(1)>_日本語';
let context;
try {
  await cp(resolve(source), extension, { recursive: true });
  report.extensionVersion = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')).version;
  const entry = resolve(directory, 'fixture-entry.ts');
  const componentPath = relative(directory, resolve('src/ui/progress.ts')).replaceAll('\\', '/');
  const localePath = relative(directory, resolve('src/i18n/text.ts')).replaceAll('\\', '/');
  await writeFile(entry, `import { createProgress } from ${JSON.stringify(componentPath)};
import { setLocale } from ${JSON.stringify(localePath)};
const initial = { enabled: false, connected: true, resourceId: 'av123:cid456', status: 'idle',
  parameters: { lookaheadMs: 10000, freezeMs: 5000, bucketMs: 1000, limit: 2 },
  frozenBuckets: 0, selected: 0, translationNeeded: 0, unknown: 0, upcoming: [] };
let fixture;
const progress = createProgress(async () => {}, () => {}, async enabled => {
  fixture.actions.push(enabled);
  fixture.set({ ...fixture.view, enabled });
});
progress.attach('fixture-player', initial.resourceId, 'bilibili');
fixture = window.__displayPlanFixture = {
  view: initial, actions: [],
  set(next) { this.view = next; progress.updateDisplayPlan(next); },
  attach(resourceId, platform = 'bilibili') { progress.attach('fixture-player', resourceId, platform); },
  locale: setLocale,
  dispose() { progress.dispose(); },
};
fixture.set(initial);
`);
  const requireWxt = createRequire(import.meta.resolve('wxt'));
  const { build } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
  await build({ configFile: false, logLevel: 'error', build: { outDir: extension, emptyOutDir: false,
    lib: { entry, formats: ['es'], fileName: () => 'display-plan-widget-fixture.js' } } });
  await writeFile(resolve(extension, 'display-plan-widget-fixture.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<style>body{margin:20px;font:14px/1.5 sans-serif}#column{max-width:660px}#playerWrap{position:static;display:block;width:100%}video{display:block;width:100%;height:160px;background:#202827}</style>
<body><div id="column"><div id="playerWrap" data-danlingo-player="fixture-player"><video></video></div></div>
<script type="module" src="display-plan-widget-fixture.js"></script>`);
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, locale: 'zh-CN', viewport: { width: 1280, height: 800 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  context.setDefaultTimeout(12000);
  await context.route(/^https?:/i, route => { report.blockedHttpRequests++; return route.abort('internetdisconnected'); });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    if (!chrome?.runtime?.id) return;
    window.__fixtureStorageWrites = 0;
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (...args) => { window.__fixtureStorageWrites++; return original(...args); };
  });
  await page.goto(origin + '/display-plan-widget-fixture.html');
  const host = page.locator('#danlingo-progress');
  const plan = host.locator('#display-plan-host');
  const checkbox = plan.locator('input[type="checkbox"]');
  const state = plan.locator('.display-plan__state');
  const screenshot = async name => { const path = resolve(directory, name + '.png');
    await page.locator('#column').screenshot({ path }); report.screenshots.push(path); };
  await checkbox.waitFor();
  assert.equal(await host.isVisible(), true);
  assert.equal(await host.locator('#panel').isVisible(), false, 'Translation progress stays hidden');
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await checkbox.isEnabled(), true);
  await screenshot('plan-off-below-video');
  report.checks.push('bilibili-entry-visible-off-with-translation-inactive-and-in-flow');

  const fixtureView = { enabled: true, connected: true, resourceId: 'av123:cid456', status: 'preview',
    parameters: { lookaheadMs: 10000, freezeMs: 5000, bucketMs: 1000, limit: 2 },
    frozenBuckets: 4, selected: 6, translationNeeded: 3, unknown: 2,
    upcoming: [{ id: 'source-1', mediaTimeMs: 12345, originalText: secret, unknown: true,
      needsTranslation: true }], reasons: { userExcluded: 1, densityNotSelected: 5 } };
  const writesBefore = await page.evaluate(() => window.__fixtureStorageWrites);
  await checkbox.check();
  await page.waitForFunction(() => window.__displayPlanFixture.actions.includes(true));
  assert.equal(await page.evaluate(() => window.__fixtureStorageWrites), writesBefore);
  await page.evaluate(view => window.__displayPlanFixture.set(view), fixtureView);
  await state.getByText('预览就绪', { exact: true }).waitFor();
  assert.match(await plan.innerText(), /当前 epoch 累计冻结桶 4.*累计拟选 6.*待到期需译 3.*待到期未知 2/s);
  assert.match(await plan.innerText(), /不改变原生显示，不调用翻译模型/);
  assert.doesNotMatch(await plan.evaluate(el => el.outerHTML), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await plan.locator('li').count(), 0, 'Original text is not in collapsed DOM');
  const bounds = await page.evaluate(() => {
    const player = document.querySelector('#playerWrap').getBoundingClientRect();
    const widget = document.querySelector('#danlingo-progress').getBoundingClientRect();
    return { playerBottom: player.bottom, widgetTop: widget.top };
  });
  assert.ok(bounds.widgetTop >= bounds.playerBottom - 1, 'Widget must remain below the video');
  report.checks.push('toggle-is-session-only-summary-and-no-eager-original-text');

  await plan.locator('details > summary').click();
  await plan.locator('li').getByText(secret, { exact: false }).waitFor();
  assert.match(await plan.innerText(), /规则覆盖未知.*需要模拟翻译/s);
  assert.equal(await plan.locator('img').count(), 0, 'Original text must be a text node');
  await screenshot('plan-expanded-desktop');
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await plan.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await screenshot('plan-expanded-mobile');
  report.checks.push('expanded-original-as-text-and-responsive-in-flow-preview');

  await plan.locator('details > summary').click();
  await plan.locator('li').first().waitFor({ state: 'detached' });
  assert.equal(await plan.locator('li').count(), 0, 'Collapsing removes original text nodes');
  await page.evaluate(() => window.__displayPlanFixture.set({ ...window.__displayPlanFixture.view, connected: false }));
  await state.getByText('视频未连接', { exact: true }).waitFor();
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await checkbox.isEnabled(), false);
  assert.doesNotMatch(await plan.evaluate(el => el.outerHTML), /PRIVATE_FIXTURE_ORIGINAL/);
  await screenshot('plan-disconnected');
  report.checks.push('collapse-and-disconnect-clear-previous-original-and-counts');

  await page.evaluate(view => {
    const fixture = window.__displayPlanFixture;
    fixture.attach('av123:cid789');
    fixture.set({ ...view, resourceId: 'av123:cid456' });
  }, fixtureView);
  await state.getByText('视频未连接', { exact: true }).waitFor();
  assert.doesNotMatch(await plan.evaluate(el => el.outerHTML), /PRIVATE_FIXTURE_ORIGINAL/);
  await page.evaluate(view => window.__displayPlanFixture.set({ ...view, resourceId: 'av123:cid789' }), fixtureView);
  await state.getByText('预览就绪', { exact: true }).waitFor();
  assert.match(await plan.innerText(), /av123 · cid789/);
  report.checks.push('resource-change-rejects-old-plan-before-new-view');

  await page.evaluate(() => window.__displayPlanFixture.dispose());
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('REPORT', resolve(directory, 'report.json'));
}
