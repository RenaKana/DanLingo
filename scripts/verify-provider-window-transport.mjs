import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Offline local transport proof only: no authorized file or public Provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installProviderTransport } from './youtube-provider-transport.mjs';
const base = resolve('.artifacts/live/provider-transport'); await mkdir(base, { recursive: true });
const dir = await mkdtemp(resolve(base, 'verify-'));
const extension = resolve(dir, 'extension'); await mkdir(extension);
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'DanLingo local transport fixture', version: '1.0',
  host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }));
await writeFile(resolve(extension, 'background.js'), 'globalThis.boundBeforeObserver = fetch.bind(globalThis);');
let context, guard, actual = 0;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  for await (const chunk of req) { void chunk; }
  actual++; res.writeHead(actual === 2 ? 429 : 200, { 'content-type': 'application/json' }); res.end('{}');
});
const report = { status: 'INCOMPLETE', checks: {} };
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(dir, 'profile'), { ...browserLaunchOptions("edge"), headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking'] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  assert.equal(await worker.evaluate(() => typeof globalThis.boundBeforeObserver), 'function');
  guard = await installProviderTransport(context, { endpoint, maxPosts: 3 });
  const send = model => worker.evaluate(async ({ endpoint, model }) => {
    try { const response = await globalThis.boundBeforeObserver(endpoint, { method: 'POST', body: JSON.stringify({ model, stream: false }) });
      await response.text(); return response.status; } catch { return 'blocked'; }
  }, { endpoint, model });
  assert.equal(await send('other'), 'blocked'); assert.equal(actual, 0);
  assert.equal(await send('deepseek-flash'), 200);
  assert.equal(await send('deepseek-flash'), 429);
  assert.equal(await send('deepseek-flash'), 'blocked');
  const until = Date.now() + 2000;
  while (guard.snapshot().active && Date.now() < until) await new Promise(done => setTimeout(done, 10));
  report.stats = guard.snapshot();
  assert.equal(actual, 2); assert.equal(report.stats.posts, 2); assert.equal(report.stats.active, 0);
  assert.equal(report.stats.bodyMs.length, 2); assert.equal(report.stats.blocked, 2);
  report.checks = { cachedWorkerFetchIntercepted: true, wrongModelNotSent: true, stoppedAfter429: true, requestCompletionCounted: true };
  report.status = 'PASS_LOCAL_BROWSER_TRANSPORT';
} catch { report.error = 'local-transport-verification-failed'; process.exitCode = 1; }
finally {
  guard?.stop(); await context?.close().catch(() => {}); await guard?.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ report: resolve(dir, 'report.json'), ...report }));
