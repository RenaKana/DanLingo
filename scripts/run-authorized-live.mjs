// The path, not the credential, is the only secret-related command-line input.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { readAuthorizedLiveConfig, authorizedTestOverrides } from './authorized-live-config.mjs';
import { discoverModels } from '../src/translation/provider.ts';
import { readNiconicoRecording, requireFileOption } from './probes/recording-input.mjs';
import { sampleProvider } from './verify-real-provider.mjs';

const [file, target, ...args] = process.argv.slice(2);
if (!file || !['preflight', 'niconico', 'youtube'].includes(target)) throw new Error('Usage: run-authorized-live.mjs CONFIG_FILE preflight --recording <json-file> [test overrides] | niconico|youtube [verification arguments]');
const configPath = resolve(file);
const recordingArgs = [], remainingArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--recording') {
    if (recordingArgs.length || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected one --recording <json-file>');
    recordingArgs.push('--recording', args[++i]);
  } else remainingArgs.push(args[i]);
}
if (target !== 'preflight' && recordingArgs.length) throw new Error('--recording is only valid for preflight');
const recordingInput = target === 'preflight'
  ? await readNiconicoRecording(requireFileOption(recordingArgs, '--recording')) : null;
const config = await readAuthorizedLiveConfig(configPath);
const overrides = {}, verificationArgs = [];
const overrideFlags = { '--test-model': 'model', '--test-profile': 'profile', '--test-thinking': 'thinkingEffort', '--test-concurrency': 'concurrency', '--test-batch-size': 'batchSize' };
for (let i = 0; i < remainingArgs.length; i++) {
  const name = overrideFlags[remainingArgs[i]];
  if (!name) { verificationArgs.push(remainingArgs[i]); continue; }
  if (overrides[name] !== undefined || !remainingArgs[i + 1] || remainingArgs[i + 1].startsWith('--')) throw new Error('Invalid or duplicate explicit test override');
  overrides[name] = remainingArgs[++i];
}
const settings = authorizedTestOverrides(config.settings, overrides), apiKey = config.apiKey;
Object.assign(process.env, { DANLINGO_E2E_CONFIG_FILE: configPath, DANLINGO_E2E_ENDPOINT: settings.endpoint,
  DANLINGO_E2E_MODEL: settings.model, DANLINGO_E2E_PROFILE: settings.profile, DANLINGO_E2E_THINKING: settings.thinkingEffort,
  DANLINGO_E2E_LIVE_SOURCE_LANGUAGE: 'auto', DANLINGO_E2E_CONCURRENCY: String(settings.concurrency), DANLINGO_E2E_BATCH_SIZE: String(settings.batchSize) });
// Clear inherited override fields first; only this invocation's explicit flags apply.
for (const name of ['DANLINGO_E2E_TEST_MODEL', 'DANLINGO_E2E_TEST_PROFILE', 'DANLINGO_E2E_TEST_THINKING']) delete process.env[name];
for (const [name, envName] of [['model', 'DANLINGO_E2E_TEST_MODEL'], ['profile', 'DANLINGO_E2E_TEST_PROFILE'], ['thinkingEffort', 'DANLINGO_E2E_TEST_THINKING']]) {
  if (overrides[name] !== undefined) process.env[envName] = overrides[name];
}
console.log(JSON.stringify({ endpoint: settings.endpoint, model: settings.model, profile: settings.profile,
  thinkingEffort: settings.thinkingEffort, concurrency: settings.concurrency, batchSize: settings.batchSize, credential: 'explicit local file, not printed or copied' }));
if (target === 'preflight') {
  const capturedAt = new Date().toISOString();
  const report = { capturedAt, evidence: 'AUTHORIZED_REAL_PROVIDER_RECORDED_COMMENTS_ONLY', settings: {
    endpoint: settings.endpoint, model: settings.model, profile: settings.profile, thinkingEffort: settings.thinkingEffort },
    requestBudget: { modelDiscovery: 1, translation: 1 }, status: 'INCOMPLETE' };
  try {
    const models = await discoverModels({ endpoint: settings.endpoint, allowLocalHttp: true, apiKey, timeoutMs: 12000 });
    report.selectedModelListed = models.includes(settings.model);
    if (!report.selectedModelListed) throw new Error('Authorized model absent from the service model list');
    report.translation = await sampleProvider(apiKey, settings, recordingInput);
    report.status = report.translation.mappedAll ? 'PASS_REAL_PROVIDER_SAMPLE' : 'INCOMPLETE_REAL_PROVIDER_SAMPLE';
  } catch (error) { report.error = String(error.message).split(apiKey).join('[redacted]'); }
  const folder = resolve('.artifacts/live/real-provider'); await mkdir(folder, { recursive: true });
  const output = resolve(folder, `preflight-${capturedAt.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(output, JSON.stringify(report, (_key, value) => typeof value === 'string' ? value.split(apiKey).join('[redacted]') : value, 2));
  console.log(JSON.stringify({ report: output, status: report.status, selectedModelListed: report.selectedModelListed,
    elapsedMs: report.translation?.elapsedMs, mappedAll: report.translation?.mappedAll,
    error: (report.error || report.translation?.error)?.split(apiKey).join('[redacted]') }));
  if (!report.status.startsWith('PASS')) process.exitCode = 1;
} else {
  const script = resolve('scripts', target === 'niconico' ? 'verify-niconico-live.mjs' : 'verify-live.mjs');
  process.argv = [process.execPath, script, ...(target === 'youtube' ? ['--real-only'] : []), '--real-provider', ...verificationArgs];
  await import(pathToFileURL(script).href);
}
