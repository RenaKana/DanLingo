import { browser } from 'wxt/browser';
import { LocalController } from '../../src/local/controller';
import { deleteModel, listModels, listDirectories, removeDirectory } from '../../src/local/storage';
import { LOCAL_CHANNEL, localError } from '../../src/local/types';
import { LocalBenchmarkRunner } from '../../src/local/benchmark-runner';
import { DirectoryScanManager } from '../../src/local/directory-manager';
import { LocalIdleUnloader } from '../../src/local/idle-unload';
import { refreshFileReferencesInWorker } from '../../src/local/file-registration-client';
import type { DirectoryScanStatus } from '../../src/local/directory-types';

const controller = new LocalController(() => new Worker(new URL('../../src/local/inference.worker.ts', import.meta.url), { type: 'module' }));
const benchmark = new LocalBenchmarkRunner(controller);
const idleUnload = new LocalIdleUnloader({
  snapshot: () => controller.snapshot(), unload: () => controller.unload(), blocked: () => benchmark.isRunning(),
  canUnload: async () => { const reply = await browser.runtime.sendMessage({ type: 'local-idle-check' }); return reply?.ok === true && reply.idle === true; },
  unloaded: () => { void browser.runtime.sendMessage({ type: 'local-idle-unloaded' }).catch(() => {}); },
});
let policyRevision = 0;
async function sourcesChanged() {
  const models = await listModels(), currentId = controller.snapshot().model?.id;
  const current = models.find(model => model.id === currentId);
  if (currentId && (!current || current.availability && current.availability !== 'ready')) controller.unload();
  await browser.runtime.sendMessage({ type: 'local-sources-updated' });
}
const directories = new DirectoryScanManager(
  () => new Worker(new URL('../../src/local/directory.worker.ts', import.meta.url), { type: 'module' }),
  async () => { await sourcesChanged(); },
);
let sourceScanEpoch = 0, fileRefreshes = 0, fileRefreshController: AbortController | undefined;
let fileRefreshStatus: DirectoryScanStatus | undefined;
async function directoryState() {
  return { directories: await listDirectories(), scan: fileRefreshes > 0 ? fileRefreshStatus : directories.snapshot(), scanBusy: directories.busy() || fileRefreshes > 0 };
}
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== LOCAL_CHANNEL || sender.id !== browser.runtime.id || sender.tab) return;
  const respond = async () => {
    const release = ['load', 'ensure', 'complete', 'benchmark-start', 'benchmark-stop'].includes(message.action)
      || message.action === 'state' && message.demand === true ? idleUnload.hold() : undefined;
    try {
      if (Number.isSafeInteger(message.policyRevision)) {
        if (message.policyRevision < policyRevision) return { ok: false, error: 'LOCAL_MODEL_CHANGED', state: controller.snapshot() };
        policyRevision = message.policyRevision;
      }
      if (benchmark.isRunning() && !['benchmark-status', 'benchmark-stop', 'state', 'list', 'directory-status', 'directory-cancel'].includes(message.action)) return { ok: false, error: 'LOCAL_BENCHMARK_BUSY' };
      switch (message.action) {
        case 'benchmark-start': {
          const report = benchmark.start(message.modelId, message.options);
          void benchmark.settled().then(() => browser.runtime.sendMessage({ type: 'local-benchmark-finished', id: report.id })).catch(() => {}).finally(() => idleUnload.changed());
          return { ok: true, report };
        }
        case 'benchmark-status': return { ok: true, report: benchmark.snapshot() };
        case 'benchmark-stop': return { ok: true, report: await benchmark.stop() };
        case 'state': return { ok: true, state: controller.snapshot() };
        case 'list': return { ok: true, models: await listModels(), state: controller.snapshot(), ...await directoryState() };
        case 'directory-status': return { ok: true, ...await directoryState() };
        case 'directory-scan': {
          const epoch = sourceScanEpoch;
          const ids = message.directoryId ? [message.directoryId] : (await listDirectories()).map(directory => directory.id);
          const results = await Promise.all(ids.map(id => directories.scan(id)));
          const cancelled = () => epoch !== sourceScanEpoch || results.some(result => result.status.phase === 'cancelled');
          let fileIssues: Awaited<ReturnType<typeof refreshFileReferencesInWorker>> = [];
          if (!message.directoryId && !cancelled()) {
            fileRefreshes++;
            const refreshController = new AbortController(); fileRefreshController = refreshController;
            fileRefreshStatus = { phase: 'scanning', stage: 'enumerating', checkedFiles: 0, modelsFound: 0,
              elapsedMs: 0, fingerprintedBytes: 0, totalFingerprintBytes: 0, issues: [] };
            const refreshStarted = performance.now();
            try {
              fileIssues = await refreshFileReferencesInWorker({ signal: refreshController.signal, onProgress: status => {
                fileRefreshStatus = { ...status, elapsedMs: performance.now() - refreshStarted };
              } });
              await sourcesChanged();
            } catch (error) {
              if (!refreshController.signal.aborted) throw error;
              fileRefreshStatus = { ...(fileRefreshStatus ?? { checkedFiles: 0, modelsFound: 0, issues: [] }), phase: 'cancelled', elapsedMs: performance.now() - refreshStarted };
            } finally {
              fileRefreshes--; if (fileRefreshController === refreshController) fileRefreshController = undefined;
              if (fileRefreshStatus?.phase === 'scanning') fileRefreshStatus = { ...fileRefreshStatus, phase: 'complete', elapsedMs: performance.now() - refreshStarted };
            }
          }
          return { ok: true, models: await listModels(), state: controller.snapshot(), ...await directoryState(), fileIssues };
        }
        case 'files-changed':
          await sourcesChanged();
          return { ok: true, models: await listModels(), state: controller.snapshot() };
        case 'directory-cancel':
          sourceScanEpoch++;
          if (fileRefreshController) {
            fileRefreshStatus = { ...(fileRefreshStatus ?? { phase: 'scanning', checkedFiles: 0, modelsFound: 0, elapsedMs: 0, issues: [] }), phase: 'cancelled' };
            fileRefreshController.abort();
          }
          directories.cancel(); return { ok: true, ...await directoryState() };
        case 'directory-remove':
          directories.cancel(message.directoryId);
          await removeDirectory(message.directoryId); await sourcesChanged();
          return { ok: true, models: await listModels(), state: controller.snapshot(), ...await directoryState() };
        case 'load':
          if (Number.isSafeInteger(message.policyRevision) && message.policyRevision < policyRevision) throw new Error('LOCAL_MODEL_CHANGED');
          return { ok: true, state: await controller.load(message.modelId, message.config, { validateSourceOnReuse: true }) };
        case 'ensure': return { ok: true, state: await controller.load(message.modelId, message.config) };
        case 'unload': case 'cancel': return { ok: true, state: controller.unload() };
        case 'delete':
          if (controller.snapshot().model?.id === message.modelId) controller.unload();
          await deleteModel(message.modelId); return { ok: true, models: await listModels(), state: controller.snapshot() };
        case 'abort': controller.abort(message.id); return { ok: true };
        case 'complete': return { ok: true, result: await controller.complete(message.id, message.modelId, message.body) };
        default: return { ok: false, error: 'LOCAL_INVALID_ACTION' };
      }
    } catch (error) {
      const code = localError(error);
      if (/^LOCAL_(?:SOURCE_|DIRECTORY_(?:PERMISSION|MISSING|NOT_FOUND))/.test(code) || code === 'LOCAL_MODEL_NOT_IMPORTED') await sourcesChanged().catch(() => {});
      return { ok: false, error: code, state: controller.snapshot() };
    } finally { release?.(); idleUnload.changed(); }
  };
  void respond().then(sendResponse);
  return true;
});
