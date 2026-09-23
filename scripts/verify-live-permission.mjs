import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Current-version unpacked payload; no Key, Provider call, or automatic native consent.
import { settingsSection } from './settings-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectReleaseInfo } from './project-version.mjs';

const args = process.argv.slice(2);
const packageVersion = getProjectReleaseInfo().version;
if (args.length === 1 && args[0] === '--help') {
  console.log(`Usage: node scripts/verify-live-permission.mjs --browser chromium|edge
Loads the unchanged .output/chrome-mv3 ${packageVersion} payload in a new headed,
offline, isolated browser. No Key or Provider request is used.
Clicks options Save with enabled=false, then waits at most 120 seconds for
native host consent. The operator handles the browser's real permission UI.
Reports the browser root PID and status/report paths for that handoff.
This proves unpacked startup and optional-host consent only, NOT manual
installation through the extensions page or upgrade permission-increase UI.
Optional runtime paths: DANLINGO_PLAYWRIGHT_MODULE, DANLINGO_E2E_EXECUTABLE.
No credential or personal-profile environment variables are read.`);
  process.exit(0);
}
assert.equal(args.length, 2, 'Use --browser chromium|edge, or --help');
assert.equal(args[0], '--browser', 'Use --browser chromium|edge');
const browserName = args[1];
assert.ok(['chromium', 'edge'].includes(browserName), 'Unknown browser');

const endpoint = 'http://192.168.31.137:8080/v1/chat/completions';
const origin = new URL(endpoint).origin;
const extension = resolve('.output/chrome-mv3');
const expectedHosts = ['https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/watch/*', 'https://www.youtube.com/*', 'https://www.bilibili.com/*', 'https://live.bilibili.com/*'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function describePayload(directory, prefix = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, path = resolve(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'Payload must not contain symbolic links');
    if (entry.isDirectory()) Object.assign(result, await describePayload(path, name + '/'));
    else { assert.equal(entry.isFile(), true, 'Unexpected payload entry'); result[name] = sha256(await readFile(path)); }
  }
  return result;
}

const root = resolve('.artifacts/live/permission');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, browserName + '-'));
const reportPath = resolve(runDir, 'report.json'), statusPath = resolve(runDir, 'status.json');
const report = {
  capturedAt: new Date().toISOString(), status: 'RUNNING', browser: browserName, endpoint, origin,
  extension, profile: resolve(runDir, 'profile'), runDir, scriptPid: process.pid,
  method: 'Headed isolated browser, unchanged unpacked payload loaded with --load-extension; real options Save and native optional-host consent.',
  limitations: [
    'Not manual installation through chrome://extensions or edge://extensions; not upgrade permission-increase acceptance.',
    'Chromium is the selected testing binary, not a claim about an installed Google Chrome channel.',
    'Native UI is handled externally; pending status alone does not prove that a permission bubble is visible.',
    'Offline browser context and HTTP(S) abort routes prevent page/extension requests; request counters do not audit browser-internal network services.',
    'No Key, model discovery, Provider response, live playback, or translation is tested.',
  ],
  network: { offline: true, httpRequests: 0, providerRequests: 0, abortedRoutes: 0 },
  checks: {}, errors: [],
};
let context, options;
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2));
async function status(phase, extra = {}) {
  const state = { at: new Date().toISOString(), phase, browser: browserName, scriptPid: process.pid,
    browserPid: report.browserPid ?? null, extensionId: report.extensionId ?? null, report: reportPath, status: statusPath, ...extra };
  await writeFile(statusPath, JSON.stringify(state, null, 2));
  await persist();
  console.log(JSON.stringify(state));
}
async function snapshot(timeout = 4000) {
  return bounded(options.evaluate(async targetOrigin => {
    const configuration = await chrome.runtime.sendMessage({ type: 'settings' });
    return {
      granted: await chrome.permissions.contains({ origins: [targetOrigin + '/*'] }),
      result: document.getElementById('result')?.textContent ?? '',
      configurationOk: configuration?.ok === true, hasKey: configuration?.hasKey,
      enabled: configuration?.settings?.enabled, endpoint: configuration?.settings?.endpoint,
      allowLocalHttp: configuration?.settings?.allowLocalHttp,
      keyFieldEmpty: document.getElementById('api-key')?.value === '',
    };
  }, origin), timeout, 'Permission/configuration snapshot');
}

