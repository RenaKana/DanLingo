import { fingerprintFiles, inspectAndOrderFiles } from './gguf.ts';
import { saveModelDeduplicated } from './storage.ts';
import { localError } from './types.ts';
let cancelled = false;
self.onmessage = async (event: MessageEvent<{ files: File[]; owner?: string } | { cancel: true }>) => {
  if ('cancel' in event.data) { cancelled = true; return; }
  try {
    self.postMessage({ stage: 'checking' });
    const { info, files } = await inspectAndOrderFiles(event.data.files);
    if (cancelled) throw new Error('LOCAL_IMPORT_ABORTED');
    self.postMessage({ stage: 'fingerprinting' });
    const fingerprint = await fingerprintFiles(files, { shouldCancel: () => cancelled });
    if (cancelled) throw new Error('LOCAL_IMPORT_ABORTED');
    const candidateInfo = { ...info, fingerprint };
    self.postMessage({ stage: 'persisting', info: candidateInfo });
    const saved = await saveModelDeduplicated({ info: candidateInfo, blobs: files }, { isCancelled: () => cancelled, owner: event.data.owner });
    self.postMessage({ ok: true, info: saved.info, created: saved.created, reused: !saved.created });
  } catch (error) { self.postMessage({ ok: false, error: localError(error) }); }
};
