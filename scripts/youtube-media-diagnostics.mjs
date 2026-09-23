// Pure projections: also serialized into the anonymous page probe where indicated.
export function bufferEvidence(ranges, currentTime) {
  if (!Number.isFinite(currentTime) || currentTime < 0 || !Array.isArray(ranges)
    || ranges.some(range => !range || !Number.isFinite(range.start) || !Number.isFinite(range.end)
      || range.start < 0 || range.end < range.start)) {
    return { valid: false, bufferAheadSeconds: null, continuousEnd: null };
  }
  const ordered = ranges.map(range => ({ ...range })).sort((a, b) => a.start - b.start);
  let end = null;
  for (const range of ordered) {
    if (end === null) {
      if (range.start <= currentTime && currentTime <= range.end) end = range.end;
    } else if (range.start <= end) end = Math.max(end, range.end);
    else break; // Never bridge even a small unbuffered hole.
  }
  return { valid: true, bufferAheadSeconds: end === null ? 0 : end - currentTime, continuousEnd: end };
}

export function normalProgress(previous, current) {
  const healthy = row => row && row.roomMatches && row.videoPresent && row.currentTime > 0
    && row.paused === false && row.seeking === false && row.ended === false && row.readyState >= 3
    && !row.ad && !row.visibleError && !row.errorCode && row.playbackRate === 1;
  if (!healthy(previous) || !healthy(current) || previous.documentSequence !== current.documentSequence
    || previous.videoGeneration !== current.videoGeneration) return false;
  const elapsed = (current.runMs - previous.runMs) / 1000;
  const progress = current.currentTime - previous.currentTime;
  return elapsed >= 0.15 && elapsed <= 1 && progress >= elapsed * 0.5
    && progress <= elapsed * 1.5 + 0.05;
}

const STATES = new Set(['kCreated', 'kStarting', 'kPlaying', 'kSeeking', 'kSuspending', 'kSuspended',
  'kResuming', 'kStopping', 'kStopped', 'kEnded', 'kError', 'BUFFERING_HAVE_NOTHING',
  'BUFFERING_HAVE_ENOUGH', 'DEMUXER_UNDERFLOW', 'DECODER_UNDERFLOW', 'REMOTING_NETWORK_CONGESTION',
  'BUFFERING_CHANGE_REASON_UNKNOWN', 'unknown', 'playing', 'paused', 'stopped', 'starting']);
const EVENTS = new Set(['kWebMediaPlayerCreated', 'kWebMediaPlayerDestroyed', 'kLoad', 'kPlay', 'kPause',
  'kEnded', 'kSuspended', 'kBufferingStateChanged', 'kPipelineStateChanged', 'kAudioBufferingStateChanged',
  'kVideoBufferingStateChanged', 'kVideoDecoderConfigChanged', 'kAudioDecoderConfigChanged',
  'kVideoTrackChange', 'kAudioTrackChange', 'kDurationChanged', 'kResolutionChanged', 'kSeek']);
const DECODERS = new Set(['FFmpegVideoDecoder', 'VpxVideoDecoder', 'Dav1dVideoDecoder', 'D3D11VideoDecoder',
  'MojoVideoDecoder', 'VaapiVideoDecoder', 'VideoToolboxVideoDecoder', 'MediaFoundationVideoDecoder',
  'FFmpegAudioDecoder', 'MojoAudioDecoder', 'AudioToolboxAudioDecoder', 'MediaFoundationAudioDecoder']);
const ERROR_CODES = new Set(['PIPELINE_OK', 'PIPELINE_ERROR_NETWORK', 'PIPELINE_ERROR_DECODE',
  'PIPELINE_ERROR_ABORT', 'PIPELINE_ERROR_INITIALIZATION_FAILED', 'PIPELINE_ERROR_COULD_NOT_RENDER',
  'PIPELINE_ERROR_READ', 'PIPELINE_ERROR_INVALID_STATE', 'DEMUXER_ERROR_COULD_NOT_OPEN',
  'DEMUXER_ERROR_COULD_NOT_PARSE', 'DEMUXER_ERROR_NO_SUPPORTED_STREAMS', 'DEMUXER_ERROR_DETECTED_HLS',
  'DECODER_ERROR_NOT_SUPPORTED', 'DECODER_ERROR_FAILED', 'DECODER_ERROR_DECODE',
  'CHUNK_DEMUXER_ERROR_APPEND_FAILED', 'CHUNK_DEMUXER_ERROR_EOS_STATUS_DECODE_ERROR',
  'CHUNK_DEMUXER_ERROR_EOS_STATUS_NETWORK_ERROR', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK',
  'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED']);