try {
  const rawManifest = await readFile(resolve(extension, 'manifest.json'));
  const manifest = JSON.parse(rawManifest);
  assert.equal(manifest.version, packageVersion);
  assert.deepEqual([...manifest.host_permissions].sort(), [...expectedHosts].sort());
  report.payload = { version: manifest.version, rawManifestSha256: sha256(rawManifest),
    hostPermissions: manifest.host_permissions, files: await describePayload(extension) };
  report.payload.fileCount = Object.keys(report.payload.files).length;

  const { chromium } = await loadPlaywright();
  const launchOptions = browserLaunchOptions(browserName);
  report.executablePath = launchOptions.executablePath ?? browserExecutablePath(browserName, { playwrightBrowser: chromium });
  context = await chromium.launchPersistentContext(report.profile, {
    ...launchOptions, headless: false, offline: true, viewport: { width: 1100, height: 900 }, locale: 'zh-CN', timeout: 30000,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check'],
  });
  context.setDefaultTimeout(10000);
  context.on('request', request => {
    if (!/^https?:\/\//i.test(request.url())) return;
    report.network.httpRequests++;
    if (new URL(request.url()).origin === origin) report.network.providerRequests++;
  });
  await context.route(/^https?:\/\//i, async route => { report.network.abortedRoutes++; await route.abort('internetdisconnected'); });
  const browser = context.browser();
  assert.ok(browser, 'Browser handle required for native UI ownership');
  report.browserVersion = browser.version();
  const browserCdp = await browser.newBrowserCDPSession();
  try {
    const processes = await bounded(browserCdp.send('SystemInfo.getProcessInfo'), 5000, 'Browser root PID');
    const roots = processes.processInfo.filter(item => item.type === 'browser');
    assert.equal(roots.length, 1, 'Expected one root browser process');
    assert.ok(Number.isInteger(roots[0].id) && roots[0].id > 0, 'Expected numeric root PID');
    report.browserPid = roots[0].id;
  } finally { await browserCdp.detach(); }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  report.extensionId = new URL(worker.url()).host;
  options = await context.newPage();
  await options.goto(`chrome-extension://${report.extensionId}/options.html`);
  report.windowTitle = 'DanLingo 权限验收 ' + runDir.split(/[\\/]/).at(-1);
  await options.evaluate(title => { document.title = title; }, report.windowTitle);
  await options.bringToFront();
  await options.waitForFunction(() => !!document.getElementById('key-state')?.textContent);
  report.loadedVersion = await options.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(report.loadedVersion, packageVersion);
  report.before = await snapshot();
  assert.equal(report.before.granted, false, 'Fresh isolated profile must not already grant the Provider origin');
  assert.equal(report.before.configurationOk, true);
  assert.equal(report.before.hasKey, false);
  assert.equal(report.before.enabled, false);
  assert.equal(report.before.keyFieldEmpty, true);
  await options.locator('#endpoint').fill(endpoint);
  await settingsSection(options,'advanced'); await options.locator('#local-http').evaluate(el=>el.closest('details').open=true); await options.locator('#local-http').check();
  await settingsSection(options,'watching');
  await options.locator('#enabled').uncheck();
  await settingsSection(options,'service'); await options.locator('#remember').uncheck();
  assert.equal(await options.locator('#api-key').inputValue(), '');
  // No get-models/test-model, RPC save, permission grant API, or native UI automation.
  await status('ready-to-request-native-permission');
  await options.locator('#save').click();
  const deadline = Date.now() + 120000;
  await status('permission-request-issued-awaiting-native-confirmation', { deadline: new Date(deadline).toISOString() });
  while (Date.now() < deadline) {
    report.after = await snapshot(Math.min(4000, Math.max(1, deadline - Date.now())));
    if (report.network.httpRequests || report.network.abortedRoutes) throw new Error('Unexpected HTTP(S) request during permission-only verification');
    if (report.after.granted && report.after.result === '已保存') break;
    if (report.after.result && report.after.result !== '正在保存…') break;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  assert.ok(report.after, 'No permission outcome snapshot was obtained');
  report.checks = {
    freshOriginUngranted: report.before.granted === false,
    grantedAfter: report.after.granted === true, configurationSaved: report.after.result === '已保存',
    disabled: report.after.enabled === false, hasKeyFalse: report.after.hasKey === false,
    keyFieldEmpty: report.after.keyFieldEmpty === true,
    endpointSaved: report.after.endpoint === endpoint, localHttpAllowed: report.after.allowLocalHttp === true,
    configurationOk: report.after.configurationOk,
  };
  assert.equal(report.after.hasKey, false, 'Permission-only flow must never acquire a Key');
  assert.equal(report.after.enabled, false, 'Permission-only flow must stay disabled');
  report.status = Object.values(report.checks).every(value => value === true) ? 'PASS_PERMISSION_ONLY' : 'INCOMPLETE';
  if (report.status === 'INCOMPLETE') report.reason = 'Native consent and configuration save did not both complete within the bounded observation.';
} catch (error) {
  report.status = report.network.httpRequests || report.network.abortedRoutes ? 'FAIL_UNEXPECTED_NETWORK' : 'INCOMPLETE';
  report.errors.push(String(error.message || error).slice(0, 1000));
} finally {
  if (context) {
    try { await bounded(context.close(), 10000, 'Isolated browser close'); report.browserClosed = true; }
    catch (error) { report.browserClosed = false; report.status = 'INCOMPLETE'; report.errors.push(String(error.message).slice(0, 300)); }
  }
  if (report.payload) {
    try { report.checks.payloadUnchanged = JSON.stringify(await describePayload(extension)) === JSON.stringify(report.payload.files); }
    catch { report.checks.payloadUnchanged = false; }
    if (!report.checks.payloadUnchanged) { report.status = 'INCOMPLETE'; report.errors.push('Release payload changed during the run'); }
  }
  if (report.network.httpRequests || report.network.abortedRoutes) report.status = 'FAIL_UNEXPECTED_NETWORK';
  report.finishedAt = new Date().toISOString();
  if (report.status !== 'PASS_PERMISSION_ONLY') process.exitCode = 1;
  await status(report.status.toLowerCase());
}
