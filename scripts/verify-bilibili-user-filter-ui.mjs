// Built-extension settings check in an isolated Edge profile. No platform or provider traffic.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';

const source = process.argv[2];
if (!source) throw Error('Usage: node scripts/verify-bilibili-user-filter-ui.mjs <built-extension-directory>');
const root = resolve('.artifacts/bilibili-user-filter-ui');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(directory, 'extension');
const report = {
  status: 'RUNNING', evidence: 'ISOLATED_EDGE_BUILT_EXTENSION_SETTINGS_STORAGE_AND_STATUS_RPC_FIXTURE',
  runDirectory: directory, checks: [], screenshots: [], blockedHttpRequests: 0, errors: [],
  limitations: [
    'An isolated storage-only local model selection satisfies the settings form; no model is imported or loaded.',
    'Rule-status states are a single-RPC fixture, not a real Bilibili page or native rule read.',
    'No provider, model inference, or personal Chrome/Edge profile is exercised.',
  ],
};
const ruleBody = 'PRIVATE_FIXTURE_RULE_BODY_DO_NOT_RENDER';
const firstSource = { tabId: 71, resourceId: 'av123:cid456' };
const secondSource = { tabId: 72, resourceId: 'av789:cid987' };
const partialSummary = {
  featureEnabled: true, nativeEnabled: true, readEvidence: { listComplete: true },
  categories: {
    keyword: { status: 'ready', total: 2, enabled: 2, supported: 2 },
    regexp: { status: 'partial', total: 3, enabled: 3, supported: 1, degraded: 0,
      details: [
        { id: 'R1', supported: true, reason: 'supported', oldReason: '', flags: 'i', nativeValid: true,
          features: [], pattern: ruleBody },
        { id: 'R2', supported: false, reason: 'lookaround', oldReason: '', flags: '', nativeValid: true,
          features: ['lookaround'], originalText: ruleBody },
      ], detailsTruncated: 1 },
    sender: { status: 'ready', total: 1, enabled: 1, supported: 1 },
    account: { status: 'unknown', total: 1, enabled: 1, supported: 0,
      reason: 'account-blacklist-is-not-danmaku-sender-list' },
  },
  sampledHits: { keyword: 3, regexp: 1, sender: 0 },
  natural: { matchedUserBranch: 2 }, suppressedCategories: [],
  filter: ruleBody,
};
const partialView = { connected: true, stale: false, featureEnabled: true,
  tabId: firstSource.tabId, resourceId: firstSource.resourceId, summary: partialSummary };
const secondView = { connected: true, stale: false, featureEnabled: true,
  tabId: secondSource.tabId, resourceId: secondSource.resourceId,
  summary: { ...partialSummary, nativeEnabled: false } };

