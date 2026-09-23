import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Genuine native chat + authorized Provider in disposable profiles. No personal browser access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSettings } from '../src/core/config.ts';
import { readAuthorizedLiveConfig } from './authorized-live-config.mjs';
import { installNativeEvidence } from './verify-youtube-native-real.mjs';
import { installNativeWindow } from './youtube-native-window.mjs';
import { installProviderTransport } from './youtube-provider-transport.mjs';

export function parseProviderWindowArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    assert.ok(['--config-file', '--url', '--buffer', '--browser', '--check-args'].includes(name) && !values.has(name), 'invalid-argument');
    if (name === '--check-args') values.set(name, true);
    else { const value = args[++i]; assert.ok(value && !value.startsWith('--'), 'missing-value'); values.set(name, value); }
  }
  assert.ok(values.get('--config-file'), 'explicit-config-required');
  const url = new URL(values.get('--url'));
  assert.ok(url.origin === 'https://www.youtube.com' && url.pathname === '/watch'
    && /^[\w-]{11}$/.test(url.searchParams.get('v') || '') && [...url.searchParams.keys()].every(k => k === 'v'), 'watch-url-required');
  const bufferMs = Number(values.get('--buffer') || 2000), browser = values.get('--browser') || 'edge';
  assert.ok([500, 1000, 2000, 3000].includes(bufferMs) && ['edge', 'chromium'].includes(browser), 'invalid-condition');
  return { configFile: values.get('--config-file'), url: url.href, bufferMs, browser, checkArgs: values.has('--check-args') };
}

async function digestBuild(root) {
  const hash = createHash('sha256'); let files = 0;
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { hash.update(relative(root, path).replaceAll('\\', '/') + '\0'); hash.update(await readFile(path)); files++; }
    }
  }
  await visit(root); return { files, sha256: hash.digest('hex') };
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99) };
}

