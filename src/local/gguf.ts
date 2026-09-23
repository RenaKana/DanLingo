import type { LocalModelInfo } from './types.ts';
import { detectTemplateCapability } from './reasoning.ts';
import { detectTranslationProfile } from './translation-profile.ts';

const QUANTIZATIONS: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K',
};
const MAX_HEADER = 32 * 1024 * 1024;
const SHARD_NAME = /(?:^|[-_.])(\d{5})-of-(\d{5})\.gguf$/i;
const FINGERPRINT_CHUNK_SIZE = 4 * 1024 * 1024;
const FINGERPRINT_VERSION = 'sha256-tree-v1';
const FINGERPRINT_DOMAIN = new TextEncoder().encode('danlingo-local-model-fingerprint-v1');
const FINGERPRINT_FILE_DOMAIN = new TextEncoder().encode('danlingo-local-model-fingerprint-file-v1');
const FINGERPRINT_CHUNK_DOMAIN = new TextEncoder().encode('danlingo-local-model-fingerprint-chunk-v1');
const FINGERPRINT_NODE_DOMAIN = new TextEncoder().encode('danlingo-local-model-fingerprint-node-v1');
const FINGERPRINT_ROOT_DOMAIN = new TextEncoder().encode('danlingo-local-model-fingerprint-root-v1');
const ZERO_HASH = new Uint8Array(32);

// This is a capability description, not a model certification list. Native
// wllama still decides whether a particular architecture is loadable.
export const LOCAL_SUPPORT = 'GGUF v2/v3；支持单文件和完整多分片。须内嵌 tokenizer；普通模型须有聊天模板，已识别的 Seed-X-PPO、TranslateGemma 使用专用翻译格式。当前引擎不支持 NLLB/mBART，词表文件不能单独加载。其他架构和实际翻译效果仍需验证。';

interface ShardMetadata { no: number; count: number; tensorsCount: number }
interface ParsedGguf {
  architecture: string;
  quantization: string;
  tokenizer: string;
  tokenizerTokens: number;
  template: boolean;
  translationProfile?: LocalModelInfo['translationProfile'];
  templateCapability: LocalModelInfo['templateCapability'];
  tensorCount: number;
  weightBytes?: number;
  metadataComplete: boolean;
  layerCount?: number;
  embeddingLength?: number;
  attentionHeads?: number;
  kvHeads?: number;
  keyLength?: number;
  valueLength?: number;
  kvKeyDimension?: number;
  kvValueDimension?: number;
  kvDimension?: number;
  contextLength?: number;
  split?: ShardMetadata;
}
interface FileEntry { file: File; name: string; parsed: ParsedGguf; filenameShard?: { no: number; count: number } }
export interface OrderedGgufFiles { info: LocalModelInfo; files: File[] }
export interface FingerprintProgress { bytesProcessed: number; totalBytes: number; fileIndex: number; fileCount: number }
export interface FingerprintOptions {
  shouldCancel?: () => boolean;
  cancelCode?: 'LOCAL_IMPORT_ABORTED' | 'LOCAL_SCAN_CANCELLED' | 'LOCAL_CANCELLED';
  checkSource?: () => void | Promise<void>;
  onProgress?: (progress: FingerprintProgress) => void;
}

function encodeU64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('LOCAL_FILE_SIZE_INVALID');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (!Number.isSafeInteger(total)) throw new Error('LOCAL_MODEL_FINGERPRINT_FAILED');
  const result = new Uint8Array(total); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) throw new Error('LOCAL_MODEL_FINGERPRINT_UNAVAILABLE');
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource));
}

async function appendTreeLeaf(levels: Array<Uint8Array | undefined>, leaf: Uint8Array): Promise<void> {
  let level = 0; let carry = leaf;
  while (levels[level]) {
    carry = await sha256(concatBytes([FINGERPRINT_NODE_DOMAIN, encodeU64(level), levels[level]!, carry]));
    levels[level] = undefined; level++;
  }
  levels[level] = carry;
}

