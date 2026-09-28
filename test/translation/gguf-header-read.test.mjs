import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFiles, inspectGguf } from '../../src/local/gguf.ts';

const MAX_HEADER = 32 * 1024 * 1024;
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const ggufString = value => { const bytes = Buffer.from(value); return Buffer.concat([u64(bytes.length), bytes]); };
const raw = (type, bytes) => ({ raw: true, type, bytes });
const fixedArray = (type, length) => raw(9, Buffer.concat([u32(type), u64(length)]));
const rawString = length => raw(8, u64(length));

function encodeValue(value) {
  if (value?.raw) return Buffer.concat([u32(value.type), value.bytes]);
  if (typeof value === 'number') return Buffer.concat([u32(4), u32(value)]);
  if (Array.isArray(value)) return Buffer.concat([u32(9), u32(8), u64(value.length), ...value.map(ggufString)]);
  return Buffer.concat([u32(8), ggufString(value)]);
}

const companionMetadata = {
  'general.architecture': 'llama',
  'general.file_type': 15,
  'tokenizer.ggml.model': 'llama',
  'tokenizer.ggml.tokens': ['hello'],
  'tokenizer.chat_template': '{{ messages }}',
};

function makeHeader({ metadata = {}, tensorCount = 1, version = 3, magic = 0x46554747, tensorInfo = true } = {}) {
  const entries = Object.entries({ ...companionMetadata, ...metadata })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => Buffer.concat([ggufString(key), encodeValue(value)]));
  const pieces = [u32(magic), u32(version), u64(tensorCount), u64(entries.length), ...entries];
  for (let i = 0; tensorInfo && i < tensorCount; i++) {
    pieces.push(ggufString(`weight-${i}`), u32(1), u64(1), u32(0), u64(0));
  }
  return Buffer.concat(pieces);
}

function sparseFile(prefix, size, name = 'sparse.gguf') {
  return {
    name,
    size,
    slice(start, end) {
      return { async arrayBuffer() {
        const bytes = new Uint8Array(end - start);
        const copyStart = Math.max(start, 0), copyEnd = Math.min(end, prefix.byteLength);
        if (copyEnd > copyStart) bytes.set(prefix.subarray(copyStart, copyEnd), copyStart - start);
        return bytes.buffer;
      } };
    },
  };
}

function counted(file, name = file.name ?? 'fixture.gguf') {
  const ranges = [];
  return {
    name, size: file.size, ranges,
    slice(start, end) {
      const part = file.slice(start, end);
      return { async arrayBuffer() {
        const buffer = await part.arrayBuffer();
        ranges.push({ start, end, bytes: buffer.byteLength });
        return buffer;
      } };
    },
  };
}

function readStats(file) {
  let next = 0;
  for (const range of file.ranges) {
    assert.equal(range.start, next, 'header ranges must be sequential and non-overlapping');
    assert.equal(range.bytes, range.end - range.start, 'each range must be read in full');
    next = range.end;
  }
  return { bytes: next, reads: file.ranges.length };
}

test('a tiny header in a huge GGUF stays within the 64 KiB read budget', async () => {
  const prefix = makeHeader();
  const file = counted(sparseFile(prefix, 2 * 1024 ** 3), 'virtual-large.gguf');
  const info = await inspectFiles([file]);
  const stats = readStats(file);
  assert.equal(info.architecture, 'llama');
  assert.ok(info.weightBytes > 1024 ** 3);
  assert.ok(stats.bytes <= 64 * 1024, `expected at most 64 KiB read, got ${stats.bytes} bytes`);
});

test('large tokenizer headers are parsed and unused fixed-width arrays are skipped', async () => {
  const tokens = Array.from({ length: 24_000 }, (_, index) => `token-${String(index).padStart(5, '0')}-long`);
  const tokenizerFile = counted(new Blob([makeHeader({ metadata: { 'tokenizer.ggml.tokens': tokens } })]));
  const info = await inspectGguf(tokenizerFile);
  const tokenizerStats = readStats(tokenizerFile);
  assert.equal(info.tokenizer, 'llama');
  assert.equal(info.metadataComplete, true);
  assert.ok(tokenizerStats.bytes > 64 * 1024);
  assert.ok(tokenizerStats.bytes < MAX_HEADER);
  assert.ok(tokenizerStats.reads < 20, `expected bounded geometric reads, got ${tokenizerStats.reads}`);

  const arrayLength = 1_000_000;
  const prefix = makeHeader({ tensorCount: 0, tensorInfo: false, metadata: {
    'split.no': 0, 'split.count': 2, 'split.tensors.count': 1,
    'unused.fixed_values': fixedArray(5, arrayLength),
  } });
  const sparse = counted(sparseFile(prefix, prefix.length + arrayLength * 4));
  const splitInfo = await inspectGguf(sparse);
  const sparseStats = readStats(sparse);
  assert.equal(splitInfo.architecture, 'llama');
  assert.ok(sparseStats.bytes <= 64 * 1024, `fixed array header read should stay within 64 KiB, got ${sparseStats.bytes} bytes`);
  assert.ok(sparseStats.bytes < prefix.length + arrayLength * 4);
});

