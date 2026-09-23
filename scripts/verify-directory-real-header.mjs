// Read-only probe of the production GGUF parser against an existing large file.
// This does not grant a browser directory handle or prove native GPU loading.
import assert from 'node:assert/strict';
import { open, stat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { inspectAndOrderFiles } from '../src/local/gguf.ts';

const path = process.argv[2];
if (!path) throw new Error('Pass one existing GGUF file path; the file is opened read-only.');
const modelPath = resolve(path), before = await stat(modelPath);
assert.ok(before.isFile() && before.size > 0, 'An existing nonempty file is required');
const maxHeader = 32 * 1024 * 1024, reads = [];
const descriptor = await open(modelPath, 'r');
const file = {
  name: basename(modelPath), size: before.size, lastModified: before.mtimeMs,
  slice(start, end) {
    assert.equal(start, 0, 'Parser must read from the file header only');
    assert.ok(end <= maxHeader, 'Parser must not read beyond its 32 MiB header budget');
    return { async arrayBuffer() {
      const buffer = Buffer.alloc(end - start);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await descriptor.read(buffer, offset, buffer.length - offset, start + offset);
        if (!bytesRead) throw new Error('Unexpected EOF during bounded header read');
        offset += bytesRead;
      }
      reads.push({ start, end, bytes: offset });
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } };
  },
};
const started = performance.now();
let info;
try { ({ info } = await inspectAndOrderFiles([file])); }
finally { await descriptor.close(); }
const headerRecognitionMs = performance.now() - started;
assert.ok(reads.length === 1 && reads[0].bytes <= maxHeader, 'One bounded header read only');
assert.equal(info.fingerprint, undefined, 'Recognition must not calculate a whole-file fingerprint');
const after = await stat(modelPath);
assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
const report = {
  capturedAt: new Date().toISOString(), status: 'PASS',
  evidence: 'REAL_FILE_READ_ONLY_PRODUCTION_HEADER_PARSER_NODE_ADAPTER',
  modelPath, bytes: before.size, gib: before.size / 1024 ** 3,
  reads, headerRecognitionMs, info, sourceSizeAndMtimeUnchanged: true,
  copiedWeightBytes: 0,
  notVerified: ['browser external directory authorization', 'external handle restart recovery', 'browser model blob directory delta', 'GPU direct load and timing'],
};
const root = resolve('.artifacts/directory-real-header'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, bytes: report.bytes, readBytes: reads[0].bytes, headerRecognitionMs, report: resolve(directory, 'report.json') }));