async function finishTree(levels: Array<Uint8Array | undefined>, leafCount: number): Promise<Uint8Array> {
  const parts = [FINGERPRINT_ROOT_DOMAIN, encodeU64(leafCount)];
  for (let level = 0; level < levels.length; level++) parts.push(encodeU64(level), levels[level] ?? ZERO_HASH);
  return sha256(concatBytes(parts));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash canonical ordered file contents without buffering a complete GGUF.
 * File names are deliberately excluded; shard order must already be canonical.
 */
export async function fingerprintFiles(files: Blob[], options: FingerprintOptions = {}): Promise<string> {
  if (!Array.isArray(files) || !files.length) throw new Error('LOCAL_MODEL_FINGERPRINT_INPUT_INVALID');
  const cancelCode = options.cancelCode ?? 'LOCAL_IMPORT_ABORTED';
  const check = async () => {
    if (options.shouldCancel?.()) throw new Error(cancelCode);
    await options.checkSource?.();
    if (options.shouldCancel?.()) throw new Error(cancelCode);
  };
  let totalBytes = 0;
  for (const file of files) {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(totalBytes + file.size)) throw new Error('LOCAL_FILE_SIZE_INVALID');
    totalBytes += file.size;
  }
  let bytesProcessed = 0;
  const report = (fileIndex: number) => {
    try { options.onProgress?.({ bytesProcessed, totalBytes, fileIndex, fileCount: files.length }); } catch { /* progress observers cannot affect hashing */ }
  };
  await check(); report(0);
  const modelLevels: Array<Uint8Array | undefined> = [];
  let modelLeafCount = 0;
  await appendTreeLeaf(modelLevels, await sha256(concatBytes([
    FINGERPRINT_DOMAIN, encodeU64(files.length), encodeU64(FINGERPRINT_CHUNK_SIZE),
  ])));
  modelLeafCount++;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    await check();
    const file = files[fileIndex]!;
    const fileLevels: Array<Uint8Array | undefined> = [];
    let fileLeafCount = 0;
    await appendTreeLeaf(fileLevels, await sha256(concatBytes([
      FINGERPRINT_FILE_DOMAIN, encodeU64(fileIndex), encodeU64(file.size),
    ])));
    fileLeafCount++;
    let offset = 0; let chunkIndex = 0;
    while (offset < file.size) {
      await check();
      const length = Math.min(FINGERPRINT_CHUNK_SIZE, file.size - offset);
      const chunk = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      if (chunk.byteLength !== length) throw new Error('LOCAL_MODEL_FINGERPRINT_FAILED');
      await check();
      const chunkHash = await sha256(chunk);
      const leaf = await sha256(concatBytes([
        FINGERPRINT_CHUNK_DOMAIN, encodeU64(chunkIndex), encodeU64(offset), encodeU64(length), chunkHash,
      ]));
      await check();
      await appendTreeLeaf(fileLevels, leaf); fileLeafCount++;
      offset += length; chunkIndex++;
      bytesProcessed += length; report(fileIndex);
    }
    const fileRoot = await finishTree(fileLevels, fileLeafCount);
    await appendTreeLeaf(modelLevels, fileRoot); modelLeafCount++;
    report(fileIndex + 1);
  }
  const fingerprint = `${FINGERPRINT_VERSION}:${hex(await finishTree(modelLevels, modelLeafCount))}`;
  await check();
  return fingerprint;
}

const invalidHeader = () => new Error('LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE');
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function quantizationName(value: unknown): string {
  if (!nonNegativeInteger(value)) return 'unknown';
  return QUANTIZATIONS[value] ?? `GGUF_TYPE_${value}`;
}

function fileName(file: File, index: number): string {
  const name = typeof file.name === 'string' && file.name ? file.name : `model-${index + 1}.gguf`;
  return name;
}

function validateCompanions(parsed: ParsedGguf): void {
  if (!parsed.architecture) throw new Error('LOCAL_ARCHITECTURE_MISSING');
  if (/^(?:mbart|nllb|nllb-moe)$/i.test(parsed.architecture)) throw new Error('LOCAL_NLLB_UNSUPPORTED');
  if (!parsed.split && parsed.tensorCount === 0) throw new Error('LOCAL_VOCAB_ONLY');
  if (!parsed.tokenizer || !positiveInteger(parsed.tokenizerTokens)) throw new Error('LOCAL_TOKENIZER_MISSING');
  if (!parsed.template && !parsed.translationProfile) throw new Error('LOCAL_CHAT_TEMPLATE_MISSING');
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return finitePositive(value) ? value : undefined;
}

