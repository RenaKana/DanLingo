import { registerModelFiles, refreshFileReferences } from './file-registration.ts';
import type { ReadOnlyFileHandle } from './directory-types.ts';

type Command =
  | { requestId: string; action: 'register'; handles: ReadOnlyFileHandle[]; expectedId?: string }
  | { requestId: string; action: 'refresh' }
  | { requestId: string; cancel: true };

const running = new Map<string, AbortController>();
const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^LOCAL_[A-Z0-9_]+$/.test(message) ? message : 'LOCAL_DIRECTORY_SCAN_FAILED';
};

self.onmessage = (event: MessageEvent<Command>) => {
  const message = event.data;
  if (!('action' in message)) {
    running.get(message.requestId)?.abort();
    return;
  }
  if (!message.requestId || !['register', 'refresh'].includes(message.action)) {
    self.postMessage({ requestId: message.requestId, ok: false, error: 'LOCAL_DIRECTORY_SCAN_REQUEST_INVALID' });
    return;
  }
  const controller = new AbortController();
  running.set(message.requestId, controller);
  const onProgress = (progress: unknown) => self.postMessage({ requestId: message.requestId, progress });
  const operation = message.action === 'register'
    ? registerModelFiles(message.handles, message.expectedId, () => controller.signal.aborted, onProgress)
    : refreshFileReferences(() => controller.signal.aborted, onProgress);
  void operation.then(result => self.postMessage({ requestId: message.requestId, ok: true, result }))
    .catch(error => self.postMessage({ requestId: message.requestId, ok: false, error: errorCode(error) }))
    .finally(() => { if (running.get(message.requestId) === controller) running.delete(message.requestId); });
};
