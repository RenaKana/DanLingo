import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceHistory, SERVICE_HISTORY_KEY, SERVICE_PRESETS } from '../../src/core/service-history.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

const fixture = () => {
  const data = {};
  return { data, history: new ServiceHistory({ get: async () => data, set: async patch => Object.assign(data, patch) }) };
};
test('verified address history is normalized, deduplicated and contains no key or model', async () => {
  const { data, history } = fixture();
  const settings = { ...DEFAULT_SETTINGS, endpoint: 'https://gateway.example/v1/', endpointMode: 'base', model: 'private-model', apiKey: 'secret' };
  await Promise.all([history.record(settings), history.record({ ...settings, endpoint: 'https://gateway.example/v1/chat/completions', endpointMode: 'completion' })]);
  assert.equal((await history.read()).length, 1);
  assert.equal((await history.read())[0].endpoint, 'https://gateway.example/v1');
  assert.doesNotMatch(JSON.stringify(data), /secret|private-model|apiKey/);
});
test('local backend and potentially secret URL components never enter history', async () => {
  const { history } = fixture();
  await history.record({ ...DEFAULT_SETTINGS, backend: 'local' });
  for (const endpoint of ['https://gateway.example/v1?credential=secret', 'https://gateway.example/v1#secret']) {
    await history.record({ ...DEFAULT_SETTINGS, endpoint }).catch(() => {});
  }
  assert.deepEqual(await history.read(), []);
});
test('history reopens, discards malformed rows and preserves localhost opt-in', async () => {
  const { history, data } = fixture();
  await history.record({ ...DEFAULT_SETTINGS, endpoint: 'http://127.0.0.1:5000/v1', allowLocalHttp: true });
  data[SERVICE_HISTORY_KEY].push({ endpoint: 'https://bad.example/?key=secret', verifiedAt: Date.now(), endpointMode: 'base', protocol: 'chat-completions' }, null);
  const reopened = new ServiceHistory({ get: async () => structuredClone(data), set: async () => {} });
  assert.equal((await reopened.read()).length, 1);
  assert.equal((await reopened.read())[0].allowLocalHttp, true);
});
test('provider presets are HTTPS addresses and remain editable data, not credentials', () => {
  assert.ok(SERVICE_PRESETS.some(row => row.name === 'OpenAI'));
  assert.ok(SERVICE_PRESETS.some(row => row.name === 'DeepSeek'));
  for (const row of SERVICE_PRESETS) assert.equal(new URL(row.endpoint).protocol, 'https:');
});
