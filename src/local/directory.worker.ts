import { scanDirectory } from './directory-scan.ts';
import type { DirectoryScanStatus } from './directory-types.ts';

const running = new Map<string, AbortController>();
const codeOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^LOCAL_[A-Z0-9_]+$/.test(message) ? message : 'LOCAL_DIRECTORY_SCAN_FAILED';
};

self.onmessage = (event: MessageEvent<{ requestId: string; directoryId?: string } | { cancel: true; requestId: string }>) => {
  const message = event.data;
  if ('cancel' in message && message.cancel === true) {
    running.get(message.requestId)?.abort();
    return;
  }
  if (!('directoryId' in message) || typeof message.requestId !== 'string' || !message.requestId || typeof message.directoryId !== 'string' || !message.directoryId) {
    self.postMessage({ requestId: message.requestId, ok: false, error: 'LOCAL_DIRECTORY_SCAN_REQUEST_INVALID' });
    return;
  }
  const controller = new AbortController();
  running.set(message.requestId, controller);
  let progress: DirectoryScanStatus | undefined;
  void scanDirectory(message.directoryId, {
    shouldCancel: () => controller.signal.aborted,
    onProgress: next => { progress = next; self.postMessage({ requestId: message.requestId, progress: next }); },
  }).then(result => self.postMessage({ requestId: message.requestId, ok: true, result }))
    .catch(error => self.postMessage({ requestId: message.requestId, ok: false, error: codeOf(error), ...(progress ? { progress } : {}) }))
    .finally(() => { if (running.get(message.requestId) === controller) running.delete(message.requestId); });
};