function metadataKeyWanted(key: string): boolean {
  return new Set([
    'general.architecture', 'general.file_type', 'general.alignment', 'general.name', 'general.basename',
    'tokenizer.ggml.model', 'tokenizer.ggml.tokens', 'tokenizer.chat_template',
    'split.no', 'split.count', 'split.tensors.count',
  ]).has(key) || /^[^.]+\.(?:block_count|embedding_length|context_length|attention\.(?:head_count|head_count_kv|key_length|value_length))$/.test(key);
}

function alignedOffset(offset: number, alignment: number): number {
  const remainder = offset % alignment;
  return remainder ? offset + alignment - remainder : offset;
}

function modelParameters(metadata: Record<string, unknown>, architecture: string): Pick<ParsedGguf, 'layerCount' | 'embeddingLength' | 'attentionHeads' | 'kvHeads' | 'keyLength' | 'valueLength' | 'kvKeyDimension' | 'kvValueDimension' | 'kvDimension' | 'contextLength'> {
  const prefix = architecture ? `${architecture}.` : '';
  const layerCount = metadataNumber(metadata, `${prefix}block_count`);
  const embeddingLength = metadataNumber(metadata, `${prefix}embedding_length`);
  const attentionHeads = metadataNumber(metadata, `${prefix}attention.head_count`);
  const kvHeads = metadataNumber(metadata, `${prefix}attention.head_count_kv`);
  const keyLength = metadataNumber(metadata, `${prefix}attention.key_length`)
    ?? (embeddingLength && attentionHeads && embeddingLength % attentionHeads === 0 ? embeddingLength / attentionHeads : undefined);
  const valueLength = metadataNumber(metadata, `${prefix}attention.value_length`)
    ?? (embeddingLength && attentionHeads && embeddingLength % attentionHeads === 0 ? embeddingLength / attentionHeads : undefined);
  const kvKeyDimension = kvHeads && keyLength ? kvHeads * keyLength : undefined;
  const kvValueDimension = kvHeads && valueLength ? kvHeads * valueLength : undefined;
  const kvDimension = kvKeyDimension !== undefined && kvValueDimension !== undefined ? kvKeyDimension + kvValueDimension : undefined;
  const contextLength = metadataNumber(metadata, `${prefix}context_length`);
  return { ...(layerCount !== undefined ? { layerCount } : {}), ...(embeddingLength !== undefined ? { embeddingLength } : {}),
    ...(attentionHeads !== undefined ? { attentionHeads } : {}), ...(kvHeads !== undefined ? { kvHeads } : {}),
    ...(keyLength !== undefined ? { keyLength } : {}), ...(valueLength !== undefined ? { valueLength } : {}),
    ...(kvKeyDimension !== undefined ? { kvKeyDimension } : {}), ...(kvValueDimension !== undefined ? { kvValueDimension } : {}),
    ...(kvDimension !== undefined ? { kvDimension } : {}), ...(contextLength !== undefined ? { contextLength } : {}) };
}

function infoFromParsed(fileNames: string[], bytes: number, parsed: ParsedGguf, id = crypto.randomUUID(), importedAt = Date.now()): LocalModelInfo {
  return { id, name: fileNames[0]!, files: fileNames, bytes, architecture: parsed.architecture, quantization: parsed.quantization,
    tokenizer: parsed.tokenizer, template: parsed.template, importedAt, metadataVersion: 1, metadataComplete: parsed.metadataComplete,
    ...(parsed.translationProfile ? { translationProfile: parsed.translationProfile } : {}),
    ...(parsed.weightBytes !== undefined ? { weightBytes: parsed.weightBytes } : {}),
    ...(parsed.templateCapability ? { templateCapability: parsed.templateCapability } : {}),
    ...(parsed.layerCount !== undefined ? { layerCount: parsed.layerCount } : {}),
    ...(parsed.embeddingLength !== undefined ? { embeddingLength: parsed.embeddingLength } : {}),
    ...(parsed.attentionHeads !== undefined ? { attentionHeads: parsed.attentionHeads } : {}),
    ...(parsed.kvHeads !== undefined ? { kvHeads: parsed.kvHeads } : {}),
    ...(parsed.keyLength !== undefined ? { keyLength: parsed.keyLength } : {}),
    ...(parsed.valueLength !== undefined ? { valueLength: parsed.valueLength } : {}),
    ...(parsed.kvKeyDimension !== undefined ? { kvKeyDimension: parsed.kvKeyDimension } : {}),
    ...(parsed.kvValueDimension !== undefined ? { kvValueDimension: parsed.kvValueDimension } : {}),
    ...(parsed.kvDimension !== undefined ? { kvDimension: parsed.kvDimension } : {}),
    ...(parsed.contextLength !== undefined ? { contextLength: parsed.contextLength } : {}),
  };
}

