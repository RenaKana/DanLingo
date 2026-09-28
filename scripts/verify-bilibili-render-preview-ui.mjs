// Isolated ShadowRoot fixture: this copies a built extension, bundles current source and blocks HTTP.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { analyzeBilibiliRenderPreview } from './bilibili-render-preview-analysis.mjs';

const source = process.argv[2];
if (!source) throw Error('Usage: node scripts/verify-bilibili-render-preview-ui.mjs <built-extension-directory>');
const root = resolve('.artifacts/bilibili-render-preview-ui'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-')), extension = resolve(directory, 'extension');
const report = { status: 'RUNNING', evidence: 'ISOLATED_EXTENSION_SHADOWROOT_RENDER_WIDGET_FIXTURE',
  runDirectory: directory, checks: [], screenshots: [], snapshots: [], errors: [], blockedHttpRequests: 0,
  limitations: ['This bundles current source into an isolated copy of the extension.',
    'Every text is a de-identified fixture, not a real Bilibili selection or verified user translation.',
    'No real page, provider, account or personal browser profile is used.'] };
let context, page;
try {
  await cp(resolve(source), extension, { recursive: true });
  report.extensionVersion = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')).version;
  const requireWxt = createRequire(import.meta.resolve('wxt'));
  const { build } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
  await build({ configFile: false, logLevel: 'error', build: { outDir: extension, emptyOutDir: false,
    lib: { entry: resolve('scripts/render-preview-widget-fixture.ts'), formats: ['es'],
      fileName: () => 'render-preview-widget-fixture.js' } } });
  await writeFile(resolve(extension, 'render-preview-widget-fixture.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<style>body{margin:20px;font:14px/1.5 sans-serif}#column{width:100%;max-width:700px}video{display:block;width:100%;height:160px;background:#202827}#render-host{display:block;width:100%}</style>
<body><div id="column"><video aria-label="夹具视频占位"></video><div id="render-host"></div></div>
<script type="module" src="render-preview-widget-fixture.js"></script>`);
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, locale: 'zh-CN', viewport: { width: 1280, height: 850 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  context.setDefaultTimeout(12000);
  await context.route(/^https?:/i, route => { report.blockedHttpRequests++; return route.abort('internetdisconnected'); });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => { window.__fixtureAlerted = false; window.alert = () => { window.__fixtureAlerted = true; }; });
  await page.goto(origin + '/render-preview-widget-fixture.html');
  const plan = page.locator('#render-host .render-preview'), stage = plan.locator('.render-preview__stage');
  const items = stage.locator('[data-render-key]'), checkbox = plan.locator('.render-preview__toggle input');
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readGeometry = () => page.evaluate(() => {
    const fixture = window.__renderFixture, stage = document.querySelector('#render-host').shadowRoot.querySelector('.render-preview__stage');
    const box = stage.getBoundingClientRect();
    return { mediaTimeMs: fixture.clock.mediaTimeMs, epoch: fixture.clock.epoch,
      stage: { left: box.left, top: box.top, width: box.width, height: box.height },
      items: [...stage.querySelectorAll('[data-render-key]')].map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { key: node.dataset.renderKey, lane: Number(node.dataset.renderLane), text: node.textContent,
          source: node.dataset.textSource, x: rect.left - box.left, y: rect.top - box.top,
          width: rect.width, height: rect.height, fontSize: style.fontSize, lineHeight: style.lineHeight,
          whiteSpace: style.whiteSpace };
      }) };
  });
  const screenshot = async name => {
    const path = resolve(directory, `${name}.png`);
    if (await checkbox.isChecked()) {
      const expectedTime = (await readGeometry()).mediaTimeMs / 1000;
      await page.waitForFunction(time => {
        const meta = document.querySelector('#render-host').shadowRoot.querySelector('.render-preview__meta');
        return meta?.textContent?.includes(`${time.toFixed(2)}s`);
      }, expectedTime);
    }
    await page.locator('#column').screenshot({ path }); report.screenshots.push(path);
    report.snapshots.push({ name, path, geometry: await readGeometry() });
  };
  await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await items.count(), 0);
  assert.equal((await page.evaluate(() => window.__renderFixture.report())).ui.rafActive, false);
  await screenshot('off'); report.checks.push('default-off-without-active-nodes');

  await checkbox.check();
  await page.waitForFunction(() => window.__renderFixture.report().ui.enabled);
  await page.evaluate(() => window.__renderFixture.feed([]));
  await page.evaluate(() => window.__renderFixture.reveal());
  await page.waitForFunction(() => window.__renderFixture.report().ui.visible);
  const ids = await page.evaluate(() => {
    const fixture = window.__renderFixture;
    const mixed = fixture.event('mixed', 10000, '[夹具] 中文 日本語 English 😀 <img src=x onerror=alert(1)>', true);
    const second = fixture.event('second', 10000, '[夹具] 第二条 short line');
    const multiline = fixture.event('multiline', 16000, '[夹具] 第一行\n第二行');
    const oversize = fixture.event('oversize', 16000, '[夹具]' + 'W'.repeat(350));
    return { ids: [mixed.id, second.id], rejected: fixture.feed([mixed, second, multiline, oversize]) };
  });
  assert.deepEqual(ids.rejected.sort(), ['multiline', 'oversize']);
  assert.equal(await items.count(), 0, 'No early entry before original media time');
  report.checks.push('full-text-measurement-and-early-unsupported-or-oversize-rejection');

  await page.evaluate(() => window.__renderFixture.setClock(10050));
  await page.waitForFunction(() => window.__renderFixture.report().counts.committed === 2);
  await page.evaluate(() => window.__renderFixture.setClock(11000));
  await page.waitForFunction(() => window.__renderFixture.report().ui.domSamples.some(row =>
    row.key.includes('mixed') && row.mediaTimeMs === 11000));
  const first = await readGeometry();
  assert.equal(first.items.length, 2);
  assert.ok(first.stage.width > 600, 'The progress host details max-width must not narrow the preview stage');
  assert.notEqual(first.items[0].lane, first.items[1].lane, 'Simultaneous entries require distinct tracks');
  assert.equal(first.items.every(item => item.fontSize === '20px' && item.whiteSpace === 'pre'), true);
  const byTrack = [...first.items].sort((a, b) => a.y - b.y);
  assert.ok(byTrack[0].y + byTrack[0].height <= byTrack[1].y + .1,
    'Measured DOM tracks must not overlap vertically');
  assert.equal(await stage.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.__fixtureAlerted), false);
  await screenshot('two-lanes-media-11s');
  await page.evaluate(() => window.__renderFixture.setClock(13000));
  await page.waitForFunction(() => window.__renderFixture.report().ui.domSamples.some(row =>
    row.key.includes('mixed') && row.mediaTimeMs === 13000));
  const second = await readGeometry();
  const firstMixed = first.items.find(item => item.key.includes('mixed'));
  const secondMixed = second.items.find(item => item.key.includes('mixed'));
  const layout = await page.evaluate(() => window.__renderFixture.report().layouts.at(-1));
  assert.ok(firstMixed && secondMixed);
  assert.equal(secondMixed.text, firstMixed.text, 'Moving text remains locked');
  assert.ok(Math.abs(secondMixed.width - firstMixed.width) < .1, 'Text width remains stable while moving');
  assert.ok(Math.abs((firstMixed.x - secondMixed.x) - layout.speedPxPerMs * 2000) < 3,
    'DOM displacement follows two seconds of media time');
  await screenshot('same-source-media-13s');
  report.checks.push('two-lane-real-dom-and-two-media-times-with-actual-displacement');

  await page.evaluate(() => window.__renderFixture.setClock(13000, { paused: true, playbackRate: 1 }));
  await frame();
  const paused = await readGeometry();
  const pausedPositions = await page.evaluate(() => window.__renderFixture.report().ui.activeDomPositions);
  await page.evaluate(() => window.__renderFixture.setClock(13000, { paused: false, playbackRate: 2 }));
  await frame();
  const doubled = await readGeometry();
  assert.ok(Math.abs(paused.items.find(item => item.key.includes('mixed')).x - secondMixed.x) < 1);
  assert.ok(Math.abs(doubled.items.find(item => item.key.includes('mixed')).x - secondMixed.x) < 1);
  assert.equal(pausedPositions.length, 2);
  assert.equal(pausedPositions.every(item => item.mediaTimeMs === 13000), true);
  assert.ok(Math.abs(pausedPositions.find(item => item.key.includes('mixed')).xPx - secondMixed.x) < 1);
  report.checks.push('pause-and-1x-2x-same-media-time-position');

  await plan.locator('select').selectOption('stored-translation');
  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    fixture.setClock(19000);
    const row = fixture.event('translated-fallback', 20000, '[夹具]短原文');
    const existing = fixture.seed(row, '[夹具]已有但过长译文'.repeat(140));
    fixture.feed([row], [existing]);
  });
  await page.evaluate(() => window.__renderFixture.setClock(20050));
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'translated-fallback' && row.state === 'committed'));
  await page.evaluate(() => window.__renderFixture.setClock(20100)); await frame();
  const fallback = await page.evaluate(() => window.__renderFixture.report().records.find(row => row.id === 'translated-fallback'));
  assert.equal(fallback.sourceMode, 'original');
  assert.equal(fallback.translationLayoutFallback, true);
  assert.match(await items.first().innerText(), /短原文/);
  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    const row = fixture.event('translated-fallback', 20000, '[夹具]短原文');
    fixture.repeat([fixture.seed(row, '[夹具]后到译文', performance.now())]);
  });
  await frame();
  assert.match(await items.first().innerText(), /短原文/);
  const late = await page.evaluate(() => window.__renderFixture.report().records.find(row => row.id === 'translated-fallback'));
  assert.ok(late.lateResultCount >= 1);
  report.checks.push('existing-translation-layout-fallback-and-late-result-does-not-change-moving-text');

  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    fixture.setClock(30000, { epoch: 2, seeking: true }); fixture.feed([]);
  });
  await page.waitForFunction(() => window.__renderFixture.report().ui.activeNodes === 0);
  assert.equal(await items.count(), 0);
  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    fixture.setClock(30000, { seeking: false }); fixture.feed([fixture.event('after-seek', 31000, '[夹具]seek 后中文 English')]);
    fixture.setClock(31050);
  });
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'after-seek' && row.state === 'committed'));
  await page.evaluate(() => window.__renderFixture.setClock(32500)); await frame();
  await screenshot('after-seek-new-epoch');
  await page.setViewportSize({ width: 390, height: 850 });
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'after-seek' && row.state === 'layout-reset'));
  assert.equal(await items.count(), 0);
  assert.equal(await plan.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await screenshot('resize-clears-old-layout');
  report.checks.push('seek-and-resize-clear-old-objects-without-replay');

  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    fixture.setClock(33000);
    fixture.feed([fixture.event('after-seek', 31000, '[夹具]seek 后中文 English'),
      fixture.event('before-collapse', 34000, '[夹具]折叠前')]);
    fixture.setClock(34050);
  });
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'before-collapse' && row.state === 'committed'));
  await page.evaluate(() => window.__renderFixture.setClock(34100)); await frame();
  await plan.locator('details').first().locator('summary').click();
  await page.waitForFunction(() => {
    const r = window.__renderFixture.report(); return r.ui.suspendReason === 'collapsed' && !r.ui.rafActive && !r.ui.activeNodes;
  });
  await screenshot('collapsed-clears-stage');
  await plan.locator('details').first().locator('summary').click();
  await page.waitForFunction(() => {
    const r = window.__renderFixture.report(); return r.ui.visible && r.ui.rafActive;
  });
  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    fixture.setClock(36000); fixture.feed([fixture.event('before-collapse', 34000, '[夹具]折叠前'),
      fixture.event('future-only', 37000, '[夹具]恢复后的未来条目')]);
  });
  await page.evaluate(() => window.__renderFixture.setClock(37050));
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'future-only' && row.state === 'committed'));
  await page.evaluate(() => window.__renderFixture.setClock(37100)); await frame();
  assert.equal((await readGeometry()).items.some(item => item.key.includes('before-collapse')), false);
  await checkbox.uncheck();
  await page.waitForFunction(() => !window.__renderFixture.report().ui.enabled);
  const closed = await page.evaluate(() => window.__renderFixture.report());
  assert.equal(await items.count(), 0);
  assert.ok(closed.ui.domSamples.length > 0, 'Closing preserves the sampling evidence');
  assert.deepEqual(closed.ui.activeDomPositions, []);
  for (const key of ['rafActive', 'intersectionActive', 'resizeActive', 'measurementNodes',
    'visibilityListenerCount', 'detailsListenerCount', 'fontListenerCount', 'motionListenerCount'])
    assert.ok(!closed.ui[key], `${key} must be zero after exit`);
  await screenshot('closed-empty');
  await checkbox.check();
  await page.waitForFunction(() => window.__renderFixture.report().ui.enabled);
  await page.evaluate(() => window.__renderFixture.feed([window.__renderFixture.event('future-only', 37000, '[夹具]恢复后的未来条目')]));
  await frame();
  assert.equal(await items.count(), 0, 'Re-enabling does not replay an already committed event');
  report.checks.push('collapse-future-only-and-close-zero-listeners-no-replay');

  const restarted = await page.evaluate(() => window.__renderFixture.report());
  assert.deepEqual(restarted.ui.domSamples, []);
  assert.equal(restarted.ui.domSampleCount, 0);
  assert.equal(restarted.ui.domSampleTruncated, false);
  assert.deepEqual(restarted.ui.activeDomPositions, []);
  const restartAnalysis = analyzeBilibiliRenderPreview(restarted);
  assert.equal(restartAnalysis.ok, true, restartAnalysis.violations.join(', '));
  report.checks.push('new-engine-clears-dom-samples-and-independent-receipt-validates');

  await plan.locator('select').selectOption('original');
  const earlyRejected = await page.evaluate(() => {
    const fixture = window.__renderFixture;
    return fixture.feed(Array.from({ length: 4096 }, (_, index) =>
      fixture.event(`spent-${index}`, 40000, '[夹具]' + 'W'.repeat(350)))).length;
  });
  assert.equal(earlyRejected, 4096);
  await checkbox.uncheck();
  await page.waitForFunction(() => !window.__renderFixture.report().ui.enabled);
  assert.equal((await page.evaluate(() => window.__renderFixture.report())).records.length, 4096);
  await checkbox.check();
  await page.waitForFunction(() => window.__renderFixture.report().ui.enabled);
  await page.evaluate(() => {
    const fixture = window.__renderFixture;
    fixture.setClock(37900);
    fixture.feed([fixture.event('after-spent-cap', 38000, '[夹具]限额后')]);
  });
  await page.waitForFunction(() => window.__renderFixture.report().ui.visible);
  await page.evaluate(() => window.__renderFixture.setClock(38050));
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'after-spent-cap' && row.state === 'committed'));
  await checkbox.uncheck();
  await page.waitForFunction(() => !window.__renderFixture.report().ui.enabled);
  await checkbox.check();
  await page.waitForFunction(() => window.__renderFixture.report().ui.enabled);
  await page.evaluate(() => window.__renderFixture.feed([
    window.__renderFixture.event('after-spent-cap', 38000, '[夹具]限额后')]));
  await frame();
  assert.equal(await items.count(), 0, 'Spent-cap exhaustion cannot replay an event within 250ms');
  report.checks.push('spent-cap-exhaustion-still-never-replays-a-past-event');

  await plan.locator('select').selectOption('live-local');
  const liveButtons = plan.locator('.render-preview__controls button');
  assert.deepEqual(await page.evaluate(() => window.__renderFixture.liveActions), []);
  assert.equal(await page.evaluate(() => window.__renderFixture.modes.at(-1)), 'live-local');
  assert.equal(await liveButtons.first().isDisabled(), true);
  for (const reason of ['live-preview-invalid-owner', 'live-preview-prepare-required']) {
    await page.evaluate(value => window.__renderFixture.setLiveState({ status: 'unprepared',
      modelName: null, modelState: 'unprepared', targetLanguage: '',
      remaining: { requests: 0, items: 0, chars: 0 },
      sent: 0, ready: 0, adopted: 0, fallback: 0, reason: value }), reason);
    const info = await plan.locator('.render-preview__live').innerText();
    assert.match(info, /先完成本地实验准备并绑定本页，再启动。/);
    assert.doesNotMatch(info, /live-preview-(?:invalid-owner|prepare-required)/);
    assert.equal(await liveButtons.first().isDisabled(), true);
  }
  await screenshot('live-prepare-required');
  report.checks.push('unprepared-live-mode-explains-prepare-and-page-binding');

  const readyState = { status: 'ready',
    modelName: '夹具本地模型', modelState: 'loaded', targetLanguage: 'zh',
    remaining: { requests: 3, items: 3, chars: 300 },
    sent: 0, ready: 0, adopted: 0, fallback: 0, reason: null };
  await page.evaluate(value => window.__renderFixture.setLiveState(value), readyState);
  assert.equal(await liveButtons.first().isEnabled(), true);
  for (const limit of ['requests', 'items', 'chars']) {
    await page.evaluate(([value, key]) => window.__renderFixture.setLiveState({ ...value,
      remaining: { ...value.remaining, [key]: 0 } }), [readyState, limit]);
    assert.equal(await liveButtons.first().isDisabled(), true, `Zero ${limit} budget must block start`);
  }
  await page.evaluate(value => window.__renderFixture.setLiveState({ ...value, status: 'stopped' }), readyState);
  assert.equal(await liveButtons.first().isDisabled(), true, 'Stopped needs a fresh ready state before restart');
  await page.evaluate(value => window.__renderFixture.setLiveState(value), readyState);
  assert.equal(await liveButtons.first().isEnabled(), true);
  assert.match(await plan.locator('.render-preview__notice').innerText(), /本地模型/);
  assert.doesNotMatch(await plan.locator('.render-preview__notice').innerText(), /不会调用翻译模型/);
  await liveButtons.first().click();
  assert.deepEqual(await page.evaluate(() => window.__renderFixture.liveActions), ['start']);
  assert.equal(await liveButtons.first().isDisabled(), true, 'Pending start cannot be repeated');
  await page.evaluate(() => window.__renderFixture.setLiveState({ status: 'running',
    modelName: '夹具本地模型', modelState: 'loaded', targetLanguage: 'zh',
    remaining: { requests: 2, items: 2, chars: 280 },
    sent: 1, ready: 1, adopted: 0, fallback: 0, reason: null }));
  report.checks.push('live-mode-selection-is-zero-call-and-explicit-start-is-single-shot');
  report.checks.push('only-ready-with-positive-budget-enables-live-start');

  const liveIdentity = { runId: 'fixture-run', configIdentity: 'fixture-config' };
  await page.evaluate(identity => {
    const fixture = window.__renderFixture;
    fixture.setClock(38900);
    const accepted = fixture.event('live-accepted', 39000, '[夹具]原文');
    const stale = fixture.event('live-stale', 39500, '[夹具]不应采用旧配置');
    fixture.feed([accepted, stale], [
      fixture.liveSeed(accepted, '[夹具]真实译文'),
      fixture.liveSeed(stale, '[夹具]旧配置译文', { configIdentity: 'old-config' }),
    ], true, {}, identity);
    fixture.setClock(39050);
  }, liveIdentity);
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'live-accepted' && row.state === 'committed'));
  await page.evaluate(() => window.__renderFixture.setClock(39550));
  await page.waitForFunction(() => window.__renderFixture.report().records.some(row =>
    row.id === 'live-stale' && row.state === 'committed'));
  await page.waitForFunction(() => window.__renderFixture.report().ui.domSamples.some(row =>
    row.key.includes('live-accepted') && row.origin === 'live-local'));
  const liveReceipt = await page.evaluate(() => window.__renderFixture.report());
  const adopted = liveReceipt.records.find(row => row.id === 'live-accepted');
  const original = liveReceipt.records.find(row => row.id === 'live-stale');
  assert.equal(adopted.sourceMode, 'stored-translation');
  assert.deepEqual([adopted.origin, adopted.runId, adopted.requestId, adopted.resultId,
    adopted.configIdentity], ['live-local', 'fixture-run', 'fixture-request', 'fixture-result', 'fixture-config']);
  assert.ok(adopted.previewReadyAtWallMs <= adopted.textLockedAtWallMs);
  assert.equal(adopted.renderSubmittedAtMediaMs, adopted.textLockedAtMediaMs);
  assert.equal(original.sourceMode, 'original');
  assert.equal(original.origin, null);
  assert.equal(liveReceipt.samples.some(sample => sample.key === adopted.key && sample.resultId === 'fixture-result'), true);
  assert.equal(JSON.stringify(liveReceipt).includes('真实译文'), false);
  assert.equal((await page.evaluate(() => window.__renderFixture.report(true))).records
    .find(row => row.id === 'live-accepted').chosenText, '[夹具]真实译文');
  await page.evaluate(() => window.__renderFixture.setClock(42800)); await frame();
  await screenshot('live-local-accepted-fixture');
  await page.evaluate(identity => {
    const fixture = window.__renderFixture;
    fixture.repeat([fixture.liveSeed(fixture.event('live-accepted', 39000, '[夹具]原文'),
      '[夹具]晚到译文', { resultId: 'late-result', availableAtWallMs: performance.now() })], identity);
  }, liveIdentity);
  await frame();
  const locked = await page.evaluate(() => window.__renderFixture.report().records.find(row => row.id === 'live-accepted'));
  assert.equal(locked.resultId, 'fixture-result');
  assert.ok(locked.lateResultCount >= 1);
  const liveAnalysis = analyzeBilibiliRenderPreview(await page.evaluate(() => window.__renderFixture.report()));
  assert.equal(liveAnalysis.ok, true, liveAnalysis.violations.join(', '));
  report.checks.push('live-result-identity-readiness-lock-submission-and-visible-origin');

  await liveButtons.nth(1).click();
  assert.deepEqual(await page.evaluate(() => window.__renderFixture.liveActions), ['start', 'stop']);
  assert.equal(await liveButtons.nth(1).isDisabled(), true);
  await page.evaluate(() => window.__renderFixture.setLiveState({ status: 'draining',
    modelName: '夹具本地模型', modelState: 'loaded', targetLanguage: 'zh',
    remaining: { requests: 2, items: 2, chars: 280 },
    sent: 1, ready: 1, adopted: 1, fallback: 1, reason: '范围结束' }));
  assert.equal(await liveButtons.first().isDisabled(), true);
  assert.equal(await liveButtons.nth(1).isDisabled(), true);
  report.checks.push('explicit-stop-draining-disables-repeat-actions');

  report.final = await page.evaluate(() => window.__renderFixture.report());
  const finalAnalysis = analyzeBilibiliRenderPreview(report.final);
  assert.equal(finalAnalysis.ok, true, finalAnalysis.violations.join(', '));
  await page.evaluate(() => window.__renderFixture.dispose());
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
  if (page) report.failureState = await page.evaluate(() => window.__renderFixture?.report()).catch(() => null);
} finally {
  await context?.close();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('REPORT', resolve(directory, 'report.json'));
}
