import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferEvidence, normalProgress, mediaProjection, mediaMessageCodes, cdnResponseProjection, smallCdnBodyProjection,
  umpVarInt, umpBodyProjection, mediaMessageProjection, mediaOmissionKinds, youtubeAppProjection } from './youtube-media-diagnostics.mjs';

test('UMP prefix integers cover all five widths and incomplete headers', () => {
  for (const [bytes, expected] of [[[127], 127], [[0x80, 2], 128], [[0xc0, 0, 2], 16384],
    [[0xe0, 0, 0, 2], 2097152], [[0xf0, 0, 0, 0, 16], 268435456], [[0xff, 255, 255, 255, 255], 4294967295]]) {
    assert.deepEqual(umpVarInt(Uint8Array.from(bytes), 0), { value: expected, next: bytes.length });
    if (bytes.length > 1) assert.equal(umpVarInt(Uint8Array.from(bytes.slice(0, -1)), 0), null);
  }
});

test('UMP projections decode known numeric fields while omitting strings and unknown payloads', () => {
  const secret = Buffer.from('SECRET_signed_url_cookie');
  const error = Buffer.concat([Buffer.from([44, secret.length + 4, 10, secret.length]), secret, Buffer.from([16, 7])]);
  const result = umpBodyProjection(error);
  assert.equal(result.complete, true);
  assert.equal(result.parts[0].sabrError.code, 7);
  assert.equal(result.parts[0].sabrError.omittedFields, 1);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  const protection = umpBodyProjection(Uint8Array.from([58, 4, 8, 3, 16, 10]));
  assert.deepEqual(protection.parts[0].streamProtection, { complete: true, status: 3, maxRetries: 10, omittedFields: 0, numericMeaning: 'not-assigned-by-public-schema', referenceInterpretation: 'attestation-required' });
  assert.equal(umpBodyProjection(Uint8Array.from([58, 2, 8, 2])).parts[0].streamProtection.referenceInterpretation, 'attestation-pending');
  const unknown = umpBodyProjection(Buffer.concat([Buffer.from([43, secret.length]), secret]));
  assert.deepEqual(unknown.parts, [{ type: 43, length: secret.length, complete: true }]);
});

test('UMP truncation, malformed protobuf and part/size limits never become a valid error', () => {
  assert.equal(umpBodyProjection(Uint8Array.from([58])).reason, 'truncated-header');
  assert.equal(umpBodyProjection(Uint8Array.from([58, 4, 8])).reason, 'truncated-part');
  assert.equal(umpBodyProjection(Uint8Array.from([44, 1, 16])).parts[0].sabrError.complete, false);
  assert.equal(umpBodyProjection(Uint8Array.from([44, 1, 0])).parts[0].sabrError.complete, false);
  assert.equal(umpBodyProjection(new Uint8Array(4097)).reason, 'size-limit');
  assert.equal(umpBodyProjection(new Uint8Array(258)).reason, 'part-limit');
  assert.equal(umpBodyProjection(Uint8Array.from([21, 0, 22, 0])).parts.length, 2);
});

test('information-level Media signals and omission categories retain no arbitrary strings', () => {
  const info = mediaMessageProjection('info', 'SECRET https://host/?token=SECRET kStopping PIPELINE_ERROR_NETWORK');
  assert.deepEqual(info.codes, ['kStopping', 'PIPELINE_ERROR_NETWORK']);
  assert.equal(info.level, 'info');
  assert.equal(JSON.stringify(info).includes('SECRET'), false);
  assert.equal(mediaMessageProjection('SECRET', 'SECRET').level, 'other');
  assert.equal(mediaMessageProjection('debug', 'SECRET').codeUnavailable, true);
  assert.deepEqual(mediaOmissionKinds({ secretName: 'SECRET', arbitrary: 42, video_buffering_state: { state: 'SECRET' } }),
    { string: 2, number: 1, boolean: 0, object: 0, other: 0 });
});

