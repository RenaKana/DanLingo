import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function verifyLocalNativeBundle(info, files) {
  if (info?.schemaVersion !== 1 || info.wllamaVersion !== '3.6.1'
    || info.llamaCommit !== '83d855c5a6d70487121edbf4020b25c96b7a04e7'
    || info.nativePolicy?.cacheRamMiB !== 0) throw new Error('Review the local native build version and cache policy');
  for (const name of ['wllama.js', 'wllama.wasm', 'source-map.json']) {
    const content = files[name], expected = info.files?.[name];
    if (!Buffer.isBuffer(content) || content.length !== expected?.bytes
      || createHash('sha256').update(content).digest('hex') !== expected.sha256) {
      throw new Error(`Local native artifact mismatch: ${name}`);
    }
  }
  const sourceMap = JSON.parse(files['source-map.json'].toString('utf8'));
  if (typeof sourceMap.default !== 'string' || !sourceMap.default) throw new Error('Local native symbol map is missing');
  return { info, wasm: files['wllama.wasm'], runtime: files['wllama.js'].toString('utf8'), sourceMap };
}

export function loadLocalNativeBundle() {
  const directory = resolve('vendor/wllama-3.6.1-webgpu');
  const info = JSON.parse(readFileSync(resolve(directory, 'build-info.json'), 'utf8'));
  const files = Object.fromEntries(['wllama.js', 'wllama.wasm', 'source-map.json'].map(name => [name, readFileSync(resolve(directory, name))]));
  return verifyLocalNativeBundle(info, files);
}
