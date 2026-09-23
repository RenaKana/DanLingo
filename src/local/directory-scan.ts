import { fingerprintFiles, inspectAndOrderFiles } from './gguf.ts';
import type { OrderedGgufFiles } from './gguf.ts';
import type { LocalModelInfo } from './types.ts';
import type { DirectoryFileSnapshot, DirectoryIssue, DirectoryScanResult, DirectoryScanStatus, DirectorySource, ReadOnlyDirectoryHandle } from './directory-types.ts';
import { commitDirectoryScan, readDirectoryScanContext, setDirectoryStatus, type StoredModel } from './storage.ts';

const SHARD_NAME = /(?:^|[-_.])(\d{5})-of-(\d{5})\.gguf$/i;

export interface DirectoryScanOptions {
  shouldCancel?: () => boolean;
  onProgress?: (status: DirectoryScanStatus) => void;
}

interface DiscoveredFile {
  path: string;
  file: File;
}

interface Group {
  key: string;
  entries: DiscoveredFile[];
}

function codeOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /^LOCAL_[A-Z0-9_]+$/.test(message) ? message : fallback;
}

function fileSystemErrorName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function sourceAccessCode(error: unknown, fallback = 'LOCAL_DIRECTORY_SCAN_FAILED'): string {
  const local = codeOf(error, '');
  if (local) return local;
  switch (fileSystemErrorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError': return 'LOCAL_DIRECTORY_PERMISSION_REQUIRED';
    case 'NotFoundError': return 'LOCAL_SOURCE_MISSING';
    default: return fallback;
  }
}

function sourceOf(info: LocalModelInfo): DirectorySource | undefined {
  const source = (info as LocalModelInfo & { source?: DirectorySource }).source;
  return source?.kind === 'directory' ? source : undefined;
}

function sourceKey(source: DirectorySource): string {
  return snapshotKey(source.files);
}

function snapshotKey(files: DirectoryFileSnapshot[]): string {
  return files.map(file => `${file.path}\u0000${file.size}\u0000${file.lastModified}`).sort().join('\u0001');
}

function shardGroupKey(path: string): string {
  const slash = path.lastIndexOf('/');
  const parent = slash < 0 ? '' : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const match = name.match(SHARD_NAME);
  if (!match || match.index === undefined) return path;
  return `${parent}\u0000${name.slice(0, match.index)}`;
}

function snapshotFor(entry: DiscoveredFile): DirectoryFileSnapshot {
  return { path: entry.path, size: entry.file.size, lastModified: entry.file.lastModified };
}

function publish(options: DirectoryScanOptions, status: DirectoryScanStatus): void {
  try { options.onProgress?.({ ...status, issues: status.issues.map(issue => ({ ...issue })) }); } catch { /* progress observers cannot affect storage */ }
}

function cancelled(options: DirectoryScanOptions): boolean {
  return options.shouldCancel?.() === true;
}

async function checkDirectoryRead(handle: ReadOnlyDirectoryHandle): Promise<void> {
  try {
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
  } catch (error) {
    throw new Error(sourceAccessCode(error));
  }
}

