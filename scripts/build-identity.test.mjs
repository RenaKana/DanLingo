import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentityAsset, createBuildIdentity } from './build-identity.mjs';

test('build identity includes the build time and changes with extension source bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'danlingo-build-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['entrypoints', 'src', 'public', 'scripts']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lock');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'wxt.config.ts'), 'config');
  writeFileSync(join(root, 'src', 'entry.ts'), 'export const value = 1;');

  const first = createBuildIdentity(root, 1_000);
  const sameBuild = createBuildIdentity(root, 1_000);
  assert.equal(first.buildId, sameBuild.buildId);
  assert.equal(first.builtAt, new Date(1_000).toISOString());
  assert.match(first.buildId, /^1\.2\.3-1000-no-git-[a-f0-9]{64}$/);

  writeFileSync(join(root, 'src', 'entry.ts'), 'export const value = 2;');
  assert.notEqual(createBuildIdentity(root, 1_000).buildId, first.buildId);
  assert.notEqual(createBuildIdentity(root, 1_001).buildId, first.buildId);
});

test('emits the exact compiled identity beside the dispatch runner page', () => {
  const identity = { version: '1.2.3', commit: 'abc123', sourceHash: 'a'.repeat(64), builtAt: '2026-09-26T00:00:00.000Z', buildId: 'fixture' };
  const emitted = [];
  buildIdentityAsset(identity).generateBundle.call({ emitFile: asset => emitted.push(asset) }, {}, {
    'dispatch-runner.html': { type: 'asset', fileName: 'dispatch-runner.html', name: 'dispatch-runner.html' },
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].fileName, 'runtime-identity.json');
  assert.deepEqual(JSON.parse(emitted[0].source), identity);
});

test('does not emit a duplicate identity from other entrypoint groups', () => {
  const emitted = [];
  buildIdentityAsset({ buildId: 'fixture' }).generateBundle.call({ emitFile: asset => emitted.push(asset) }, {}, {
    'background.js': { type: 'chunk', fileName: 'background.js', name: 'background' },
  });
  assert.deepEqual(emitted, []);
});
