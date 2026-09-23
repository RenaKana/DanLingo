import type { LocalModelInfo } from './types.ts';
import { fingerprintFiles, inspectAndOrderFiles } from './gguf.ts';
import type { FingerprintProgress } from './gguf.ts';
import type { DirectoryFileSnapshot, DirectoryInfo, DirectoryIssue, DirectoryScanStatus, DirectorySource, FileSource, ReadOnlyFileHandle, ReadOnlyDirectoryHandle, StoredDirectory } from './directory-types.ts';

const DATABASE_NAME = 'danlingo-local-models-v1';
const DATABASE_VERSION = 2;
const MODEL_STORE = 'models';
const DIRECTORY_STORE = 'directories';

type DirectoryModelInfo = LocalModelInfo & {
  source?: DirectorySource | FileSource;
  availability?: 'ready' | 'permission-required' | 'missing' | 'changed' | 'error';
  error?: string;
};

export interface StoredModel {
  info: LocalModelInfo;
  /** Private read-only handles; never included in runtime message replies. */
  fileHandles?: ReadOnlyFileHandle[];
  /** Materialized bytes are retained only for legacy/imported Blob records. */
  blobs?: File[];
  /** Private import-cancellation ownership token. */
  importOwner?: string;
}
export interface DeduplicatedSaveResult { info: LocalModelInfo; created: boolean }

const sourceOf = (info: LocalModelInfo | undefined): DirectorySource | undefined => {
  const source = info && (info as DirectoryModelInfo).source;
  return source?.kind === 'directory' && typeof source.directoryId === 'string' ? source : undefined;
};
const withAvailability = (info: LocalModelInfo, availability: DirectoryModelInfo['availability']): LocalModelInfo =>
  ({ ...info, availability } as LocalModelInfo);
const codeOf = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : '';
  return /^LOCAL_[A-Z0-9_]+$/.test(message) ? message : fallback;
};
const fileSystemErrorName = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
};
const sourceAccessCode = (error: unknown, fallback = 'LOCAL_DIRECTORY_SCAN_FAILED'): string => {
  const local = codeOf(error, '');
  if (local) return local;
  switch (fileSystemErrorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError': return 'LOCAL_DIRECTORY_PERMISSION_REQUIRED';
    case 'NotFoundError': return 'LOCAL_SOURCE_MISSING';
    default: return fallback;
  }
};

interface ResolveModelFilesOptions {
  shouldCancel?: () => boolean;
  onProgress?: (progress: FingerprintProgress) => void;
}
function checkResolutionCancellation(options: ResolveModelFilesOptions): void {
  if (options.shouldCancel?.()) throw new Error('LOCAL_CANCELLED');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MODEL_STORE)) db.createObjectStore(MODEL_STORE, { keyPath: 'info.id' });
      if (!db.objectStoreNames.contains(DIRECTORY_STORE)) db.createObjectStore(DIRECTORY_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('LOCAL_STORAGE_UNAVAILABLE'));
  });
}

