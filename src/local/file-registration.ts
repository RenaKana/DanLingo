import { inspectAndOrderFiles } from './gguf.ts';
import { groupFiles } from './directory-scan.ts';
import { hasReusableMetadata, listFileReferences, markFileReferenceError, saveFileReference, type StoredModel } from './storage.ts';
import type { DirectoryFileSnapshot, DirectoryIssue, DirectoryScanStatus, FileSource, ReadOnlyFileHandle } from './directory-types.ts';
import type { LocalModelInfo } from './types.ts';

type Progress = (status: DirectoryScanStatus) => void;
type Timings = NonNullable<DirectoryScanStatus['timings']>;
interface FileEntry { path: string; file: File; handle: ReadOnlyFileHandle }
interface PreparedModel { info: LocalModelInfo; handles: ReadOnlyFileHandle[] }

function now(): number { return performance.now(); }

function publish(onProgress: Progress | undefined, status: DirectoryScanStatus): void {
  try {
    onProgress?.({ ...status, elapsedMs: status.startedAt ? Date.now() - status.startedAt : status.elapsedMs,
      issues: status.issues.map(issue => ({ ...issue })), timings: status.timings ? { ...status.timings } : undefined });
  } catch { /* progress observers cannot affect registration */ }
}

function snapshotFor(entry: FileEntry): DirectoryFileSnapshot {
  return { path: entry.path, size: entry.file.size, lastModified: entry.file.lastModified };
}

function snapshotKey(files: DirectoryFileSnapshot[]): string {
  return files.map(file => `${file.path}\u0000${file.size}\u0000${file.lastModified}`).sort().join('\u0001');
}

function sourceOf(info: LocalModelInfo): FileSource | undefined {
  const source = info.source;
  return source?.kind === 'files' ? source : undefined;
}

function timings(): Timings { return { enumerationMs: 0, fileAccessMs: 0, headerMs: 0, registrationMs: 0 }; }

function isRetired(model: StoredModel): boolean {
  return model.info.availability === 'changed' || model.info.availability === 'missing';
}

function entriesInSourceOrder(model: StoredModel, entries: FileEntry[]): FileEntry[] | undefined {
  const source = sourceOf(model.info);
  if (!source || source.files.length !== entries.length) return undefined;
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const ordered = source.files.map(snapshot => {
    const entry = byPath.get(snapshot.path);
    return entry && entry.file.size === snapshot.size && entry.file.lastModified === snapshot.lastModified ? entry : undefined;
  });
  if (ordered.some(entry => !entry) || !model.fileHandles || model.fileHandles.length !== ordered.length) return undefined;
  return ordered as FileEntry[];
}

