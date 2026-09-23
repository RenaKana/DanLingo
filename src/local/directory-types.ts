/** Shared contracts for direct, read-only local model directory sources. */
export interface ReadOnlyDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}

export interface ReadOnlyFileHandle extends FileSystemFileHandle {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}

export interface FileSource {
  kind: 'files';
  directoryName: string;
  files: DirectoryFileSnapshot[];
}

export interface DirectoryInfo {
  id: string;
  name: string;
  addedAt: number;
  revision: number;
  status: 'ready' | 'permission-required' | 'missing' | 'error';
  lastScannedAt?: number;
  error?: string;
  issues?: DirectoryIssue[];
}

export interface DirectoryIssue {
  path: string;
  error: string;
}

export interface DirectoryFileSnapshot {
  path: string;
  size: number;
  lastModified: number;
}

export interface DirectorySource {
  kind: 'directory';
  directoryId: string;
  directoryName: string;
  files: DirectoryFileSnapshot[];
}

export interface DirectoryScanStatus {
  phase: 'idle' | 'scanning' | 'complete' | 'cancelled' | 'error';
  stage?: 'enumerating' | 'fingerprinting' | 'persisting';
  directoryId?: string;
  checkedFiles: number;
  modelsFound: number;
  elapsedMs: number;
  fingerprintedBytes?: number;
  totalFingerprintBytes?: number;
  issues: DirectoryIssue[];
  error?: string;
}

export interface DirectoryScanResult {
  invalidatedIds: string[];
  status: DirectoryScanStatus;
}

export interface StoredDirectory extends DirectoryInfo {
  handle: ReadOnlyDirectoryHandle;
  /** User-removed model groups, retained across manual refreshes. Never deletes files. */
  excludedModels?: string[][];
}