async function walkDirectory(
  handle: FileSystemDirectoryHandle,
  prefix: string,
  options: DirectoryScanOptions,
  status: DirectoryScanStatus,
  files: DiscoveredFile[],
): Promise<void> {
  if (cancelled(options)) throw new Error('LOCAL_SCAN_CANCELLED');
  const directoryWithEntries = handle as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterable<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
  };
  const entries = typeof directoryWithEntries.entries === 'function' ? directoryWithEntries.entries() : undefined;
  if (!entries) throw new Error('LOCAL_DIRECTORY_SCAN_FAILED');
  try {
    for await (const value of entries as AsyncIterable<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>) {
      if (cancelled(options)) throw new Error('LOCAL_SCAN_CANCELLED');
      const [name, entry] = value;
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        await walkDirectory(entry, path, options, status, files);
        continue;
      }
      status.checkedFiles++;
      if (entry.kind !== 'file' || !name.toLowerCase().endsWith('.gguf')) {
        publish(options, status);
        continue;
      }
      try { files.push({ path, file: await entry.getFile() }); }
      catch (error) {
        const code = sourceAccessCode(error);
        status.issues.push({ path, error: code });
        publish(options, status);
        if (code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED') throw new Error(code);
        throw new Error('LOCAL_DIRECTORY_SCAN_FAILED');
      }
      publish(options, status);
    }
  } catch (error) {
    const code = sourceAccessCode(error);
    if (code === 'LOCAL_SCAN_CANCELLED' || code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' || code === 'LOCAL_DIRECTORY_SCAN_FAILED') throw new Error(code);
    if (code === 'LOCAL_SOURCE_MISSING') {
      status.issues.push({ path: prefix || '<root>', error: code });
      publish(options, status);
      throw new Error('LOCAL_DIRECTORY_SCAN_FAILED');
    }
    throw new Error('LOCAL_DIRECTORY_SCAN_FAILED');
  }
}

