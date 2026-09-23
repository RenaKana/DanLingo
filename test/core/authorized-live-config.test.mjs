import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorizedLiveConfig, assertAuthorizedLiveSettings, authorizedTestOverrides } from '../../scripts/authorized-live-config.mjs';

const file = 'base_url = "http://192.168.1.20:8080/v1"\nKEY = "fixture-only"\nmodel = "gemini-test"\n思考强度可选 : "low medium high"';
test('available effort list does not lower or select an explicit reasoning effort', () => {
  const config = parseAuthorizedLiveConfig(file);
  assert.equal(config.settings.thinkingEffort, 'default');
  assert.equal(config.settings.endpoint, 'http://192.168.1.20:8080/v1/chat/completions');
});
test('explicit credential file cannot send its key to another origin or model', () => {
  const { settings } = parseAuthorizedLiveConfig(file);
  const env = { DANLINGO_E2E_ENDPOINT: settings.endpoint, DANLINGO_E2E_MODEL: settings.model, DANLINGO_E2E_PROFILE: settings.profile, DANLINGO_E2E_THINKING: settings.thinkingEffort };
  assert.doesNotThrow(() => assertAuthorizedLiveSettings(settings, env));
  assert.throws(() => assertAuthorizedLiveSettings(settings, { ...env, DANLINGO_E2E_ENDPOINT: 'http://192.168.1.21:8080/v1' }), /differ/);
  assert.throws(() => assertAuthorizedLiveSettings(settings, { ...env, DANLINGO_E2E_MODEL: 'other-model' }), /differ/);
});
test('ambiguous credentials are rejected without exposing the value', () => {
  assert.throws(() => parseAuthorizedLiveConfig(file + '\nKEY = "second-secret"'), error => !error.message.includes('second-secret') && /Duplicate/.test(error.message));
  assert.throws(() => parseAuthorizedLiveConfig(file.replace('fixture-only', 'contains whitespace')), /Invalid/);
});
test('public HTTP and unsupported explicit effort are rejected', () => {
  assert.throws(() => parseAuthorizedLiveConfig(file.replace('192.168.1.20', 'example.com')));
  assert.throws(() => parseAuthorizedLiveConfig(file + '\nthinking_effort = "off"'), /unsupported-thinking-effort/);
});
test('explicit model/concurrency comparison leaves the file configuration and destination intact', () => {
  const { settings } = parseAuthorizedLiveConfig(file);
  const selected = authorizedTestOverrides(settings, { model: 'deepseek-flash', profile: 'deepseek', concurrency: 16, batchSize: 10 });
  assert.equal(selected.model, 'deepseek-flash');
  assert.equal(selected.thinkingEffort, 'default');
  assert.equal(selected.concurrency, 16);
  assert.equal(selected.batchSize, 10);
  assert.equal(selected.endpoint, settings.endpoint);
  assert.equal(settings.model, 'gemini-test');
  assert.equal(settings.concurrency, 2);
  for (const concurrency of [32, 64]) {
    const higher = authorizedTestOverrides(settings, { concurrency });
    assert.equal(higher.concurrency, concurrency); assert.equal(higher.endpoint, settings.endpoint);
  }
  assert.throws(() => authorizedTestOverrides(settings, { concurrency: 65 }), /1..64/);
  assert.throws(() => authorizedTestOverrides(settings, { batchSize: 201 }), /1..200/);
});
