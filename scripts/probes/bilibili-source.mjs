import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublic } from './bilibili-http.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('Usage: node scripts/probes/bilibili-source.mjs <BVID>\nWrites captured source evidence to .artifacts/probes/bilibili/source/.');
  process.exit(0);
}
const bvid = args[0];
if (args.length !== 1 || !/^BV[0-9A-Za-z]{10}$/.test(bvid ?? '')) {
  throw new Error('Usage: node scripts/probes/bilibili-source.mjs <BVID>');
}
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const capturedAt = new Date().toISOString();
const runId = capturedAt.replace(/[:.]/g, '-');
const outputDir = resolve(projectRoot, '.artifacts/probes/bilibili/source', `${bvid}-${runId}`);
const output = resolve(outputDir, 'source-evidence.json');
const report = { evidenceLevel: 'HTTP-discovered current page resources and static source; NOT a browser load trace',
  capturedAt,
  bvid, sources: [], quotations: [], missingAnchors: [] };
const sourceMap = new Map();

async function load(label, url) {
  const response = await getPublic(url);
  report.sources.push({ label, ...response.evidence });
  if (response.evidence.status !== 200) throw new Error(`${label}: HTTP ${response.evidence.status}`);
  const source = response.bytes.toString('utf8');
  sourceMap.set(label, source);
  return source;
}
function quote(label, name, needle, { before = 80, after = 650 } = {}) {
  const source = sourceMap.get(label), offset = source.indexOf(needle);
  if (offset < 0) { report.missingAnchors.push({ label, name, needle }); return; }
  const start = Math.max(0, offset - before);
  const lines = source.slice(0, offset).split('\n');
  report.quotations.push({ source: label, name, needle,
    anchorUtf16Offset: offset, line: lines.length, column: lines.at(-1).length + 1,
    excerptStartUtf16Offset: start, excerpt: source.slice(start, offset + after) });
}

try {
  const page = await load('page', `https://www.bilibili.com/video/${bvid}/`);
  const srcs = [...page.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]);
  const coreRef = srcs.find(src => /\/bfs\/static\/player\/main\/core\.[a-f\d]+\.js$/.test(src));
  if (!coreRef) throw new Error('Current player core reference missing; inspect page/version');
  const coreUrl = new URL(coreRef, 'https://www.bilibili.com/').href;
  const core = await load('core', coreUrl);
  quote('page', 'page references core', coreRef, { before: 30, after: coreRef.length + 15 });
  quote('core', 'UGC community helper dependency list', 'getCommunityHelper=function', { after: 500 });
  quote('core', 'public path for dynamic widgets', '__webpack_require__.p=');
  quote('core', 'native API getDanmakuX', 'getDanmakuX:function', { after: 100 });
  quote('core', 'current WBI split first segment', 'i.fetchDmSeg=function', { after: 920 });
  quote('core', 'view pageSize converted to seconds', 'this.pageSize=', { before: 100, after: 200 });
  quote('core', 'protobuf decode', 'o=n.pb2Json.toJson', { after: 370 });
  quote('core', 'protobuf defaults', 'r.toJson=function', { after: 240 });
  quote('core', 'embedded DanmakuElem schema', '"DanmakuElem":{"fields"', { before: 0, after: 1010 });
  quote('core', 'load decoded segment', 'i.loadDmPb=function', { after: 490 });
  quote('core', 'decoded elements appended once', 'i.appendDm=function(n){var r=performance.now()', { after: 200 });
  quote('core', 'list store native queue', 'i.appendDm=function(n){var r=this;if(Array.isArray(n))', { after: 1440 });
  // These numeric chunks belong to the reviewed version's UGC dependency list.
  // Parse only literal hashes from the loader mapping; never eval downloaded JS.
  const loader = core.slice(core.indexOf('__webpack_require__.u=function'));
  for (const chunk of [662, 505]) {
    const hash = loader.match(new RegExp(`(?:[,{])${chunk}:"([a-f0-9]{8})"`))?.[1];
    if (!hash || !core.includes(`i.e(${chunk})`)) throw new Error(`Chunk ${chunk} mapping changed`);
    const name = `npd.${chunk}.${hash}.js`;
    await load(`chunk${chunk}`, new URL(`widgets/${name}`, coreUrl).href);
    quote('core', `chunk ${chunk} content hash`, `${chunk}:"${hash}"`, { before: 0, after: 20 });
  }
  quote('chunk505', 'Danmaku controller module imports', '10193:function', { after: 360 });
  quote('chunk505', 'native parse and addList queue', 'this.dc.addDmList=', { after: 350 });
  quote('chunk505', 'native mode parser', 'e.parseDmList=function', { after: 560 });
  quote('chunk505', 'native text/time parser', 'e.parseCommon=function', { after: 650 });
  quote('chunk505', 'native instance creation', 't.initDanmaku=function', { after: 2490 });
  quote('chunk505', 'existing hook must be preserved', 'hooks:{beforeRender:function', { after: 720 });
  quote('chunk505', 'instance exposed to store', 'this.danmakuStore.danmakuX=', { after: 85 });
  quote('chunk662', 'large-list worker before model creation', 't.prototype.addList=function(t){var e=this;(null==t?', { after: 560 });
  quote('chunk662', 'wire milliseconds become native timeline seconds', 'stime:void 0!==t.stime&&t.stime/1e3', { after: 450 });
  quote('chunk662', 'beforeRender before filtering and construction', 't.prototype.insert=function(t,e){var r=this,n=this.config.scene.isMini;', { after: 550 });
  quote('chunk662', 'native data on flag and model constructor', 't.on=!0,r.initRender(t)', { before: 0, after: 650 });
  quote('chunk662', 'model snapshots text before render', 't.prototype.init=function(t,e){var r=this,n=t.textData', { after: 2680 });
  quote('chunk662', 'normal DOM text write', 'this.element.textContent=tk(this.text)', { after: 145 });
  quote('chunk662', 'normal width derives from new model text', 'e.prototype.getSize=function(){var t=0,e=0,r=this.text', { after: 820 });
  quote('chunk662', 'font width estimator cache', 't.getLen=function', { before: 0, after: 760 });
  quote('chunk662', 'existing hook map dispatch', 't.prototype.callHooks=function', { after: 390 });
  quote('chunk662', 'phase ordering and metadata', 't.prototype.startFrameScheduler=function', { after: 950 });
  quote('chunk662', 'destroy releases native on flag', 't.prototype.destroy=function(){this.spaceManager', { after: 320 });
  const metadata = sourceMap.get('chunk662').match(/getMetadata=function\(\)\{return\{version:"([^"]+)",lastCompiled:"([^"]+)"/);
  report.playerMetadataFromSource = metadata ? { version: metadata[1], lastCompiled: metadata[2] } : null;
  report.runtimeVerified = false;
  report.safeRemeasureVerified = false;
  if (report.missingAnchors.length) process.exitCode = 1;
} catch (error) {
  report.error = /^(Current |Chunk |page: HTTP |core: HTTP |chunk\d+: HTTP )/.test(error.message) ? error.message : 'Transport/source-discovery failed';
  process.exitCode = 1;
} finally {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sources: report.sources, quotations: report.quotations.length,
    missingAnchors: report.missingAnchors, error: report.error, runtimeVerified: false, report: output }, null, 2));
}