const NUMBER_KEYS = new Set(['duration', 'seek_target', 'video_frames_decoded', 'video_frames_dropped',
  'audio_bytes_decoded', 'video_bytes_decoded', 'kVideoPlaybackRoughness', 'kVideoPlaybackFreezing']);
const BOOLEAN_KEYS = new Set(['kIsPlatformVideoDecoder', 'kIsPlatformAudioDecoder', 'kIsVideoDecryptingDemuxerStream',
  'kIsAudioDecryptingDemuxerStream']);
const STATE_KEYS = new Set(['pipeline_state', 'kPipelineState', 'state', 'reason']);
const NESTED_KEYS = new Set(['audio_buffering_state', 'video_buffering_state', 'pipeline_buffering_state']);

// No arbitrary string is returned, including unrecognized key names or enum values.
export function mediaProjection(input, depth = 0) {
  const values = {};
  let omitted = 0;
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 1) return { values, omitted: 1 };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'event' && EVENTS.has(value)) values[key] = value;
    else if (STATE_KEYS.has(key) && STATES.has(value)) values[key] = value;
    else if (['kVideoDecoderName', 'kAudioDecoderName'].includes(key) && DECODERS.has(value)) values[key] = value;
    else if (['error', 'pipeline_error'].includes(key) && ERROR_CODES.has(value)) values[key] = value;
    else if (NUMBER_KEYS.has(key) && (typeof value === 'number' || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))
      && Number.isFinite(Number(value))) values[key] = Number(value);
    else if (BOOLEAN_KEYS.has(key) && [true, false, 'true', 'false'].includes(value)) values[key] = value === true || value === 'true';
    else if (NESTED_KEYS.has(key) && depth === 0) {
      const nested = mediaProjection(value, depth + 1);
      if (Object.keys(nested.values).length) values[key] = nested.values;
      omitted += nested.omitted;
    } else omitted++;
  }
  return { values, omitted };
}

export function mediaMessageCodes(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.slice(0, 8192).match(/\b[A-Z][A-Z0-9_]+\b/g) || [])]
    .filter(word => ERROR_CODES.has(word)).slice(0, 20);
}

// Anonymous CDN diagnostics only: never return body text or arbitrary header values.
export function cdnResponseProjection(response) {
  const knownMime = new Set(['video/mp4', 'audio/mp4', 'video/webm', 'audio/webm',
    'application/octet-stream', 'application/vnd.yt-ump', 'text/plain', 'text/html', 'application/json']);
  const mime = String(response?.mimeType || '').toLowerCase().split(';')[0].trim();
  return { mime: knownMime.has(mime) ? mime : 'other',
    protocol: ['h2', 'h3', 'http/1.1', 'http/1.0'].includes(response?.protocol) ? response.protocol : 'other',
    fromDiskCache: response?.fromDiskCache === true, fromServiceWorker: response?.fromServiceWorker === true };
}

export function smallCdnBodyProjection(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4096) return { kind: 'not-inspected-size-limit' };
  let kind = bytes.length === 0 ? 'empty' : 'unknown';
  const text = new TextDecoder().decode(bytes).trimStart();
  if (/^(?:<!doctype html\b|<html\b)/i.test(text)) kind = 'html';
  else if (/^[\[{]/.test(text)) {
    try { JSON.parse(text); kind = 'json'; } catch { /* incomplete or non-JSON bytes */ }
  }
  const box = String.fromCharCode(...bytes.slice(4, 8));
  if (['ftyp', 'styp', 'moof', 'mdat', 'sidx'].includes(box)) kind = 'iso-bmff-signature';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) kind = 'ebml-signature';
  return { kind, decodedBytes: bytes.length };
}

export const UMP_REFERENCE = 'LuanRT/googlevideo@58f92b7ba8fc252a510963f003088279a00d4ab0';
// UMP uses its own prefix-length integers, NOT protobuf varints.
// Reference: src/core/UmpReader.ts; SabrError field 2 is int32 in sabr_error.proto.
export function umpVarInt(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset], size = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
  if (offset + size > bytes.length) return null;
  let value = size === 5 ? 0 : first & [0, 127, 63, 31, 15][size];
  let factor = size === 5 ? 1 : 2 ** (8 - size);
  for (let i = 1; i < size; i++) { value += bytes[offset + i] * factor; factor *= 256; }
  return { value, next: offset + size };
}

