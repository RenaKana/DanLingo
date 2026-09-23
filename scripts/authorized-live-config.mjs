// Explicit local test configuration only. Never search profiles or print file contents.
import { readFile } from 'node:fs/promises';
import { completionEndpoint, DEFAULT_SETTINGS, normalizeSettings, MAX_CONCURRENCY } from '../src/core/config.ts';

export function parseAuthorizedLiveConfig(text) {
  const fields = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(base_url|KEY|model|profile|thinking_effort)\s*[:=：]\s*(["'])(.*?)\2\s*$/i);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (fields.has(name)) throw new Error('Duplicate authorized test configuration field');
    fields.set(name, match[3].trim());
  }
  if (!fields.get('base_url') || !fields.get('key') || !fields.get('model')) throw new Error('Authorized test file requires quoted base_url, KEY and model');
  const apiKey = fields.get('key');
  if (/[\r\n\s]/.test(apiKey)) throw new Error('Invalid authorized test credential');
  const endpoint = completionEndpoint(fields.get('base_url'), true);
  const model = fields.get('model');
  const profile = fields.get('profile') || (/^gemini-/i.test(model) ? 'gemini' : 'chat-completions');
  if (!['gemini', 'deepseek', 'minimax', 'chat-completions'].includes(profile)) throw new Error('Invalid authorized test Provider profile');
  // A list of supported efforts is not a selected effort. Preserve the service default.
  const thinkingEffort = fields.get('thinking_effort') || 'default';
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, endpoint, model, profile, thinkingEffort, allowLocalHttp: true });
  return { settings, apiKey };
}

export async function readAuthorizedLiveConfig(path) {
  if (!path) throw new Error('An explicit authorized test configuration file is required');
  return parseAuthorizedLiveConfig(await readFile(path, 'utf8'));
}

export function authorizedTestOverrides(settings, overrides = {}) {
  const values = { ...settings };
  for (const name of ['model', 'profile', 'thinkingEffort']) if (overrides[name] !== undefined) values[name] = overrides[name];
  if (overrides.concurrency !== undefined) {
    const concurrency = Number(overrides.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error(`Test concurrency must be 1..${MAX_CONCURRENCY}`);
    values.concurrency = concurrency;
  }
  if (overrides.batchSize !== undefined) {
    const batchSize = Number(overrides.batchSize);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('Test batch size must be 1..200');
    values.batchSize = batchSize;
  }
  if (!values.model || !['gemini', 'deepseek', 'minimax', 'chat-completions'].includes(values.profile)) throw new Error('Invalid explicit test model or profile');
  // Overrides are test-only; the credential file continues to bind the destination exactly.
  return normalizeSettings(values);
}

export function assertAuthorizedLiveSettings(settings, env) {
  const selected = { endpoint: completionEndpoint(env.DANLINGO_E2E_ENDPOINT || '', true), model: env.DANLINGO_E2E_MODEL,
    profile: env.DANLINGO_E2E_PROFILE, thinkingEffort: env.DANLINGO_E2E_THINKING };
  if (Object.keys(selected).some(name => selected[name] !== settings[name])) throw new Error('Selected test service or model settings differ from the authorized file');
}
