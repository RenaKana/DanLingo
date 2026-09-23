import type { DirectoryScanStatus, ReadOnlyFileHandle } from './directory-types.ts';
import type { LocalModelInfo } from './types.ts';
import type { DirectoryIssue } from './directory-types.ts';

interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface FileRegistrationOptions {
  signal?: AbortSignal;
  onProgress?: (status: DirectoryScanStatus) => void;
}

type WorkerResult = { models: LocalModelInfo[]; issues: DirectoryIssue[] } | DirectoryIssue[];

function run<T extends WorkerResult>(command: Record<string, unknown>, options: FileRegistrationOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('LOCAL_SCAN_CANCELLED')); return; }
    const worker = new Worker(new URL('./file-registration.worker.ts', import.meta.url), { type: 'module' }) as WorkerLike;
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; worker.terminate(); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => { try { worker.postMessage({ requestId, cancel: true }); } catch { finish(new Error('LOCAL_SCAN_CANCELLED')); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (message.progress) {
        try { options.onProgress?.(message.progress as DirectoryScanStatus); } catch { /* progress observers cannot affect registration */ }
        return;
      }
      if (message.ok) finish(undefined, message.result as T);
      else finish(new Error(typeof message.error === 'string' ? message.error : 'LOCAL_DIRECTORY_SCAN_FAILED'));
    };
    worker.onerror = () => finish(new Error('LOCAL_DIRECTORY_SCAN_FAILED'));
    try { worker.postMessage({ ...command, requestId }); }
    catch { finish(new Error('LOCAL_DIRECTORY_SCAN_FAILED')); }
  });
}

export function registerModelFilesInWorker(
  handles: ReadOnlyFileHandle[], expectedId?: string, options?: FileRegistrationOptions,
): Promise<{ models: LocalModelInfo[]; issues: DirectoryIssue[] }> {
  return run({ action: 'register', handles, ...(expectedId ? { expectedId } : {}) }, options);
}

export function refreshFileReferencesInWorker(options?: FileRegistrationOptions): Promise<DirectoryIssue[]> {
  return run({ action: 'refresh' }, options);
}
