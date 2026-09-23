// Remove accidental Playwright gzip-body exception text from the first completed L0 run.
// Keep the fact/count of metadata decoding failures and every real platform result.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const root = resolve('.artifacts/live/l0/youtube');
const target = resolve(process.argv[2] || '.artifacts/live/l0/youtube/run-ig2O2r/report.json');
if (!target.startsWith(root + sep) || !target.endsWith(sep + 'report.json')) throw new Error('Expected a YouTube L0 report inside the owned artifact directory');
const report = JSON.parse(await readFile(target, 'utf8'));
if (!report.result) throw new Error('Only redact a completed run');
let count = 0;
for (const room of report.rooms || []) {
  room.errors = (room.errors || []).map(error => {
    if (typeof error !== 'string' || !error.startsWith('Response metadata: POST data is not a valid JSON object:')) return error;
    count++;
    return 'Response metadata: native request body was gzip; decoding failed in the initial probe. Raw compressed request text removed to avoid retaining page session context.';
  });
}
if (count) {
  report.privacyRedactions = { at: new Date().toISOString(), count, reason: 'Removed gzip request-body exception strings from metadata errors. Real requests, messages, phase results and failures remain unchanged. Future probe decodes gzip within 1MB and records field names only.' };
  await writeFile(target, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: target, redactedMetadataErrors: count, result: report.result }));