function installUserFilterStatusFixture() {
  if (!globalThis.chrome?.runtime?.id || !location.pathname.endsWith('/options.html')) return;
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  const fixture = window.__userFilterStatusFixture = { sources: [], views: {}, fail: false, calls: [] };
  chrome.runtime.sendMessage = (message, ...rest) => {
    if (message?.type !== 'bilibili-user-filter-status') return send(message, ...rest);
    fixture.calls.push({ type: message.type, tabId: message.tabId ?? null });
    if (fixture.fail) return Promise.reject(new Error('fixture-status-read-failed'));
    const chosen = Number.isSafeInteger(message.tabId)
      ? fixture.sources.find(source => source.tabId === message.tabId)
      : fixture.sources.length === 1 ? fixture.sources[0] : null;
    return Promise.resolve(structuredClone({ ok: true, sources: fixture.sources,
      selectedTabId: chosen?.tabId ?? null,
      view: chosen ? fixture.views[chosen.tabId] ?? null
        : { connected: false, stale: false, featureEnabled: true, summary: null } }));
  };
}
let context;
try {
  await cp(resolve(source), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  report.extensionVersion = manifest.version;
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  context.setDefaultTimeout(12000);
  await context.route(/^https?:/i, route => {
    report.blockedHttpRequests++;
    return route.abort('internetdisconnected');
  });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
  let page;
  const open = async () => {
    const next = await context.newPage();
    next.on('pageerror', error => report.errors.push(error.message));
    await next.addInitScript(installUserFilterStatusFixture);
    await next.goto(origin + '/options.html');
    await next.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
    await settingsSection(next, 'watching');
    return next;
  };
  const screenshot = async name => {
    const path = resolve(directory, name + '.png');
    await page.locator('[data-section="watching"]').screenshot({ path });
    report.screenshots.push(path);
  };
  const status = () => page.locator('#bilibili-user-filter-status');
  const state = () => status().locator('.user-filter-status__state');
  const expectState = async text => {
    await state().getByText(text, { exact: true }).waitFor();
    assert.equal(await state().innerText(), text);
  };
  const setFixture = async next => {
    await page.evaluate(value => {
      Object.assign(window.__userFilterStatusFixture, value);
      document.dispatchEvent(new Event('visibilitychange'));
    }, next);
  };
  const settings = async () => {
    const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
    assert.equal(response?.ok, true, 'Settings read failed');
    return response.settings;
  };
  const save = async () => {
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.querySelector('#save').disabled &&
      document.querySelector('#result')?.textContent === '已保存');
  };
  page = await open();
  const checkbox = () => page.locator('#bilibili-user-filters');
  assert.equal(await checkbox().isChecked(), false);
  assert.equal((await settings()).bilibiliUserFilters, false);
  report.checks.push('fresh-install-default-disabled');

  // The UI requires a selected local model ID for any form save. The isolated
  // storage placeholder only passes that form check; translation stays disabled.
  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings.v1'))['settings.v1'];
    await chrome.storage.local.set({ 'settings.v1': {
      ...stored, backend: 'local', enabled: false, localPreloadOnEntry: false,
      localModelId: 'isolated-ui-placeholder', bilibiliUserFilters: false,
    } });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  await settingsSection(page, 'watching');
  assert.equal((await settings()).backend, 'local');
  assert.equal((await settings()).enabled, false);
  assert.equal(await checkbox().isChecked(), false);
  await checkbox().check();
  await save();
  assert.equal((await settings()).bilibiliUserFilters, true);
  assert.equal((await settings()).enabled, false);
  report.checks.push('checked-and-saved-with-translation-disabled');

  await page.close();
  page = await open();
  assert.equal(await checkbox().isChecked(), true);
  assert.equal((await settings()).bilibiliUserFilters, true);
  await screenshot('watching-user-filters-on');
  report.checks.push('reopened-setting-persists-enabled');

  await expectState('未连接视频标签页');
  await screenshot('watching-user-filter-disconnected');
  report.checks.push('status-disconnected-without-video-tab');

  await setFixture({ sources: [firstSource, secondSource],
    views: { [firstSource.tabId]: partialView, [secondSource.tabId]: secondView } });
  const sourceSelect = page.locator('#bilibili-user-filter-source');
  await page.locator('#bilibili-user-filter-source-row').waitFor({ state: 'visible' });
  assert.equal(await sourceSelect.inputValue(), '', 'Multiple tabs must require explicit selection');
  await sourceSelect.selectOption(String(firstSource.tabId));
  await expectState('已声明类别部分覆盖');
  assert.match(await status().innerText(), /av123 · cid456 · 标签页 71/);
  assert.match(await status().innerText(), /关键词.*已启用 2.*可支持 2/s);
  assert.match(await status().innerText(), /正则.*已启用 3.*可支持 1.*不支持 2/s);
  assert.match(await status().innerText(), /发送者.*可支持 1/s);
  assert.match(await status().innerText(), /当前候选采样命中.*关键词 3.*正则 1.*发送者 0/s);
  assert.match(await status().innerText(), /账号.*未知/s);
  await status().locator('details > summary').click();
  assert.match(await status().innerText(), /R2.*不支持.*环视/s);
  assert.doesNotMatch(await status().evaluate(el => el.textContent), new RegExp(ruleBody));
  await screenshot('watching-user-filter-partial-expanded');
  await page.setViewportSize({ width: 420, height: 800 });
  assert.equal(await status().evaluate(el => el.scrollWidth > el.clientWidth + 1), false,
    'Rule status must fit the narrow settings column');
  await screenshot('watching-user-filter-partial-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  report.checks.push('multitab-explicit-selection-partial-coverage-redacted-details-and-samples');

  const changedSource = { ...firstSource, resourceId: 'av123:cid777' };
  await setFixture({ sources: [changedSource, secondSource] });
  await expectState('正在读取规则');
  assert.match(await status().innerText(), /av123 · cid777 · 标签页 71/);
  assert.doesNotMatch(await status().innerText(), /R2|av123 · cid456|当前候选采样命中 · 关键词 3/);
  await setFixture({ views: { [firstSource.tabId]: { ...partialView, resourceId: changedSource.resourceId },
    [secondSource.tabId]: secondView } });
  await expectState('已声明类别部分覆盖');
  report.checks.push('resource-change-clears-previous-rule-status-before-current-reply');

  await sourceSelect.selectOption(String(secondSource.tabId));
  await expectState('Bilibili 原生屏蔽已关闭');
  assert.match(await status().innerText(), /av789 · cid987 · 标签页 72/);
  report.checks.push('multitab-switch-native-disabled');

  await setFixture({ views: { [firstSource.tabId]: { ...partialView, resourceId: changedSource.resourceId },
    [secondSource.tabId]: { ...secondView, featureEnabled: false } } });
  await expectState('功能已关闭');
  report.checks.push('feature-disabled-distinct-from-native-disabled');

  await setFixture({ views: { [firstSource.tabId]: { ...partialView, resourceId: changedSource.resourceId },
    [secondSource.tabId]: { ...secondView, stale: true } } });
  await expectState('规则状态已过期');
  await screenshot('watching-user-filter-expired');
  report.checks.push('expired-status-distinct-from-disabled');

  await setFixture({ fail: true });
  await expectState('规则状态读取失败');
  assert.doesNotMatch(await state().innerText(), /过期/);
  await screenshot('watching-user-filter-read-failed');
  report.checks.push('read-failure-clears-previous-state');

  const blockedBefore = report.blockedHttpRequests;
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://www.bilibili.com/__danlingo_fixture_block__'); return false; }
    catch { return true; }
  });
  assert.equal(blocked, true);
  assert.ok(report.blockedHttpRequests > blockedBefore, 'External HTTP must be blocked by the browser route');
  report.checks.push('external-http-interception-confirmed');

  await checkbox().uncheck();
  await save();
  await page.close();
  page = await open();
  const final = await settings();
  assert.equal(await checkbox().isChecked(), false);
  assert.equal(final.bilibiliUserFilters, false);
  assert.equal(final.backend, 'local');
  assert.equal(final.enabled, false);
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('settings.v1'))['settings.v1']);
  assert.equal(stored.bilibiliUserFilters, false);
  report.checks.push('unchecked-saved-and-reopened-disabled');
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('REPORT', resolve(directory, 'report.json'));
}
