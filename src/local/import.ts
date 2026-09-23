import type { LocalModelInfo } from './types.ts';
import { deleteModelIfOwned } from './storage.ts';
export function importLocalFiles(files: File[], options: { signal?: AbortSignal; onProgress?: (stage: string) => void; onReused?: (info: LocalModelInfo) => void } = {}): Promise<LocalModelInfo> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    const importOwner = crypto.randomUUID();
    let importingId: string | undefined, importingFingerprint: string | undefined;
    let aborted = false, settled = false;
    const finish = () => { worker.terminate(); options.signal?.removeEventListener('abort', abort); };
    const cleanupOwned = (id: string | undefined, fingerprint: string | undefined) => {
      if (id && fingerprint) void deleteModelIfOwned(id, fingerprint, importOwner).catch(() => {});
    };
    const abort = () => {
      if (aborted || settled) return;
      aborted = true;
      options.signal?.removeEventListener('abort', abort);
      // Keep the worker alive long enough to report whether it created a model;
      // a duplicate result is never an owned record and must not be deleted.
      worker.postMessage({ cancel: true });
      cleanupOwned(importingId, importingFingerprint);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (event.data.stage) {
        if (aborted) return;
        if (event.data.info?.id && event.data.info?.fingerprint) {
          importingId = event.data.info.id; importingFingerprint = event.data.info.fingerprint;
        }
        options.onProgress?.(event.data.stage); return;
      }
      const created = event.data.created === true;
      const resultInfo = event.data.info as LocalModelInfo | undefined;
      finish();
      if (aborted) {
        if (created) cleanupOwned(resultInfo?.id ?? importingId, resultInfo?.fingerprint ?? importingFingerprint);
        return;
      }
      settled = true;
      if (event.data.ok) {
        if (event.data.reused) options.onReused?.(resultInfo!);
        resolve(resultInfo!);
      } else reject(new Error(event.data.error));
    };
    worker.onerror = () => { finish(); if (!aborted && !settled) { settled = true; reject(new Error('LOCAL_IMPORT_WORKER_FAILED')); } };
    worker.postMessage({ files, owner: importOwner });
  });
}
