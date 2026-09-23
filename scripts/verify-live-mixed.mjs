import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Build first. Production extension, synthetic Niconico/YouTube pages and a local mock.
// node scripts/verify-live-mixed.mjs [--browser chromium|edge] [--concurrency 1|2|both] [--headed]
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureHtml, fixtureUrl, installBridgeObserver, installNativeFixture } from './vod-fixture.mjs';
import { LIVE_FIXTURE_IDS, chatAdd, installLiveFixtureRoutes, installLiveObserver } from './live-fixture.mjs';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${name} requires a value`);
  return args[index + 1];
}
if (args.includes('--help')) {
  console.log('node scripts/verify-live-mixed.mjs [--browser chromium|edge] [--concurrency 1|2|both] [--headed]');
  process.exit(0);
}
const browserName = option('--browser', 'chromium'), selection = option('--concurrency', 'both');
assert.ok(['chromium', 'edge'].includes(browserName)); assert.ok(['1', '2', 'both'].includes(selection));
const limits = selection === 'both' ? [1, 2] : [Number(selection)];
const root = resolve('.artifacts/live/mixed'); await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, browserName + '-'));
const report = { capturedAt: new Date().toISOString(), runDir, browser: browserName, status: 'RUNNING',
  scenarios: {}, requests: [], errors: [], limitations: [
    'Synthetic site/player fixtures exercise the copied production MAIN, ISOLATED and background code; this is not real-platform playback acceptance.',
    'The copied manifest pregrants loopback only. Native install and optional-host consent prompts are not verified.',
    'Only a synthetic session Key and process-owned loopback Provider are used. No real Provider, personal browser profile or external page is used.',
    'Recorded release time is actual overlay DOM insertion relative to the production source event, not physical pixel display time.',
    'CDP can keep a worker target/Playwright object across restart; stopped/running transitions and a cleared worker-global nonce establish actual restart.',
  ] };
const persist = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error('Timed out: ' + label);
}
const apiKey = 'danlingo-mixed-synthetic-' + randomUUID();
const translated = text => '【模拟译文】' + text;
let context, server, control, phase = 'setup';
const holds = new Map(), active = new Set();
function release(row) { const done = holds.get(row.id); assert.ok(done, 'Expected held Provider request'); done(); }
function releaseAll() { if (control) control.holdVod = false; for (const done of [...holds.values()]) done(); }
function rows(concurrency, kind) { return report.requests.filter(row => row.concurrency === concurrency && (!kind || row.kind === kind)); }

async function startMock() {
  server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    let row;
    try {
      assert.equal(req.headers.authorization, 'Bearer ' + apiKey, 'Mock must receive the same synthetic Key');
      let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length <= 100000, 'Request byte budget'); }
      const json = JSON.parse(body), decoded = decodeTranslationFixtureRequest(json), { items } = decoded;
      assert.ok(Array.isArray(items) && items.length === 1 && report.requests.length < 40, 'Finite single-item Provider request budget');
      const text = items[0].text, kind = text.includes('_VOD_') ? 'vod' : text.includes('_LIVE_') ? 'live' : 'unknown';
      assert.notEqual(kind, 'unknown', 'Only explicitly controlled fixture text may reach Provider');
      row = { id: report.requests.length + 1, at: Date.now(), concurrency: control.concurrency, phase, kind,
        text, model: json.model, protocol: decoded.protocol, held: kind === 'vod' && control.holdVod };
      report.requests.push(row); active.add(row.id); row.activeAtStart = active.size;
      control.maxActive = Math.max(control.maxActive, active.size);
      res.on('close', () => { if (!row.completedAt) { row.clientClosedAt = Date.now(); active.delete(row.id); } });
      if (row.held) await new Promise(done => {
        const finish = () => { clearTimeout(timer); holds.delete(row.id); row.releasedAt = Date.now(); done(); };
        const timer = setTimeout(() => { row.autoReleased = true; finish(); }, 25000);
        holds.set(row.id, finish);
      });
      row.closedBeforeResponse = res.destroyed; row.completedAt = Date.now(); active.delete(row.id);
      const reply = encodeTranslationFixtureResponse(decoded, items.map(item => ({ id: item.id, text: translated(item.text) })));
      res.setHeader('content-type', reply.contentType); res.end(reply.body);
    } catch (error) {
      if (row) active.delete(row.id);
      report.errors.push('mock: ' + String(error.message || error).slice(0, 500));
      if (!res.headersSent) res.writeHead(500); res.end('{}');
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
}

async function workerRestart(options, worker, rpc) {
  const nonce = randomUUID();
  await worker.evaluate(nonce => { globalThis.__DL_MIXED_RESTART_NONCE__ = nonce; }, nonce);
  const cdp = await context.newCDPSession(options), versions = new Map(), transitions = [];
  try {
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      for (const version of event.versions) {
        versions.set(version.versionId, version);
        if (version.scriptURL === worker.url()) transitions.push({ at: Date.now(), versionId: version.versionId,
          runningStatus: version.runningStatus, status: version.status, targetId: version.targetId });
      }
    });
    await cdp.send('ServiceWorker.enable');
    const version = await waitFor(() => [...versions.values()].find(value => value.scriptURL === worker.url()
      && value.status === 'activated' && value.runningStatus === 'running'), 'current background worker');
    const stoppedAt = Date.now();
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await waitFor(() => transitions.some(value => value.at >= stoppedAt && value.versionId === version.versionId && value.runningStatus === 'stopped'), 'CDP observed actual stopped worker');
    const overview = await rpc({ type: 'overview' }); assert.equal(overview.ok, true);
    await waitFor(() => transitions.some(value => value.at >= stoppedAt && value.versionId === version.versionId && value.runningStatus === 'running'), 'CDP observed worker running again');
    const resumed = context.serviceWorkers().find(candidate => candidate.url() === worker.url());
    assert.ok(resumed); assert.equal(await resumed.evaluate(() => globalThis.__DL_MIXED_RESTART_NONCE__ === undefined), true);
    assert.equal(overview.hasKey, true); assert.equal(overview.remembered, false);
    const exactKey = await options.evaluate(async expected => {
      const local = await chrome.storage.local.get('providerKey.v1'), session = await chrome.storage.session.get('providerKey.v1');
      return !local['providerKey.v1'] && session['providerKey.v1']?.value === expected;
    }, apiKey);
    assert.equal(exactKey, true);
    return { stoppedAt, transitions, freshWorkerMemory: true, sameBrowserContext: true, exactSessionKeyRetained: true };
  } finally { await cdp.detach().catch(() => {}); }
}

async function scenario(chromium, extension, endpoint, concurrency) {
  const base = await mkdtemp(resolve(runDir, `concurrency-${concurrency}-`));
  const evidence = report.scenarios[concurrency] = { status: 'RUNNING', directory: base, checks: {}, screenshots: [] };
  control = { concurrency, holdVod: true, maxActive: 0 }; phase = `c${concurrency}-initial-vod`;
  context = await chromium.launchPersistentContext(resolve(base, 'profile'), { ...browserLaunchOptions(browserName), headless: !args.includes('--headed'),
    viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  let vod, live, options;
  try {
    await context.route(/^https?:\/\//, route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
    await waitFor(() => options.locator('#key-state').textContent(), 'initial options overview');
    const rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
    const initial = await rpc({ type: 'settings' }); assert.equal(initial.ok, true);
    const saved = await rpc({ type: 'save', settings: { ...initial.settings, enabled: true, endpoint,
      model: 'mixed-local-mock', profile: 'chat-completions', thinkingEffort: 'default', allowLocalHttp: true,
      sourceLanguage: 'ja', liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans', translationScope: 'all',
      concurrency, batchSize: 1, requestTimeoutMs: 120000, thinkingRequestTimeoutMs: 120000,
      liveBufferMs: 2000, liveDensity: 12, liveSpeed: 180 }, apiKey, remember: false });
    assert.equal(saved.ok, true, saved.error); evidence.settings = saved.settings;
    evidence.browserVersion = await options.evaluate(() => navigator.userAgent);

    // Reuse the existing native fixture but keep only four distinct ordinary
    // messages. This mutates site fixture data, never extension bridge traffic.
    vod = await context.newPage();
    await vod.addInitScript({ content: `(${installBridgeObserver})();(${installNativeFixture})();
      document.addEventListener('DOMContentLoaded',()=>{
        const fixture=window.__DL_FIXTURE__;
        const rows=['zero','negative-render','near','mixed-last'].map((id,index)=>fixture.chat(id,index*1000,'MIX_C${concurrency}_VOD_'+index+' 元からある動画コメント'));
        fixture.rows.splice(0,fixture.rows.length,...rows);
      },{once:true});` });
    await vod.route('https://www.nicovideo.jp/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml }));
    await vod.goto(fixtureUrl); await vod.bringToFront();
    await waitFor(() => rows(concurrency, 'vod').length === concurrency, 'initial VOD saturates chosen concurrency');
    const initialVod = [...rows(concurrency, 'vod')];
    assert.ok(initialVod.every(row => holds.has(row.id)));
    await waitFor(() => vod.evaluate(() => window.__DL_VOD__.sourceComplete && window.__DL_VOD__.sources.size === 4), 'four production VOD sources');

    live = await context.newPage();
    const fixture = await installLiveFixtureRoutes(live); await live.addInitScript(installLiveObserver);
    const liveUrl = 'https://www.youtube.com/watch?v=' + LIVE_FIXTURE_IDS[0];
    await live.goto(liveUrl); await live.bringToFront();
    const observe = () => live.evaluate(() => window.__DL_LIVE_EVIDENCE__);
    const connected = () => waitFor(async () => {
      const latest = (await observe()).snapshots.at(-1);
      return latest?.connection === 'connected' && !latest.playback.paused && latest.playback.contentActive
        && fixture.requests.some(row => row.index >= 1);
    }, 'production live source connected');
    await connected(); await delay(1100);
    async function inject(suffix) {
      const id = `mixed-c${concurrency}-${suffix}`, text = `MIX_C${concurrency}_LIVE_${suffix} 今届いたライブコメント`;
      fixture.enqueue(LIVE_FIXTURE_IDS[0], chatAdd(id, text));
      const event = await waitFor(async () => (await observe()).events.flatMap(batch => batch.events || []).find(event => event.sourceId === id), 'production source event ' + id);
      assert.equal(event.translatable, true);
      return { id, text, receivedAt: event.receivedAt };
    }
    async function rendering(event, useTranslation) {
      const text = useTranslation ? translated(event.text) : event.text;
      const row = await waitFor(async () => (await observe()).renders.find(value => value.text === text), 'actual overlay ' + event.id, 6000);
      const elapsedMs = row.at - event.receivedAt;
      assert.ok(elapsedMs >= 1950 && elapsedMs <= 2450, `Fixed 2000ms display deadline: ${elapsedMs}`);
      const sourceEventId = JSON.stringify(['youtube', 'live', LIVE_FIXTURE_IDS[0], event.id]);
      const identity = await live.evaluate(sourceEventId => {
        const span = [...(document.getElementById('danlingo-live-overlay')?.shadowRoot?.querySelectorAll('span') || [])]
          .find(node => node.getAttribute('data-source-event-id') === sourceEventId);
        return span ? { sourceEventId: span.getAttribute('data-source-event-id'), status: span.getAttribute('data-translation-status'),
          displayAt: Number(span.getAttribute('data-display-at')), text: span.textContent } : null;
      }, sourceEventId);
      assert.ok(identity, 'Rendered DOM must identify the exact production source event');
      assert.equal(identity.status, useTranslation ? 'translated' : 'original'); assert.equal(identity.text, text);
      return { sourceId: event.id, text: row.text, sourceReceivedAt: event.receivedAt, renderedAt: row.at, elapsedMs, identity };
    }
    phase = `c${concurrency}-occupied-live-deadline`;
    const expired = await inject('expired');
    evidence.checks.occupiedDeadline = await rendering(expired, false);
    assert.equal(rows(concurrency, 'live').length, 0, 'Live Provider must not exceed occupied concurrency');
    assert.equal(rows(concurrency, 'vod').length, concurrency, 'No excess VOD admission');
    assert.ok(initialVod.every(row => !row.clientClosedAt && !row.completedAt && holds.has(row.id)), 'Existing VOD must remain running naturally');

    phase = `c${concurrency}-live-priority`;
    release(initialVod[0]);
    await waitFor(() => initialVod[0].completedAt, 'first existing VOD naturally finishes');
    assert.equal(initialVod[0].closedBeforeResponse, false); assert.ok(!initialVod[0].autoReleased);
    await delay(1100);
    assert.equal(rows(concurrency, 'vod').length, concurrency, 'Reserved live slot must not admit new VOD');
    const priority = await inject('priority');
    const priorityRequest = await waitFor(() => rows(concurrency, 'live').find(row => row.text === priority.text), 'live uses released slot');
    assert.ok(priorityRequest.at >= initialVod[0].completedAt);
    evidence.checks.livePriority = { ...await rendering(priority, true), providerStartedAt: priorityRequest.at,
      previousVodCompletedAt: initialVod[0].completedAt, priorVodNotAborted: true, noNewVodAdmission: true };
    if (concurrency === 2) {
      assert.ok(holds.has(initialVod[1].id) && !initialVod[1].clientClosedAt, 'Second original VOD must coexist with live');
      release(initialVod[1]); await waitFor(() => initialVod[1].completedAt, 'second existing VOD naturally finishes');
      assert.equal(initialVod[1].closedBeforeResponse, false);
      await waitFor(() => rows(concurrency, 'vod').length === 3, 'one new VOD can use its unreserved slot');
      const newVod = rows(concurrency, 'vod')[2]; assert.ok(holds.has(newVod.id));
      await delay(1100); assert.equal(rows(concurrency, 'vod').length, 3, 'Second new VOD must leave a live slot');
      phase = 'c2-reserved-live-slot';
      const reserved = await inject('reserved');
      const request = await waitFor(() => rows(concurrency, 'live').find(row => row.text === reserved.text), 'new live uses reserved slot');
      assert.ok(holds.has(newVod.id) && !newVod.completedAt && !newVod.clientClosedAt);
      evidence.checks.newVodReservation = { ...await rendering(reserved, true), liveStartedAt: request.at,
        concurrentVodRequestId: newVod.id, newVodActive: true, secondSlotReserved: true };
    }

    phase = `c${concurrency}-vod-completion`;
    if (concurrency === 1) {
      await live.locator('#home').click();
      await waitFor(() => live.locator('#danlingo-live-overlay').count().then(count => count === 0), 'live session closes before VOD resumes');
    }
    releaseAll();
    await waitFor(() => vod.evaluate(() => window.__DL_VOD__.prepared.size === 4), 'all VOD comments pretranslated', 20000);
    assert.equal(rows(concurrency, 'vod').length, 4, 'Each distinct VOD text admitted exactly once');
    const native = await vod.evaluate(() => window.__DL_FIXTURE__.rows.map(row => window.__DL_FIXTURE__.render(row.id)));
    for (const row of native) assert.equal(row.text, translated(row.original), 'Native VOD staging filter must receive prepared translation');
    evidence.checks.vodCompletion = { prepared: native.length, distinctProviderRequests: rows(concurrency, 'vod').length,
      nativeRenderedTexts: native.map(row => row.text), maxSimultaneousProviderRequests: control.maxActive };
    assert.ok(control.maxActive <= concurrency, 'Global Provider concurrency is a hard limit');
    assert.ok(rows(concurrency, 'vod').every(row => !row.autoReleased && !row.closedBeforeResponse && !row.clientClosedAt));
    assert.ok(!rows(concurrency).some(row => row.text === expired.text), 'Expired live event must never requeue into Provider');
    const observed = await observe(), originalRows = observed.renders.filter(row => row.text === expired.text);
    assert.equal(originalRows.length, 1); assert.equal(originalRows[0].changes.length, 0);
    assert.ok(!observed.renders.some(row => row.text === translated(expired.text)));
    evidence.checks.noExpiredRequeue = { providerAttempts: 0, originalRenders: 1, subsequentTextChanges: 0 };

    if (concurrency === 2) {
      phase = 'c2-worker-restart'; await live.bringToFront(); await connected();
      evidence.checks.workerRestart = await workerRestart(options, worker, rpc);
      const recovered = await inject('after-restart');
      evidence.checks.workerRestart.newMessage = await rendering(recovered, true);
      evidence.checks.workerRestart.providerRequest = rows(concurrency, 'live').find(row => row.text === recovered.text);
      assert.ok(evidence.checks.workerRestart.providerRequest, 'New message must actually call the same mock after restart');
      const shot = resolve(base, 'live-after-worker-restart.png'); await live.screenshot({ path: shot }); evidence.screenshots.push(shot);
    }
    await vod.bringToFront(); const shot = resolve(base, 'vod-pretranslated.png');
    await vod.screenshot({ path: shot }); evidence.screenshots.push(shot);
    evidence.chatRequests = fixture.requests; evidence.finalOverview = await rpc({ type: 'overview' });
    assert.equal(report.errors.length, 0); evidence.status = 'PASS';
    console.log(`PASS: concurrency ${concurrency} mixed VOD/live${concurrency === 2 ? ' and actual worker restart' : ''}`);
  } catch (error) {
    evidence.status = 'FAIL'; evidence.phase = phase; evidence.error = String(error.stack || error).slice(0, 3000);
    if (live) evidence.lastLive = await live.evaluate(() => window.__DL_LIVE_EVIDENCE__).catch(() => null);
    if (vod) evidence.lastVod = await vod.evaluate(() => ({ sources: window.__DL_VOD__?.sources.size, prepared: window.__DL_VOD__?.prepared.size, snapshot: window.__DL_VOD__?.snapshot })).catch(() => null);
    throw error;
  } finally { releaseAll(); await context.close(); context = undefined; await persist(); }
}

try {
  const endpoint = await startMock(), build = resolve('.output/chrome-mv3'), extension = resolve(runDir, 'test-extension');
  const sourceManifest = await readFile(resolve(build, 'manifest.json'), 'utf8');
  report.build = { path: build, version: JSON.parse(sourceManifest).version,
    manifestSha256: createHash('sha256').update(sourceManifest).digest('hex'),
    backgroundSha256: createHash('sha256').update(await readFile(resolve(build, 'background.js'))).digest('hex') };
  await cp(build, extension, { recursive: true });
  const manifest = JSON.parse(sourceManifest); manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const { chromium } = await loadPlaywright();
  for (const concurrency of limits) { console.log('CHECK: mixed concurrency ' + concurrency); await scenario(chromium, extension, endpoint, concurrency); }
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(String(error.stack || error).slice(0, 3000)); process.exitCode = 1; }
finally {
  releaseAll(); await context?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await persist(); console.log('Report: ' + resolve(runDir, 'report.json'));
}
