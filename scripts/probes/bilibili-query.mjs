import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublic, sha256 } from './bilibili-http.mjs';
import { decodeSegment, decodeViewSegmentConfig, encodeSegment, sanitizeElements } from './bilibili-protobuf.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('Usage: node scripts/probes/bilibili-query.mjs <BVID> [page]\nWrites the report and sanitized samples to .artifacts/probes/bilibili/query/.');
  process.exit(0);
}
const bvid = args[0];
const page = Number(args[1] ?? 1);
if (args.length < 1 || args.length > 2 || !/^BV[0-9A-Za-z]{10}$/.test(bvid ?? '')
  || !Number.isSafeInteger(page) || page < 1) {
  throw new Error('Usage: node scripts/probes/bilibili-query.mjs <BVID> [page]');
}
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const capturedAt = new Date().toISOString();
const runId = capturedAt.replace(/[:.]/g, '-');
const outputDir = resolve(projectRoot, '.artifacts/probes/bilibili/query', `${bvid}-p${page}-${runId}`);
mkdirSync(outputDir, { recursive: true });
const requests = [];
const report = { evidenceLevel: 'anonymous HTTP query; not browser/native verification', capturedAt, bvid, page, requests };
const output = resolve(outputDir, 'report.json');
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');

async function request(url) {
  try {
    const response = await getPublic(url);
    requests.push(response.evidence);
    const prefix = response.bytes.subarray(0, 100).toString('utf8').trimStart();
    if (response.evidence.status !== 200) throw new Error(`HTTP ${response.evidence.status}`);
    if (prefix.startsWith('{')) {
      const json = JSON.parse(response.bytes.toString('utf8'));
      response.evidence.apiCode = json.code ?? null;
      if (json.code !== 0) throw new Error(`API code ${json.code ?? 'missing'}`);
      response.json = json;
    }
    return response;
  } catch (error) {
    // Do not serialize server error bodies (or a subprocess stderr/body).
    throw new Error(`GET failed for ${url}: ${/^(HTTP |API code )/.test(error.message) ? error.message : 'transport/decode failure'}`);
  }
}

function coverage(elems, start, end) {
  const values = elems.flatMap(e => Number.isInteger(e.progress) ? [e.progress] : []);
  const modeCounts = {}, fieldPresence = {}, unknownElementFields = {};
  for (const elem of elems) {
    const mode = String(elem.mode ?? 'missing'); modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
    for (const key of Object.keys(elem)) fieldPresence[key] = (fieldPresence[key] ?? 0) + 1;
    for (const field of elem.unknownFieldNumbers ?? []) unknownElementFields[field] = (unknownElementFields[field] ?? 0) + 1;
  }
  return { returnedCount: elems.length, minProgressMs: values.length ? Math.min(...values) : null,
    maxProgressMs: values.length ? Math.max(...values) : null, progressOmittedOnWire: elems.length - values.length,
    effectiveMinProgressMsWithProtoDefault: elems.length ? Math.min(...elems.map(e => e.progress ?? 0)) : null,
    outsideRequestedRange: values.filter(x => x < start || x >= end).length,
    modeCounts, fieldPresence, unknownElementFields, completeHistory: false };
}

try {
  const meta = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const data = meta.json?.data;
  const selected = data?.pages?.find(p => p.page === page);
  if (!selected || !Number.isSafeInteger(selected.cid) || !Number.isSafeInteger(data.aid)) throw new Error('Missing safe aid/CID/page');
  report.media = { bvid: data.bvid, aid: String(data.aid), cid: String(selected.cid),
    durationSeconds: selected.duration, pages: data.pages.map(p => ({ page: p.page, cid: String(p.cid), durationSeconds: p.duration })) };
  const query = `type=1&oid=${selected.cid}&pid=${data.aid}`;
  try {
    const view = await request(`https://api.bilibili.com/x/v2/dm/web/view?${query}`);
    if (view.json) throw new Error('Expected protobuf');
    report.segmentConfig = decodeViewSegmentConfig(view.bytes);
  } catch (error) { report.viewError = error.message; }
  // Exact current player first-segment optimization is separately tested unsigned.
  // No WBI bypass/signature fabrication, login or automatic retries.
  const probes = [
    { label: 'legacy-segment-1', path: 'web/seg.so', extra: 'segment_index=1', start: 0, end: 360_000 },
    ...(selected.duration > 360 ? [{ label: 'legacy-segment-2', path: 'web/seg.so', extra: 'segment_index=2', start: 360_000, end: 720_000 }] : []),
    { label: 'current-wbi-first120-unsigned', path: 'wbi/web/seg.so', extra: 'segment_index=1&pull_mode=1&ps=0&pe=120000', start: 0, end: 120_000 },
  ];
  report.segments = [];
  for (const probe of probes) {
    const item = { label: probe.label, requestedRangeMs: [probe.start, probe.end] };
    report.segments.push(item);
    try {
      const response = await request(`https://api.bilibili.com/x/v2/dm/${probe.path}?${query}&${probe.extra}`);
      if (response.json) throw new Error('Expected protobuf segment; got API JSON');
      const decoded = decodeSegment(response.bytes);
      Object.assign(item, coverage(decoded.elems, probe.start, probe.end), { unknownEnvelopeFields: decoded.unknownFieldNumbers });
      const safe = sanitizeElements(decoded.elems), binary = encodeSegment(safe);
      const fixture = { evidenceLevel: 'live-response-redacted-synthetic-payload',
        origin: 'Derived from one live response; field coverage is observed, while text and IDs are synthetic.',
        source: response.evidence, requestedRangeMs: item.requestedRangeMs,
        redaction: 'First up to eight elements; IDs/user hashes/timestamps/text/URLs removed or replaced. Unknown fields dropped. This is NOT raw server protobuf.',
        expected: safe, sanitizedProtobufBase64: binary.toString('base64'), sanitizedSha256: sha256(binary) };
      const name = `sample-${probe.label}.json`;
      writeFileSync(resolve(outputDir, name), JSON.stringify(fixture, null, 2) + '\n');
      item.sampleFixture = name;
    } catch (error) { item.error = error.message; }
    save();
  }
  report.limitations = ['Not complete history; only requested public windows at this time.',
    'Unsigned WBI query success/failure does not establish all signed/browser sessions.',
    'HTTP resource discovery is not a browser network trace or native rendering pass.',
    'No Provider call or real translation performed.'];
  report.status = report.segments.some(segment => segment.error) ? 'partial-or-failed' : 'queries-decoded';
  if (report.segments.every(segment => segment.error)) process.exitCode = 1;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { save(); console.log(JSON.stringify(report, null, 2)); console.log(output); }