function numericUmpProtoProjection(bytes, protection = false) {
  let offset = 0, omittedFields = 0, fields = 0;
  const values = protection ? { status: null, maxRetries: null } : { code: null };
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('truncated');
      const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw new Error('invalid');
  };
  try {
    while (offset < bytes.length && fields++ < 64) {
      const tag = varint(), field = tag >> 3n, wire = Number(tag & 7n);
      if (!field) throw new Error('invalid');
      if (wire === 0) {
        const value = varint();
        const key = protection ? field === 1n ? 'status' : field === 2n ? 'maxRetries' : null : field === 2n ? 'code' : null;
        if (key) values[key] = Number(BigInt.asIntN(32, value)); else omittedFields++;
      } else {
        const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : NaN;
        if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Error('invalid');
        offset += length; omittedFields++;
      }
    }
    return { complete: offset === bytes.length, ...values, omittedFields, numericMeaning: 'not-assigned-by-public-schema' };
  } catch { return { complete: false, omittedFields, numericMeaning: 'not-assigned-by-public-schema' }; }
}

export function umpBodyProjection(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4096) return { complete: false, reason: 'size-limit', parts: [] };
  const parts = []; let offset = 0;
  while (offset < bytes.length && parts.length < 128) {
    const type = umpVarInt(bytes, offset);
    const size = type && umpVarInt(bytes, type.next);
    if (!size) return { complete: false, reason: 'truncated-header', parsedBytes: offset, parts };
    const end = size.next + size.value;
    const complete = end <= bytes.length;
    const row = { type: type.value, length: size.value, complete };
    // All other payloads (including redirect URLs, cookies, identifiers and error type strings) remain unread.
    if (complete && type.value === 44) row.sabrError = numericUmpProtoProjection(bytes.subarray(size.next, end));
    if (complete && type.value === 58) {
      row.streamProtection = numericUmpProtoProjection(bytes.subarray(size.next, end), true);
      // Fixed public SabrStream.ts handleStreamProtectionStatus; not an official YouTube contract.
      row.streamProtection.referenceInterpretation = row.streamProtection.complete && row.streamProtection.status === 3
        ? 'attestation-required' : row.streamProtection.complete && row.streamProtection.status === 2 ? 'attestation-pending' : 'unassigned';
    }
    parts.push(row);
    if (!complete) return { complete: false, reason: 'truncated-part', parsedBytes: offset, parts };
    offset = end;
  }
  return { complete: offset === bytes.length, reason: offset === bytes.length ? 'complete' : 'part-limit', parsedBytes: offset, parts };
}

export function mediaMessageProjection(level, text) {
  const safe = new Set([...ERROR_CODES, ...STATES, ...EVENTS, ...DECODERS]);
  const codes = typeof text === 'string' ? [...new Set(text.slice(0, 8192).match(/[A-Za-z][A-Za-z0-9_]+/g) || [])].filter(code => safe.has(code)).slice(0, 20) : [];
  return { level: ['info', 'debug', 'warning', 'error'].includes(level) ? level : 'other', codes,
    codeUnavailable: codes.length === 0, textTruncated: typeof text === 'string' && text.length > 8192 };
}

export function mediaOmissionKinds(input, depth = 0) {
  const counts = { string: 0, number: 0, boolean: 0, object: 0, other: 0 };
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 1) { counts.other++; return counts; }
  for (const [key, value] of Object.entries(input)) {
    if (NESTED_KEYS.has(key) && depth === 0) {
      const child = mediaOmissionKinds(value, 1);
      for (const kind of Object.keys(counts)) counts[kind] += child[kind];
    } else if (mediaProjection({ [key]: value }, depth).omitted) {
      const kind = value === null ? 'other' : typeof value;
      counts[Object.hasOwn(counts, kind) ? kind : 'other']++;
    }
  }
  return counts;
}

// Self-contained for serialization into the page. Never returns reason/message text.
export function youtubeAppProjection(response, videoData, requestedRoom) {
  const status = response?.playabilityStatus?.status;
  const known = ['OK', 'ERROR', 'UNPLAYABLE', 'LOGIN_REQUIRED', 'LIVE_STREAM_OFFLINE', 'CONTENT_CHECK_REQUIRED', 'AGE_CHECK_REQUIRED'];
  const rawCode = videoData?.errorCode;
  const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' && /^\d{1,7}$/.test(rawCode) ? Number(rawCode) : null;
  return { responseAvailable: !!response, responseRoomMatches: response?.videoDetails?.videoId === requestedRoom,
    playabilityStatus: known.includes(status) ? status : status == null ? 'unavailable' : 'other',
    reasonPresentButOmitted: typeof response?.playabilityStatus?.reason === 'string',
    errorScreenPresent: !!response?.playabilityStatus?.errorScreen,
    videoDataCodePresent: rawCode != null, videoDataErrorCode: Number.isInteger(code) && code >= 0 && code <= 1000000 ? code : null,
    isLiveNow: response?.videoDetails?.isLive === true || response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true };
}
