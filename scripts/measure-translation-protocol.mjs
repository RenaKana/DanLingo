import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReplay } from './replay-translation-cost.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let python = process.env.DANLINGO_TOKENIZER_PYTHON ?? 'python';
let output = path.join(root, '.artifacts/cost-optimization/protocol-tokenization.json');
const tokenizer = { encoding: 'cl100k_base' };
for (let i = 0; i < args.length; i++) {
  const flag = args[i], value = args[++i]; assert.ok(value, `missing value for ${flag}`);
  if (flag === '--python') python = value;
  else if (flag === '--output') output = path.resolve(value);
  else if (flag === '--encoding') tokenizer.encoding = value;
  else if (flag === '--tokenizer-json') tokenizer.path = path.resolve(value);
  else if (flag === '--tokenizer-name') tokenizer.name = value;
  else throw new Error(`unknown option ${flag}`);
}
const replay = await runReplay({ captureProtocol: true });
const records = replay.profiles.flatMap(profile => ['baseline', 'current'].flatMap(version =>
  profile[version].attempts.map(attempt => ({ id: `${profile.name}/${version}/${attempt.id}`, content: attempt.protocolContent }))));
const processResult = spawnSync(python, [path.join(root, 'scripts/measure-translation-protocol.py')], {
  input: JSON.stringify({ tokenizer, records }), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, TIKTOKEN_CACHE_DIR: process.env.TIKTOKEN_CACHE_DIR
    ?? process.env.DATA_GYM_CACHE_DIR ?? path.join(root, '.artifacts/cost-optimization/tokenizer-cache') },
});
if (processResult.error) throw processResult.error;
if (processResult.status !== 0) throw new Error(processResult.stdout || processResult.stderr || 'offline tokenizer unavailable');
const measured = JSON.parse(processResult.stdout), byId = new Map(measured.records.map(record => [record.id, record]));
const report = {
  evidence: 'Offline real tokenizer applied to synthetic observed protocol strings; surrogate tokenizer only, not actual model usage or provider billing.',
  tokenizer: measured.tokenizer, fixtureSha256: replay.fixtureSha256,
  sourceHashes: { baseline: replay.baseline.sourceHashes, current: replay.current.sourceHashes },
  settings: replay.settings,
  limitations: [
    'The selected tokenizer is not established as the actual DeepSeek/model tokenizer. Counts only substantiate compression for this named tokenizer.',
    'Prompt counts sum actual system and user message content. Chat-role framing and provider templates are excluded, so these are not API input usage.',
    'Source and output text are additionally encoded in isolation. Framing residuals include BPE boundary effects and are not separately billable categories.',
    'Output strings are fixed synthetic responses. Missing/failed attempts have unknown output token counts and cannot establish full request cost.',
    'No network download, external model call, prefix-cache assumption or translation-quality evaluation occurs.',
  ],
  profiles: replay.profiles.map(profile => {
    const result = { name: profile.name, rawOccurrences: profile.baseline.summary.rawOccurrences,
      coveragePreserved: profile.comparison.coveragePreserved };
    for (const version of ['baseline', 'current']) {
      const attempts = profile[version].attempts.map(attempt => ({ ...byId.get(`${profile.name}/${version}/${attempt.id}`),
        status: attempt.status, usageKnown: attempt.cost.known }));
      const fields = ['fixedPromptTokens', 'userContentTokens', 'sourceTokensInIsolation', 'inputFramingResidual',
        'promptContentTokens', 'outputContentTokens', 'outputTextTokensInIsolation', 'outputFramingResidual'];
      const totals = Object.fromEntries(fields.map(field => [field, attempts.some(attempt => attempt[field] === null)
        ? null : attempts.reduce((sum, attempt) => sum + attempt[field], 0)]));
      result[version] = { totals, requests: attempts.length, unknownOutputAttempts: attempts.filter(attempt => attempt.outputContentTokens === null).length, attempts };
    }
    result.promptContentReduction = 1 - result.current.totals.promptContentTokens / result.baseline.totals.promptContentTokens;
    result.outputContentReduction = result.baseline.totals.outputContentTokens === null || result.current.totals.outputContentTokens === null ? null
      : 1 - result.current.totals.outputContentTokens / result.baseline.totals.outputContentTokens;
    return result;
  }),
};
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, evidence: report.evidence, tokenizer: report.tokenizer,
  profiles: report.profiles.map(({ name, baseline, current, ...rest }) => ({ name, baseline: baseline.totals, current: current.totals, ...rest })) }, null, 2));
