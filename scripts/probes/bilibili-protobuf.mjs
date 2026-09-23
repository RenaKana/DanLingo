// Independent, dependency-free subset of DmSegMobileReply / DmWebViewReply.
// Field numbers verified against the current player's embedded protobuf schema.
// int64 values stay decimal strings; omitted scalars remain omitted (not zero).
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_BYTES = 16 * 1024 * 1024;
const fields = new Map([
  [1, ['id', 'int64']], [2, ['progress', 'int32']], [3, ['mode', 'int32']],
  [4, ['fontsize', 'int32']], [5, ['color', 'uint32']], [6, ['midHash', 'string']],
  [7, ['content', 'string']], [8, ['ctime', 'int64']], [9, ['weight', 'int32']],
  [10, ['action', 'string']], [11, ['pool', 'int32']], [12, ['idStr', 'string']],
  [13, ['attr', 'int32']], [22, ['animation', 'string']], [24, ['colorful', 'int32']],
  [26, ['oid', 'int64']], [27, ['dmFrom', 'int32']],
]);

class Reader {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw new Error('Invalid protobuf input size');
    this.bytes = bytes; this.pos = 0;
  }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.bytes.length) throw new Error('Truncated protobuf field');
    const value = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return value;
  }
  varint() {
    let value = 0n;
    for (let n = 0; n < 10; n++) {
      const byte = this.take(1)[0];
      if (n === 9 && byte > 1) throw new Error('Varint exceeds uint64');
      value |= BigInt(byte & 127) << BigInt(n * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('Unterminated varint');
  }
  tag() {
    const value = this.varint();
    const field = Number(value >> 3n), wire = Number(value & 7n);
    if (field < 1 || field > 0x1fffffff) throw new Error('Invalid field number');
    return { field, wire };
  }
  blob() {
    const length = this.varint();
    if (length > BigInt(MAX_BYTES)) throw new Error('Length exceeds probe limit');
    return this.take(Number(length));
  }
  skip(wire) {
    switch (wire) {
      case 0: this.varint(); return;
      case 1: this.take(8); return;
      case 2: this.blob(); return;
      case 5: this.take(4); return;
      default: throw new Error(`Unsupported wire type ${wire}`);
    }
  }
}

function checkWire(actual, expected) {
  if (actual !== expected) throw new Error(`Wire type ${actual}, expected ${expected}`);
}

export function decodeElement(bytes) {
  const reader = new Reader(bytes), result = {}, unknown = new Set();
  while (reader.pos < bytes.length) {
    const { field, wire } = reader.tag(), spec = fields.get(field);
    if (!spec) { reader.skip(wire); unknown.add(field); continue; }
    const [name, type] = spec;
    checkWire(wire, type === 'string' ? 2 : 0);
    if (type === 'string') result[name] = utf8.decode(reader.blob());
    else {
      const value = reader.varint();
      result[name] = type === 'int64' ? BigInt.asIntN(64, value).toString() :
        Number(type === 'int32' ? BigInt.asIntN(32, value) : BigInt.asUintN(32, value));
    }
  }
  if (unknown.size) result.unknownFieldNumbers = [...unknown].sort((a, b) => a - b);
  return result;
}

export function decodeSegment(bytes) {
  const reader = new Reader(bytes), elems = [], unknown = new Set();
  while (reader.pos < bytes.length) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      checkWire(wire, 2);
      if (elems.length >= 100_000) throw new Error('Too many elements');
      elems.push(decodeElement(reader.blob()));
    } else { reader.skip(wire); unknown.add(field); }
  }
  return { elems, unknownFieldNumbers: [...unknown].sort((a, b) => a - b) };
}

export function decodeViewSegmentConfig(bytes) {
  const reader = new Reader(bytes);
  let result = null;
  while (reader.pos < bytes.length) {
    const { field, wire } = reader.tag();
    if (field !== 4) { reader.skip(wire); continue; }
    checkWire(wire, 2);
    const child = new Reader(reader.blob());
    result ??= {};
    while (child.pos < child.bytes.length) {
      const tag = child.tag();
      if (tag.field === 1 || tag.field === 2) {
        checkWire(tag.wire, 0);
        result[tag.field === 1 ? 'pageSize' : 'total'] = BigInt.asIntN(64, child.varint()).toString();
      } else child.skip(tag.wire);
    }
  }
  return result;
}

// Encoder is for sanitized fixtures only; never used to send/alter server data.
export function encodeVarint(input) {
  let value = BigInt(input);
  if (value < -(1n << 63n) || value > (1n << 64n) - 1n) throw new Error('Integer outside 64-bit range');
  value = BigInt.asUintN(64, value);
  const bytes = [];
  while (value > 127n) { bytes.push(Number(value & 127n) | 128); value >>= 7n; }
  bytes.push(Number(value)); return Buffer.from(bytes);
}

export function encodeField(number, value, string = false) {
  const key = encodeVarint(BigInt(number) * 8n + (string ? 2n : 0n));
  if (!string) return Buffer.concat([key, encodeVarint(value)]);
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return Buffer.concat([key, encodeVarint(bytes.length), bytes]);
}

export function encodeSegment(elems) {
  return Buffer.concat(elems.map(elem => encodeField(1, Buffer.concat([...fields]
    .filter(([, [name]]) => Object.hasOwn(elem, name))
    .map(([number, [name, type]]) => encodeField(number, elem[name], type === 'string'))), true)));
}

export function sanitizeElements(elems, maximum = 8) {
  // Re-encode a small sample, never store a raw segment, user hash, source ID,
  // timestamps, animation JSON, URLs, comment text or its hash.
  return elems.slice(0, maximum).map((elem, index) => {
    const safe = {};
    for (const name of ['progress', 'mode', 'fontsize', 'color', 'weight', 'pool', 'attr', 'colorful', 'dmFrom']) {
      if (Object.hasOwn(elem, name)) safe[name] = elem[name];
    }
    if (Object.hasOwn(elem, 'id')) safe.id = String(9_007_199_254_740_993n + BigInt(index));
    if (Object.hasOwn(elem, 'idStr')) safe.idStr = String(9_007_199_254_740_993n + BigInt(index));
    if (Object.hasOwn(elem, 'ctime')) safe.ctime = '946684800';
    if (Object.hasOwn(elem, 'midHash')) safe.midHash = 'redacted';
    if (Object.hasOwn(elem, 'content')) safe.content = `脱敏样本${index + 1} / sample 🙂`;
    if (Object.hasOwn(elem, 'action')) safe.action = '';
    if (Object.hasOwn(elem, 'animation')) safe.animation = '';
    if (Object.hasOwn(elem, 'oid')) safe.oid = '0';
    return safe;
  });
}
