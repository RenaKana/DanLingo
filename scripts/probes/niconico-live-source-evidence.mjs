// Extract narrow, hash-verified statements from the actual captured official watch-page bundles.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const watchId = process.argv[2] || 'lv351351036';
if (!/^lv\d+$/.test(watchId)) throw new Error('Expected lv ID');
const root = resolve('.artifacts/live/l0/niconico', watchId);
const report = JSON.parse(await readFile(resolve(root, 'report.json'), 'utf8'));
const rules = [
  ['protobuf-chat-fields', 'nicolib.', 'dwango.nicolive.chat.data.Chat', 0, 1000],
  ['protobuf-envelope-fields', 'nicolib.', 'dwango.nicolive.chat.service.edge.ChunkedMessage', 0, 1600],
  ['decoded-event', 'nicolib.', 'dispatchMessage(e)', 0, 250],
  ['wire-to-native-comment', 'usecase.', 'no:t.no,vpos:t.vpos', 300, 900],
  ['epoch-to-program-time', 'usecase.', 'this.param.videoPositionBaseTime', 170, 220],
  ['native-live-receipt-clock', 'pc-watch.', 'async renderUserComment(e)', 280, 1200],
  ['program-video-not-page-ad', 'pc-watch.', "document.querySelector(\"[data-layer-name='videoLayer'] video\")", 100, 130],
  ['live-chase-dom-state', 'pc-watch.', '"data-live-status":"chase"', 90, 420],
  ['program-clock-base', 'domain.', 'get msFromVposBaseTime()', 0, 250],
  ['native-input', 'comment-renderer.', 'async addToRender(t,e)', 0, 900],
  ['native-filter-before-conversion', 'comment-renderer.', 't.prototype._addReceivedChatListByStreaming=function', 0, 520],
  ['moving-time-adjustment', 'comment-renderer.', 't.vpos=t.vpos+200', 300, 550],
  ['centisecond-to-ms', 'comment-renderer.', 'this._vposMs=10*this.vpos', 120, 120],
  ['staging-before-slot-generation', 'comment-renderer.', 't.prototype._applyStagingFilters=function', 0, 1900],
];
const evidence = [];
for (const [claim, filePart, needle, before, after] of rules) {
  const module = report.modules.find(module => module.file.includes(filePart));
  if (!module) throw new Error('Missing real module ' + filePart);
  const bytes = await readFile(resolve(root, 'sources', module.file));
  if (createHash('sha256').update(bytes).digest('hex') !== module.sha256) throw new Error('Source hash mismatch ' + module.file);
  const source = bytes.toString('utf8'), index = source.indexOf(needle);
  if (index < 0) throw new Error('Missing source anchor ' + claim);
  const start = Math.max(0, index - before), end = Math.min(source.length, index + after);
  evidence.push({ claim, url: module.url, sha256: module.sha256, file: module.file, offsetUnit: 'UTF-16 code units', start, end, excerpt: source.slice(start, end) });
}
await writeFile(resolve(root, 'source-evidence.json'), JSON.stringify({ capturedAt: report.capturedAt, watchId, evidence }, null, 2));
console.log(JSON.stringify({ sourceEvidence: resolve(root, 'source-evidence.json'), verifiedAnchors: evidence.length }));