export function groupFiles(files: DiscoveredFile[]): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of files) {
    const key = shardGroupKey(entry.path);
    const group = groups.get(key) ?? { key, entries: [] };
    group.entries.push(entry); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function candidateFromGroup(group: Group, ordered: OrderedGgufFiles, fingerprint: string, directoryId: string, directoryName: string): StoredModel {
  const byFile = new Map(group.entries.map(entry => [entry.file, entry]));
  const source: DirectorySource = { kind: 'directory', directoryId, directoryName,
    files: ordered.files.map(file => snapshotFor(byFile.get(file)!)) };
  const info = { ...ordered.info, fingerprint, source, availability: 'ready' } as LocalModelInfo;
  return { info };
}

function reusableModelForGroup(group: Group, fingerprint: string, previous: StoredModel[], used: Set<string>): StoredModel | undefined {
  const key = snapshotKey(group.entries.map(snapshotFor));
  for (const model of previous) {
    const source = sourceOf(model.info);
    const availability = (model.info as LocalModelInfo & { availability?: string }).availability;
    if (!source || sourceKey(source) !== key || model.info.fingerprint !== fingerprint || used.has(model.info.id)
      || availability === 'changed' || availability === 'missing') continue;
    used.add(model.info.id);
    return model;
  }
  return undefined;
}

function terminalStatus(
  phase: DirectoryScanStatus['phase'], directoryId: string, startedAt: number, status: DirectoryScanStatus,
  error?: string,
): DirectoryScanResult {
  return { invalidatedIds: [], status: { ...status, phase, directoryId, elapsedMs: Date.now() - startedAt, ...(error ? { error } : {}) } };
}

export async function scanDirectory(id: string, options: DirectoryScanOptions = {}): Promise<DirectoryScanResult> {
  const startedAt = Date.now();
  const progressOptions: DirectoryScanOptions = options.onProgress ? {
    ...options,
    onProgress: next => options.onProgress?.({ ...next, elapsedMs: Date.now() - startedAt }),
  } : options;
  const status: DirectoryScanStatus = { phase: 'scanning', stage: 'enumerating', directoryId: id,
    checkedFiles: 0, modelsFound: 0, elapsedMs: 0, fingerprintedBytes: 0, totalFingerprintBytes: 0, issues: [] };
  publish(progressOptions, status);
  let context;
  try {
    context = await readDirectoryScanContext(id);
    if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
    let permission: PermissionState;
    try { permission = await context.directory.handle.queryPermission({ mode: 'read' }); }
    catch (error) {
      const code = sourceAccessCode(error);
      const directoryStatus = code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required'
        : code === 'LOCAL_SOURCE_MISSING' ? 'missing' : 'error';
      await setDirectoryStatus(id, { status: directoryStatus, error: code });
      return terminalStatus('error', id, startedAt, status, code);
    }
    if (permission !== 'granted') {
      await setDirectoryStatus(id, { status: 'permission-required', error: 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' });
      return terminalStatus('error', id, startedAt, status, 'LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    }
    const discovered: DiscoveredFile[] = [];
    await walkDirectory(context.directory.handle, '', progressOptions, status, discovered);
    if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
    const candidates: StoredModel[] = [];
    const prepared: Array<{ group: Group; ordered: OrderedGgufFiles }> = [];
    let totalFingerprintBytes = 0;
    for (const group of groupFiles(discovered)) {
      if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
      const paths = group.entries.map(entry => entry.path);
      if (context.directory.excludedModels?.some(excluded => excluded.some(path => paths.includes(path)))) continue;
      try {
        const ordered = await inspectAndOrderFiles(group.entries.map(entry => entry.file));
        const bytes = ordered.files.reduce((sum, file) => sum + file.size, totalFingerprintBytes);
        if (!Number.isSafeInteger(bytes)) throw new Error('LOCAL_FILE_SIZE_INVALID');
        totalFingerprintBytes = bytes;
        prepared.push({ group, ordered });
      } catch (error) {
        if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
        status.issues.push({ path: paths.join(', '), error: codeOf(error, 'LOCAL_DIRECTORY_MODEL_INVALID') });
      }
      publish(progressOptions, status);
    }
    status.totalFingerprintBytes = totalFingerprintBytes;
    status.stage = 'fingerprinting';
    publish(progressOptions, status);
    const reused = new Set<string>();
    let fingerprintedBytes = 0;
    for (const { group, ordered } of prepared) {
      if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
      const fingerprint = await fingerprintFiles(ordered.files, {
        shouldCancel: () => cancelled(options), cancelCode: 'LOCAL_SCAN_CANCELLED',
        checkSource: () => checkDirectoryRead(context!.directory.handle),
        onProgress: progress => {
          status.fingerprintedBytes = fingerprintedBytes + progress.bytesProcessed;
          publish(progressOptions, status);
        },
      });
      if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
      const prior = reusableModelForGroup(group, fingerprint, context.models, reused);
      candidates.push(prior ?? candidateFromGroup(group, ordered, fingerprint, context.directory.id, context.directory.name));
      fingerprintedBytes += ordered.files.reduce((sum, file) => sum + file.size, 0);
      status.fingerprintedBytes = fingerprintedBytes;
      status.modelsFound = candidates.length;
      publish(progressOptions, status);
    }
    if (cancelled(options)) return terminalStatus('cancelled', id, startedAt, status);
    status.stage = 'persisting';
    publish(progressOptions, status);
    const invalidatedIds = await commitDirectoryScan(id, context.directory.revision, candidates, {
      phase: 'complete', lastScannedAt: Date.now(), issues: status.issues,
    }, { shouldCancel: () => cancelled(options) });
    status.phase = 'complete'; status.elapsedMs = Date.now() - startedAt;
    publish(progressOptions, status);
    return { invalidatedIds, status: { ...status, issues: status.issues.map(issue => ({ ...issue })) } };
  } catch (error) {
    const code = codeOf(error, 'LOCAL_DIRECTORY_SCAN_FAILED');
    if (code === 'LOCAL_SCAN_CANCELLED') return terminalStatus('cancelled', id, startedAt, status);
    if (code === 'LOCAL_DIRECTORY_SCAN_CONFLICT') return terminalStatus('error', id, startedAt, status, code);
    if (code === 'LOCAL_DIRECTORY_NOT_FOUND') return terminalStatus('error', id, startedAt, status, code);
    if (context) {
      const directoryStatus = code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required'
        : code === 'LOCAL_SOURCE_MISSING' ? 'missing' : 'error';
      await setDirectoryStatus(id, { status: directoryStatus, error: code }).catch(() => {});
    }
    return terminalStatus('error', id, startedAt, status, code);
  }
}
