import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readBilibiliSourceEvidence, readNiconicoRecording, requireFileOption } from './recording-input.mjs';

const fixtures = new URL('../../test/fixtures/', import.meta.url);

test('real probes require an explicit file input', () => {
  assert.throws(() => requireFileOption([], '--recording'), /Expected --recording/);
  assert.throws(() => requireFileOption(['--recording', 'sample.json', '--extra'], '--recording'), /Expected --recording/);
  assert.equal(requireFileOption(['--recording', 'external capture.json'], '--recording').endsWith('external capture.json'), true);
});

test('provider recording loader rejects the hand-authored synthetic replacement', async () => {
  const file = fileURLToPath(new URL('niconico-vod-synthetic.json', fixtures));
  await assert.rejects(readNiconicoRecording(file), /Real Niconico query evidence is required/);
});

test('real page probe loader rejects synthetic source pseudocode', async () => {
  const file = fileURLToPath(new URL('bilibili-source-synthetic.json', fixtures));
  await assert.rejects(readBilibiliSourceEvidence(file), /Real Bilibili source evidence is required/);
});