/** Run in the import/inference worker. Header reads are bounded; weight bytes are not buffered. */
async function parseGguf(file: Blob, requireCompanions: boolean): Promise<ParsedGguf> {
  if (!Number.isSafeInteger(file.size) || file.size < 24) throw invalidHeader();
  const buffer = await file.slice(0, Math.min(file.size, MAX_HEADER)).arrayBuffer();
  const data = new DataView(buffer); let offset = 0;
  const requireBytes = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > buffer.byteLength) throw invalidHeader();
  };
  const u32 = () => { requireBytes(4); const n = data.getUint32(offset, true); offset += 4; return n; };
  const u64 = () => {
    requireBytes(8);
    const n = Number(data.getBigUint64(offset, true)); offset += 8;
    if (!Number.isSafeInteger(n)) throw invalidHeader();
    return n;
  };
  const string = (read: boolean) => {
    const size = u64(); requireBytes(size);
    let s = '';
    if (read) {
      try { s = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, offset, size)); }
      catch { throw invalidHeader(); }
    }
    offset += size; return s;
  };
  const value = (type: number, read: boolean, depth = 0): unknown => {
    if (depth > 1) throw invalidHeader();
    if (type === 8) return string(read);
    if (type === 9) {
      const childType = u32(); const length = u64();
      if (length > 1_000_000) throw invalidHeader();
      for (let i = 0; i < length; i++) value(childType, false, depth + 1);
      return length;
    }
    const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const size = sizes[type]; if (!size) throw invalidHeader(); requireBytes(size);
    if (!read) { offset += size; return undefined; }
    const result = type === 1 ? data.getInt8(offset) : type === 3 ? data.getInt16(offset, true)
      : type === 5 ? data.getInt32(offset, true) : type === 6 ? data.getFloat32(offset, true)
      : type === 11 ? Number(data.getBigInt64(offset, true)) : type === 12 ? data.getFloat64(offset, true)
      : size === 1 ? data.getUint8(offset) : size === 2 ? data.getUint16(offset, true)
      : size === 4 ? data.getUint32(offset, true) : Number(data.getBigUint64(offset, true));
    offset += size;
    if (!Number.isSafeInteger(result)) throw invalidHeader();
    return result;
  };

  if (u32() !== 0x46554747) throw new Error('LOCAL_NOT_GGUF');
  if (![2, 3].includes(u32())) throw new Error('LOCAL_GGUF_VERSION_UNSUPPORTED');
  const tensorCount = u64(); const metadataCount = u64();
  if (!nonNegativeInteger(tensorCount) || metadataCount > 100_000) throw invalidHeader();
  const metadata: Record<string, unknown> = {};
  for (let i = 0; i < metadataCount; i++) {
    const key = string(true); const type = u32();
    const wanted = metadataKeyWanted(key);
    const entry = value(type, wanted); if (wanted) metadata[key] = entry;
  }
  const architecture = typeof metadata['general.architecture'] === 'string' ? metadata['general.architecture'].trim() : '';
  const tokenizer = typeof metadata['tokenizer.ggml.model'] === 'string' ? metadata['tokenizer.ggml.model'].trim() : '';
  const tokenizerTokens = typeof metadata['tokenizer.ggml.tokens'] === 'number' ? metadata['tokenizer.ggml.tokens'] : 0;
  const template = typeof metadata['tokenizer.chat_template'] === 'string' && !!metadata['tokenizer.chat_template'].trim();
  const splitCountValue = metadata['split.count'];
  const splitNoValue = metadata['split.no'];
  const splitTensorsValue = metadata['split.tensors.count'];
  let split: ShardMetadata | undefined;
  if (splitCountValue !== undefined) {
    if (!positiveInteger(splitCountValue)) throw new Error('LOCAL_SHARD_METADATA_INVALID');
    if (splitCountValue > 1) {
      if (!nonNegativeInteger(splitNoValue) || splitNoValue >= splitCountValue || !positiveInteger(splitTensorsValue)) throw new Error('LOCAL_SHARD_METADATA_INVALID');
      split = { no: splitNoValue, count: splitCountValue, tensorsCount: splitTensorsValue };
    } else if (splitNoValue !== undefined || splitTensorsValue !== undefined) {
      throw new Error('LOCAL_SHARD_METADATA_INVALID');
    }
  } else if (splitNoValue !== undefined || splitTensorsValue !== undefined) {
    throw new Error('LOCAL_SHARD_METADATA_INVALID');
  }
  const parameters = modelParameters(metadata, architecture);
  let weightBytes: number | undefined;
  try {
    const alignmentValue = metadataNumber(metadata, 'general.alignment') ?? 32;
    const alignment = alignmentValue > 0 && alignmentValue <= 4096 ? alignmentValue : 32;
    for (let i = 0; i < tensorCount; i++) {
      string(false);
      const dimensions = u32();
      if (dimensions > 64) throw invalidHeader();
      for (let dimension = 0; dimension < dimensions; dimension++) u64();
      u32();
      u64();
    }
    const dataOffset = alignedOffset(offset, alignment);
    if (dataOffset <= file.size) weightBytes = file.size - dataOffset;
  } catch (error) {
    if (error instanceof Error && error.message !== 'LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE') throw error;
  }
  const translationProfile = detectTranslationProfile(metadata);
  const parsed: ParsedGguf = { architecture, quantization: quantizationName(metadata['general.file_type']), tokenizer,
    tokenizerTokens, template, ...(translationProfile ? { translationProfile } : {}),
    templateCapability: translationProfile ? { status: 'verified', mode: 'none', supported: translationProfile === 'seed-x' ? ['auto'] : ['auto', 'off'], evidence: 'direct-translation-profile' }
      : detectTemplateCapability(metadata['tokenizer.chat_template'], architecture), tensorCount,
    ...(weightBytes !== undefined ? { weightBytes } : {}), metadataComplete: true, ...parameters, ...(split ? { split } : {}) };
  if (requireCompanions) validateCompanions(parsed);
  return parsed;
}