test('invalid magic and unsupported version stop after the fixed preamble', async () => {
  const badMagic = counted(new Blob([makeHeader({ magic: 0x12345678 })]));
  await assert.rejects(inspectFiles([badMagic]), /LOCAL_NOT_GGUF/);
  assert.deepEqual(readStats(badMagic), { bytes: 8, reads: 1 });

  const badVersion = counted(new Blob([makeHeader({ version: 1 })]));
  await assert.rejects(inspectFiles([badVersion]), /LOCAL_GGUF_VERSION_UNSUPPORTED/);
  assert.deepEqual(readStats(badVersion), { bytes: 8, reads: 1 });
});

test('truncated, over-limit, oversized-array, and malformed-value headers fail closed', async () => {
  const truncated = counted(new Blob([Buffer.concat([u32(0x46554747), u32(3), u64(1), u64(1)])]));
  await assert.rejects(inspectFiles([truncated]), /LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE/);
  assert.equal(readStats(truncated).bytes, 24);

  const tooLarge = makeHeader({ tensorCount: 0, tensorInfo: false, metadata: {
    'split.no': 0, 'split.count': 2, 'split.tensors.count': 1,
    'unused.large_string': rawString(MAX_HEADER),
  } });
  const overLimit = counted(sparseFile(tooLarge, MAX_HEADER * 2));
  await assert.rejects(inspectGguf(overLimit), /LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE/);
  assert.ok(readStats(overLimit).bytes <= 64 * 1024);

  const oversizedArray = counted(new Blob([makeHeader({ metadata: {
    'unused.too_many': raw(9, Buffer.concat([u32(8), u64(1_000_001)])),
  } })]));
  await assert.rejects(inspectFiles([oversizedArray]), /LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE/);

  const unknownType = counted(new Blob([makeHeader({ metadata: { 'unused.bad_type': raw(99, Buffer.alloc(0)) } })]));
  await assert.rejects(inspectFiles([unknownType]), /LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE/);
});

test('nested arrays keep the previous bounded-depth acceptance rules', async () => {
  const emptyNested = raw(9, Buffer.concat([u32(9), u64(1), u32(4), u64(0)]));
  const accepted = counted(new Blob([makeHeader({ metadata: { 'unused.empty_nested': emptyNested } })]));
  assert.equal((await inspectFiles([accepted])).architecture, 'llama');
  readStats(accepted);

  const nonemptyNested = raw(9, Buffer.concat([u32(9), u64(1), u32(4), u64(1), u32(7)]));
  const rejected = counted(new Blob([makeHeader({ metadata: { 'unused.nonempty_nested': nonemptyNested } })]));
  await assert.rejects(inspectFiles([rejected]), /LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE/);
});

test('canonical shard order and companion metadata remain valid', async () => {
  const first = counted(new Blob([makeHeader({
    metadata: { 'split.no': 0, 'split.count': 2, 'split.tensors.count': 2 },
  })]), 'model-00001-of-00002.gguf');
  const second = counted(new Blob([makeHeader({
    metadata: {
      'general.architecture': undefined, 'general.file_type': undefined,
      'tokenizer.ggml.model': undefined, 'tokenizer.ggml.tokens': undefined, 'tokenizer.chat_template': undefined,
      'split.no': 1, 'split.count': 2, 'split.tensors.count': 2,
    },
  })]), 'model-00002-of-00002.gguf');
  const info = await inspectFiles([second, first]);
  assert.deepEqual(info.files, [first.name, second.name]);
  assert.equal(info.bytes, first.size + second.size);
  readStats(first); readStats(second);
});
