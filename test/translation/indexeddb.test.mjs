import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import ts from 'typescript';
import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from '../../scripts/browser-runtime.mjs';

test('browser runtime honors explicit paths and preserves Chrome and Edge brands', () => {
  const previous = {
    testBrowser: process.env.DANLINGO_TEST_BROWSER,
    e2eExecutable: process.env.DANLINGO_E2E_EXECUTABLE,
  };
  try {
    delete process.env.DANLINGO_TEST_BROWSER;
    delete process.env.DANLINGO_E2E_EXECUTABLE;
    assert.deepEqual(browserLaunchOptions('chromium'), {});
    assert.deepEqual(browserLaunchOptions('chrome'), { channel: 'chrome' });
    assert.deepEqual(browserLaunchOptions('edge'), { channel: 'msedge' });

    process.env.DANLINGO_TEST_BROWSER = fileURLToPath(import.meta.url);
    assert.deepEqual(browserLaunchOptions('edge'), { executablePath: resolve(process.env.DANLINGO_TEST_BROWSER) });
    assert.deepEqual(browserLaunchOptions('chromium', { executablePath: process.execPath }), { executablePath: resolve(process.execPath) });
    assert.throws(() => browserLaunchOptions('chromium', { executablePath: resolve('.missing-browser') }), /does not exist/u);
  } finally {
    if (previous.testBrowser === undefined) delete process.env.DANLINGO_TEST_BROWSER;
    else process.env.DANLINGO_TEST_BROWSER = previous.testBrowser;
    if (previous.e2eExecutable === undefined) delete process.env.DANLINGO_E2E_EXECUTABLE;
    else process.env.DANLINGO_E2E_EXECUTABLE = previous.e2eExecutable;
  }
});