export async function inspectGguf(file: Blob): Promise<Pick<LocalModelInfo, 'architecture' | 'quantization' | 'tokenizer' | 'template' | 'translationProfile' | 'weightBytes' | 'layerCount' | 'embeddingLength' | 'attentionHeads' | 'kvHeads' | 'keyLength' | 'valueLength' | 'kvKeyDimension' | 'kvValueDimension' | 'kvDimension' | 'contextLength' | 'metadataComplete' | 'templateCapability'>> {
  const parsed = await parseGguf(file, true);
  return { architecture: parsed.architecture, quantization: parsed.quantization, tokenizer: parsed.tokenizer, template: parsed.template,
    ...(parsed.translationProfile ? { translationProfile: parsed.translationProfile } : {}),
    ...(parsed.weightBytes !== undefined ? { weightBytes: parsed.weightBytes } : {}),
    ...(parsed.layerCount !== undefined ? { layerCount: parsed.layerCount } : {}),
    ...(parsed.embeddingLength !== undefined ? { embeddingLength: parsed.embeddingLength } : {}),
    ...(parsed.attentionHeads !== undefined ? { attentionHeads: parsed.attentionHeads } : {}),
    ...(parsed.kvHeads !== undefined ? { kvHeads: parsed.kvHeads } : {}),
    ...(parsed.keyLength !== undefined ? { keyLength: parsed.keyLength } : {}),
    ...(parsed.valueLength !== undefined ? { valueLength: parsed.valueLength } : {}),
    ...(parsed.kvKeyDimension !== undefined ? { kvKeyDimension: parsed.kvKeyDimension } : {}),
    ...(parsed.kvValueDimension !== undefined ? { kvValueDimension: parsed.kvValueDimension } : {}),
    ...(parsed.kvDimension !== undefined ? { kvDimension: parsed.kvDimension } : {}),
    ...(parsed.contextLength !== undefined ? { contextLength: parsed.contextLength } : {}),
    metadataComplete: parsed.metadataComplete, templateCapability: parsed.templateCapability };
}

function compareShardMetadata(entries: FileEntry[], expectedCount: number): void {
  const first = entries.find(entry => entry.parsed.split?.no === 0)!.parsed;
  if (entries.some(entry => !entry.parsed.split || entry.parsed.split.count !== expectedCount)) throw new Error('LOCAL_SHARD_MIXED');
  // llama.cpp's splitter stores full model metadata in shard zero only.
  if (entries.some(entry => entry.parsed.architecture && entry.parsed.architecture !== first.architecture
    || entry.parsed.quantization !== 'unknown' && entry.parsed.quantization !== first.quantization)) throw new Error('LOCAL_SHARD_MIXED');
  const tensorTotals = new Set(entries.map(entry => entry.parsed.split!.tensorsCount));
  if (tensorTotals.size !== 1 || entries.reduce((sum, entry) => sum + entry.parsed.tensorCount, 0) !== first.split!.tensorsCount) throw new Error('LOCAL_SHARD_METADATA_INVALID');
}