export async function main(args) {
  const config = parseProviderWindowArgs(args);
  if (config.checkArgs) {
    console.log(JSON.stringify({ status: 'VALID_NO_CREDENTIAL_READ_NO_REQUESTS', bufferMs: config.bufferMs, browser: config.browser,
      inputMs: 60000, maxPosts: 200, concurrency: 32, model: 'deepseek-flash', profile: 'deepseek', thinking: 'off', stream: false })); return;
  }
  const authorized = await readAuthorizedLiveConfig(config.configFile).catch(() => { throw new Error('authorized-config-invalid'); });
  const build = resolve('.output/chrome-mv3');
  await access(resolve(build, 'manifest.json'));
  const base = resolve('.artifacts/live/native-provider'); await mkdir(base, { recursive: true });
  const runDir = await mkdtemp(resolve(base, 'window-'));
  const report = { capturedAt: new Date().toISOString(), status: 'INCOMPLETE', phase: 'setup', browser: config.browser,
    condition: { inputMs: 60000, bufferMs: config.bufferMs, concurrency: 32, model: 'deepseek-flash', profile: 'deepseek', thinking: 'off', stream: false },
    checks: {}, nativeNetwork: { responses: 0, statuses: {}, pageErrors: 0 },
    limitations: ['Owned isolated browser and fresh cache, not the personal logged-in Chrome or physical media acceptance.',
      'Only the copied manifest adds the authorized Provider origin. Saved personal settings are untouched.',
      'Fixed receipt window includes every eligible intercepted source; cancellations, missing and timeouts remain in the denominator.',
      'On-time submission with DOM corroboration and actual native presentation latency are separate measures.',
      'Transport guard caps all POSTs at 200 including retries; 401/403/429 stop new requests. Durations include completion or failure observed at browser transport.',
      'No message body, author, resource/session ID, continuation, URL, credential, endpoint, screenshot, HAR or trace is exported.'] };
  let context, page, options, worker, rpc, watchdog, transport;
  const delay = ms => new Promise(done => setTimeout(done, ms));
  const save = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const waitFor = async (fn, ms, code) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await delay(100); } throw new Error(code);
  };
  const captureTransport = async () => {
    const data = transport?.snapshot();
    assert.ok(data, 'transport-observer-lost');
    const { headerMs, bodyMs, ...counters } = data;
    report.transport = { scope: 'Entire isolated enabled run including activation and final drain; not exclusively the 60-second source cohort',
      ...counters, headersMs: distribution(headerMs), completionMs: distribution(bodyMs) };
  };
  try {
    report.toolHashes = {};
    for (const name of ['scripts/verify-youtube-native-provider.mjs', 'scripts/youtube-native-window.mjs', 'scripts/youtube-provider-transport.mjs']) {
      report.toolHashes[name] = createHash('sha256').update(await readFile(name)).digest('hex');
    }
    report.build = await digestBuild(build);
    const extension = resolve(runDir, 'test-extension'); await cp(build, extension, { recursive: true });
    assert.deepEqual(await digestBuild(extension), report.build, 'build-copy-mismatch');
    report.checks.productionCopyExactBeforeTestPermission = true;
    const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), new URL(authorized.settings.endpoint).origin + '/*'])];
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const { chromium } = await loadPlaywright();
    const profile = await mkdtemp(resolve(runDir, 'profile-'));
    context = await chromium.launchPersistentContext(profile, { ...browserLaunchOptions(config.browser), headless: true, viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    watchdog = setTimeout(() => { report.watchdogExpired = true; void context.close(); }, 150000);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    report.browserVersion = await options.evaluate(() => navigator.userAgent);
    rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
    const settings = normalizeSettings({ ...authorized.settings, enabled: false, displayMode: 'translated',
      model: 'deepseek-flash', profile: 'deepseek', thinkingEffort: 'off', concurrency: 32, translationStream: false,
      liveBufferMs: config.bufferMs, liveSourceLanguage: 'auto', sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
    assert.equal(settings.endpoint, authorized.settings.endpoint, 'authorized-destination-changed');
    assert.equal((await rpc({ type: 'save', settings, apiKey: authorized.apiKey, remember: false })).ok, true, 'isolated-save-failed');
    const saved = await rpc({ type: 'settings' });
    assert.ok(saved.hasKey && saved.remembered !== true && Object.keys(settings).every(k => saved.settings?.[k] === settings[k]), 'isolated-settings-mismatch');
    report.checks.isolatedSettingsVerified = true;
    transport = await installProviderTransport(context, { endpoint: settings.endpoint });
    page = await context.newPage(); await page.addInitScript(installNativeEvidence);
    await page.addInitScript(installNativeWindow, { bufferMs: config.bufferMs });
    page.on('pageerror', () => { report.nativeNetwork.pageErrors++; });
    page.on('response', response => {
      try {
        const url = new URL(response.url());
        if (url.origin === 'https://www.youtube.com' && url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
          report.nativeNetwork.responses++; const status = response.status();
          report.nativeNetwork.statuses[status] = (report.nativeNetwork.statuses[status] || 0) + 1;
        }
      } catch { /* The report only counts the known native endpoint. */ }
    });
    report.phase = 'navigate-watch-page'; await save();
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.bringToFront();
    report.phase = 'bind-disabled-native-list';
    await waitFor(() => page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__?.bind()), 20000, 'native-list-unavailable');
    report.checks.originalMethodsCaptured = true;
    assert.equal((await rpc({ type: 'toggle', enabled: true })).ok, true, 'enable-failed'); await page.bringToFront();
    await waitFor(() => page.evaluate(() => window.__DL_NATIVE_WINDOW__?.active()), 15000, 'native-adapter-unavailable');
    report.phase = 'fixed-input-window'; await page.evaluate(() => window.__DL_NATIVE_WINDOW__.begin()); await save();
    const until = Date.now() + 60000;
    while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
    await page.evaluate(() => window.__DL_NATIVE_WINDOW__.end());
    report.phase = 'drain-valid-cohort'; await save();
    // Keep translation enabled so final arrivals receive the full selected budget.
    await delay(config.bufferMs + 1000);
    report.window = await page.evaluate(() => window.__DL_NATIVE_WINDOW__.summary());
    report.phase = 'disable-and-restore';
    transport.stop();
    assert.equal((await rpc({ type: 'toggle', enabled: false })).ok, true, 'disable-failed');
    await delay(1000); await captureTransport();
    report.restoration = await page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.restoration());
    const w = report.window;
    Object.assign(report.checks, { fixedWindow: w.windowMs >= 60000 && w.windowMs < 62000,
      realNativeTraffic: report.nativeNetwork.responses > 0 && w.received > 0,
      providerCalled: report.transport.posts > 0, postCap: report.transport.posts <= 200,
      concurrencyWithinConfiguredCap: report.transport.peak <= 32,
      realTranslationPresented: w.onTimeTranslated > 0,
      noDuplicateOrOvertake: w.duplicate === 0 && w.overtakes === 0 && w.overflow === 0,
      observerBound: w.invalidNotifications === 0 && w.unboundSourceOccurrences === 0,
      nativeMethodsRestored: Object.values(report.restoration).every(v => v === true) });
    report.performance = { target: .9, reachedInObservedCohort: w.onTimeRatio !== null && w.onTimeRatio >= .9,
      load: report.transport.peak < 32 ? 'C32_NOT_SATURATED_NO_MAXIMUM_THROUGHPUT_CLAIM' : 'OBSERVED_C32_PEAK_NOT_SUSTAINED_SATURATION_PROOF' };
    report.status = Object.values(report.checks).every(Boolean) ? 'COMPLETE_REAL_CHAT_PROVIDER_WINDOW' : 'INCOMPLETE_REAL_CHAT_PROVIDER_WINDOW';
    report.phase = 'complete';
  } catch (error) {
    const safe = ['native-list-unavailable', 'native-adapter-unavailable', 'enable-failed', 'disable-failed', 'isolated-save-failed', 'isolated-settings-mismatch', 'transport-observer-lost'];
    report.error = String(error?.message || '').match(/net::ERR_[A-Z_]+/)?.[0]
      || (safe.includes(error?.message) ? error.message : report.watchdogExpired ? 'hard-run-deadline'
        : error?.name === 'TimeoutError' ? 'bounded-browser-timeout' : 'verification-failed-at-recorded-phase');
    await captureTransport().catch(() => {});
  } finally {
    clearTimeout(watchdog); authorized.apiKey = '';
    transport?.stop();
    if (rpc) {
      await rpc({ type: 'toggle', enabled: false }).catch(() => {});
      report.testKeyDeleted = (await rpc({ type: 'delete-key' }).catch(() => null))?.ok === true;
    }
    await page?.evaluate(() => { window.__DL_NATIVE_WINDOW__?.stop(); window.__DL_NATIVE_REAL_EVIDENCE__?.stop(); }).catch(() => {});
    await context?.close().catch(() => {});
    await transport?.close();
    if (rpc && !report.testKeyDeleted) report.status = 'INCOMPLETE_TEST_CLEANUP';
    await save();
  }
  console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), status: report.status, phase: report.phase,
    error: report.error, checks: report.checks, window: report.window, transport: report.transport, performance: report.performance }));
  if (report.status !== 'COMPLETE_REAL_CHAT_PROVIDER_WINDOW') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('Invalid arguments or unavailable prerequisites; no result established.'); process.exitCode = 1; });
}
