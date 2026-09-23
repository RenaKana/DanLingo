import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadLocalNativeBundle, verifyLocalNativeBundle } from '../../scripts/local-native-bundle.mjs';
import { localWllamaAssets } from '../../scripts/local-wllama-assets.mjs';

function fixture() {
  const files = {
    'wllama.js': Buffer.from('native runtime'),
    'wllama.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    'source-map.json': Buffer.from(JSON.stringify({ default: 'paired symbols' })),
  };
  const info = {
    schemaVersion: 1, wllamaVersion: '3.6.1',
    llamaCommit: '83d855c5a6d70487121edbf4020b25c96b7a04e7',
    nativePolicy: { cacheRamMiB: 0 },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, {
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    }])),
  };
  return { info, files };
}

test('native bundle accepts a paired build and rejects missing or changed artifacts', () => {
  const { info, files } = fixture();
  assert.equal(verifyLocalNativeBundle(info, files).sourceMap.default, 'paired symbols');
  for (const name of Object.keys(files)) {
    const changed = Buffer.from(files[name]);
    changed[0] ^= 1;
    assert.throws(() => verifyLocalNativeBundle(info, { ...files, [name]: changed }), /artifact mismatch/);
    assert.throws(() => verifyLocalNativeBundle(info, { ...files, [name]: undefined }), /artifact mismatch/);
  }
});

test('native bundle rejects unreviewed versions, cache policy and empty symbol maps', () => {
  const { info, files } = fixture();
  for (const replacement of [
    { schemaVersion: 2 }, { wllamaVersion: '3.6.2' }, { llamaCommit: 'other' },
    { nativePolicy: { cacheRamMiB: -1 } },
  ]) assert.throws(() => verifyLocalNativeBundle({ ...info, ...replacement }, files), /version and cache policy/);
  const emptyMap = Buffer.from('{"default":""}');
  info.files['source-map.json'] = {
    bytes: emptyMap.length, sha256: createHash('sha256').update(emptyMap).digest('hex'),
  };
  assert.throws(() => verifyLocalNativeBundle(info, { ...files, 'source-map.json': emptyMap }), /symbol map is missing/);
});

test('production packaging emits the verified native binary, runtime, symbols and provenance together', () => {
  const native = loadLocalNativeBundle();
  const plugin = localWllamaAssets();
  const source = readFileSync('node_modules/@wllama/wllama/esm/index.js', 'utf8');
  const patched = plugin.transform(source, '/node_modules/@wllama/wllama/esm/index.js');
  assert.ok(patched.code.includes(`var WASM_SOURCE_MAP = ${JSON.stringify(native.sourceMap)};`));
  assert.ok(patched.code.includes('/local/wllama-worker.js'));
  const assets = [];
  plugin.generateBundle.call({ emitFile: asset => assets.push(asset) });
  const byName = Object.fromEntries(assets.map(asset => [asset.fileName, asset.source]));
  assert.deepEqual(byName['local/wllama.wasm'], native.wasm);
  assert.ok(byName['local/wllama-worker.js'].includes(native.runtime.replace('var Module', 'var ___Module')));
  assert.deepEqual(JSON.parse(byName['local/native-build.json']), native.info);
  assert.ok(byName['local/WLLAMA-LICENSE.txt'].length > 500);
  assert.ok(byName['local/LLAMA-LICENSE.txt'].length > 500);
  const assetsWithoutEngine = [];
  localWllamaAssets().generateBundle.call({ emitFile: asset => assetsWithoutEngine.push(asset) });
  assert.equal(assetsWithoutEngine.length, 0);
});

test('packaged private GPU flush resolves matching IDs, hides replies from Wllama, and bounds failures', async () => {
  const plugin = localWllamaAssets();
  const source = readFileSync('node_modules/@wllama/wllama/esm/index.js', 'utf8');
  const patched = plugin.transform(source, '/node_modules/@wllama/wllama/esm/index.js').code;
  const shim = patched.match(/var createWorker = \(workerCode\) => \{[\s\S]*?\n      \};/)?.[0];
  assert.ok(shim);
  const timers = new Map(); let sequence = 0;
  class Worker {
    listeners = new Map(); messages = []; normalMessages = []; terminated = false;
    addEventListener(name, callback) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(name, data) {
      let stopped = false;
      for (const callback of this.listeners.get(name) ?? []) {
        callback({ data, stopImmediatePropagation() { stopped = true; } }); if (stopped) return;
      }
      if (name === 'message') this.normalMessages.push(data);
    }
  }
  const context = { URL, Worker, location: { href: 'https://extension/inference.worker.js' },
    setTimeout(callback, ms) { assert.equal(ms, 5000); timers.set(++sequence, callback); return sequence; },
    clearTimeout(id) { timers.delete(id); }, dispatchEvent() {}, CustomEvent: class {}, __DANLINGO_GPU_TIMING__: true };
  const worker = runInNewContext(`${shim}\ncreateWorker('const RUN_OPTIONS = {"nbThread":1};')`, context);
  const flush = () => context.__DANLINGO_GPU_FLUSH__();
  const first = flush();
  await assert.rejects(flush(), /LOCAL_GPU_TIMING_BUSY/);
  assert.equal(worker.messages.length, 1); assert.equal(worker.messages[0].callbackId, undefined);
  worker.emit('message', { verb: 'danlingo.gpu.flushed', id: 999, metrics: {} });
  assert.equal(timers.size, 1); assert.equal(worker.normalMessages.length, 0);
  worker.emit('message', { verb: 'danlingo.gpu.flushed', id: worker.messages[0].id, metrics: { executionMs: 4 } });
  assert.equal((await first).executionMs, 4); assert.equal(timers.size, 0);
  const timeout = flush(), timedOut = assert.rejects(timeout, /LOCAL_GPU_TIMING_TIMEOUT/);
  const [timerId, callback] = [...timers][0]; timers.delete(timerId); callback(); await timedOut;
  const nativeError = flush(), errored = assert.rejects(nativeError, /LOCAL_GPU_TIMING_UNAVAILABLE/);
  worker.emit('error'); await errored; assert.equal(timers.size, 0);
  const terminated = flush(), rejected = assert.rejects(terminated, /LOCAL_GPU_TIMING_UNAVAILABLE/);
  worker.terminate(); await rejected; assert.equal(timers.size, 0); assert.equal(worker.terminated, true);
  worker.emit('message', { callbackId: 12, result: true });
  assert.equal(worker.normalMessages.length, 1); assert.equal(worker.normalMessages[0].callbackId, 12);
});