function validateFileNames(entries: FileEntry[], expectedCount: number): void {
  const named = entries.filter(entry => entry.filenameShard);
  if (!named.length) return;
  if (named.length !== entries.length) throw new Error('LOCAL_SHARD_MIXED');
  if (new Set(entries.map(entry => entry.name.replace(SHARD_NAME, ''))).size !== 1) throw new Error('LOCAL_SHARD_MIXED');
  const candidates = [0, 1].filter(base => entries.every(entry => entry.filenameShard!.count === expectedCount
    && entry.filenameShard!.no === entry.parsed.split!.no + base));
  if (!candidates.length) throw new Error('LOCAL_SHARD_ORDER_INVALID');
}

async function inspectAndOrderFiles(files: File[]): Promise<OrderedGgufFiles> {
  if (!Array.isArray(files) || !files.length) throw new Error('LOCAL_SELECT_SINGLE_COMPLETE_GGUF');
  const entries: FileEntry[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const name = fileName(file, index);
    if (!name.toLowerCase().endsWith('.gguf')) throw new Error('LOCAL_FORMAT_UNSUPPORTED');
    const parsed = await parseGguf(file, false);
    const match = name.match(SHARD_NAME);
    const filenameShard = match ? { no: Number(match[1])!, count: Number(match[2])! } : undefined;
    entries.push({ file, name, parsed, filenameShard });
  }
  const shardEntries = entries.filter(entry => entry.parsed.split);
  const namedShardEntries = entries.filter(entry => entry.filenameShard);
  if (entries.length === 1 && !shardEntries.length && !namedShardEntries.length) {
    validateCompanions(entries[0]!.parsed);
    const entry = entries[0]!;
    return { files: [entry.file], info: infoFromParsed([entry.name], entry.file.size, entry.parsed) };
  }
  if (!shardEntries.length) throw new Error(namedShardEntries.length ? 'LOCAL_SHARD_METADATA_MISSING' : 'LOCAL_SELECT_SINGLE_COMPLETE_GGUF');
  if (shardEntries.length !== entries.length || entries.some(entry => !entry.parsed.split)) throw new Error('LOCAL_SHARD_MIXED');
  const expectedCount = shardEntries[0]!.parsed.split!.count;
  if (entries.length !== expectedCount) throw new Error('LOCAL_SHARD_SET_INCOMPLETE');
  const numbers = entries.map(entry => entry.parsed.split!.no);
  if (new Set(numbers).size !== numbers.length) throw new Error('LOCAL_SHARD_DUPLICATE');
  if (numbers.some(no => no < 0 || no >= expectedCount) || !numbers.every((no, index) => numbers.includes(index))) throw new Error('LOCAL_SHARD_SET_INCOMPLETE');
  compareShardMetadata(entries, expectedCount);
  validateFileNames(entries, expectedCount);
  const ordered = [...entries].sort((a, b) => a.parsed.split!.no - b.parsed.split!.no);
  const primary = ordered[0]!.parsed;
  validateCompanions(primary);
  const bytes = ordered.reduce((sum, entry) => sum + entry.file.size, 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('LOCAL_FILE_SIZE_INVALID');
  const weightBytes = ordered.every(entry => entry.parsed.weightBytes !== undefined)
    ? ordered.reduce((sum, entry) => sum + (entry.parsed.weightBytes ?? 0), 0) : undefined;
  const parsed: ParsedGguf = { ...primary, ...(weightBytes !== undefined ? { weightBytes } : {}),
    metadataComplete: ordered.every(entry => entry.parsed.metadataComplete) };
  return { files: ordered.map(entry => entry.file), info: infoFromParsed(ordered.map(entry => entry.name), bytes, parsed) };
}

/** Validate a complete single-file or coherent multi-shard selection and return canonical shard order. */
export { inspectAndOrderFiles };

export async function inspectFiles(files: File[]): Promise<LocalModelInfo> {
  return (await inspectAndOrderFiles(files)).info;
}