test('YouTube application state is identity-bound with only known statuses and numeric error codes', () => {
  const result = youtubeAppProjection({ videoDetails: { videoId: 'room', isLive: true },
    playabilityStatus: { status: 'ERROR', reason: 'SECRET', errorScreen: { arbitrary: 'SECRET' } } }, { errorCode: '153' }, 'room');
  assert.equal(result.responseRoomMatches, true); assert.equal(result.playabilityStatus, 'ERROR');
  assert.equal(result.videoDataErrorCode, 153); assert.equal(result.reasonPresentButOmitted, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(youtubeAppProjection({ playabilityStatus: { status: 'SECRET' } }, { errorCode: 'SECRET' }, 'room').playabilityStatus, 'other');
});

test('small CDN classification never returns raw text, headers or signed addresses', () => {
  for (const [body, kind] of [['<!doctype html><html>SECRET</html>', 'html'], ['{"token":"SECRET"}', 'json'], ['', 'empty'], ['SECRET', 'unknown']]) {
    const result = smallCdnBodyProjection(Buffer.from(body));
    assert.equal(result.kind, kind);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
  assert.equal(smallCdnBodyProjection(Buffer.from([0, 0, 0, 12, 102, 116, 121, 112])).kind, 'iso-bmff-signature');
  assert.equal(smallCdnBodyProjection(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])).kind, 'ebml-signature');
  assert.equal(smallCdnBodyProjection(new Uint8Array(4097)).kind, 'not-inspected-size-limit');
  assert.deepEqual(cdnResponseProjection({ mimeType: 'SECRET', protocol: 'SECRET', headers: { token: 'SECRET' } }),
    { mime: 'other', protocol: 'other', fromDiskCache: false, fromServiceWorker: false });
});

test('buffer ahead comes from the continuous range containing the current position', () => {
  assert.deepEqual(bufferEvidence([{ start: 0, end: 10 }, { start: 20, end: 40 }], 25),
    { valid: true, bufferAheadSeconds: 15, continuousEnd: 40 });
  assert.equal(bufferEvidence([{ start: 0, end: 10 }, { start: 10, end: 12 }], 9).bufferAheadSeconds, 3);
});

test('future ranges, empty buffers and tiny holes do not inflate available media', () => {
  for (const [ranges, position] of [[[], 2], [[{ start: 20, end: 40 }], 10], [[{ start: 0, end: 10 }, { start: 20, end: 40 }], 15]]) {
    assert.equal(bufferEvidence(ranges, position).bufferAheadSeconds, 0);
  }
  assert.equal(bufferEvidence([{ start: 0, end: 10 }, { start: 10.001, end: 40 }], 9).bufferAheadSeconds, 1);
  assert.equal(bufferEvidence([{ start: 0, end: 10 }, { start: 20, end: 40 }], 10).bufferAheadSeconds, 0);
});

test('unavailable or invalid times are unknown rather than positive buffers', () => {
  for (const [ranges, position] of [[[], NaN], [[], null], [[{ start: 0, end: Infinity }], 2],
    [[{ start: NaN, end: 10 }], 2], [[{ start: 10, end: 2 }], 2], [null, 2]]) {
    assert.deepEqual(bufferEvidence(ranges, position), { valid: false, bufferAheadSeconds: null, continuousEnd: null });
  }
});

const sample = (runMs, currentTime, patch = {}) => ({ runMs, currentTime, roomMatches: true, videoPresent: true,
  documentSequence: 1, videoGeneration: 1, paused: false, seeking: false, ended: false, readyState: 4,
  ad: false, visibleError: false, errorCode: null, playbackRate: 1, ...patch });
test('startup jumps, stalled time, element changes and missing intervals cannot anchor the window', () => {
  assert.equal(normalProgress(sample(0, 100), sample(250, 100.25)), true);
  for (const [previous, current] of [[sample(0, 0), sample(250, 4000)], [sample(0, 100), sample(250, 4000)],
    [sample(0, 100), sample(250, 100)], [sample(0, 100), sample(250, 100.25, { videoGeneration: 2 })],
    [sample(0, 100), sample(250, 100.25, { documentSequence: 2 })], [sample(0, 100), sample(2000, 102)]]) {
    assert.equal(normalProgress(previous, current), false);
  }
});

test('Media output retains only known enums and numbers, including nested buffering state', () => {
  const raw = { event: 'kPlay', pipeline_state: 'kPlaying', video_buffering_state: { state: 'BUFFERING_HAVE_NOTHING',
    reason: 'DEMUXER_UNDERFLOW', url: 'https://example.test/signed?token=SECRET' },
  kVideoDecoderName: 'D3D11VideoDecoder', duration: '90.25', url: 'https://example.test/?key=SECRET',
  arbitrarySecretKey: 'SECRET', kAudioDecoderName: 'SECRET', kIsPlatformVideoDecoder: 'true' };
  const result = mediaProjection(raw);
  assert.deepEqual(result.values, { event: 'kPlay', pipeline_state: 'kPlaying', video_buffering_state: {
    state: 'BUFFERING_HAVE_NOTHING', reason: 'DEMUXER_UNDERFLOW' }, kVideoDecoderName: 'D3D11VideoDecoder',
  duration: 90.25, kIsPlatformVideoDecoder: true });
  assert.equal(result.omitted, 4);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(mediaMessageCodes('https://example.test/?token=SECRET PIPELINE_ERROR_DECODE PIPELINE_ERROR_SECRET'), ['PIPELINE_ERROR_DECODE']);
});
