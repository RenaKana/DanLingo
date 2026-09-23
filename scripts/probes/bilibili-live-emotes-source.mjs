// Public source evidence only; this does not claim natural mixed-message acceptance.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPublic } from './bilibili-http.mjs';

const { bytes, evidence } = await getPublic('https://s1.hdslb.com/bfs/live-pkg/danmaku/danmaku-v2.js');
if (evidence.status !== 200) throw new Error('Public native bundle unavailable: ' + evidence.status);
const source = bytes.toString('utf8');
const snippets = (token, before = 200, after = 900) => {
  const result = []; let offset = -1;
  while ((offset = source.indexOf(token, offset + 1)) >= 0 && result.length < 16)
    result.push({ utf16Offset: offset, text: source.slice(Math.max(0, offset - before), offset + after) });
  return result;
};
const report = {
  evidence: 'official public live danmaku bundle, static inspection, anonymous GET only',
  resource: evidence,
  nativeParser: snippets('dmType:t[0][12]'),
  inlineRenderer: snippets('s.match(/\\[\\S+?\\]/g)', 300, 1150),
  inlineMap: snippets('emots', 230, 400),
  limitations: ['No natural mixed packet or chat DOM sample in this static report.', 'No translation provider calls.'],
};
const output = resolve('.artifacts/bilibili/mixed-emote-source'); await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: resolve(output, 'report.json'), resource: evidence, snippets: {
  nativeParser: report.nativeParser.length, inlineRenderer: report.inlineRenderer.length, inlineMap: report.inlineMap.length,
} }));