test('browser runtime direct executable lookup rejects known brand mismatches but allows custom names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'danlingo-browser-brand-'));
  const chromePath = join(directory, 'chrome.exe');
  const edgePath = join(directory, 'msedge.exe');
  const customPath = join(directory, 'custom-browser.exe');
  try {
    for (const path of [chromePath, edgePath, customPath]) {
      await writeFile(path, 'executable placeholder');
      await chmod(path, 0o755);
    }
    assert.throws(() => browserExecutablePath('edge', { executablePath: chromePath }), /requested browser brand is Edge/u);
    assert.throws(() => browserExecutablePath('chrome', { executablePath: edgePath }), /requested browser brand is Chrome/u);
    assert.throws(() => browserLaunchOptions('edge', { executablePath: chromePath }), /requested browser brand is Edge/u);
    assert.throws(() => browserLaunchOptions('chrome', { executablePath: edgePath }), /requested browser brand is Chrome/u);
    assert.equal(browserExecutablePath('edge', { executablePath: customPath }), resolve(customPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function browserChecks() {
  const { IndexedDbTranslationCache } = await import('/src/translation/cache.ts');
  const checks = [];
  const equal = (a, b, message) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  const check = async (name, run) => {
    try { await run(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: String(error) }); }
  };
  await check('persists exact text across close/reopen and expires on epoch TTL', async () => {
    let epoch = 10_000;
    const options = { dbName: 'persist', now: () => epoch, ttlMs: 50 };
    const a = new IndexedDbTranslationCache(options);
    await a.set('exact key', '  文\n😀  ', { resourceId: 'sm9' });
    await a.close();
    epoch += 49;
    const b = new IndexedDbTranslationCache(options);
    try {
      equal(await b.get('exact key'), '  文\n😀  ', 'persisted text');
      epoch++;
      equal(await b.get('exact key'), undefined, 'TTL exact boundary');
      const stats = await b.stats();
      equal([stats.entries, stats.bytes], [0, 0], 'expired accounting');
    } finally { await b.close(); }
  });
  await check('LRU entry eviction touches on read, with monotonic persisted access ordering', async () => {
    const cache = new IndexedDbTranslationCache({ dbName: 'lru', maxEntries: 2 });
    try {
      await cache.set('a', 'A', { resourceId: 'r' });
      await cache.set('b', 'B', { resourceId: 'r' });
      await cache.get('a');
      await cache.set('c', 'C', { resourceId: 'r' });
      equal(await cache.get('b'), undefined, 'least recently used');
      equal(await cache.get('a'), 'A', 'touched entry');
      equal((await cache.stats()).entries, 2, 'entry bound');
    } finally { await cache.close(); }
  });
  await check('UTF-8 byte limit accounts for large keys, values, and overwrites', async () => {
    const cache = new IndexedDbTranslationCache({ dbName: 'bytes', maxBytes: 400 });
    try {
      await cache.set('key'.repeat(30), '字'.repeat(50), { resourceId: 'r' });
      equal((await cache.stats()).entries, 1, 'one payload fits');
      await cache.set('b', '字'.repeat(50), { resourceId: 'r' });
      equal((await cache.stats()).entries, 1, 'total byte bound');
      await cache.set('b', 'tiny', { resourceId: 'r' });
      const stats = await cache.stats();
      if (stats.bytes <= 0 || stats.bytes > 400) throw new Error('invalid byte accounting');
      await cache.set('oversize', 'x'.repeat(1000), { resourceId: 'r' });
      equal(await cache.get('oversize'), undefined, 'oversize skipped');
      equal(await cache.get('b'), 'tiny', 'unrelated entry retained');
    } finally { await cache.close(); }
  });
  await check('concurrent cache instances share atomic capacity and byte metadata', async () => {
    const options = { dbName: 'concurrent', maxEntries: 5, maxBytes: 100_000 };
    const a = new IndexedDbTranslationCache(options);
    const b = new IndexedDbTranslationCache(options);
    try {
      await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? a : b).set(`key-${index}`, `value-${index}`, { resourceId: 'r' })));
      const s1 = await a.stats();
      const s2 = await b.stats();
      equal(s1.entries, 5, 'atomic capacity');
      equal([s1.entries, s1.bytes], [s2.entries, s2.bytes], 'same metadata');
      await Promise.all([a.set('same', 'x', { resourceId: 'r' }), b.set('same', 'y', { resourceId: 'r' })]);
      equal((await a.stats()).entries, 5, 'overwrite counted once');
    } finally { await a.close(); await b.close(); }
  });
  await check('resource clear and whole-cache clear keep other scopes/accounting correct', async () => {
    const cache = new IndexedDbTranslationCache({ dbName: 'clear' });
    try {
      await cache.set('a1', 'A1', { resourceId: 'a' });
      await cache.set('a2', 'A2', { resourceId: 'a' });
      await cache.set('b1', 'B1', { resourceId: 'b' });
      await cache.clear('a');
      equal(await cache.get('a1'), undefined, 'cleared scope');
      equal(await cache.get('b1'), 'B1', 'other scope');
      equal((await cache.stats()).entries, 1, 'scoped accounting');
      await cache.clear();
      const stats = await cache.stats();
      equal([stats.entries, stats.bytes], [0, 0], 'global accounting');
    } finally { await cache.close(); }
  });
  await check('per-write TTL and tighter read/config limits are applied', async () => {
    let epoch = 1000;
    const cache = new IndexedDbTranslationCache({ dbName: 'policy', now: () => epoch });
    try {
      await cache.set('short', 'S', { resourceId: 'r', ttlMs: 10 });
      await cache.set('long', 'L', { resourceId: 'r', ttlMs: 100 });
      epoch += 10;
      equal(await cache.get('short'), undefined, 'write TTL');
      equal(await cache.get('long', { ttlMs: 5 }), undefined, 'shorter read TTL');
      await cache.set('one', '1', { resourceId: 'r' });
      await cache.set('two', '2', { resourceId: 'r' });
      await cache.get('two', { maxEntries: 1 });
      equal((await cache.stats()).entries, 1, 'read policy capacity');
      await cache.get('two', { maxEntries: 0 });
      equal((await cache.stats()).entries, 0, 'disabled cache');
    } finally { await cache.close(); }
  });
  await check('reopen with smaller hard bounds evicts existing excess without needing a write', async () => {
    const a = new IndexedDbTranslationCache({ dbName: 'resize', maxEntries: 10 });
    await a.set('a', 'A', { resourceId: 'r' });
    await a.set('b', 'B', { resourceId: 'r' });
    await a.close();
    const b = new IndexedDbTranslationCache({ dbName: 'resize', maxEntries: 1 });
    try { equal((await b.stats()).entries, 1, 'new hard capacity'); }
    finally { await b.close(); }
  });
  await check('bulk get/set use one transaction and one maintenance pass per group, preserving duplicate accounting', async () => {
    const cache = new IndexedDbTranslationCache({ dbName: 'bulk', maxEntries: 200 });
    const originalTransaction = IDBDatabase.prototype.transaction;
    const originalMaintain = cache.maintain;
    let transactions = 0, maintenance = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === 'bulk') transactions++;
      return originalTransaction.apply(this, args);
    };
    cache.maintain = function (...args) { maintenance++; return originalMaintain.apply(this, args); };
    try {
      const entries = Array.from({ length: 100 }, (_, n) => ({ key: `k-${n}`, text: `v-${n}`, resourceId: n % 2 ? 'a' : 'b' }));
      await cache.setMany([...entries, { ...entries[0], text: 'overwritten' }]);
      equal([transactions, maintenance], [1, 1], 'one write transaction and maintenance');
      const hit = await cache.getMany([...entries.map(({ key }) => key), 'k-0', 'missing']);
      equal([transactions, maintenance], [2, 2], 'one read transaction and maintenance');
      equal(hit.size, 100, 'all unique keys'); equal(hit.get('k-0'), 'overwritten', 'last duplicate wins');
      equal((await cache.stats()).entries, 100, 'duplicates counted once');
      await cache.clear('a'); equal((await cache.stats()).entries, 50, 'resource clear after bulk');
      await cache.clear(); equal((await cache.stats()).bytes, 0, 'no stale byte metadata');
      await cache.setMany([
        { key: 'a', text: 'old', resourceId: 'r' }, { key: 'b', text: 'B', resourceId: 'r' },
        { key: 'a', text: 'latest', resourceId: 'r' },
      ], { maxEntries: 1 });
      equal(await cache.get('a'), 'latest', 'last duplicate is most recently used');
      equal(await cache.get('b'), undefined, 'older unique entry evicted');
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
      cache.maintain = originalMaintain;
      await cache.close();
    }
  });
  await check('concurrent bulk writes and scoped clear are atomic, with tighter read limits and TTL', async () => {
    let epoch = 1000;
    const options = { dbName: 'bulk-races', now: () => epoch, maxEntries: 5, ttlMs: 100 };
    const a = new IndexedDbTranslationCache(options), b = new IndexedDbTranslationCache(options);
    try {
      await Promise.all([
        a.setMany(Array.from({ length: 10 }, (_, n) => ({ key: `a-${n}`, text: 'A', resourceId: 'a' }))),
        b.setMany(Array.from({ length: 10 }, (_, n) => ({ key: `b-${n}`, text: 'B', resourceId: 'b' }))),
      ]);
      const one = await a.stats(), two = await b.stats();
      equal(one.entries, 5, 'shared capacity'); equal([one.entries, one.bytes], [two.entries, two.bytes], 'shared accounting');
      await a.clear();
      const write = a.setMany([{ key: 'a', text: 'A', resourceId: 'a' }, { key: 'b', text: 'B', resourceId: 'b' }]);
      const clear = a.clear('a');
      const read = a.getMany(['a', 'b']);
      await Promise.all([write, clear]);
      equal([...await read], [['b', 'B']], 'ordered clear cannot split or resurrect a bulk write');
      await a.setMany([{ key: 'c', text: 'C', resourceId: 'b' }]);
      equal((await a.getMany(['b', 'c'], { maxEntries: 1 })).size, 1, 'tightened read capacity');
      epoch += 100;
      equal((await a.getMany(['b', 'c'])).size, 0, 'exact TTL boundary');
      equal((await b.stats()).bytes, 0, 'expired shared bytes');
    } finally { await a.close(); await b.close(); }
  });
  await check('real IndexedDB lookup of 100 sources feeds one provider POST and preserves duplicate display IDs', async () => {
    const { TranslationEngine } = await import('/src/translation/engine.ts');
    const { DEFAULT_SETTINGS } = await import('/src/core/config.ts');
    const cache = new IndexedDbTranslationCache({ dbName: 'bulk-engine' });
    const calls = [];
    const engine = new TranslationEngine({ cache, fetch: async (_url, init) => {
      const items = JSON.parse(JSON.parse(init.body).messages[1].content).items;
      calls.push(items);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: `translated-${text}` })) }) } }] });
    } });
    try {
      const items = Array.from({ length: 110 }, (_, n) => ({ id: `display-${n}`, text: `source-${n % 100}`, deadlineAt: 0 }));
      const request = { resourceId: 'video', mode: 'vod', apiKey: 'test-only-not-a-real-key', settings: { ...DEFAULT_SETTINGS, enabled: true }, items };
      const translated = await engine.translate(request);
      equal(calls.length, 1, 'one grouped provider POST'); equal(calls[0].length, 100, 'unique provider sources');
      equal(translated.items.map(({ id }) => id), items.map(({ id }) => id), 'every display identity');
      if (!translated.items.every(({ status }) => status === 'translated')) throw new Error('all sources should translate');
      equal((await cache.stats()).entries, 100, 'single grouped write persisted');
      const cached = await engine.translate(request);
      if (!cached.items.every(({ status }) => status === 'cached')) throw new Error('all sources should be cached');
      equal(calls.length, 1, 'cache replay makes no provider request');
    } finally { engine.dispose(); await cache.close(); }
  });
  const localModels = await import('/src/local/storage.ts');
  const { fingerprintFiles } = await import('/src/local/gguf.ts');
  const localStored = (id, blobs, fingerprint) => ({
    info: { id, name: blobs[0].name, files: blobs.map(blob => blob.name), bytes: blobs.reduce((sum, blob) => sum + blob.size, 0), importedAt: Date.now(),
      architecture: 'llama', quantization: 'Q4_K_M', tokenizer: 'llama', template: true, ...(fingerprint ? { fingerprint } : {}) }, blobs,
  });
  const legacyModel = id => {
    const u32 = n => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, n, true); return bytes; };
    const u64 = n => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(n), true); return bytes; };
    const str = s => { const bytes = new TextEncoder().encode(s); return [u64(bytes.length), bytes]; };
    const metadata = { 'general.architecture': 'llama', 'general.file_type': 15, 'tokenizer.ggml.model': 'llama',
      'tokenizer.ggml.tokens': ['hello'], 'tokenizer.chat_template': '{{ messages }}', 'llama.block_count': 4,
      'llama.embedding_length': 128, 'llama.attention.head_count': 4, 'llama.attention.head_count_kv': 2 };
    const entries = Object.entries(metadata).flatMap(([key, value]) => [...str(key), ...(typeof value === 'number'
      ? [u32(4), u32(value)] : Array.isArray(value) ? [u32(9), u32(8), u64(value.length), ...value.flatMap(str)] : [u32(8), ...str(value)])]);
    const file = new File([u32(0x46554747), u32(3), u64(1), u64(Object.keys(metadata).length), ...entries], id + '.gguf');
    return { info: { id, name: 'User model name', files: [file.name], bytes: file.size, importedAt: 123,
      architecture: 'llama', quantization: 'Q4_K_M', tokenizer: 'llama', template: true }, blobs: [file] };
  };
  await check('legacy local models lazily hydrate metadata without reimport or changing identity', async () => {
    const original = legacyModel('legacy-local'); await localModels.saveModel(original);
    const hydrated = await localModels.readModel(original.info.id);
    equal(hydrated.info.metadataVersion, 1, 'metadata version'); equal(hydrated.info.layerCount, 4, 'layer count');
    equal(hydrated.info.kvHeads, 2, 'KV dimensions'); equal(hydrated.info.importedAt, 123, 'import timestamp preserved');
    equal(hydrated.info.name, original.info.name, 'user name preserved'); equal(hydrated.blobs[0].size, original.blobs[0].size, 'model bytes preserved');
    equal((await localModels.listModels()).find(model => model.id === original.info.id).metadataVersion, 1, 'upgrade persisted');
    await localModels.deleteModel(original.info.id);
  });
  await check('lazy metadata hydration cannot resurrect a model deleted while its header is read', async () => {
    const original = legacyModel('deleted-during-hydration'); await localModels.saveModel(original);
    const arrayBuffer = Blob.prototype.arrayBuffer;
    let release, entered, once = true;
    const blocked = new Promise(resolve => { entered = resolve; });
    Blob.prototype.arrayBuffer = async function () {
      if (once) { once = false; entered(); await new Promise(resolve => { release = resolve; }); }
      return arrayBuffer.call(this);
    };
    try {
      const reading = localModels.readModel(original.info.id); await blocked;
      await localModels.deleteModel(original.info.id); release();
      equal(await reading, undefined, 'deleted model is not returned');
      equal(await localModels.readModel(original.info.id), undefined, 'deleted model is not recreated');
    } finally { Blob.prototype.arrayBuffer = arrayBuffer; release?.(); }
  });
  await check('fixed-chunk fingerprint ignores filenames but preserves shard order and bytes', async () => {
    const first = [new File(['part-a'], 'model-00001-of-00002.gguf'), new File(['part-b'], 'model-00002-of-00002.gguf')];
    const renamed = [new File(['part-a'], 'renamed-00001-of-00002.gguf'), new File(['part-b'], 'renamed-00002-of-00002.gguf')];
    const reordered = [renamed[1], renamed[0]];
    equal(await fingerprintFiles(first), await fingerprintFiles(renamed), 'renamed files share content fingerprint');
    if (await fingerprintFiles(first) === await fingerprintFiles(reordered)) throw new Error('shard order must affect fingerprint');
    if (await fingerprintFiles(first) === await fingerprintFiles([new File(['part-x'], 'model-00001-of-00002.gguf'), first[1]])) throw new Error('changed bytes must affect fingerprint');
  });
  await check('identical renamed imports reuse one model while same-name versions remain distinct', async () => {
    const original = [new File(['version-a'], 'model.gguf')];
    const renamed = [new File(['version-a'], 'renamed.gguf')];
    const changed = [new File(['version-b'], 'model.gguf')];
    const fingerprint = await fingerprintFiles(original);
    const first = await localModels.saveModelDeduplicated(localStored('dedup-original', original, fingerprint));
    const reused = await localModels.saveModelDeduplicated(localStored('dedup-renamed', renamed, fingerprint));
    equal(reused.created, false, 'renamed duplicate is reused'); equal(reused.info.id, first.info.id, 'duplicate keeps existing identity');
    const changedResult = await localModels.saveModelDeduplicated(localStored('dedup-version-b', changed, await fingerprintFiles(changed)));
    equal(changedResult.created, true, 'same-name changed bytes are imported');
    const ids = (await localModels.listModels()).filter(model => ['dedup-original', 'dedup-version-b'].includes(model.id)).map(model => model.id).sort();
    equal(ids, ['dedup-original', 'dedup-version-b'], 'both distinct versions remain stored');
    await localModels.deleteModel(first.info.id); await localModels.deleteModel(changedResult.info.id);
  });
  await check('legacy models are fingerprinted lazily only after a content candidate match', async () => {
    const legacyBlobs = [new File(['legacy-content'], 'legacy.gguf')];
    const legacy = localStored('dedup-legacy', legacyBlobs);
    await localModels.saveModel(legacy);
    const fingerprint = await fingerprintFiles([new File(['legacy-content'], 'renamed.gguf')]);
    const reused = await localModels.saveModelDeduplicated(localStored('dedup-legacy-candidate', [new File(['legacy-content'], 'renamed.gguf')], fingerprint));
    equal(reused.created, false, 'legacy content is reused'); equal(reused.info.id, legacy.info.id, 'legacy identity preserved');
    equal((await localModels.readModel(legacy.info.id)).info.fingerprint, fingerprint, 'legacy fingerprint persisted');
    equal(await localModels.deleteModelIfOwned(legacy.info.id, fingerprint, 'legacy-owner'), false, 'unowned legacy model is not cancellation-deletable');
    await localModels.deleteModel(legacy.info.id);
  });
  await check('concurrent identical imports are atomically collapsed and cancellation preserves the duplicate', async () => {
    const blobs = [new File(['concurrent-content'], 'concurrent.gguf')];
    const fingerprint = await fingerprintFiles(blobs);
    const ownerA = 'dedup-owner-a', ownerB = 'dedup-owner-b';
    const [a, b] = await Promise.all([
      localModels.saveModelDeduplicated(localStored('dedup-concurrent-a', blobs, fingerprint), { owner: ownerA }),
      localModels.saveModelDeduplicated(localStored('dedup-concurrent-b', [new File(['concurrent-content'], 'other.gguf')], fingerprint), { owner: ownerB }),
    ]);
    equal(Number(a.created) + Number(b.created), 1, 'one concurrent write owns storage'); equal(a.info.id, b.info.id, 'concurrent callers reuse one identity');
    const existing = a.info;
    const creatorOwner = a.created ? ownerA : ownerB;
    equal(await localModels.deleteModelIfOwned(existing.id, fingerprint, creatorOwner), false, 'creator cancellation cannot delete after reuse');
    let cancelled = false;
    try { await localModels.saveModelDeduplicated(localStored('dedup-cancelled', [new File(['concurrent-content'], 'cancelled.gguf')], fingerprint), { owner: 'dedup-cancelled-owner', isCancelled: () => { cancelled = true; return true; } }); throw new Error('cancellation should reject'); }
    catch (error) { equal(error.message, 'LOCAL_IMPORT_ABORTED', 'cancellation error'); }
    equal(cancelled, true, 'cancellation callback observed'); equal((await localModels.readModel(existing.id)).info.id, existing.id, 'pre-existing duplicate survives cancellation');
    await localModels.deleteModel(existing.id);
  });
  return checks;
}

