import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { auditUrl } from '../src/diagnostics/bilibili-audit-cache';
import { BUILD_ID } from '../src/core/build-identity';
import { DISPATCH_AUDIT_ACTIONS, parseDispatchHash, type DispatchAuditAction } from '../src/diagnostics/dispatch-runner-protocol';

const CHANNEL = 'danlingo.bilibili.audit.v1';
export default defineContentScript({
  matches: ['https://www.bilibili.com/video/BV1yvhW6sEzi*', 'https://www.bilibili.com/video/BV1RHaw6mEDR*'], runAt: 'document_idle',
  main(ctx) {
    if (!auditUrl(location.href)) return;
    const token = crypto.randomUUID();
    const panel = document.createElement('aside'); panel.id = 'danlingo-audit';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#17202c;color:white;border:1px solid #8295af;padding:10px;font:12px/1.5 sans-serif;max-width:350px;border-radius:8px';
    const manifestVersion = browser.runtime.getManifest().version;
    const buildLabel = BUILD_ID.split('-').slice(-2).join('-').slice(0, 28);
    const titleLabel = `DanLingo ${manifestVersion} · ${buildLabel}`;
    const title = document.createElement('strong'); title.dataset.component = 'diagnostic-content';
    title.dataset.buildId = BUILD_ID; title.textContent = `${titleLabel} · 单片段诊断（不调用模型）`;
    const status = document.createElement('p'); status.id = 'danlingo-audit-status'; status.textContent = '点击检查以连接真实播放器';
    const detail = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '观测详情';
    const output = document.createElement('pre'); output.id = 'danlingo-audit-detail'; output.style.cssText = 'max-height:160px;overflow:auto;white-space:pre-wrap';
    detail.append(summary, output); panel.append(title, status);
    const send = (type: string, extra = {}) => window.postMessage({ channel: CHANNEL, from: 'content', token, type, ...extra }, location.origin);
    let runnerEvidence: any = { environment: { status: 'unknown', signature: null, comparable: null, changes: [] },
      buildId: null, modelFingerprint: null, startedAt: null, prepareEnvironment: null };
    let taskBaseline: any = null, rangeBaseline: any = null, mainEstimate: any = null, mainRestoration: any = null;
    let hasCapture = false;
    const mainRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const runnerExportRequests = new Set<string>();
    function requestMain(type: string, extra: Record<string, unknown> = {}, options: { timeoutMs?: number; suppressDownload?: boolean } = {}) {
      const requestId = crypto.randomUUID(), timeoutMs = options.timeoutMs ?? 12000;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          mainRequests.delete(requestId); runnerExportRequests.delete(requestId);
          reject(new Error(`等待播放器回执超时：${type}`));
        }, timeoutMs);
        mainRequests.set(requestId, { resolve, reject, timer });
        if (options.suppressDownload) runnerExportRequests.add(requestId);
        send(type, { ...extra, requestId });
      });
    }
    function resolveMainRequest(message: any) {
      if (typeof message?.requestId !== 'string') return;
      const request = mainRequests.get(message.requestId);
      if (!request) return;
      mainRequests.delete(message.requestId); clearTimeout(request.timer);
      runnerExportRequests.delete(message.requestId);
      if (message.type === 'error') request.reject(new Error(typeof message.error === 'string' ? message.error : '播放器诊断失败'));
      else request.resolve(message);
    }
    let inspection: any = null, active = false, stopped = false, busy = false, pending = 0, error = '', baseline: any = null;
    let version = -1, cacheRows: any[] = [], safety: any[] = [], exported: any = null;
    let diagnosticMainBuildId: string | null = null;
    let localRun: any = null, localPreview: any = null, localReport: any = null, localPolling = false, localReady = false;
    let localStopRequested = false;
    let pendingLocalStart: (() => Promise<void>) | null = null;
    const button = (label: string, click: () => void) => { const b = document.createElement('button'); b.textContent = label;
      b.style.cssText = 'margin:3px;padding:4px 8px;color:#17202c;background:#eef4ff;border-radius:4px'; b.onclick = click; panel.append(b); return b; };
    button('检查连接', () => send('inspect'));
    const start = button('开始观测', () => { void begin(false); }); start.disabled = true;
    const shadowStart = button('开始影子验证', () => { void begin(true); }); shadowStart.disabled = true;
    button('停止', () => { send('stop'); if (localRun) void stopLocal('manual'); });
    const exportButton = button('导出 JSON', () => { void exportData(); }); exportButton.disabled = true;
    let branchBaseline: any = null;
    const branchButton = button('导出分支信息', () => { void exportBranches(); }); branchButton.disabled = true;
    panel.append(detail); document.body.append(panel);
    const localDetail = document.createElement('details');
    const localSummary = document.createElement('summary'); localSummary.textContent = '本地对照实验（默认关闭）';
    const localStatus = document.createElement('p'); localStatus.textContent = '仅当前已加载本地模型；独立空缓存；不保存设置。';
    localDetail.append(localSummary, localStatus);
    const field = (label: string, value: string, min: string, max: string) => {
      const line = document.createElement('label'); line.textContent = label;
      const input = document.createElement('input'); input.type = 'number'; input.value = value;
      input.min = min; input.max = max; input.step = '1'; input.style.cssText = 'width:56px;margin:3px';
      line.append(input); localDetail.append(line); return input;
    };
    const localFrom = field('起点秒', '52', '0', '86400');
    const localDuration = field('时长秒', '5', '1', '35');
    const localWindow = field('预取秒', '5', '5', '60');
    const localButton = (label: string, action: () => void) => {
      const b = document.createElement('button'); b.textContent = label;
      b.style.cssText = 'margin:3px;padding:4px;color:#17202c;background:#eef4ff;border-radius:4px';
      b.onclick = action; localDetail.append(b); return b;
    };
    localButton('定位并暂停', () => { localPreview = null; send('experiment-position', { seconds: Number(localFrom.value) }); });
    localButton('估算输入', () => { void previewLocal(); });
    const baselineButton = localButton('运行 A · 不筛选', () => { void beginLocal(false); });
    const filteredButton = localButton('运行 B · 筛选', () => { void beginLocal(true); });
    baselineButton.disabled = filteredButton.disabled = true;
    const dispatchBaselineButton = localButton('派发对照 · 现有', () => { void beginLocal(true, false, false); });
    const dispatchSingleButton = localButton('派发对照 · 单条', () => { void beginLocal(true, false, true); });
    dispatchBaselineButton.disabled = dispatchSingleButton.disabled = true;
    const replayLabel = document.createElement('label'); replayLabel.textContent = '已有真实译文（JSON，仅本次隔离缓存）';
    replayLabel.style.display = 'block';
    const replayInput = document.createElement('textarea'); replayInput.setAttribute('aria-label', '已有真实译文 JSON');
    replayInput.rows = 2; replayInput.style.cssText = 'display:block;width:100%;box-sizing:border-box';
    replayLabel.append(replayInput); localDetail.append(replayLabel);
    const replayButton = localButton('运行仅缓存对照 · 零调用', () => { void beginLocal(false, true); });
    replayButton.disabled = true;
    replayInput.oninput = () => { replayButton.disabled = !localPreview || !replayInput.value.trim() || !!localRun || active; };
    panel.append(localDetail);
    for (const input of [localFrom, localDuration, localWindow]) input.oninput = () => {
      localPreview = null; baselineButton.disabled = filteredButton.disabled = replayButton.disabled = true;
      dispatchBaselineButton.disabled = dispatchSingleButton.disabled = true;
    };
    function localRange() {
      const fromMs = Number(localFrom.value) * 1000, duration = Number(localDuration.value), prefetchSeconds = Number(localWindow.value);
      if (!Number.isSafeInteger(fromMs) || fromMs < 0 || !Number.isSafeInteger(duration) || duration < 1 || duration > 35 ||
          !Number.isSafeInteger(prefetchSeconds) || prefetchSeconds < 5 || prefetchSeconds > 60) throw new Error('请填写有效的片段与窗口');
      return { fromMs, toMs: fromMs + duration * 1000, prefetchSeconds };
    }
    function previewReceipt() {
      if (!localPreview) return null;
      const { items: _items, allowTexts: _allowTexts, ...preview } = localPreview;
      return preview;
    }
    function localRunReceipt() {
      if (!localRun) return null;
      const { allowTexts: _allowTexts, cacheReplay: _cacheReplay, ...run } = localRun;
      return run;
    }
    function localReportReceipt() {
      if (!localReport) return null;
      const report = localReport.report;
      return { ok: localReport.ok === true,
        report: report ? { state: report.state, stopReason: report.stopReason, incomplete: report.incomplete,
          providerCalls: report.providerCalls, safety: report.safety } : null,
        dispatch: localReport.dispatch ? { ...localReport.dispatch } : null };
    }
    function runnerStatusFields(snapshot = inspection) {
      const timeSeconds = Number(snapshot?.time);
      const idle = !active && !busy && pending === 0 && (!localRun || localReport?.report?.state === 'stopped');
      return { idle, active, stopped, busy, pending, localReady, localRun: localRunReceipt(),
        exported: exported ? { ready: true, schema: exported.schema, cid: exported.identity?.cid ?? null } : null,
        buildId: BUILD_ID, inspection: snapshot ?? null, preview: previewReceipt(), localPreview: previewReceipt(),
        localReport: localReportReceipt(), runnerEvidence: structuredClone(runnerEvidence), hasCapture,
        exportAvailable: stopped && hasCapture && !exported,
        ...(Number.isFinite(timeSeconds) ? { videoTimeMs: timeSeconds * 1000, paused: snapshot.paused === true,
          seeking: snapshot.seeking === true, playbackRate: snapshot.rate } : { videoTimeMs: null, paused: null,
          seeking: null, playbackRate: null }) };
    }
    async function inspectRunner() {
      const reply = await requestMain('inspect');
      if (reply.type !== 'inspection' || !reply.value) throw new Error('播放器尚未适配');
      inspection = reply.value;
      return inspection;
    }
    function readModelFingerprint(preview = localPreview) {
      const state = preview?.local;
      if (!state || state.phase !== 'ready' || state.modelMatched !== true ||
          typeof state.modelFingerprint !== 'string' || !state.modelFingerprint || !Number.isSafeInteger(state.generation)) return null;
      return { fingerprint: state.modelFingerprint, generation: state.generation };
    }
    function verifyBuildIdentity(preview = localPreview) {
      const ids = [BUILD_ID, diagnosticMainBuildId, preview?.dispatch?.backgroundBuildId, preview?.dispatch?.watchBuildId];
      if (ids.some(value => typeof value !== 'string' || !value) || ids.some(value => value !== ids[0]))
        throw new Error('content、MAIN、background和watch构建标识不一致');
      return ids[0];
    }
    async function previewLocal(rangeOverride?: { fromMs: number; toMs: number; prefetchSeconds: number }, allowEmpty = false, propagate = false) {
      try {
        if (active || localRun) throw new Error('请先停止并导出当前实验');
        const range = rangeOverride ?? localRange();
        const result = await browser.runtime.sendMessage({ type: 'bilibili-experiment-preview', resourceId: inspection?.identity.resourceId, ...range });
        if (!result?.ok) throw new Error(result?.error || '无法估算');
        const texts = [...new Set<string>(result.items.filter((row: any) => row.translationEligible).map((row: any) => row.text))];
        if (!texts.length && !allowEmpty) throw new Error('片段内没有可翻译输入');
        localPreview = { ...result, ...range, allowTexts: texts,
          budget: { maxInputItems: texts.length, maxInputChars: texts.reduce((sum, text) => sum + text.length, 0), maxAttempts: texts.length } };
        localStatus.textContent = `local · window ${range.prefetchSeconds}秒 · 输入上限 ${texts.length}条 / ${localPreview.budget.maxInputChars}字 · 尝试最多${texts.length}次；每组独立空缓存。`;
        output.textContent = JSON.stringify({ range, budget: localPreview.budget,
          buildIdentity: { diagnosticContent: { version: manifestVersion, buildId: BUILD_ID },
            diagnosticMain: { buildId: diagnosticMainBuildId },
            background: { buildId: result.dispatch.backgroundBuildId },
            watch: { buildId: result.dispatch.watchBuildId } }, settings: result.settings, local: result.local,
          dispatch: result.dispatch }, null, 2);
        baselineButton.disabled = false; filteredButton.disabled = true;
        dispatchBaselineButton.disabled = dispatchSingleButton.disabled = true;
        replayButton.disabled = !replayInput.value.trim();
        const estimate = await requestMain('experiment-estimate');
        if (estimate.type !== 'experiment-estimate') throw new Error('原生实验估算回执无效');
        mainEstimate = estimate;
        return localPreview;
      } catch (e) { localStatus.textContent = String(e); if (propagate) throw e; return null; }
    }
    async function beginLocal(filterEnabled: boolean, cacheOnly = false, singleDispatch?: boolean, runnerAction = false) {
      try {
        if (!localPreview || localRun || active) throw new Error('请先定位、估算输入并停止旧观测');
        const p = localPreview, range = localRange();
        if (range.fromMs !== p.fromMs || range.toMs !== p.toMs || range.prefetchSeconds !== p.prefetchSeconds)
          throw new Error('参数已变化，请重新估算');
        const dispatchComparison = singleDispatch !== undefined;
        if (dispatchComparison && (!p.dispatchComparisonReady || !filterEnabled || cacheOnly ||
            range.fromMs !== 52000 || range.toMs !== 67000 || range.prefetchSeconds !== 5))
          throw new Error('派发对照仅用于当前已加载单条模型、并发2、52–67秒和5秒预取');
        if (dispatchComparison && (p.budget.maxInputItems < 55 || p.budget.maxInputChars < 600))
          throw new Error('当前候选不足以使用已声明的对照预算');
        const cacheReplay = cacheOnly ? JSON.parse(replayInput.value) : undefined;
        if (cacheOnly && (!cacheReplay || !Array.isArray(cacheReplay.entries) || !cacheReplay.entries.length ||
            cacheReplay.entries.length > 100)) throw new Error('请提供1–100条已有译文及来源');
        baseline = null; version = -1;
        baseline = await read([]); version = baseline.configVersion;
        cacheRows = []; safety = [{ at: performance.now(), engine: baseline.engine }]; error = ''; exported = null; localReport = null;
        if (filterEnabled && !p.filteredBudget) throw new Error('筛选预算尚未完成');
        localReady = false; localStopRequested = false;
        localRun = { runId: crypto.randomUUID(), ...range, filterEnabled,
          budget: cacheOnly ? { maxInputItems: 0, maxInputChars: 0, maxAttempts: 0 } : dispatchComparison
            ? { maxInputItems: 55, maxInputChars: 600, maxAttempts: 55 } : filterEnabled ? p.filteredBudget : p.budget,
          ...(dispatchComparison ? { dispatchComparison: true, singleDispatch } : {}),
          allowTexts: p.allowTexts, ...(cacheOnly ? { cacheReplay } : {}) };
        pendingLocalStart = async () => {
          const result = await browser.runtime.sendMessage({ type: 'bilibili-experiment-start', resourceId: inspection.identity.resourceId, ...localRun });
          if (!result?.ok) throw new Error(result?.error || '本地实验未就绪');
          if (dispatchComparison) {
            const safety = result.report?.safety;
            const actualFingerprint = readModelFingerprint(p);
            if (result.report?.state !== 'running' || safety?.modelMatched !== true || safety?.modelLoads !== 0 ||
                !actualFingerprint || actualFingerprint.generation !== safety.modelGeneration ||
                actualFingerprint.fingerprint !== runnerEvidence.modelFingerprint ||
                actualFingerprint.generation !== runnerEvidence.modelGeneration)
              throw new Error('后台未确认原模型身份、运行代数和零加载条件');
            runnerEvidence.modelGeneration = actualFingerprint.generation;
          }
          localReport = result;
          localReady = true;
          localStatus.textContent = cacheOnly ? '仅缓存对照已就绪。请直接播放；未命中保留原文，模型调用为零。'
            : dispatchComparison ? `派发对照 · ${singleDispatch ? '单条' : '现有'}已就绪；筛选开启，最多${localRun.budget.maxAttempts}次 / ${localRun.budget.maxInputChars}字。请播放。`
            : `本地实验 ${filterEnabled ? 'B' : 'A'} 已就绪。请直接播放；播放前不发送翻译。`;
          title.textContent = `${titleLabel} · ${cacheOnly ? '仅缓存对照' : dispatchComparison ? `派发对照 · ${singleDispatch ? '单条' : '现有'}` : `显式本地实验 ${filterEnabled ? 'B' : 'A'}`}`;
        };
        start.disabled = shadowStart.disabled = baselineButton.disabled = filteredButton.disabled = replayButton.disabled = true;
        dispatchBaselineButton.disabled = dispatchSingleButton.disabled = true;
        exportButton.disabled = true;
        if (runnerAction) {
          const started = await requestMain('start', { shadow: true, experiment: { fromMs: range.fromMs, toMs: range.toMs } });
          if (started.type !== 'started' || !localReady) throw new Error('本地实验未得到运行确认');
        } else send('start', { shadow: true, experiment: { fromMs: range.fromMs, toMs: range.toMs } });
        return localRun;
      } catch (e) { localStatus.textContent = String(e); await stopLocal('start-failed', runnerAction); if (runnerAction) throw e; return null; }
    }
    async function stopLocal(reason: string, propagate = false) {
      if (!localRun) return;
      try {
        const result = await browser.runtime.sendMessage({ type: 'bilibili-experiment-stop', runId: localRun.runId, reason });
        if (!result?.ok) throw new Error(result?.error || '本地实验停止失败');
        localReport = result; return result;
      } catch (e) { localStatus.textContent = String(e); if (propagate) throw e; return null; }
    }
    async function localSnapshot() {
      const run = localRun;
      if (!run) return;
      const result = await browser.runtime.sendMessage({ type: 'bilibili-experiment-status', runId: run.runId });
      if (localRun !== run) return; // Export or a later run may finish while this poll is in flight.
      if (!result?.ok) throw new Error(result?.error || '实验状态不可用');
      localReport = result;
      const report = result.report;
      localStatus.textContent = `${run.cacheReplay ? '仅缓存对照' : run.dispatchComparison ? `派发对照 · ${run.singleDispatch ? '单条' : '现有'}` : `local ${run.filterEnabled ? 'B' : 'A'}`} · 已发送 ${report.sentInputItems}条 / ${report.sentInputChars}字 · ${report.providerCalls}次 · ${report.state}${report.incomplete ? '（不完整）' : ''}`;
      if (run.dispatchComparison && result.dispatch) output.textContent = JSON.stringify({ dispatch: result.dispatch }, null, 2);
      if (run.dispatchComparison && active && report.state === 'stopped' && !localStopRequested) {
        localStopRequested = true;
        send('stop', { reason: result.dispatch?.violationReason ? 'dispatch-assertion-failed' : 'background-stopped' });
      }
    }

    async function read(texts: string[]) {
      const response = await browser.runtime.sendMessage({ type: 'bilibili-audit-read', resourceId: inspection?.identity.resourceId, texts });
      if (!response?.ok) throw new Error(response?.error || 'audit-background-unavailable');
      if (version >= 0 && response.configVersion !== version) throw new Error('配置已改变，观测已停止');
      if (baseline && response.workerSession !== baseline.workerSession) throw new Error('后台已重启，计数证据不连续');
      if (baseline && response.engine.providerCalls !== baseline.engine.providerCalls) throw new Error('后台模型调用计数改变，样本作废');
      return response;
    }
    async function begin(shadow: boolean, experiment?: { fromMs: number; toMs: number }, runnerAction = false) {
      try {
        if (localRun) throw new Error('请先导出当前本地实验');
        baseline = null; version = -1;
        baseline = await read([]); version = baseline.configVersion;
        cacheRows = []; safety = [{ at: performance.now(), engine: baseline.engine }]; error = ''; exported = null;
        start.disabled = true; shadowStart.disabled = true; exportButton.disabled = true;
        if (runnerAction) {
          const started = await requestMain('start', { shadow, ...(experiment ? { experiment } : {}) });
          if (started.type !== 'started') throw new Error('播放器观测未启动');
        } else send('start', { shadow, ...(experiment ? { experiment } : {}) });
        return true;
      } catch (e) { status.textContent = String(e); if (runnerAction) throw e; return false; }
    }
    async function exportData(runnerAction = false) {
      if (!stopped || busy || (pending && !error)) { status.textContent = '正在完成缓存只读检查，请稍后导出'; return; }
      try {
        if (localRun) await localSnapshot();
        const final = await read([]); safety.push({ at: performance.now(), engine: final.engine });
        if (runnerAction) await requestMain('export', {}, { suppressDownload: true }); else send('export');
        return exported;
      } catch (e) { error = String(e); if (runnerAction) throw e; send('export'); return null; }
    }
    async function exportBranches() {
      if (active) { status.textContent = '请先停止观测，再导出分支信息'; return; }
      try { branchBaseline = await read([]); send('inspect-branches'); }
      catch (e) { status.textContent = String(e); }
    }
    async function waitForState(predicate: () => boolean, message: string, timeoutMs = 12000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(message);
    }
    async function prepareRunner() {
      if (active || busy || pending || localRun) throw new Error('请先停止并导出当前观测');
      const initial = await inspectRunner();
      if (!initial.identity?.resourceId || !Number.isFinite(initial.time) || typeof initial.paused !== 'boolean' ||
          !Number.isFinite(initial.rate) || !initial.scroll || !Number.isFinite(initial.scroll.x) || !Number.isFinite(initial.scroll.y))
        throw new Error('无法捕获可恢复的播放器状态');
      if (!taskBaseline) {
        taskBaseline = { resourceId: initial.identity.resourceId, timeSeconds: initial.time, paused: initial.paused,
          playbackRate: initial.rate, scrollX: initial.scroll.x, scrollY: initial.scroll.y };
        rangeBaseline = { from: localFrom.value, duration: localDuration.value, window: localWindow.value };
      }
      if (initial.identity.resourceId !== taskBaseline.resourceId) throw new Error('播放器资源已改变，不能安全恢复');
      hasCapture = false; stopped = false; exported = null; mainRestoration = null;
      const fixedRange = { fromMs: 52000, toMs: 67000, prefetchSeconds: 5 };
      baseline = null; version = -1;
      baseline = await read([]); version = baseline.configVersion;
      localFrom.value = '52'; localDuration.value = '15'; localWindow.value = '5';
      const positioned = await requestMain('experiment-position', { seconds: 52, playbackRate: 1 });
      if (positioned.type !== 'positioned' || positioned.resourceId !== taskBaseline.resourceId ||
          !Number.isFinite(positioned.seconds) || Math.abs(positioned.seconds - 52) > 0.25 ||
          positioned.paused !== true || positioned.seeking !== false || positioned.playbackRate !== 1 || positioned.display !== true)
        throw new Error('52秒定位后播放器状态不符合实验要求');
      const current = await inspectRunner();
      if (current.identity.resourceId !== taskBaseline.resourceId || !current.paused || current.seeking || current.rate !== 1 ||
          current.display !== true || Math.abs(current.time - 52) > 0.25)
        throw new Error('定位后的播放器快照与回执不一致');
      const preview = await previewLocal(fixedRange, true, true);
      if (!preview || preview.resourceId !== taskBaseline.resourceId || preview.configVersion !== baseline?.configVersion ||
          preview.dispatch?.savedBatchLimit < 1)
        throw new Error('窗口预览回执缺少资源、配置版本或已保存批量上限');
      const estimate = mainEstimate;
      const estimatePlayback = estimate?.playback;
      if (!estimate || estimate.type !== 'experiment-estimate' || !Array.isArray(estimate.rows) ||
          !estimatePlayback || !Number.isFinite(estimatePlayback.timeSeconds) || Math.abs(estimatePlayback.timeSeconds - 52) > 0.25 ||
          estimatePlayback.paused !== true || estimatePlayback.seeking !== false || estimatePlayback.playbackRate !== 1 ||
          estimatePlayback.display !== true || estimate.nativeContract?.verified !== true ||
          estimate.nativeConfiguration?.valid !== true || estimate.nativeConfiguration.area !== 25 ||
          estimate.nativeConfiguration.domArea !== '25%')
        throw new Error('原生25%契约或暂停定位快照未通过');
      const buildId = verifyBuildIdentity(preview);
      const environment = await requestMain('runner-environment');
      if (environment.type !== 'runner-environment' || environment.resourceId !== taskBaseline.resourceId ||
          typeof environment.signature !== 'string' || !environment.sample || environment.nativeContract?.verified !== true ||
          environment.nativeConfiguration?.valid !== true || environment.nativeConfiguration.area !== 25 ||
          environment.nativeConfiguration.domArea !== '25%' || environment.playback?.paused !== true ||
          environment.playback?.seeking !== false || environment.playback?.playbackRate !== 1 ||
          environment.playback?.display !== true)
        throw new Error('runner环境快照或原生25%契约无效');
      const modelFingerprint = readModelFingerprint(preview);
      if (preview.dispatchComparisonReady === true && !modelFingerprint)
        throw new Error('派发对照预览未能确认已加载模型身份');
      runnerEvidence = { environment: { status: 'unknown', signature: null, comparable: null, changes: [] },
        buildId, modelFingerprint: modelFingerprint?.fingerprint ?? null, modelGeneration: modelFingerprint?.generation ?? null, startedAt: null,
        prepareEnvironment: { status: 'unknown', signature: environment.signature,
          comparable: environment.comparable, sample: environment.sample, observedAt: performance.now(),
          nativeContract: environment.nativeContract, nativeConfiguration: environment.nativeConfiguration } };
      inspection = { ...current, nativeContract: estimate.nativeContract,
        nativeConfiguration: estimate.nativeConfiguration, playback: estimatePlayback,
        runnerEnvironment: runnerEvidence.prepareEnvironment };
      mainRestoration = null;
      return { ok: true, ...runnerStatusFields(inspection), preview: previewReceipt(), localPreview: previewReceipt() };
    }
    async function runnerStop() {
      if (hasCapture && !stopped) {
        const reply = await requestMain('stop');
        if (reply.type !== 'stopped') throw new Error('播放器未确认停止');
      }
      if (localRun && localReport?.report?.state !== 'stopped') await stopLocal('manual', true);
      if (hasCapture) await waitForState(() => !active, '播放器仍处于观测状态');
      if (localRun) await waitForState(() => localReport?.report?.state === 'stopped', '本地实验仍未停止');
      if (hasCapture && stopped && !busy && !exported) { busy = true; send('drain'); }
      if (hasCapture) await waitForState(() => pending === 0 && !busy && !localPolling, '候选缓存仍未完成');
      return { ok: true, ...runnerStatusFields() };
    }
    async function restoreRunner() {
      if (active || (localRun && localReport?.report?.state !== 'stopped')) await runnerStop();
      if (!taskBaseline) return { ok: true, ...runnerStatusFields(), restored: false,
        hooksRestored: mainRestoration ?? { notInstalled: true } };
      if (taskBaseline.resourceId !== inspection?.identity?.resourceId)
        throw new Error('当前播放器资源不同，保留原始恢复快照');
      const reply = await requestMain('restore', { ...taskBaseline, resourceId: taskBaseline.resourceId });
      if (reply.type !== 'restored' || !reply.value || Math.abs(reply.value.timeSeconds - taskBaseline.timeSeconds) > 0.5 ||
          reply.value.paused !== taskBaseline.paused || reply.value.playbackRate !== taskBaseline.playbackRate ||
          reply.value.seeking !== false || Math.abs(reply.value.scroll?.x - taskBaseline.scrollX) > 0.5 ||
          Math.abs(reply.value.scroll?.y - taskBaseline.scrollY) > 0.5)
        throw new Error('播放器状态恢复回执不一致');
      if (rangeBaseline) {
        localFrom.value = rangeBaseline.from; localDuration.value = rangeBaseline.duration; localWindow.value = rangeBaseline.window;
      }
      const current = await inspectRunner();
      return { ok: true, ...runnerStatusFields(current), restored: true,
        hooksRestored: mainRestoration ?? { notInstalled: true }, playbackRestored: reply.value };
    }
    async function runDispatchAction(action: DispatchAuditAction) {
      if (action === 'inspect') return { ok: true, ...runnerStatusFields(await inspectRunner()) };
      if (action === 'prepare') return prepareRunner();
      if (action === 'zero-start') {
        if (!localPreview || localPreview.fromMs !== 52000 || localPreview.toMs !== 67000 || localPreview.prefetchSeconds !== 5)
          throw new Error('请先完成52–67秒、5秒预取的runner准备');
        if (localRun || active) throw new Error('当前已有活动观测');
        localRun = null; localReady = false;
        if (!await begin(true, { fromMs: 52000, toMs: 67000 }, true)) throw new Error('零调用观测未启动');
        return { ok: true, ...runnerStatusFields(await inspectRunner()) };
      }
      if (action === 'start-B' || action === 'start-A') {
        if (!localPreview || localPreview.fromMs !== 52000 || localPreview.toMs !== 67000 || localPreview.prefetchSeconds !== 5)
          throw new Error('请先完成52–67秒、5秒预取的runner准备');
        const singleDispatch = action === 'start-B';
        await beginLocal(true, false, singleDispatch, true);
        return { ok: true, ...runnerStatusFields(await inspectRunner()) };
      }
      if (action === 'stop') return runnerStop();
      if (action === 'export') {
        if (exported) return { ok: true, data: exported };
        if (!stopped || busy || pending > 0) throw new Error('只有停止且候选缓存完成后才能导出');
        const data = await exportData(true);
        if (!data) throw new Error('观测导出不可用');
        return { ok: true, data };
      }
      if (action === 'status') return { ok: true, ...runnerStatusFields(await inspectRunner()) };
      if (action === 'play') {
        if (!active || !hasCapture) throw new Error('没有可播放的活动runner观测');
        const reply = await requestMain('play');
        if (reply.type !== 'played' || !reply.value || reply.value.paused !== false || reply.value.seeking !== false ||
            reply.value.playbackRate !== 1 || !Number.isFinite(reply.value.fromSeconds) ||
            !Number.isFinite(reply.value.toSeconds) || reply.value.toSeconds <= reply.value.fromSeconds + 0.05)
          throw new Error('播放器未实际推进');
        return { ok: true, ...runnerStatusFields(), played: reply.value };
      }
      if (action === 'restore') return restoreRunner();
      throw new Error('runner action is not allowed');
    }
    function download(data: any, filename: string) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    const onMessage = async (event: MessageEvent) => {
      const d = event.data;
      if (event.source !== window || event.origin !== location.origin || d?.channel !== CHANNEL || d.from !== 'main' || d.token !== token) return;
      if (typeof d.buildId === 'string') {
        diagnosticMainBuildId = d.buildId; title.dataset.mainBuildId = d.buildId;
      }
      if (d.type === 'runner-evidence' && d.runnerEvidence && typeof d.runnerEvidence === 'object') {
        runnerEvidence = { ...runnerEvidence, ...d.runnerEvidence,
          prepareEnvironment: runnerEvidence.prepareEnvironment, modelFingerprint: runnerEvidence.modelFingerprint };
      }
      if (d.type === 'experiment-estimate' && localPreview && !localRun && Array.isArray(d.rows)) {
        const filtered = new Map<string, any>(d.rows.map((row: any) => [row.id, row]));
        const remaining = [...new Set<string>(localPreview.items.filter((row: any) => row.translationEligible &&
          !(filtered.get(row.id)?.state === 'filtered' && filtered.get(row.id)?.originalText === row.text))
          .map((row: any) => row.text))];
        localPreview.filteredBudget = { maxInputItems: remaining.length,
          maxInputChars: remaining.reduce((sum, text) => sum + text.length, 0), maxAttempts: remaining.length };
        filteredButton.disabled = remaining.length === 0;
        dispatchBaselineButton.disabled = dispatchSingleButton.disabled = !localPreview.dispatchComparisonReady || !remaining.length ||
          localPreview.fromMs !== 52000 || localPreview.toMs !== 67000 || localPreview.prefetchSeconds !== 5;
        localStatus.textContent += ` 筛选后估算 ${remaining.length}条 / ${localPreview.filteredBudget.maxInputChars}字（仅干跑）。`;
      }
      if (d.type === 'inspection') {
        inspection = d.value; output.textContent = JSON.stringify(inspection, null, 2);
        start.disabled = !inspection; status.textContent = inspection ? `已连接 CID ${inspection.identity.cid}；暂停后开始` : '播放器尚未适配';
        shadowStart.disabled = !inspection;
        branchButton.disabled = !inspection;
      }
      if (d.type === 'branch-inspection' && branchBaseline) {
        try {
          const final = await read([]);
          if (final.configVersion !== branchBaseline.configVersion || final.workerSession !== branchBaseline.workerSession ||
              final.engine.providerCalls !== branchBaseline.engine.providerCalls) throw new Error('分支检查期间后台状态已改变');
          const data = { schema: 1, inspection: d.value, currentSettings: branchBaseline.settings,
            configVersion: branchBaseline.configVersion, safety: [branchBaseline.engine, final.engine],
            purpose: 'Native rejection branch investigation; no model calls or rule decisions' };
          download(data, `DanLingo-native-branches-${d.value.identity.cid}-${Date.now()}.json`);
          output.textContent = JSON.stringify({ cid: d.value.identity.cid, methods: d.value.branches.methods.map((m: any) => ({ name: m.name, owner: m.owner, length: m.length, truncated: m.truncated })) }, null, 2);
          status.textContent = '已导出只读分支信息；未调用原生过滤器或模型';
        } catch (e) { status.textContent = String(e); }
        finally { branchBaseline = null; }
      }
      if (d.type === 'started') { active = true; stopped = false; hasCapture = true;
        if (d.shadowStatus) output.textContent = JSON.stringify(d.shadowStatus, null, 2);
        status.textContent = localRun ? '请直接播放；本地翻译按所选区间和预算自动停止，保存设置保持不变'
        : d.shadow && d.shadowStatus?.reason ? `影子条件未知：${d.shadowStatus.reason}；保留所有候选`
        : d.shadow
        ? '已启用影子验证，请播放视频；只记预测，不排除或调用模型，35 秒后自动停止'
        : '已启用采集，请播放视频；连续观测 35 秒后自动停止';
        if (pendingLocalStart) { const startLocal = pendingLocalStart; pendingLocalStart = null;
          try { await startLocal(); } catch (e) { error = String(e); localStatus.textContent = error; send('stop'); await stopLocal('start-failed'); } }
      }
      if (d.type === 'progress') status.textContent = `采集中 ${Math.round(d.videoTimeMs / 1000)} 秒 · 候选 ${d.counts.records} · 可见事件 ${d.visibleEvents} · 当前映射 ${d.mapped}/${d.visible}`;
      if (d.type === 'stopped') { active = false; stopped = true; mainRestoration = d.restoration ?? mainRestoration; if (localRun) await stopLocal(d.ended.reason === 'interval-complete' ? 'range-complete' : d.ended.reason); exportButton.disabled = !error && (busy || pending > 0); status.textContent = `采集已停止：${d.ended.reason}；完成缓存检查后可导出`; }
      if (d.type === 'error') { active = false; error = d.error; status.textContent = error; pendingLocalStart = null; if (localRun) await stopLocal('diagnostic-error'); start.disabled = false; shadowStart.disabled = false; }
      if (d.type === 'candidates') {
        pending = d.remaining;
        try {
          if (d.rows.length) {
            const response = await read(d.rows.map((row: any) => row.originalText));
            cacheRows.push(...d.rows.map((row: any, index: number) => ({ ...row, ...response.items[index], inflightHit: false,
              inflightEvidence: 'real-background-pendingItems-zero', cacheObservedMonotonicMs: performance.now() })));
          }
        } catch (e) { error = String(e); send('stop'); status.textContent = error; }
        finally { busy = false; exportButton.disabled = !stopped || (pending > 0 && !error); }
      }
      if (d.type === 'export') {
        runnerEvidence = { ...runnerEvidence, ...(d.data.runnerEvidence ?? {}),
          modelFingerprint: runnerEvidence.modelFingerprint, prepareEnvironment: runnerEvidence.prepareEnvironment };
        exported = { ...d.data, runnerEvidence,
          buildIdentity: { diagnosticContent: { version: manifestVersion, buildId: BUILD_ID },
          diagnosticMain: { buildId: diagnosticMainBuildId },
          background: { buildId: localPreview?.dispatch?.backgroundBuildId ?? null },
          watch: { buildId: localPreview?.dispatch?.watchBuildId ?? null } },
          currentSettings: baseline?.settings, cacheRows, safety, diagnosticError: error || null,
          localExperiment: localRun ? { configuration: { ...localRun, allowTexts: undefined }, ...localReport } : null,
          pendingCandidates: pending, modelCallsMadeByOtherCode: !localRun && safety.length > 1 && !error ? 0 : null,
          pendingContentsMeaning: localRun ? `cacheRows describe the untouched user cache only; actual experiment uses an independent ${localRun.cacheReplay ? 'seeded, cache-only' : 'initially empty'} memory cache; provider counts are in localExperiment`
            : 'counterfactual current window/language/cache/exact-text dedupe; actual translation disabled; no provider requests or simulated completions' };
        const runnerDownload = runnerExportRequests.has(d.requestId);
        let filename: string | null = null;
        if (!runnerDownload) {
          const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
          link.download = `DanLingo-real-bilibili-${d.data.identity.cid}-${Date.now()}.json`; link.click(); filename = link.download;
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        output.textContent = JSON.stringify({ cid: d.data.identity.cid, candidates: cacheRows.length, nativeRows: d.data.records.length,
          visibleEvents: d.data.visibleEvents.length, safety, error: error || null, ...(filename ? { file: filename } : {}) }, null, 2);
        status.textContent = runnerDownload ? 'runner已导出真实观测数据' : '已导出真实观测 JSON';
        if (localRun) { localRun = null; localReady = false; localPreview = null; title.textContent = `${titleLabel} · 单片段诊断（不调用模型）`; }
        start.disabled = shadowStart.disabled = !inspection;
      }
      resolveMainRequest(d);
    };
    window.addEventListener('message', onMessage);
    const runnerPageUrl = browser.runtime.getURL('/dispatch-runner.html');
    const runnerListener = (message: any, sender: { id?: string; url?: string; frameId?: number; tab?: unknown }) => {
      if (sender.id !== browser.runtime.id || message?.type !== 'dispatch-runner-action') return;
      try {
        const senderUrl = new URL(sender.url ?? ''), expectedUrl = new URL(runnerPageUrl);
        if (senderUrl.origin !== expectedUrl.origin || senderUrl.pathname !== expectedUrl.pathname || senderUrl.search ||
            (sender.frameId !== undefined && sender.frameId !== 0)) return;
        parseDispatchHash(senderUrl.hash);
      } catch { return; }
      const keys = message && typeof message === 'object' ? Object.keys(message).sort().join(',') : '';
      if (keys !== 'action,args,type' || !message.args || typeof message.args !== 'object' || Array.isArray(message.args) ||
          Object.keys(message.args).length !== 0 || !DISPATCH_AUDIT_ACTIONS.includes(message.action))
        return Promise.resolve({ ok: false, error: 'invalid-runner-action' });
      return runDispatchAction(message.action as DispatchAuditAction).catch(error => ({ ok: false,
        error: error instanceof Error ? error.message.slice(0, 180) : 'runner-action-failed' }));
    };
    browser.runtime.onMessage.addListener(runnerListener);
    let checks = 0;
    const timer = setInterval(() => {
      if (localRun && localReady && !localPolling) { localPolling = true; void localSnapshot().catch(e => {
        localStatus.textContent = String(e); send('stop');
      }).finally(() => { localPolling = false; }); }
      if ((active || stopped) && !busy && !exported && !error) { busy = true; send('drain'); }
      if (active && ++checks % 3 === 0) void read([]).then(value => safety.push({ at: performance.now(), engine: value.engine }))
        .catch(e => { error = String(e); send('stop'); status.textContent = error; });
    }, 500);
    ctx.onInvalidated(() => {
      send('stop'); if (localRun) void stopLocal('invalidated'); clearInterval(timer);
      window.removeEventListener('message', onMessage); browser.runtime.onMessage.removeListener(runnerListener); panel.remove();
      for (const [requestId, request] of mainRequests) { clearTimeout(request.timer); request.reject(new Error('diagnostic-content-invalidated')); }
      mainRequests.clear(); runnerExportRequests.clear();
    });
  },
});
