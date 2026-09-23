import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import ts from 'typescript';
import { loadPlaywright, browserLaunchOptions, browserExecutablePath } from '../../scripts/browser-runtime.mjs';

async function browserChecks() {
  const storage = await import('/src/local/storage.ts');
  const { scanDirectory } = await import('/src/local/directory-scan.ts');
  const { registerModelFiles, refreshFileReferences } = await import('/src/local/file-registration.ts');
  const checks = [];
  const equal = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  };
  const check = async (name, run) => {
    try { await run(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: String(error?.stack ?? error) }); }
  };
  const rejectCode = async (promise, code) => {
    try { await promise; throw new Error(`expected ${code}`); }
    catch (error) { equal(error?.message, code, 'error code'); }
  };
  const concat = parts => {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  };
  const u32 = value => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; };
  const u64 = value => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); return bytes; };
  const string = value => { const bytes = new TextEncoder().encode(value); return concat([u64(bytes.byteLength), bytes]); };
  const gguf = (suffix = '', overrides = {}) => {
    const metadata = {
      'general.architecture': 'llama', 'general.file_type': 15,
      'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.tokens': ['hello'],
      'tokenizer.chat_template': '{{ messages }}',
      ...overrides,
    };
    const entries = Object.entries(metadata).filter(([, value]) => value !== undefined).flatMap(([key, value]) => [
      string(key), ...(typeof value === 'number'
        ? [u32(4), u32(value)]
        : Array.isArray(value) ? [u32(9), u32(8), u64(value.length), ...value.map(string)]
          : [u32(8), string(value)]),
    ]);
    return concat([u32(0x46554747), u32(3), u64(1), u64(Object.keys(metadata).length), ...entries, new TextEncoder().encode(suffix)]);
  };
  const writeFile = async (directory, name, contents) => {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  };
  const newRoot = async label => {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(`danlingo-directory-test-${label}-${crypto.randomUUID()}`, { create: true });
  };
  const rawModel = id => new Promise((resolvePromise, reject) => {
    const request = indexedDB.open('danlingo-local-models-v1');
    request.onerror = () => reject(request.error ?? new Error('raw model open failed'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('models', 'readonly');
      const get = tx.objectStore('models').get(id);
      get.onsuccess = () => resolvePromise(get.result);
      get.onerror = () => reject(get.error ?? new Error('raw model read failed'));
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error ?? new Error('raw model transaction failed'));
    };
  });
  const putRawModel = model => new Promise((resolvePromise, reject) => {
    const request = indexedDB.open('danlingo-local-models-v1');
    request.onerror = () => reject(request.error ?? new Error('raw model open failed'));
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put(model);
      tx.oncomplete = () => { db.close(); resolvePromise(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('raw model write failed')); };
    };
  });
  const seedLegacyModel = model => new Promise((resolvePromise, reject) => {
    const request = indexedDB.open('danlingo-local-models-v1', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('models')) request.result.createObjectStore('models', { keyPath: 'info.id' });
    };
    request.onerror = () => reject(request.error ?? new Error('legacy model open failed'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put(model);
      tx.oncomplete = () => { db.close(); resolvePromise(); };
      tx.onerror = () => { db.close(); reject(tx.error ?? new Error('legacy model seed failed')); };
    };
  });
  const makeDenied = () => ({
    kind: 'directory', name: 'denied',
    queryPermission: async () => 'prompt', requestPermission: async () => 'granted',
  });

  await check('registration requires already granted read permission and public listing hides handles', async () => {
    await rejectCode(storage.registerDirectory(makeDenied()), 'LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    const legacyFile = new File([gguf()], 'legacy.gguf');
    await seedLegacyModel({ info: { id: 'legacy-v1', name: 'legacy.gguf', files: ['legacy.gguf'], bytes: legacyFile.size, importedAt: 123,
      architecture: 'llama', quantization: 'Q4_K_M', tokenizer: 'llama', template: true }, blobs: [legacyFile] });
    const legacy = await storage.readModel('legacy-v1');
    equal(legacy.blobs[0].size, legacyFile.size, 'v1 upgrade preserves legacy Blob bytes');
    equal((await rawModel('legacy-v1')).blobs[0].size, legacyFile.size, 'v1 upgrade persists legacy Blob bytes');
    await storage.deleteModel('legacy-v1');
    const root = await newRoot('registration');
    await writeFile(root, 'valid.gguf', gguf());
    const first = await storage.registerDirectory(root);
    const duplicate = await storage.registerDirectory(root);
    equal(duplicate.id, first.id, 'same OPFS directory is not registered twice');
    const listed = await storage.listDirectories();
    const entry = listed.find(directory => directory.id === first.id);
    if (!entry) throw new Error('registered directory missing from listing');
    equal(Object.prototype.hasOwnProperty.call(entry, 'handle'), false, 'public listing does not expose handle');
    const persisted = await storage.readDirectory(first.id);
    equal(persisted.handle.kind, 'directory', 'real directory handle round-trips through IndexedDB');
    await storage.removeDirectory(first.id);

    const parent = await newRoot('overlap-parent');
    const child = await parent.getDirectoryHandle('child', { create: true });
    const childFirst = await storage.registerDirectory(child);
    await rejectCode(storage.registerDirectory(parent), 'LOCAL_DIRECTORY_OVERLAP');
    await storage.removeDirectory(childFirst.id);

    const parentFirst = await newRoot('overlap-child');
    const childSecond = await parentFirst.getDirectoryHandle('child', { create: true });
    const parentFirstInfo = await storage.registerDirectory(parentFirst);
    await rejectCode(storage.registerDirectory(childSecond), 'LOCAL_DIRECTORY_OVERLAP');
    await storage.removeDirectory(parentFirstInfo.id);
  });

  await check('recursive scan keeps local issues, reuses unchanged identity, and changes identity on file replacement', async () => {
    const root = await newRoot('scan');
    const nested = await root.getDirectoryHandle('nested', { create: true });
    await writeFile(nested, 'model.gguf', gguf('aaaa'));
    await writeFile(root, 'broken.gguf', new Uint8Array([1, 2, 3]));
    const modelHandle = await nested.getFileHandle('model.gguf');
    const fileHandlePrototype = Object.getPrototypeOf(modelHandle), originalGetFile = fileHandlePrototype.getFile;
    let sourceReads = 0;
    fileHandlePrototype.getFile = async function (...args) {
      const file = await originalGetFile.apply(this, args);
      if (this.name === 'model.gguf') { sourceReads++; return new File([file], file.name, { lastModified: 1_700_000_000_000 }); }
      return file;
    };
    const directory = await storage.registerDirectory(root);
    try {
      const first = await scanDirectory(directory.id);
      equal(first.status.phase, 'complete', 'scan completes with a local bad-file issue');
      equal(first.status.checkedFiles, 2, 'recursive scan checks both GGUF files');
      equal(first.status.modelsFound, 1, 'one valid model is indexed');
      equal(first.status.issues.length, 1, 'bad file is reported without aborting the scan');
      const firstModel = (await storage.listModels()).find(model => model.source?.directoryId === directory.id);
      if (!firstModel) throw new Error('directory model was not indexed');
      equal(firstModel.source.files[0].path, 'nested/model.gguf', 'source stores the relative recursive path');
      equal(firstModel.source.files[0].lastModified, 1_700_000_000_000, 'test source timestamp is fixed');
      const resolved = await storage.resolveModelFiles(firstModel.id);
      equal(resolved.files.length, 1, 'directory model resolves its current file');

      const second = await scanDirectory(directory.id);
      equal(second.status.phase, 'complete', 'unchanged directory rescans');
      const reused = (await storage.listModels()).find(model => model.source?.directoryId === directory.id);
      equal(reused.id, firstModel.id, 'unchanged content keeps model identity');

      sourceReads = 0;
      await storage.listModels();
      equal(sourceReads, 0, 'listing does not read model source files');

      await writeFile(nested, 'model.gguf', gguf('bbbb'));
      const changed = await scanDirectory(directory.id);
      equal(changed.status.phase, 'complete', 'same-size content change rescans');
      if (!changed.invalidatedIds.includes(firstModel.id)) throw new Error('old identity was not invalidated');
      const replacement = (await storage.listModels()).find(model => model.source?.directoryId === directory.id);
      if (!replacement) throw new Error('replacement model missing');
      if (replacement.id === firstModel.id) throw new Error('same-size content change reused the old identity');
      equal(replacement.source.files[0].size, firstModel.source.files[0].size, 'replacement has the same file size');
      equal(replacement.source.files[0].lastModified, firstModel.source.files[0].lastModified, 'replacement has the same timestamp');
    } finally {
      fileHandlePrototype.getFile = originalGetFile;
      await storage.removeDirectory(directory.id);
    }
  });

  await check('same-name paths stay separate, content is fingerprinted, and listings do not read source files', async () => {
    const root = await newRoot('independent');
    const left = await root.getDirectoryHandle('left', { create: true });
    const right = await root.getDirectoryHandle('right', { create: true });
    await writeFile(left, 'model.gguf', gguf());
    await writeFile(right, 'model.gguf', gguf());
    await writeFile(root, 'notes.txt', new TextEncoder().encode('not a model'));
    const directory = await storage.registerDirectory(root);
    const first = await scanDirectory(directory.id);
    equal(first.status.checkedFiles, 3, 'every file is counted, including non-GGUF files');
    equal(first.status.modelsFound, 2, 'same-name files in different paths are independent models');
    const firstModels = (await storage.listModels()).filter(model => model.source?.directoryId === directory.id);
    equal(firstModels.map(model => model.source.files[0].path).sort(), ['left/model.gguf', 'right/model.gguf'], 'both paths are retained');
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    let contentReads = 0;
    Blob.prototype.arrayBuffer = async function () { contentReads++; return originalArrayBuffer.call(this); };
    try {
      const second = await scanDirectory(directory.id);
      equal(second.status.phase, 'complete', 'unchanged scan completes');
      if (contentReads === 0) throw new Error('unchanged source content must still be fingerprinted');
      contentReads = 0;
      await storage.listModels();
      equal(contentReads, 0, 'model listing does not read source bytes');
    } finally { Blob.prototype.arrayBuffer = originalArrayBuffer; }
    const secondModels = (await storage.listModels()).filter(model => model.source?.directoryId === directory.id);
    equal(secondModels.map(model => model.id).sort(), firstModels.map(model => model.id).sort(), 'unchanged groups keep both IDs');
    await storage.removeDirectory(directory.id);
  });

  await check('complete shards are indexed while a malformed shard group remains a local issue', async () => {
    const root = await newRoot('shards');
    const split = { 'split.count': 2, 'split.tensors.count': 2 };
    await writeFile(root, 'complete-00001-of-00002.gguf', gguf('', { ...split, 'split.no': 0 }));
    await writeFile(root, 'complete-00002-of-00002.gguf', gguf('', { ...split, 'split.no': 1 }));
    await writeFile(root, 'broken-00001-of-00002.gguf', gguf('', { ...split, 'split.no': 0 }));
    await writeFile(root, 'broken-00002-of-00002.gguf', new Uint8Array([1, 2, 3]));
    const directory = await storage.registerDirectory(root);
    const result = await scanDirectory(directory.id);
    equal(result.status.phase, 'complete', 'a bad shard group does not abort unrelated valid groups');
    equal(result.status.modelsFound, 1, 'complete shard group is indexed');
    equal(result.status.issues.length, 1, 'malformed shard group is reported');
    equal((await storage.listModels()).filter(model => model.source?.directoryId === directory.id)[0].source.files.length, 2, 'complete model keeps both shards');
    await storage.removeDirectory(directory.id);
  });

  await check('changed and missing source IDs are permanently retired, and directory status overlays listModels', async () => {
    const changedRoot = await newRoot('retired-changed');
    await writeFile(changedRoot, 'model.gguf', gguf());
    const changedDirectory = await storage.registerDirectory(changedRoot);
    await scanDirectory(changedDirectory.id);
    const changedModel = (await storage.listModels()).find(model => model.source?.directoryId === changedDirectory.id);
    if (!changedModel) throw new Error('changed source model missing');
    const raw = await rawModel(changedModel.id);
    equal(Object.prototype.hasOwnProperty.call(raw, 'blobs'), false, 'directory model stores no blobs');
    await writeFile(changedRoot, 'model.gguf', gguf('changed'));
    await rejectCode(storage.resolveModelFiles(changedModel.id), 'LOCAL_SOURCE_CHANGED');
    equal((await storage.listModels()).find(model => model.id === changedModel.id).availability, 'changed', 'changed source is retired');
    await writeFile(changedRoot, 'model.gguf', gguf());
    await rejectCode(storage.resolveModelFiles(changedModel.id), 'LOCAL_SOURCE_CHANGED');
    const replacementScan = await scanDirectory(changedDirectory.id);
    if (!replacementScan.invalidatedIds.includes(changedModel.id)) throw new Error('retired changed ID was not invalidated by rescan');
    const replacementModel = (await storage.listModels()).find(model => model.source?.directoryId === changedDirectory.id);
    if (!replacementModel || replacementModel.id === changedModel.id) throw new Error('retired changed ID was reused after source reverted');
    await storage.removeDirectory(changedDirectory.id);

    const missingRoot = await newRoot('retired-missing');
    await writeFile(missingRoot, 'model.gguf', gguf());
    const missingDirectory = await storage.registerDirectory(missingRoot);
    await scanDirectory(missingDirectory.id);
    const missingModel = (await storage.listModels()).find(model => model.source?.directoryId === missingDirectory.id);
    await missingRoot.removeEntry('model.gguf');
    await rejectCode(storage.resolveModelFiles(missingModel.id), 'LOCAL_SOURCE_MISSING');
    equal((await storage.listModels()).find(model => model.id === missingModel.id).availability, 'missing', 'missing source is retired');
    await writeFile(missingRoot, 'model.gguf', gguf());
    await rejectCode(storage.resolveModelFiles(missingModel.id), 'LOCAL_SOURCE_MISSING');
    await storage.setDirectoryStatus(missingDirectory.id, { status: 'permission-required', error: 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' });
    equal((await storage.listModels()).find(model => model.id === missingModel.id).availability, 'missing', 'retired missing state wins over directory permission overlay');
    await storage.removeDirectory(missingDirectory.id);

    const overlayRoot = await newRoot('directory-overlay');
    await writeFile(overlayRoot, 'model.gguf', gguf());
    const overlayDirectory = await storage.registerDirectory(overlayRoot);
    await scanDirectory(overlayDirectory.id);
    const overlayModel = (await storage.listModels()).find(model => model.source?.directoryId === overlayDirectory.id);
    await storage.setDirectoryStatus(overlayDirectory.id, { status: 'permission-required', error: 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' });
    equal((await storage.listModels()).find(model => model.id === overlayModel.id).availability, 'permission-required', 'directory permission loss overlays model availability');
    await storage.setDirectoryStatus(overlayDirectory.id, { status: 'missing', error: 'LOCAL_SOURCE_MISSING' });
    equal((await storage.listModels()).find(model => model.id === overlayModel.id).availability, 'missing', 'directory missing overlays model availability');
    await storage.setDirectoryStatus(overlayDirectory.id, { status: 'error', error: 'LOCAL_DIRECTORY_SCAN_FAILED' });
    equal((await storage.listModels()).find(model => model.id === overlayModel.id).availability, 'error', 'directory scan failure overlays model availability');
    await storage.removeDirectory(overlayDirectory.id);
  });

  await check('cancelled scan does not commit or delete the previous directory index', async () => {
    const root = await newRoot('cancel');
    await writeFile(root, 'first.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    const initial = await scanDirectory(directory.id);
    const before = (await storage.listModels()).filter(model => model.source?.directoryId === directory.id);
    equal(before.length, 1, 'initial index exists');
    await writeFile(root, 'second.gguf', gguf('second'));
    let calls = 0;
    const cancelled = await scanDirectory(directory.id, { shouldCancel: () => ++calls >= 4 });
    equal(cancelled.status.phase, 'cancelled', 'scan reports cancellation');
    equal(cancelled.invalidatedIds, [], 'cancelled scan invalidates nothing');
    const after = (await storage.listModels()).filter(model => model.source?.directoryId === directory.id);
    equal(after.map(model => model.id), before.map(model => model.id), 'cancelled scan leaves previous index intact');
    equal((await storage.readDirectory(directory.id)).revision, 1, 'cancelled scan does not advance revision');
    await storage.removeDirectory(directory.id);
  });

  await check('cancellation and permission loss during fingerprinting do not commit directory candidates', async () => {
    const root = await newRoot('fingerprint-cancel');
    await writeFile(root, 'model.gguf', gguf('aaaa'));
    const directory = await storage.registerDirectory(root);
    await scanDirectory(directory.id);
    const before = (await storage.listModels()).find(model => model.source?.directoryId === directory.id);
    const revision = (await storage.readDirectory(directory.id)).revision;
    await writeFile(root, 'model.gguf', gguf('bbbb'));
    let cancelled = false;
    const result = await scanDirectory(directory.id, { shouldCancel: () => cancelled,
      onProgress: status => { if (status.stage === 'fingerprinting' && status.fingerprintedBytes > 0) cancelled = true; } });
    equal(result.status.phase, 'cancelled', 'hash cancellation is reported');
    equal((await storage.readDirectory(directory.id)).revision, revision, 'cancelled hash does not advance revision');
    equal((await storage.listModels()).find(model => model.source?.directoryId === directory.id).id, before.id, 'cancelled hash keeps previous model identity');

    const proto = Object.getPrototypeOf(root), originalPermission = proto.queryPermission;
    let denied = false;
    proto.queryPermission = async function (...args) { return denied ? 'prompt' : originalPermission.apply(this, args); };
    try {
      denied = true;
      equal(await (await storage.readDirectory(directory.id)).handle.queryPermission({ mode: 'read' }), 'prompt', 'permission mock reaches stored directory handles');
      denied = false;
      const permission = await scanDirectory(directory.id, { onProgress: status => {
        if (status.stage === 'fingerprinting' && status.fingerprintedBytes > 0) denied = true;
      } });
      equal(permission.status.phase, 'error', 'mid-hash permission loss is reported');
      equal(permission.status.error, 'LOCAL_DIRECTORY_PERMISSION_REQUIRED', 'permission error is preserved');
      const afterPermission = await storage.readDirectory(directory.id);
      equal(afterPermission.revision, revision + 1, 'only the directory status update advances revision');
      equal(afterPermission.status, 'permission-required', 'directory permission state is recorded');
      equal((await rawModel(before.id)).info.fingerprint, before.fingerprint, 'permission loss keeps the prior stored model');
    } finally {
      proto.queryPermission = originalPermission;
      await storage.removeDirectory(directory.id);
    }
  });

  await check('revision CAS rejects a stale scan commit without applying its models', async () => {
    const root = await newRoot('cas');
    const directory = await storage.registerDirectory(root);
    const context = await storage.readDirectoryScanContext(directory.id);
    await storage.commitDirectoryScan(directory.id, context.directory.revision, [], { phase: 'complete' });
    await rejectCode(storage.commitDirectoryScan(directory.id, context.directory.revision, [], { phase: 'complete' }), 'LOCAL_DIRECTORY_SCAN_CONFLICT');
    equal((await storage.readDirectory(directory.id)).revision, 1, 'only the winning commit advances revision');
    await storage.removeDirectory(directory.id);
  });

  await check('cancellation at the commit boundary preserves the previous complete index', async () => {
    const root = await newRoot('commit-cancel');
    await writeFile(root, 'model.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    await scanDirectory(directory.id);
    const before = (await storage.listModels()).find(model => model.source?.directoryId === directory.id);
    const context = await storage.readDirectoryScanContext(directory.id);
    await rejectCode(storage.commitDirectoryScan(directory.id, context.directory.revision, [], { phase: 'complete' }, { shouldCancel: () => true }), 'LOCAL_SCAN_CANCELLED');
    equal((await storage.readDirectory(directory.id)).revision, context.directory.revision, 'cancelled commit keeps revision');
    equal((await storage.listModels()).find(model => model.id === before.id).id, before.id, 'cancelled commit keeps previous model');
    await storage.removeDirectory(directory.id);
  });

  await check('concurrent scans publish one winner and one scan conflict', async () => {
    const root = await newRoot('concurrent');
    await writeFile(root, 'model.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    const results = await Promise.all([scanDirectory(directory.id), scanDirectory(directory.id)]);
    equal(results.filter(result => result.status.phase === 'complete').length, 1, 'one concurrent scan commits');
    equal(results.filter(result => result.status.error === 'LOCAL_DIRECTORY_SCAN_CONFLICT').length, 1, 'stale concurrent scan reports conflict');
    equal((await storage.readDirectory(directory.id)).revision, 1, 'concurrent scans advance revision once');
    await storage.removeDirectory(directory.id);
  });

  await check('file removal during enumeration fails the scan without pruning the previous index', async () => {
    const root = await newRoot('mid-scan-removal');
    await writeFile(root, 'model.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    await scanDirectory(directory.id);
    const previous = (await storage.listModels()).find(model => model.source?.directoryId === directory.id);
    const fileHandle = await root.getFileHandle('model.gguf');
    const filePrototype = Object.getPrototypeOf(fileHandle);
    const originalGetFile = filePrototype.getFile;
    filePrototype.getFile = async function () {
      if (this.name === 'model.gguf') {
        await root.removeEntry('model.gguf').catch(() => {});
        throw new DOMException('file removed during scan', 'NotFoundError');
      }
      return originalGetFile.call(this);
    };
    try {
      const result = await scanDirectory(directory.id);
      equal(result.status.phase, 'error', 'mid-scan removal fails the scan');
      equal(result.status.error, 'LOCAL_DIRECTORY_SCAN_FAILED', 'mid-scan removal is classified as incomplete scan');
      equal(result.status.issues[0].path, 'model.gguf', 'failed file path is visible in scan issues');
      equal(result.status.issues[0].error, 'LOCAL_SOURCE_MISSING', 'failed file issue keeps source-missing detail');
      equal((await storage.listModels()).find(model => model.id === previous.id).availability, 'error', 'old model is retained but unavailable');
      equal((await storage.readDirectory(directory.id)).revision, 2, 'failed scan advances status revision without committing model changes');
    } finally { filePrototype.getFile = originalGetFile; }
    await storage.removeDirectory(directory.id);
  });

  await check('resolver cannot restore a model removed while its file is being read', async () => {
    const root = await newRoot('resolver-removal');
    await writeFile(root, 'model.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    await scanDirectory(directory.id);
    const model = (await storage.listModels()).find(entry => entry.source?.directoryId === directory.id);
    const context = await storage.readDirectoryScanContext(directory.id);
    const fileHandle = await root.getFileHandle('model.gguf');
    const filePrototype = Object.getPrototypeOf(fileHandle);
    const originalGetFile = filePrototype.getFile;
    let entered;
    const enteredPromise = new Promise(resolvePromise => { entered = resolvePromise; });
    let release;
    const gate = new Promise(resolvePromise => { release = resolvePromise; });
    filePrototype.getFile = async function () {
      if (this.name === 'model.gguf') { entered(); await gate; }
      return originalGetFile.call(this);
    };
    try {
      const resolving = storage.resolveModelFiles(model.id);
      await enteredPromise;
      await storage.removeDirectory(directory.id);
      release();
      await rejectCode(resolving, 'LOCAL_SOURCE_MISSING');
      await rejectCode(storage.commitDirectoryScan(directory.id, context.directory.revision, context.models, { phase: 'complete' }), 'LOCAL_DIRECTORY_NOT_FOUND');
      equal(await storage.readDirectory(directory.id), undefined, 'removed directory stays absent');
      if ((await storage.listModels()).some(entry => entry.id === model.id)) throw new Error('removed directory model was resurrected');
      equal(await storage.readModel(model.id), undefined, 'removed model is not resurrected by stale resolver');
    } finally { filePrototype.getFile = originalGetFile; release?.(); }
  });

  await check('source retirement races cannot be overwritten by a stale scan snapshot', async () => {
    const root = await newRoot('retirement-race');
    await writeFile(root, 'model.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    await scanDirectory(directory.id);
    const context = await storage.readDirectoryScanContext(directory.id);
    const model = context.models[0];
    await writeFile(root, 'model.gguf', gguf('changed'));
    await rejectCode(storage.resolveModelFiles(model.info.id), 'LOCAL_SOURCE_CHANGED');
    await rejectCode(storage.commitDirectoryScan(directory.id, context.directory.revision, context.models, { phase: 'complete' }), 'LOCAL_DIRECTORY_SCAN_CONFLICT');
    equal((await storage.listModels()).find(entry => entry.id === model.info.id).availability, 'changed', 'retired model remains changed after stale commit');
    await storage.removeDirectory(directory.id);
  });

  await check('removing a directory removes only its managed models and directory record', async () => {
    const root = await newRoot('remove');
    await writeFile(root, 'model.gguf', gguf());
    const directory = await storage.registerDirectory(root);
    await scanDirectory(directory.id);
    const model = (await storage.listModels()).find(entry => entry.source?.directoryId === directory.id);
    if (!model) throw new Error('managed model missing');
    const removed = await storage.removeDirectory(directory.id);
    equal(removed, [model.id], 'remove reports affected managed model IDs');
    equal(await storage.readDirectory(directory.id), undefined, 'directory record removed');
    if ((await storage.listModels()).some(entry => entry.id === model.id)) throw new Error('managed model survived directory removal');
  });

  await check('individual removal excludes only that model and prevents stale scans or manual refresh resurrecting it', async () => {
    const root = await newRoot('exclude');
    await writeFile(root, 'remove.gguf', gguf()); await writeFile(root, 'keep.gguf', gguf());
    const directory = await storage.registerDirectory(root); await scanDirectory(directory.id);
    const model = (await storage.listModels()).find(model => model.source?.directoryId === directory.id && model.name === 'remove.gguf');
    const before = await storage.readDirectoryScanContext(directory.id);
    await storage.deleteModel(model.id);
    await rejectCode(storage.commitDirectoryScan(directory.id, before.directory.revision, before.models, { phase: 'complete' }), 'LOCAL_DIRECTORY_SCAN_CONFLICT');
    await scanDirectory(directory.id);
    equal((await storage.listModels()).filter(model => model.source?.directoryId === directory.id).map(model => model.name), ['keep.gguf'], 'excluded model stays removed');
    equal((await (await root.getFileHandle('remove.gguf')).getFile()).size, gguf().length, 'original file still exists unchanged');
    equal('excludedModels' in (await storage.listDirectories()).find(row => row.id === directory.id), false, 'private exclusions not leaked');
    await storage.removeDirectory(directory.id);
  });

  await check('direct file selection stores handles without weights, reuses identities and isolates malformed models', async () => {
    const root = await newRoot('files');
    await writeFile(root, 'one.gguf', gguf()); await writeFile(root, 'two.gguf', gguf()); await writeFile(root, 'bad.gguf', new Uint8Array([1, 2, 3]));
    const handles = await Promise.all(['one.gguf', 'two.gguf', 'bad.gguf'].map(name => root.getFileHandle(name)));
    const result = await registerModelFiles(handles);
    equal(result.models.length, 2, 'two independent models registered'); equal(result.issues.length, 1, 'bad model reported separately');
    for (const model of result.models) {
      const raw = await rawModel(model.id);
      equal('blobs' in raw, false, 'no stored weight copy'); equal(raw.fileHandles[0].kind, 'file', 'persisted file handle');
      const publicModel = (await storage.listModels()).find(entry => entry.id === model.id);
      equal('fileHandles' in publicModel, false, 'handles absent from public list');
      equal((await storage.resolveModelFiles(model.id)).files[0].size, gguf().length, 'original file resolves');
    }
    const again = await registerModelFiles(handles.slice(0, 2));
    equal(again.models.map(model => model.id), result.models.map(model => model.id), 'reselection reuses unchanged identities');
    equal(await refreshFileReferences(), [], 'manual refresh accepts unchanged files');
    for (const model of result.models) await storage.deleteModel(model.id);
    equal((await (await root.getFileHandle('one.gguf')).getFile()).size, gguf().length, 'removal preserves original');
  });

  await check('direct selection requires complete shards and orders them before storing handles', async () => {
    const root = await newRoot('file-shards'), split = { 'split.count': 2, 'split.tensors.count': 2 };
    await writeFile(root, 'split-00001-of-00002.gguf', gguf('', { ...split, 'split.no': 0 }));
    await writeFile(root, 'split-00002-of-00002.gguf', gguf('', { ...split, 'split.no': 1 }));
    const first = await root.getFileHandle('split-00001-of-00002.gguf'), second = await root.getFileHandle('split-00002-of-00002.gguf');
    const incomplete = await registerModelFiles([first]); equal(incomplete.models.length, 0, 'incomplete set not registered'); equal(incomplete.issues.length, 1, 'incomplete set reported');
    const complete = await registerModelFiles([second, first]); equal(complete.models.length, 1, 'one full model');
    const model = complete.models[0], raw = await rawModel(model.id);
    equal(raw.fileHandles.map(handle => handle.name), [first.name, second.name], 'handles follow canonical shard order');
    equal((await storage.resolveModelFiles(model.id)).files.map(file => file.name), [first.name, second.name], 'load uses canonical shard order');
    await storage.deleteModel(model.id);
  });

  await check('changed direct file retires its cache identity and manual refresh registers a new snapshot', async () => {
    const root = await newRoot('file-change'); await writeFile(root, 'changing.gguf', gguf('aaaa'));
    const handle = await root.getFileHandle('changing.gguf'), proto = Object.getPrototypeOf(handle), original = proto.getFile;
    proto.getFile = async function (...args) {
      const file = await original.apply(this, args);
      return this.name === 'changing.gguf' ? new File([file], file.name, { lastModified: 1_700_000_000_000 }) : file;
    };
    try {
      const first = (await registerModelFiles([handle])).models[0];
      await writeFile(root, 'changing.gguf', gguf('bbbb'));
      await rejectCode(storage.resolveModelFiles(first.id), 'LOCAL_SOURCE_CHANGED');
      equal(await refreshFileReferences(), [], 'refresh succeeds');
      equal(await rawModel(first.id), undefined, 'old identity removed');
      const next = (await storage.listModels()).find(model => model.name === 'changing.gguf');
      if (!next || next.id === first.id) throw new Error('same-size content replacement must get a fresh ID');
      equal(next.source.files[0].size, first.source.files[0].size, 'replacement has the same file size');
      equal(next.source.files[0].lastModified, first.source.files[0].lastModified, 'replacement has the same timestamp');
      equal((await storage.resolveModelFiles(next.id)).files[0].size, gguf('bbbb').length, 'new snapshot loads');
      await storage.deleteModel(next.id);
    } finally { proto.getFile = original; }
  });

  await check('legacy external references are fingerprinted once and moved to a new identity', async () => {
    const root = await newRoot('file-legacy'); await writeFile(root, 'legacy.gguf', gguf());
    const handle = await root.getFileHandle('legacy.gguf'), legacy = (await registerModelFiles([handle])).models[0];
    const record = await rawModel(legacy.id); delete record.info.fingerprint;
    await putRawModel(record);
    await rejectCode(storage.resolveModelFiles(legacy.id), 'LOCAL_SOURCE_CHANGED');
    equal(await rawModel(legacy.id), undefined, 'legacy identity is retired');
    const migrated = (await storage.listModels()).find(model => model.name === 'legacy.gguf');
    if (!migrated || migrated.id === legacy.id || !migrated.fingerprint) throw new Error('legacy external source must get a fingerprinted identity');
    equal((await storage.resolveModelFiles(migrated.id)).files.length, 1, 'migrated source resolves');
    await storage.deleteModel(migrated.id);
  });

  await check('cancelling source verification preserves a legacy external identity', async () => {
    const root = await newRoot('file-legacy-cancel'); await writeFile(root, 'legacy.gguf', gguf());
    const handle = await root.getFileHandle('legacy.gguf'), legacy = (await registerModelFiles([handle])).models[0];
    const record = await rawModel(legacy.id); delete record.info.fingerprint; await putRawModel(record);
    let cancelled = false; const progress = [];
    await rejectCode(storage.resolveModelFiles(legacy.id, {
      shouldCancel: () => cancelled,
      onProgress: value => { progress.push(value); if (value.bytesProcessed > 0) cancelled = true; },
    }), 'LOCAL_CANCELLED');
    if (!progress.some(value => value.bytesProcessed > 0)) throw new Error('source verification did not report byte progress');
    const current = await rawModel(legacy.id);
    equal(current.info.id, legacy.id, 'cancel does not rotate the legacy identity');
    equal(current.info.fingerprint, undefined, 'cancel does not persist a fingerprint');
    equal((await storage.listModels()).filter(model => model.name === 'legacy.gguf').map(model => model.id), [legacy.id], 'cancel creates no replacement identity');
    await storage.deleteModel(legacy.id);
  });

  await check('direct file permission loss is recoverable without copying or changing identity', async () => {
    const root = await newRoot('file-permission'); await writeFile(root, 'permission.gguf', gguf());
    const handle = await root.getFileHandle('permission.gguf'), model = (await registerModelFiles([handle])).models[0];
    const proto = Object.getPrototypeOf(handle), original = proto.queryPermission;
    proto.queryPermission = async () => 'prompt';
    try { await rejectCode(storage.resolveModelFiles(model.id), 'LOCAL_DIRECTORY_PERMISSION_REQUIRED'); }
    finally { proto.queryPermission = original; }
    equal((await storage.listModels()).find(entry => entry.id === model.id).availability, 'permission-required', 'permission error visible');
    equal((await registerModelFiles([handle], model.id)).models[0].id, model.id, 'reauthorization keeps identity');
    equal((await storage.resolveModelFiles(model.id)).files.length, 1, 'read recovers');
    await storage.deleteModel(model.id);
  });

  await check('manual file refresh cannot resurrect a model removed while reading its handle', async () => {
    const root = await newRoot('file-delete-race'); await writeFile(root, 'race.gguf', gguf());
    const handle = await root.getFileHandle('race.gguf'), model = (await registerModelFiles([handle])).models[0];
    const proto = Object.getPrototypeOf(handle), original = proto.getFile;
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    proto.getFile = async function () { if (this.name === 'race.gguf') { entered(); await gate; } return original.call(this); };
    try {
      const refresh = refreshFileReferences(); await waiting; await storage.deleteModel(model.id); release(); await refresh;
      equal(await rawModel(model.id), undefined, 'deleted identity stays absent');
      equal((await storage.listModels()).some(entry => entry.name === 'race.gguf'), false, 'no replacement resurrected');
    } finally { proto.getFile = original; release?.(); }
  });

  await check('cancelling direct-file refresh before commit keeps the previous identity and source status', async () => {
    const root = await newRoot('file-cancel'); await writeFile(root, 'cancel.gguf', gguf());
    const handle = await root.getFileHandle('cancel.gguf'), model = (await registerModelFiles([handle])).models[0];
    await writeFile(root, 'cancel.gguf', gguf('changed but cancelled'));
    const proto = Object.getPrototypeOf(handle), original = proto.getFile;
    let entered, release, cancelled = false;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    proto.getFile = async function () { if (this.name === 'cancel.gguf') { entered(); await gate; } return original.call(this); };
    try {
      const refresh = refreshFileReferences(() => cancelled); await waiting; cancelled = true; release(); await rejectCode(refresh, 'LOCAL_SCAN_CANCELLED');
      equal((await rawModel(model.id)).info, model, 'cancel preserves prior snapshot and availability');
      equal((await storage.listModels()).filter(entry => entry.name === 'cancel.gguf').map(entry => entry.id), [model.id], 'no replacement committed');
    } finally { proto.getFile = original; release?.(); await storage.deleteModel(model.id); }
  });

  return checks;
}

test('local directory model storage and scanning in an isolated headless browser', { timeout: 60_000 }, async (t) => {
  let playwright, browserOptions, browserPath;
  try {
    playwright = await loadPlaywright();
    browserOptions = browserLaunchOptions('chromium');
    browserPath = browserExecutablePath('chromium', { playwrightBrowser: playwright.chromium });
  } catch (error) {
    t.skip(error.message);
    return;
  }
  const { chromium } = playwright;
  const profile = await mkdtemp(join(tmpdir(), 'danlingo-directory-test-'));
  const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = new Map(), requests = [], pageErrors = [];
  let receive, context;
  const received = new Promise(resolvePromise => { receive = resolvePromise; });
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    try {
      if (req.url === '/result' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        try { receive(JSON.parse(body)); } catch { receive({ error: 'invalid browser test report' }); }
        res.end('ok');
      } else if (req.method === 'GET' && /^\/src\/[a-zA-Z0-9_./-]+\.ts$/.test(req.url)) {
        const path = resolve(sourceRoot, req.url.slice('/src/'.length));
        if (!path.startsWith(resolve(sourceRoot) + sep)) { res.statusCode = 403; res.end(); return; }
        if (!files.has(req.url)) {
          const source = await readFile(path, 'utf8');
          files.set(req.url, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
        }
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(files.get(req.url));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>DanLingo directory tests</title><pre id="result">Running</pre><script type="module">
          try { const checks = await (${browserChecks.toString()})(); document.querySelector('#result').textContent = JSON.stringify(checks); await fetch('/result', {method:'POST', body:JSON.stringify(checks)}); }
          catch(error) { await fetch('/result', {method:'POST',body:JSON.stringify({error:String(error)})}); }
        </script>`);
      } else { res.statusCode = 404; res.end(); }
    } catch (error) { res.statusCode = error.code === 'ENOENT' ? 404 : 500; res.end('Test module unavailable'); }
  });
  t.after(async () => {
    try { await context?.close(); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolvePromise => server.close(resolvePromise));
      if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('danlingo-directory-test-')) throw new Error('Unexpected test profile cleanup path');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(profile, {
    ...browserOptions, executablePath: browserPath, headless: true, timeout: 20_000,
    args: ['--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions'],
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  t.diagnostic(`Headless ${await context.browser()?.version()} using isolated profile; ${browserPath}`);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  let timeout;
  const result = await Promise.race([
    received,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Directory browser checks timed out; requests=${JSON.stringify(requests)}; pageErrors=${JSON.stringify(pageErrors)}`)), 15_000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.ok(Array.isArray(result), JSON.stringify(result));
  for (const check of result) await t.test(check.name, () => assert.equal(check.ok, true, check.error));
});
