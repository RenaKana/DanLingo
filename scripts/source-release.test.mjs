import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isSourceFile, findSensitiveContent, collectSource } from './source-release.mjs';

test('source selection excludes local credentials, stores, raw captures and weights', () => {
  for (const path of ['测试用.txt', '.env', '.pnpm-store/index.json', '.output/manifest.json',
    '.artifacts/report.json', 'docs/LIVE_G3_PROGRESS.md', 'scripts/probes/bilibili-test-output.txt',
    'test/profile/Preferences.json', 'src/model.gguf', 'src/secret.json', 'vendor/unknown/runtime.wasm',
    '../src/main.ts', 'src/../../private.json', 'src\\main.ts']) assert.equal(isSourceFile(path), false, path);
  for (const path of ['src/core/config.ts', 'test/core/config.test.mjs', 'scripts/verify-credential-safety.mjs',
    'docs/GITHUB_RELEASE.md', '.github/workflows/ci.yml', 'vendor/wllama-3.6.1-webgpu/wllama.wasm']) assert.equal(isSourceFile(path), true, path);
});

test('credential scanning catches known UTF8/UTF16LE and common tokens without returning values', () => {
  const synthetic = 'not-a-real-' + 'credential-fixture';
  for (const encoding of ['utf8', 'utf16le']) assert.deepEqual(findSensitiveContent(Buffer.from(synthetic, encoding), [synthetic]), ['known-local-credential']);
  assert.deepEqual(findSensitiveContent(Buffer.from('sk-' + 'a'.repeat(40))), ['provider-key']);
  assert.deepEqual(findSensitiveContent(Buffer.from('ghp_' + 'a'.repeat(36))), ['github-token']);
  assert.deepEqual(findSensitiveContent(Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')), ['private-key']);
  assert.deepEqual(findSensitiveContent(Buffer.from('https://' + 'user:password@example.invalid')), ['url-password']);
  assert.deepEqual(findSensitiveContent(Buffer.from('https://example.invalid; apiKey: fixture')), []);
  const reviewed = 'https://' + 'user:password@example.invalid';
  const hashes = [createHash('sha256').update(reviewed).digest('hex')];
  assert.deepEqual(findSensitiveContent(Buffer.from(reviewed), [], hashes), []);
  assert.deepEqual(findSensitiveContent(Buffer.from(reviewed + '/changed'), [], hashes), ['url-password']);
});

test('source collection is allowlisted and does not follow source junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'danlingo-source-test-'));
  try {
    for (const dir of ['src', '.artifacts', 'docs']) await mkdir(join(root, dir));
    for (const file of ['package.json', 'src/main.ts', '.artifacts/private.json', 'docs/USAGE.md', 'docs/private.md']) await writeFile(join(root, file), '{}');
    assert.deepEqual(await collectSource(root), ['docs/USAGE.md', 'package.json', 'src/main.ts']);
    await symlink(join(root, '.artifacts'), join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(collectSource(root), /symlink requires review/);
  } finally {
    // root is the unique temporary directory created by this test, never a user path.
    await rm(root, { recursive: true, force: true });
  }
});
