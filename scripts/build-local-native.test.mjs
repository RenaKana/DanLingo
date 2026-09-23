import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { serializeNativeSourceMap } from './build-local-native.mjs';

const promoted = await readFile(new URL('../vendor/wllama-3.6.1-webgpu/source-map.json', import.meta.url), 'utf8');
const promotedMap = JSON.parse(promoted);
const template = map => `export const WASM_SOURCE_MAP: Record<string, string> = ${JSON.stringify(map)};\n`;

test('native symbol map is byte-identical across gzip host OS markers', () => {
  for (const os of [0, 3, 10, 19, 255]) {
    const map = Object.fromEntries(Object.entries(promotedMap).map(([key, value]) => {
      const gzip = Buffer.from(value, 'base64');
      gzip[9] = os;
      return [key, gzip.toString('base64')];
    }));
    const actual = serializeNativeSourceMap(template(map));
    assert.equal(actual, promoted);
    for (const key of Object.keys(map)) {
      assert.deepEqual(gunzipSync(Buffer.from(JSON.parse(actual)[key], 'base64')),
        gunzipSync(Buffer.from(map[key], 'base64')));
    }
  }
});

test('native symbol map rejects unexpected parser output or gzip formats', () => {
  assert.throws(() => serializeNativeSourceMap('{}'), /Unexpected pinned source-map output/);
  assert.throws(() => serializeNativeSourceMap(template({ default: 'invalid' })), /Unexpected source-map gzip header/);
});