test('IndexedDB in an isolated installed headless browser (loopback only)', { timeout: 60_000 }, async (t) => {
  let playwright, browserOptions, browserPath;
  const browserName = process.env.DANLINGO_E2E_BROWSER || 'chromium';
  try {
    playwright = await loadPlaywright();
    browserOptions = browserLaunchOptions(browserName);
    browserPath = browserExecutablePath(browserName, { playwrightBrowser: playwright.chromium });
  } catch (error) {
    t.skip(error.message);
    return;
  }
  const { chromium } = playwright;
  const profile = await mkdtemp(join(tmpdir(), 'danlingo-idb-test-'));
  const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = new Map(), requests = [], pageErrors = [];
  let receive, context;
  const received = new Promise((resolve) => { receive = resolve; });
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    try {
      if (req.url === '/result' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        try { receive(JSON.parse(body)); } catch { receive({ error: 'invalid browser test report' }); }
        res.end('ok');
      } else if (req.method === 'GET' && /^\/src\/[a-zA-Z0-9_./-]+\.ts$/.test(req.url)) {
        // Serve current transitive source imports, so config/cache dependencies cannot drift from a fixed list.
        const path = resolve(sourceRoot, req.url.slice('/src/'.length));
        if (!path.startsWith(resolve(sourceRoot) + sep)) { res.statusCode = 403; res.end(); return; }
        if (!files.has(req.url)) {
          const source = await readFile(path, 'utf8');
          files.set(req.url, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
        }
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(files.get(req.url));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>DanLingo IndexedDB tests</title><pre id="result">Running</pre><script type="module">
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
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      // Delete only the exact directory created above, after validating the absolute parent and prefix.
      if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('danlingo-idb-test-')) throw new Error('Unexpected test profile cleanup path');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Playwright owns the browser pipe/session lifecycle; no raw flattened CDP attachment or user profile.
  context = await chromium.launchPersistentContext(profile, {
    ...browserOptions, headless: true, timeout: 20_000,
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
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`IndexedDB browser checks timed out; requests=${JSON.stringify(requests)}; pageErrors=${JSON.stringify(pageErrors)}`)), 15_000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.ok(Array.isArray(result), JSON.stringify(result));
  for (const check of result) await t.test(check.name, () => assert.equal(check.ok, true, check.error));
});
