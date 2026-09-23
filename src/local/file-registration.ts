import { fingerprintFiles, inspectAndOrderFiles } from './gguf.ts';
import { groupFiles } from './directory-scan.ts';
import { listFileReferences, markFileReferenceError, saveFileReference } from './storage.ts';
import type { DirectoryIssue, DirectoryScanStatus, ReadOnlyFileHandle } from './directory-types.ts';
import type { LocalModelInfo } from './types.ts';

type Progress = (status: DirectoryScanStatus) => void;
function publish(onProgress: Progress | undefined, status: DirectoryScanStatus): void {
  try { onProgress?.({ ...status, issues: status.issues.map(issue => ({ ...issue })) }); } catch { /* progress observers cannot affect registration */ }
}

async function checkReadPermission(handles: ReadOnlyFileHandle[]): Promise<void> {
  for (const handle of handles) {
    try { if (await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED'); }
    catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
      throw new Error(name === 'NotAllowedError' || name === 'SecurityError' ? 'LOCAL_DIRECTORY_PERMISSION_REQUIRED'
        : name === 'NotFoundError' ? 'LOCAL_SOURCE_MISSING' : error instanceof Error ? error.message : 'LOCAL_DIRECTORY_SCAN_FAILED');
    }
  }
}

export async function registerModelFiles(
  handles: ReadOnlyFileHandle[], expectedId?: string, shouldCancel = () => false, onProgress?: Progress,
): Promise<{ models: LocalModelInfo[]; issues: DirectoryIssue[] }> {
  if (!handles.length) throw new Error('LOCAL_SELECT_SINGLE_COMPLETE_GGUF');
  const entries: { path: string; file: File; handle: ReadOnlyFileHandle }[] = [];
  const progress: DirectoryScanStatus = { phase: 'scanning', stage: 'enumerating', checkedFiles: 0, modelsFound: 0,
    elapsedMs: 0, fingerprintedBytes: 0, totalFingerprintBytes: 0, issues: [] };
  publish(onProgress, progress);
  for (const handle of handles) {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    if (handle.kind !== 'file' || typeof handle.queryPermission !== 'function') throw new Error('LOCAL_FILE_HANDLE_UNSUPPORTED');
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    const file = await handle.getFile();
    if (!file.name.toLowerCase().endsWith('.gguf')) throw new Error('LOCAL_FORMAT_UNSUPPORTED');
    entries.push({ path: file.name, file, handle });
    progress.checkedFiles++;
    publish(onProgress, progress);
  }
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('LOCAL_SHARD_DUPLICATE');
  const issues: DirectoryIssue[] = [];
  const prepared: Array<{ group: ReturnType<typeof groupFiles>[number]; ordered: Awaited<ReturnType<typeof inspectAndOrderFiles>>; handles: ReadOnlyFileHandle[]; fingerprint?: string }> = [];
  const handleByFile = new Map(entries.map(entry => [entry.file, entry.handle]));
  for (const group of groupFiles(entries)) {
    try {
      if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
      const ordered = await inspectAndOrderFiles(group.entries.map(entry => entry.file));
      prepared.push({ group, ordered, handles: ordered.files.map(file => handleByFile.get(file)!) });
    } catch (error) {
      if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
      issues.push({ path: group.entries.map(entry => entry.path).join(', '), error: error instanceof Error && /^LOCAL_[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_DIRECTORY_MODEL_INVALID' });
    }
  }
  progress.stage = 'fingerprinting';
  progress.totalFingerprintBytes = prepared.reduce((total, model) => total + model.ordered.files.reduce((sum, file) => sum + file.size, 0), 0);
  if (!Number.isSafeInteger(progress.totalFingerprintBytes)) throw new Error('LOCAL_FILE_SIZE_INVALID');
  publish(onProgress, progress);
  let completedBytes = 0;
  for (const model of prepared) {
    model.fingerprint = await fingerprintFiles(model.ordered.files, {
      shouldCancel, cancelCode: 'LOCAL_SCAN_CANCELLED', checkSource: () => checkReadPermission(model.handles),
      onProgress: value => { progress.fingerprintedBytes = completedBytes + value.bytesProcessed; publish(onProgress, progress); },
    });
    completedBytes += model.ordered.files.reduce((sum, file) => sum + file.size, 0);
    progress.fingerprintedBytes = completedBytes;
    publish(onProgress, progress);
  }
  const models: LocalModelInfo[] = [];
  progress.stage = 'persisting';
  publish(onProgress, progress);
  for (const model of prepared) {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    await checkReadPermission(model.handles);
    const source = { kind: 'files' as const, directoryName: '直接选择的文件',
      files: model.ordered.files.map(file => ({ path: file.name, size: file.size, lastModified: file.lastModified })) };
    const info: LocalModelInfo = { ...model.ordered.info, fingerprint: model.fingerprint!, availability: 'ready', source };
    models.push(await saveFileReference(info, model.handles, expectedId, shouldCancel));
    progress.modelsFound = models.length;
    publish(onProgress, progress);
  }
  return { models, issues };
}

/** Manual refresh only; checking a model list never enumerates or reparses source files. */
export async function refreshFileReferences(shouldCancel = () => false, onProgress?: Progress): Promise<DirectoryIssue[]> {
  const issues: DirectoryIssue[] = [];
  const models = await listFileReferences();
  const totalFingerprintBytes = models.reduce((total, model) => {
    const bytes = model.info.source?.kind === 'files' ? model.info.source.files.reduce((sum, file) => sum + file.size, 0) : 0;
    const next = total + bytes;
    return Number.isSafeInteger(next) ? next : total;
  }, 0);
  let completedBytes = 0, completedModels = 0;
  for (const model of models) {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    let modelProgressBytes = 0;
    try {
      const result = await registerModelFiles(model.fileHandles ?? [], model.info.id, shouldCancel, status => {
        modelProgressBytes = Math.max(modelProgressBytes, status.fingerprintedBytes ?? 0);
        if (status.fingerprintedBytes !== undefined) status.fingerprintedBytes = completedBytes + modelProgressBytes;
        if (status.totalFingerprintBytes !== undefined) status.totalFingerprintBytes = totalFingerprintBytes;
        status.modelsFound += completedModels;
        publish(onProgress, status);
      });
      issues.push(...result.issues);
      if (!result.models.length) throw new Error(result.issues[0]?.error ?? 'LOCAL_DIRECTORY_MODEL_INVALID');
    } catch (error) {
      if (shouldCancel() || error instanceof Error && error.message === 'LOCAL_SCAN_CANCELLED') throw new Error('LOCAL_SCAN_CANCELLED');
      await markFileReferenceError(model.info.id, error).catch(() => {});
      if (!issues.some(issue => issue.path === model.info.name)) issues.push({ path: model.info.name, error: error instanceof Error ? error.message : 'LOCAL_DIRECTORY_SCAN_FAILED' });
    } finally {
      completedBytes += modelProgressBytes;
      completedModels++;
    }
  }
  return issues;
}