async function transaction<T>(storeNames: string | string[], mode: IDBTransactionMode, callback: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      let failure: Error | undefined;
      let request: IDBRequest<T>;
      const tx = db.transaction(typeof storeNames === 'string' ? [storeNames] : storeNames, mode);
      try { request = callback(tx); }
      catch (error) {
        failure = error instanceof Error ? error : new Error('LOCAL_STORAGE_QUOTA_OR_IO');
        try { tx.abort(); } catch { /* already finished */ }
        reject(failure);
        return;
      }
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

const modelStore = (tx: IDBTransaction) => tx.objectStore(MODEL_STORE);
const directoryStore = (tx: IDBTransaction) => tx.objectStore(DIRECTORY_STORE);
const readStoredModel = (id: string): Promise<StoredModel | undefined> => transaction(MODEL_STORE, 'readonly', tx => modelStore(tx).get(id));
const readStoredModels = (): Promise<StoredModel[]> => transaction(MODEL_STORE, 'readonly', tx => modelStore(tx).getAll());
const readStoredDirectories = (): Promise<StoredDirectory[]> => transaction(DIRECTORY_STORE, 'readonly', tx => directoryStore(tx).getAll());

export const saveModel = (model: StoredModel) => transaction(MODEL_STORE, 'readwrite', tx => modelStore(tx).put(model));

/** Remove registration only. Directory groups are excluded from later scans atomically. */
export async function deleteModel(id: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      const tx = db.transaction([MODEL_STORE, DIRECTORY_STORE], 'readwrite'), store = tx.objectStore(MODEL_STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const model = request.result as StoredModel | undefined;
        const source = sourceOf(model?.info);
        if (source) {
          const directories = tx.objectStore(DIRECTORY_STORE), directoryRequest = directories.get(source.directoryId);
          directoryRequest.onsuccess = () => {
            const directory = directoryRequest.result as StoredDirectory | undefined;
            if (directory) directories.put({ ...directory, revision: directory.revision + 1,
              excludedModels: [...(directory.excludedModels ?? []), source.files.map(file => file.path).sort()] });
          };
        }
        if (model) store.delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

interface ModelSnapshot { importedAt: number; bytes: number; files: string[]; blobSizes: number[] }
interface LegacyFingerprintCandidate { snapshot: ModelSnapshot }

function snapshotModel(model: StoredModel): ModelSnapshot {
  if (!Array.isArray(model.blobs)) throw new Error('LOCAL_MODEL_SOURCE_INVALID');
  return { importedAt: model.info.importedAt, bytes: model.info.bytes, files: [...model.info.files], blobSizes: model.blobs.map(blob => blob.size) };
}

function sameSnapshot(model: StoredModel, snapshot: ModelSnapshot): boolean {
  if (!Array.isArray(model.blobs)) return false;
  return model.info.importedAt === snapshot.importedAt && model.info.bytes === snapshot.bytes
    && model.info.files.length === snapshot.files.length && model.info.files.every((name, index) => name === snapshot.files[index])
    && model.blobs.length === snapshot.blobSizes.length && model.blobs.every((blob, index) => blob.size === snapshot.blobSizes[index]);
}

function possibleContentMatch(existing: StoredModel, incoming: StoredModel): boolean {
  if (!Array.isArray(existing.blobs) || !Array.isArray(incoming.blobs)) return false;
  return existing.info.bytes === incoming.info.bytes && existing.blobs.length === incoming.blobs.length
    && existing.blobs.every((blob, index) => blob.size === incoming.blobs![index]?.size);
}

/** Atomically reuse a content-identical legacy/Blob model or insert the new model. */
export async function saveModelDeduplicated(model: StoredModel, options: { isCancelled?: () => boolean; owner?: string } = {}): Promise<DeduplicatedSaveResult> {
  if (!Array.isArray(model.blobs)) throw new Error('LOCAL_MODEL_SOURCE_INVALID');
  const fingerprint = model.info.fingerprint;
  if (typeof fingerprint !== 'string' || !fingerprint) throw new Error('LOCAL_MODEL_FINGERPRINT_MISSING');
  if (options.isCancelled?.()) throw new Error('LOCAL_IMPORT_ABORTED');
  const existing = await readStoredModels();
  const legacyCandidates = new Map<string, LegacyFingerprintCandidate>();
  for (const candidate of existing) {
    if (options.isCancelled?.()) throw new Error('LOCAL_IMPORT_ABORTED');
    if (candidate.info.fingerprint || !possibleContentMatch(candidate, model)) continue;
    try {
      if (await fingerprintFiles(candidate.blobs!, { shouldCancel: options.isCancelled }) === fingerprint) legacyCandidates.set(candidate.info.id, { snapshot: snapshotModel(candidate) });
    } catch {
      // A corrupt/unreadable legacy candidate must not block importing a valid model.
      if (options.isCancelled?.()) throw new Error('LOCAL_IMPORT_ABORTED');
    }
  }
  if (options.isCancelled?.()) throw new Error('LOCAL_IMPORT_ABORTED');
  const db = await open();
  try {
    return await new Promise<DeduplicatedSaveResult>((resolve, reject) => {
      const tx = db.transaction(MODEL_STORE, 'readwrite'), store = tx.objectStore(MODEL_STORE);
      let result: DeduplicatedSaveResult | undefined;
      let failure: Error | undefined;
      const abort = (error: Error) => { failure = error; try { tx.abort(); } catch { /* transaction already finished */ } };
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          if (options.isCancelled?.()) { abort(new Error('LOCAL_IMPORT_ABORTED')); return; }
          const current = request.result as StoredModel[];
          const duplicate = current.find(entry => entry.info.fingerprint === fingerprint);
          if (duplicate) {
            if (duplicate.importOwner && duplicate.importOwner !== options.owner) store.put({ info: duplicate.info, blobs: duplicate.blobs });
            result = { info: duplicate.info, created: false }; return;
          }
          const collision = current.find(entry => entry.info.id === model.info.id);
          if (collision) { abort(new Error('LOCAL_MODEL_ID_COLLISION')); return; }
          for (const candidate of current) {
            const legacy = legacyCandidates.get(candidate.info.id);
            if (!legacy || !sameSnapshot(candidate, legacy.snapshot)) continue;
            const info = { ...candidate.info, fingerprint };
            store.put({ info, blobs: candidate.blobs });
            result = { info, created: false };
            return;
          }
          if (options.isCancelled?.()) { abort(new Error('LOCAL_IMPORT_ABORTED')); return; }
          const ownedModel = options.owner ? { ...model, importOwner: options.owner } : model;
          store.put(ownedModel); result = { info: model.info, created: true };
        } catch (error) { abort(error instanceof Error ? error : new Error('LOCAL_STORAGE_QUOTA_OR_IO')); }
      };
      tx.oncomplete = () => result ? resolve(result) : reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

/** Delete only a model still owned by this import attempt; never delete a reused or legacy model. */
export async function deleteModelIfOwned(id: string, fingerprint: string, owner: string): Promise<boolean> {
  if (!owner) return false;
  const db = await open();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(MODEL_STORE, 'readwrite'), store = tx.objectStore(MODEL_STORE);
      let deleted = false;
      const request = store.get(id);
      request.onsuccess = () => {
        const model = request.result as StoredModel | undefined;
        if (model?.info.id === id && !sourceOf(model.info) && model.info.fingerprint === fingerprint && model.importOwner === owner) { store.delete(id); deleted = true; }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = tx.onabort = () => reject(new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

async function hydrateModel(model: StoredModel): Promise<StoredModel | undefined> {
  if (model.info.source || model.info.metadataVersion === 1) return model;
  if (!Array.isArray(model.blobs)) return model;
  try {
    const inspected = await inspectAndOrderFiles(model.blobs);
    const info: LocalModelInfo = { ...model.info, ...inspected.info,
      id: model.info.id, name: model.info.name, files: model.info.files, bytes: model.info.bytes, importedAt: model.info.importedAt,
      metadataVersion: 1 };
    const db = await open();
    try {
      return await new Promise<StoredModel | undefined>((resolve, reject) => {
        const tx = db.transaction(MODEL_STORE, 'readwrite'), store = tx.objectStore(MODEL_STORE);
        const request = store.get(model.info.id); let result: StoredModel | undefined;
        request.onsuccess = () => {
          result = request.result;
          if (result && !sourceOf(result.info) && result.info.metadataVersion !== 1 && result.info.importedAt === model.info.importedAt) {
            result = { ...result, info, blobs: result.blobs }; store.put(result);
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
      });
    } finally { db.close(); }
  } catch {
    // Metadata repair must never discard a previously imported model or its blobs.
    return model;
  }
}

function publicDirectory(record: StoredDirectory): DirectoryInfo {
  const { handle: _handle, excludedModels: _excludedModels, ...info } = record;
  return { ...info, ...(info.issues ? { issues: info.issues.map(issue => ({ ...issue })) } : {}) };
}

function newDirectoryId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `directory-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function withDirectoryRegistrationLock<T>(callback: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator & { locks?: { request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> } } | undefined)?.locks;
  return locks?.request ? locks.request('danlingo-local-directory-register', { mode: 'exclusive' }, callback) : callback();
}

async function directoryRelationship(a: ReadOnlyDirectoryHandle, b: ReadOnlyDirectoryHandle): Promise<'same' | 'overlap' | 'disjoint'> {
  try { if (await a.isSameEntry(b)) return 'same'; }
  catch { /* resolve below may still establish the relationship */ }
  let attempted = false;
  for (const [parent, child] of [[a, b], [b, a]] as const) {
    if (typeof parent.resolve !== 'function') continue;
    attempted = true;
    try {
      if (await parent.resolve(child)) return 'overlap';
    } catch (error) {
      const code = sourceAccessCode(error, 'LOCAL_DIRECTORY_OVERLAP_CHECK_FAILED');
      if (code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' || code === 'LOCAL_SOURCE_MISSING') throw new Error(code);
      throw new Error('LOCAL_DIRECTORY_OVERLAP_CHECK_FAILED');
    }
  }
  if (!attempted) throw new Error('LOCAL_DIRECTORY_OVERLAP_CHECK_FAILED');
  return 'disjoint';
}

async function updateDirectory(id: string, change: Partial<DirectoryInfo>): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DIRECTORY_STORE, 'readwrite'), store = tx.objectStore(DIRECTORY_STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result as StoredDirectory | undefined;
        if (current) store.put({ ...current, ...change, revision: current.revision + 1 });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

export async function registerDirectory(handle: ReadOnlyDirectoryHandle): Promise<DirectoryInfo> {
  if (!handle || handle.kind !== 'directory' || typeof handle.queryPermission !== 'function' || typeof handle.requestPermission !== 'function') throw new Error('LOCAL_DIRECTORY_HANDLE_UNSUPPORTED');
  let permission: PermissionState;
  try { permission = await handle.queryPermission({ mode: 'read' }); }
  catch { throw new Error('LOCAL_DIRECTORY_PERMISSION_UNAVAILABLE'); }
  if (permission !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
  return withDirectoryRegistrationLock(async () => {
    const existing = await readStoredDirectories();
    for (const record of existing) {
      const relationship = await directoryRelationship(record.handle, handle);
      if (relationship === 'same') return publicDirectory(record);
      if (relationship === 'overlap') throw new Error('LOCAL_DIRECTORY_OVERLAP');
    }
    const info: DirectoryInfo = { id: newDirectoryId(), name: handle.name || '本地目录', addedAt: Date.now(), revision: 0, status: 'ready' };
    await transaction(DIRECTORY_STORE, 'readwrite', tx => directoryStore(tx).put({ ...info, handle } as StoredDirectory));
    return info;
  });
}

export async function listDirectories(): Promise<DirectoryInfo[]> {
  return (await readStoredDirectories()).map(publicDirectory);
}

/** Trusted settings UI only: this is the sole API that exposes a persisted handle. */
export async function readDirectory(id: string): Promise<StoredDirectory | undefined> {
  return transaction(DIRECTORY_STORE, 'readonly', tx => directoryStore(tx).get(id));
}

export async function removeDirectory(id: string): Promise<string[]> {
  const db = await open();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction([DIRECTORY_STORE, MODEL_STORE], 'readwrite');
      const dirs = tx.objectStore(DIRECTORY_STORE), models = tx.objectStore(MODEL_STORE);
      const directoryRequest = dirs.get(id), modelsRequest = models.getAll();
      let directory: StoredDirectory | undefined, all: StoredModel[] | undefined;
      let result: string[] | undefined;
      let failure: Error | undefined;
      const finish = () => {
        if (!directory || !all || result) return;
        const affected = all.filter(model => sourceOf(model.info)?.directoryId === id).map(model => model.info.id);
        for (const model of all) if (sourceOf(model.info)?.directoryId === id) models.delete(model.info.id);
        dirs.delete(id); result = affected;
      };
      directoryRequest.onsuccess = () => { directory = directoryRequest.result; if (!directory) failure = new Error('LOCAL_DIRECTORY_NOT_FOUND'); else finish(); };
      modelsRequest.onsuccess = () => { all = modelsRequest.result as StoredModel[]; finish(); };
      tx.oncomplete = () => result ? resolve(result) : reject(failure ?? new Error('LOCAL_DIRECTORY_NOT_FOUND'));
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

async function markModelAvailability(id: string, availability: DirectoryModelInfo['availability'], error?: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([MODEL_STORE, DIRECTORY_STORE], 'readwrite');
      const store = tx.objectStore(MODEL_STORE), directories = tx.objectStore(DIRECTORY_STORE);
      let failure: Error | undefined;
      const abort = (error: Error) => { failure = error; try { tx.abort(); } catch { /* transaction already finished */ } };
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result as StoredModel | undefined;
        if (!current || !current.info.source) { abort(new Error('LOCAL_SOURCE_MISSING')); return; }
        const source = sourceOf(current.info);
        const previousAvailability = (current.info as DirectoryModelInfo).availability;
        if (previousAvailability === 'changed' || previousAvailability === 'missing') {
          abort(new Error(previousAvailability === 'changed' ? 'LOCAL_SOURCE_CHANGED' : 'LOCAL_SOURCE_MISSING'));
          return;
        }
        const info = { ...current.info, availability, ...(error ? { error } : { error: undefined }) } as DirectoryModelInfo;
        store.put({ ...current, info });
        const retired = availability === 'changed' || availability === 'missing';
        if (retired && source) {
          const directoryRequest = directories.get(source.directoryId);
          directoryRequest.onsuccess = () => {
            const directory = directoryRequest.result as StoredDirectory | undefined;
            if (directory) directories.put({ ...directory, revision: directory.revision + 1 });
          };
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

async function reidentifyLegacyExternalModel(model: StoredModel, fingerprint: string, shouldCancel?: () => boolean): Promise<void> {
  if (shouldCancel?.()) throw new Error('LOCAL_CANCELLED');
  const source = model.info.source;
  if (!source) throw new Error('LOCAL_MODEL_SOURCE_INVALID');
  const id = crypto.randomUUID();
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const stores = source.kind === 'directory' ? [MODEL_STORE, DIRECTORY_STORE] : [MODEL_STORE];
      const tx = db.transaction(stores, 'readwrite'), models = tx.objectStore(MODEL_STORE);
      const directories = source.kind === 'directory' ? tx.objectStore(DIRECTORY_STORE) : undefined;
      let result = false;
      let failure: Error | undefined;
      const abort = (error: Error) => { failure = error; try { tx.abort(); } catch { /* transaction already finished */ } };
      const request = models.get(model.info.id);
      request.onsuccess = () => {
        if (shouldCancel?.()) { abort(new Error('LOCAL_CANCELLED')); return; }
        const current = request.result as StoredModel | undefined;
        if (!current || !current.info.source || current.info.fingerprint
          || JSON.stringify(current.info.source) !== JSON.stringify(source)) { abort(new Error('LOCAL_SOURCE_CHANGED')); return; }
        const info = { ...current.info, id, importedAt: Date.now(), fingerprint, availability: 'ready', error: undefined } as LocalModelInfo;
        const replace = () => {
          if (shouldCancel?.()) { abort(new Error('LOCAL_CANCELLED')); return; }
          models.delete(current.info.id); models.put({ ...current, info }); result = true;
        };
        if (source.kind !== 'directory') { replace(); return; }
        const directoryRequest = directories!.get(source.directoryId);
        directoryRequest.onsuccess = () => {
          if (shouldCancel?.()) { abort(new Error('LOCAL_CANCELLED')); return; }
          const directory = directoryRequest.result as StoredDirectory | undefined;
          if (!directory) { abort(new Error('LOCAL_SOURCE_MISSING')); return; }
          directories!.put({ ...directory, revision: directory.revision + 1 });
          replace();
        };
      };
      tx.oncomplete = () => result ? resolve() : reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}

function pathParts(path: string): string[] {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) throw new Error('LOCAL_DIRECTORY_PATH_INVALID');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('LOCAL_DIRECTORY_PATH_INVALID');
  return parts;
}

async function fileAtPath(handle: ReadOnlyDirectoryHandle, path: string): Promise<File> {
  const parts = pathParts(path);
  let directory: FileSystemDirectoryHandle = handle;
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: false });
    const fileHandle = await directory.getFileHandle(parts.at(-1)!, { create: false });
    return await fileHandle.getFile();
  } catch (error) {
    const code = sourceAccessCode(error, 'LOCAL_DIRECTORY_SCAN_FAILED');
    throw new Error(code);
  }
}

async function directoryPermission(record: StoredDirectory): Promise<void> {
  try {
    if (await record.handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
  } catch (error) {
    const code = sourceAccessCode(error, 'LOCAL_DIRECTORY_SCAN_FAILED');
    const status = code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required'
      : code === 'LOCAL_SOURCE_MISSING' ? 'missing' : 'error';
    await updateDirectory(record.id, { status, error: code });
    throw new Error(code);
  }
}

async function resolveDirectoryFiles(model: StoredModel, source: DirectorySource, options: ResolveModelFilesOptions): Promise<{ info: LocalModelInfo; files: File[] }> {
  checkResolutionCancellation(options);
  const directory = await readDirectory(source.directoryId);
  if (!directory) {
    await markModelAvailability(model.info.id, 'missing', 'LOCAL_SOURCE_MISSING');
    throw new Error('LOCAL_SOURCE_MISSING');
  }
  try { await directoryPermission(directory); }
  catch (error) {
    const code = sourceAccessCode(error);
    const availability = code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required'
      : code === 'LOCAL_SOURCE_MISSING' ? 'missing' : 'error';
    await markModelAvailability(model.info.id, availability, code);
    throw new Error(code);
  }
  const files: File[] = [];
  for (const snapshot of source.files) {
    checkResolutionCancellation(options);
    let file: File;
    try { file = await fileAtPath(directory.handle, snapshot.path); }
    catch (error) {
      const code = sourceAccessCode(error);
      const availability = code === 'LOCAL_SOURCE_MISSING' ? 'missing'
        : code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required' : 'error';
      await markModelAvailability(model.info.id, availability, code);
      throw new Error(code);
    }
    if (file.size !== snapshot.size || file.lastModified !== snapshot.lastModified) {
      await markModelAvailability(model.info.id, 'changed', 'LOCAL_SOURCE_CHANGED');
      throw new Error('LOCAL_SOURCE_CHANGED');
    }
    checkResolutionCancellation(options);
    files.push(file);
  }
  if (!files.length) {
    await markModelAvailability(model.info.id, 'error', 'LOCAL_DIRECTORY_SCAN_FAILED');
    throw new Error('LOCAL_DIRECTORY_SCAN_FAILED');
  }
  let fingerprint: string;
  try {
    fingerprint = await fingerprintFiles(files, {
      shouldCancel: options.shouldCancel, cancelCode: 'LOCAL_CANCELLED', onProgress: options.onProgress,
      checkSource: () => directoryPermission(directory),
    });
  }
  catch (error) {
    const code = sourceAccessCode(error, 'LOCAL_MODEL_FINGERPRINT_FAILED');
    if (code === 'LOCAL_CANCELLED') throw new Error(code);
    const availability = code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required'
      : code === 'LOCAL_SOURCE_MISSING' ? 'missing' : 'error';
    await markModelAvailability(model.info.id, availability, code).catch(() => {});
    throw new Error(code);
  }
  if (!model.info.fingerprint) {
    checkResolutionCancellation(options);
    await reidentifyLegacyExternalModel(model, fingerprint, options.shouldCancel);
    throw new Error('LOCAL_SOURCE_CHANGED');
  }
  if (model.info.fingerprint !== fingerprint) {
    await markModelAvailability(model.info.id, 'changed', 'LOCAL_SOURCE_CHANGED');
    throw new Error('LOCAL_SOURCE_CHANGED');
  }
  checkResolutionCancellation(options);
  await markModelAvailability(model.info.id, 'ready');
  return { info: withAvailability(model.info, 'ready'), files };
}

export async function resolveModelFiles(id: string, options: ResolveModelFilesOptions = {}): Promise<{ info: LocalModelInfo; files: File[] }> {
  checkResolutionCancellation(options);
  const model = await readStoredModel(id);
  checkResolutionCancellation(options);
  if (!model) throw new Error('LOCAL_MODEL_NOT_IMPORTED');
  if (model.info.source?.kind === 'files') return resolveFileHandles(model, model.info.source, options);
  const source = sourceOf(model.info);
  if (!source) {
    if (!Array.isArray(model.blobs)) throw new Error('LOCAL_MODEL_SOURCE_INVALID');
    return { info: model.info, files: model.blobs };
  }
  const availability = (model.info as DirectoryModelInfo).availability;
  if (availability === 'changed') throw new Error('LOCAL_SOURCE_CHANGED');
  if (availability === 'missing') throw new Error('LOCAL_SOURCE_MISSING');
  return resolveDirectoryFiles(model, source, options);
}

export async function validateModelSource(id: string): Promise<void> {
  await resolveModelFiles(id);
}

/** Trusted extension documents only. Handles never leave the extension's storage boundary. */
export async function readFileReference(id: string): Promise<StoredModel | undefined> {
  const model = await readStoredModel(id);
  return model?.info.source?.kind === 'files' ? model : undefined;
}

export async function listFileReferences(): Promise<StoredModel[]> {
  return (await readStoredModels()).filter(model => model.info.source?.kind === 'files');
}

export async function saveFileReference(info: LocalModelInfo, handles: ReadOnlyFileHandle[], expectedId?: string, shouldCancel = () => false): Promise<LocalModelInfo> {
  return withDirectoryRegistrationLock(async () => {
    if (shouldCancel()) throw new Error('LOCAL_SCAN_CANCELLED');
    const existing = await listFileReferences();
    let previous: StoredModel | undefined;
    for (const model of existing) {
      if (model.fileHandles?.length !== handles.length) continue;
      if ((await Promise.all(handles.map((handle, index) => handle.isSameEntry(model.fileHandles![index]!)))).every(Boolean)) {
        previous = model; break;
      }
    }
    // A background refresh must not resurrect a model the user removed during its file read.
    if (expectedId && previous?.info.id !== expectedId) throw new Error('LOCAL_MODEL_NOT_IMPORTED');
    let next = info;
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(MODEL_STORE, 'readwrite'), store = tx.objectStore(MODEL_STORE);
        let failure: string | undefined;
        const write = (current?: StoredModel) => {
          if (shouldCancel()) { failure = 'LOCAL_SCAN_CANCELLED'; tx.abort(); return; }
          if (expectedId && !current) { failure = 'LOCAL_MODEL_NOT_IMPORTED'; tx.abort(); return; }
          // Decide reuse from the transactional record, not a stale pre-read: source
          // retirement can run while handle comparisons or file parsing are pending.
          const unchanged = current && !['missing', 'changed'].includes(current.info.availability ?? '')
            && current.info.fingerprint === info.fingerprint
            && JSON.stringify(current.info.source?.files) === JSON.stringify(info.source?.files);
          next = unchanged && current ? { ...info, id: current.info.id, importedAt: current.info.importedAt } : info;
          if (current && current.info.id !== next.id) store.delete(current.info.id);
          store.put({ info: next, fileHandles: handles } satisfies StoredModel);
        };
        if (previous) {
          const request = store.get(previous.info.id);
          request.onsuccess = () => write(request.result);
        } else write();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error(failure ?? 'LOCAL_STORAGE_QUOTA_OR_IO'));
      });
    } finally { db.close(); }
    return next;
  });
}

async function resolveFileHandles(model: StoredModel, source: FileSource, options: ResolveModelFilesOptions): Promise<{ info: LocalModelInfo; files: File[] }> {
  if (model.info.availability === 'changed') throw new Error('LOCAL_SOURCE_CHANGED');
  if (model.info.availability === 'missing') throw new Error('LOCAL_SOURCE_MISSING');
  try {
    if (!model.fileHandles?.length || model.fileHandles.length !== source.files.length) throw new Error('LOCAL_MODEL_SOURCE_INVALID');
    const files: File[] = [];
    for (const [index, handle] of model.fileHandles.entries()) {
      checkResolutionCancellation(options);
      if (await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
      const file = await handle.getFile(), snapshot = source.files[index]!;
      if (file.size !== snapshot.size || file.lastModified !== snapshot.lastModified) throw new Error('LOCAL_SOURCE_CHANGED');
      checkResolutionCancellation(options);
      files.push(file);
    }
    const fingerprint = await fingerprintFiles(files, {
      shouldCancel: options.shouldCancel, cancelCode: 'LOCAL_CANCELLED', onProgress: options.onProgress,
      checkSource: async () => {
        for (const handle of model.fileHandles!) {
          try { if (await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED'); }
          catch (error) { throw new Error(sourceAccessCode(error)); }
        }
      },
    });
    checkResolutionCancellation(options);
    if (!model.info.fingerprint) {
      await reidentifyLegacyExternalModel(model, fingerprint, options.shouldCancel);
      throw new Error('LOCAL_SOURCE_CHANGED');
    }
    if (model.info.fingerprint !== fingerprint) throw new Error('LOCAL_SOURCE_CHANGED');
    await markModelAvailability(model.info.id, 'ready');
    return { info: withAvailability(model.info, 'ready'), files };
  } catch (error) {
    const code = sourceAccessCode(error);
    if (code === 'LOCAL_CANCELLED') throw new Error(code);
    await markModelAvailability(model.info.id, code === 'LOCAL_SOURCE_CHANGED' ? 'changed' : code === 'LOCAL_SOURCE_MISSING' ? 'missing'
      : code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' ? 'permission-required' : 'error', code).catch(() => {});
    throw new Error(code);
  }
}

export async function markFileReferenceError(id: string, error: unknown): Promise<void> {
  const code = sourceAccessCode(error);
  await markModelAvailability(id, code === 'LOCAL_SOURCE_MISSING' ? 'missing' : code === 'LOCAL_DIRECTORY_PERMISSION_REQUIRED'
    ? 'permission-required' : 'error', code);
}

export async function readModel(id: string): Promise<StoredModel | undefined> {
  const model = await readStoredModel(id);
  if (!model) return undefined;
  if (model.info.source) {
    const resolved = await resolveModelFiles(id);
    return { ...model, info: resolved.info, blobs: resolved.files };
  }
  return hydrateModel(model);
}

export async function listModels(): Promise<LocalModelInfo[]> {
  // Cursor values stay inside the worker/offscreen, model bytes are never serialized over runtime messaging.
  const models = await readStoredModels();
  const directories = new Map((await readStoredDirectories()).map(directory => [directory.id, directory]));
  const hydrated = [] as StoredModel[];
  for (const model of models) {
    const next = sourceOf(model.info) ? model : await hydrateModel(model);
    if (next) hydrated.push(next);
  }
  return hydrated.map(model => {
    const source = sourceOf(model.info);
    if (!source) return model.info;
    const info = model.info as DirectoryModelInfo;
    if (info.availability === 'changed' || info.availability === 'missing') return model.info;
    const directory = directories.get(source.directoryId);
    if (!directory) return { ...model.info, availability: 'missing', error: 'LOCAL_SOURCE_MISSING' } as LocalModelInfo;
    if (directory.status === 'ready') return model.info;
    const availability = directory.status === 'permission-required' ? 'permission-required'
      : directory.status === 'missing' ? 'missing' : 'error';
    return { ...model.info, availability, error: directory.error } as LocalModelInfo;
  });
}

export interface DirectoryScanContext {
  directory: StoredDirectory;
  models: StoredModel[];
}

/** Read-only snapshot for a scanner; commitDirectoryScan performs the revision CAS. */
export async function readDirectoryScanContext(id: string): Promise<DirectoryScanContext> {
  const directory = await readDirectory(id);
  if (!directory) throw new Error('LOCAL_DIRECTORY_NOT_FOUND');
  return { directory, models: (await readStoredModels()).filter(model => sourceOf(model.info)?.directoryId === id) };
}

export async function setDirectoryStatus(id: string, change: Partial<DirectoryInfo>): Promise<void> {
  await updateDirectory(id, change);
}

export async function commitDirectoryScan(
  directoryId: string,
  expectedRevision: number,
  models: StoredModel[],
  status: Pick<DirectoryScanStatus, 'phase'> & { lastScannedAt?: number; issues?: DirectoryIssue[]; error?: string },
  options: { shouldCancel?: () => boolean } = {},
): Promise<string[]> {
  const db = await open();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction([DIRECTORY_STORE, MODEL_STORE], 'readwrite');
      const dirs = tx.objectStore(DIRECTORY_STORE), modelStoreRef = tx.objectStore(MODEL_STORE);
      const dirRequest = dirs.get(directoryId), modelsRequest = modelStoreRef.getAll();
      let directory: StoredDirectory | undefined, all: StoredModel[] | undefined;
      let result: string[] | undefined;
      let failure: Error | undefined;
      const abort = (error: Error) => { failure = error; try { tx.abort(); } catch { /* already finished */ } };
      const finish = () => {
        if (!directory || !all || result) return;
        if (options.shouldCancel?.()) { abort(new Error('LOCAL_SCAN_CANCELLED')); return; }
        if (directory.revision !== expectedRevision) { abort(new Error('LOCAL_DIRECTORY_SCAN_CONFLICT')); return; }
        const existing = all.filter(model => sourceOf(model.info)?.directoryId === directoryId);
        const nextIds = new Set(models.map(model => model.info.id));
        result = existing.filter(model => !nextIds.has(model.info.id)).map(model => model.info.id);
        for (const model of existing) if (!nextIds.has(model.info.id)) modelStoreRef.delete(model.info.id);
        for (const model of models) {
          const source = sourceOf(model.info);
          modelStoreRef.put(source ? { info: withAvailability(model.info, 'ready') } : model);
        }
        const next: StoredDirectory = { ...directory, revision: expectedRevision + 1,
          status: status.phase === 'complete' ? 'ready' : 'error',
          ...(status.lastScannedAt === undefined ? {} : { lastScannedAt: status.lastScannedAt }),
          ...(status.issues?.length ? { issues: status.issues } : { issues: undefined }),
          ...(status.error ? { error: status.error } : { error: undefined }) };
        dirs.put(next);
      };
      dirRequest.onsuccess = () => { directory = dirRequest.result; if (!directory) abort(new Error('LOCAL_DIRECTORY_NOT_FOUND')); else finish(); };
      modelsRequest.onsuccess = () => { all = modelsRequest.result as StoredModel[]; finish(); };
      tx.oncomplete = () => result ? resolve(result) : reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('LOCAL_STORAGE_QUOTA_OR_IO'));
    });
  } finally { db.close(); }
}