async function sameEntriesInSourceOrder(model: StoredModel, ordered: FileEntry[], shouldCancel: () => boolean): Promise<boolean> {
  if (!model.fileHandles || model.fileHandles.length !== ordered.length) return false;
  try {
    for (const [index, entry] of ordered.entries()) {
      if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
      if (!await entry.handle.isSameEntry(model.fileHandles[index]!)) return false;
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCAL_SCAN_CANCELLED') throw error;
    return false;
  }
  return true;
}

function sourceInfo(info: LocalModelInfo, files: File[]): LocalModelInfo {
  const source: FileSource = { kind: 'files', directoryName: '直接选择的文件',
    files: files.map(file => ({ path: file.name, size: file.size, lastModified: file.lastModified })) };
  return { ...info, availability: 'ready', error: undefined, source } as LocalModelInfo;
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
  handles: ReadOnlyFileHandle[], expectedId?: string, shouldCancel = () => false, onProgress?: Progress, knownPrevious?: StoredModel,
): Promise<{ models: LocalModelInfo[]; issues: DirectoryIssue[] }> {
  if (!handles.length) throw new Error('LOCAL_SELECT_SINGLE_COMPLETE_GGUF');
  const startedAt = Date.now();
  const progress: DirectoryScanStatus = { phase: 'scanning', stage: 'enumerating', checkedFiles: 0, modelsFound: 0,
    elapsedMs: 0, startedAt, timings: timings(), issues: [] };
  publish(onProgress, progress);
  let previous = knownPrevious;
  if (!previous && expectedId) previous = (await listFileReferences()).find(model => model.info.id === expectedId);
  if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
  if (expectedId && (!previous || previous.info.id !== expectedId)) throw new Error('LOCAL_MODEL_NOT_IMPORTED');

  const entries: FileEntry[] = [];
  for (const handle of handles) {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    const enumerationStarted = now();
    if (handle.kind !== 'file' || typeof handle.queryPermission !== 'function') throw new Error('LOCAL_FILE_HANDLE_UNSUPPORTED');
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    progress.timings!.enumerationMs += now() - enumerationStarted;
    progress.stage = 'reading-files'; progress.currentFile = handle.name;
    publish(onProgress, progress);
    const accessStarted = now();
    let file: File;
    try { file = await handle.getFile(); }
    finally { progress.timings!.fileAccessMs += now() - accessStarted; }
    if (!file.name.toLowerCase().endsWith('.gguf')) throw new Error('LOCAL_FORMAT_UNSUPPORTED');
    entries.push({ path: file.name, file, handle });
    progress.checkedFiles++;
    progress.currentFile = undefined; progress.stage = 'enumerating';
    publish(onProgress, progress);
  }
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('LOCAL_SHARD_DUPLICATE');
  const issues: DirectoryIssue[] = [];
  const prepared: PreparedModel[] = [];
  const handleByFile = new Map(entries.map(entry => [entry.file, entry.handle]));
  const groups = groupFiles(entries);
  const matchingPrevious = previous && !isRetired(previous)
    && snapshotKey(sourceOf(previous.info)?.files ?? []) === snapshotKey(entries.map(snapshotFor)) ? previous : undefined;
  const cachedOrder = matchingPrevious && hasReusableMetadata(matchingPrevious.info)
    ? entriesInSourceOrder(matchingPrevious, entries) : undefined;
  const reuseCached = !!matchingPrevious && !!cachedOrder && await sameEntriesInSourceOrder(matchingPrevious, cachedOrder, shouldCancel);
  if (reuseCached && matchingPrevious && cachedOrder) {
    prepared.push({ info: { ...matchingPrevious.info, availability: 'ready', error: undefined } as LocalModelInfo,
      handles: cachedOrder.map(entry => entry.handle) });
  } else {
    for (const group of groups) {
      let headerStarted: number | undefined;
      try {
        if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
        progress.stage = 'reading-header'; progress.currentFile = group.entries.map(entry => entry.path).join(', ');
        publish(onProgress, progress);
        headerStarted = now();
        const ordered = await inspectAndOrderFiles(group.entries.map(entry => entry.file));
        const orderedHandles = ordered.files.map(file => handleByFile.get(file)!);
        const groupSnapshots = ordered.files.map(file => ({ path: file.name, size: file.size, lastModified: file.lastModified }));
        const preservesIdentity = matchingPrevious && snapshotKey(sourceOf(matchingPrevious.info)?.files ?? []) === snapshotKey(groupSnapshots);
        const info: LocalModelInfo = sourceInfo({ ...ordered.info,
          ...(preservesIdentity ? { id: matchingPrevious.info.id, importedAt: matchingPrevious.info.importedAt,
            ...(matchingPrevious.info.fingerprint ? { fingerprint: matchingPrevious.info.fingerprint } : {}) } : {}) }, ordered.files);
        prepared.push({ info, handles: orderedHandles });
      } catch (error) {
        if (shouldCancel() || error instanceof Error && error.message === 'LOCAL_SCAN_CANCELLED') throw new Error('LOCAL_SCAN_CANCELLED');
        issues.push({ path: group.entries.map(entry => entry.path).join(', '), error: error instanceof Error && /^LOCAL_[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_DIRECTORY_MODEL_INVALID' });
      } finally {
        if (headerStarted !== undefined) progress.timings!.headerMs += now() - headerStarted;
        progress.currentFile = undefined; progress.stage = 'enumerating';
      }
      publish(onProgress, progress);
    }
  }

  if (!prepared.length && !issues.length) throw new Error('LOCAL_SELECT_SINGLE_COMPLETE_GGUF');
  const models: LocalModelInfo[] = [];
  progress.stage = 'persisting'; progress.currentFile = undefined;
  publish(onProgress, progress);
  for (const model of prepared) {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    await checkReadPermission(model.handles);
    const registrationStarted = now();
    let saved: LocalModelInfo;
    try { saved = await saveFileReference(model.info, model.handles, expectedId, shouldCancel); }
    finally { progress.timings!.registrationMs += now() - registrationStarted; }
    models.push(saved);
    progress.modelsFound = models.length;
    publish(onProgress, progress);
  }
  return { models, issues };
}

/** Manual refresh only; checking a model list never enumerates or reparses source files. */
export async function refreshFileReferences(shouldCancel = () => false, onProgress?: Progress): Promise<DirectoryIssue[]> {
  const issues: DirectoryIssue[] = [];
  const startedAt = Date.now();
  const models = await listFileReferences();
  const completedTimings = timings();
  let completedFiles = 0, completedModels = 0;
  for (const model of models) {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    const modelTimings = timings();
    let checkedFiles = 0;
    try {
      const result = await registerModelFiles(model.fileHandles ?? [], model.info.id, shouldCancel, status => {
        Object.assign(modelTimings, status.timings ?? {});
        checkedFiles = Math.max(checkedFiles, status.checkedFiles);
        status.startedAt = startedAt;
        status.elapsedMs = Date.now() - startedAt;
        status.checkedFiles += completedFiles;
        status.modelsFound += completedModels;
        status.timings = {
          enumerationMs: completedTimings.enumerationMs + modelTimings.enumerationMs,
          fileAccessMs: completedTimings.fileAccessMs + modelTimings.fileAccessMs,
          headerMs: completedTimings.headerMs + modelTimings.headerMs,
          registrationMs: completedTimings.registrationMs + modelTimings.registrationMs,
        };
        publish(onProgress, status);
      }, model);
      issues.push(...result.issues);
      if (!result.models.length) throw new Error(result.issues[0]?.error ?? 'LOCAL_DIRECTORY_MODEL_INVALID');
    } catch (error) {
      if (shouldCancel() || error instanceof Error && error.message === 'LOCAL_SCAN_CANCELLED') throw new Error('LOCAL_SCAN_CANCELLED');
      await markFileReferenceError(model.info.id, error).catch(() => {});
      if (!issues.some(issue => issue.path === model.info.name)) issues.push({ path: model.info.name, error: error instanceof Error ? error.message : 'LOCAL_DIRECTORY_SCAN_FAILED' });
    } finally {
      completedTimings.enumerationMs += modelTimings.enumerationMs;
      completedTimings.fileAccessMs += modelTimings.fileAccessMs;
      completedTimings.headerMs += modelTimings.headerMs;
      completedTimings.registrationMs += modelTimings.registrationMs;
      completedFiles += Math.max(checkedFiles, model.fileHandles?.length ?? 0);
      completedModels++;
    }
  }
  return issues;
}
