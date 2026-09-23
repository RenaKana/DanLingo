import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production recent-record UI and status integration with a deterministic request stub.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const moduleUri = async file => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(await readFile(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ ...browserLaunchOptions("chromium"), headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 700 } });
const output = resolve('.artifacts/live/recent-repairs'); await mkdir(output, { recursive: true });
try {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><main style="width:640px;margin:24px"><div id="player" style="height:240px;background:#18231d;color:white;padding:12px"><video></video>合成 Niconico 原生画布区域</div></main>' }));
  await page.goto('https://fixture.invalid/');
  await page.evaluate(async ({ repairs, status }) => {
    const { createLiveRepairs } = await import(repairs), { createLiveStatus } = await import(status);
    const pending = new Map(), calls = []; let scans = 0;
    const view = createLiveRepairs({ request(value) { calls.push(value); return new Promise(resolve => pending.set(value.requestId, resolve)); }, scan(scope) {
      scans++;
      if(scope==='visible') {
        view.capture('visible-missed','画面に見える未取得コメント','unprocessed');
        const requested=Number(view.repairVisible('visible-missed'))+Number(view.repairVisible('successful'));
        view.scanStatus('supported',2,'visible',requested);
      } else { view.capture('scanned', '補掃された原生コメント', 'unprocessed'); view.scanStatus('supported', 1); }
    } });
    const statusView = createLiveStatus(); statusView.repairControl(view.host); statusView.attach(document.querySelector('#player'));
    const runtimeStatus = { scenario: 'live', state: 'ready', connection: 'connected', messages: 3, translated: 1, original: 2, cacheHits: 0, queued: 0, inflight: 0, coverage: 'all', recentEligible: 3, recentTranslated: 1 };
    statusView.update(runtimeStatus, '在线 · deepseek-v4-flash · 思考 关闭 · SC 思考 max');
    view.capture('failed', '時間切れの原文', 'queued'); view.delivered('failed', false);
    view.capture('unneeded', '你好', 'unneeded');
    view.capture('successful', '翻訳済みの原文', 'queued'); view.prepared('successful', '已经翻译');
    window.__fixture = { view, calls, setModelSummary(summary) { statusView.update(runtimeStatus, summary); }, get scans() { return scans; }, reply(id, text, state = 'translated') { const call = calls.filter(row => row.sourceId === id).at(-1); pending.get(call.requestId)({ id: call.requestId, status: state, text }); },
      staleReply(requestId, text) { pending.get(requestId)({ id: requestId, status: 'translated', text }); } };
  }, { repairs: await moduleUri('src/ui/live-repairs.ts'), status: await moduleUri('src/ui/live-status.ts') });
  const model = page.locator('#danlingo-live-status').locator('#model');
  const modelSummary = '在线 · deepseek-v4-flash · 思考 关闭 · SC 思考 max';
  await model.waitFor({ state: 'attached' });
  assert.equal(await model.isVisible(), true);
  assert.equal(await model.textContent(), modelSummary);
  await page.evaluate(() => window.__fixture.setModelSummary(''));
  assert.equal(await model.isHidden(), true);
  await page.evaluate(summary => window.__fixture.setModelSummary(summary), modelSummary);
  assert.equal(await model.isVisible(), true);
  assert.equal(await model.textContent(), modelSummary);
  await page.screenshot({ path: resolve(output, 'live-model-status.png') });
  await page.getByText('近期弹幕补翻', { exact: true }).click();
  const row = id => page.locator(`[data-source-id="${id}"]`);
  const failedRetry = row('failed').getByRole('button', { name: '强制重译', exact: true });
  await failedRetry.click();
  const failedRequest = await page.evaluate(() => window.__fixture.calls.at(-1));
  assert.equal(failedRequest.force, true);
  assert.equal(await failedRetry.textContent(), '');
  assert.equal(await row('failed').getByRole('button', { name: '显示原文', exact: true }).textContent(), '');
  await failedRetry.evaluate(button => { button.click(); button.click(); });
  assert.equal(await page.evaluate(() => window.__fixture.calls.filter(row => row.sourceId === 'failed').length), 1);
  await page.getByRole('button', { name: '补翻近期未译', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__fixture.calls.map(row => row.sourceId)), ['failed', 'unneeded']);
  await page.evaluate(() => { window.__fixture.reply('failed', '补翻有效译文'); window.__fixture.reply('unneeded', undefined, 'failed'); });
  await row('failed').getByText('补翻有效译文', { exact: true }).waitFor();
  assert.equal((await row('unneeded').textContent()).startsWith('失败'), true);
  const failedCallsBeforeOriginal = await page.evaluate(() => window.__fixture.calls.length);
  await row('failed').getByRole('button', { name: '显示原文', exact: true }).press('Enter');
  assert.equal(await page.evaluate(() => window.__fixture.calls.length), failedCallsBeforeOriginal);
  assert.equal(await row('failed').locator('.text').textContent(), '時間切れの原文');
  assert.equal((await row('failed').textContent()).includes('补翻有效译文'), false);
  await row('failed').getByRole('button', { name: '显示译文', exact: true }).press('Enter');
  await row('failed').getByText('补翻有效译文', { exact: true }).waitFor();
  await row('successful').getByRole('button', { name: '强制重译', exact: true }).click();
  const firstForce = await page.evaluate(() => window.__fixture.calls.at(-1)); assert.equal(firstForce.force, true); assert.equal(firstForce.manual, true);
  await page.evaluate(() => window.__fixture.view.invalidate());
  await row('successful').getByRole('button', { name: '强制重译', exact: true }).click();
  const callsBeforeOriginalWhilePending = await page.evaluate(() => window.__fixture.calls.length);
  await row('successful').getByRole('button', { name: '显示原文', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__fixture.calls.length), callsBeforeOriginalWhilePending);
  assert.equal(await row('successful').locator('.text').textContent(), '翻訳済みの原文');
  await page.evaluate(id => window.__fixture.staleReply(id, '不应出现的旧译文'), firstForce.requestId);
  assert.equal((await row('successful').textContent()).includes('不应出现'), false);
  assert.equal(await row('successful').getByRole('button', { name: '强制重译', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__fixture.reply('successful', '新配置译文'));
  await row('successful').getByRole('button', { name: '显示译文', exact: true }).click();
  await row('successful').getByText('新配置译文', { exact: true }).waitFor();
  await page.getByText('更多', {exact:true}).click();
  await page.getByRole('button', { name: '原生队列补扫', exact: true }).click();
  await row('scanned').waitFor(); assert.equal(await page.evaluate(() => window.__fixture.scans), 1);
  assert.equal(await page.evaluate(() => window.__fixture.calls.some(row => row.sourceId === 'scanned')), false, 'rescan itself does not create inference');
  await page.getByRole('button',{name:'补翻当前可见未译',exact:true}).click();
  await page.getByRole('button',{name:'补翻当前可见未译',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(row=>row.sourceId==='visible-missed').length),1,'visible action captures and translates missed row; repeated clicks merge');
  assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(row=>row.sourceId==='successful').length),2,'visible scan skips already translated records');
  await page.evaluate(()=>window.__fixture.reply('visible-missed','可见漏译的补翻结果'));
  await row('visible-missed').getByText('可见漏译的补翻结果',{exact:true}).waitFor();
  await page.screenshot({ path: resolve(output, 'recent-repairs.png') });
  await page.evaluate(() => { for (let i = 0; i < 350; i++) window.__fixture.view.capture('bound-' + i, 'Bounded record ' + i, 'unprocessed'); });
  // End focus/selection before checking the hard bound; active evicted rows may remain tombstoned until release.
  await page.locator('.note').first().click();
  assert.equal(await page.locator('[data-source-id]').count(), 300);
  assert.equal(await row('bound-0').count(), 0); assert.equal(await row('bound-349').count(), 1);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ status: 'PASS', evidence: 'PRODUCTION_RECENT_UI_STATUS_DETERMINISTIC_REQUEST_STUB',
    checks: ['model-summary-visible-and-hidden-without-summary', 'single-retry-merges-clicks', 'batch-excludes-success-and-inflight', 'no-need-reconsideration-failure-is-not-unneeded', 'show-original-local-and-toggle', 'original-choice-survives-inflight-result', 'explicit-force', 'stale-generation-no-overwrite', 'queue-scan-is-read-only-until-user-retry', 'visible-scan-captures-and-repairs-only-untranslated', 'bounded-300-records-all-readable'],
    limitation: 'No real Niconico page, actual native pixel visibility, or HTTP transport evidence from this UI test.' }, null, 2));
  console.log('PASS recent record repair UI and status integration');
} finally { await browser.close(); }
