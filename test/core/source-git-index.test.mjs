import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkGitIndex } from '../../scripts/source-release.mjs';

test('Git index scan rejects forbidden tracked files even when ignored', async () => {
  await mkdir('.artifacts/source-git-test', { recursive: true });
  const root = await mkdtemp(resolve('.artifacts/source-git-test/repo-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main');
  await writeFile(resolve(root, '.gitignore'), '*.gguf\n');
  await writeFile(resolve(root, 'private.gguf'), 'synthetic weight');
  git('add', '-f', 'private.gguf');
  const result = await checkGitIndex(root);
  assert.equal(result.files, 1); assert.deepEqual(result.findings, [{ path: 'private.gguf', categories: ['git-index-file-not-approved'] }]);
});

test('Git index scan sees staged secrets hidden by later working-tree edits', async () => {
  await mkdir('.artifacts/source-git-test', { recursive: true });
  const root = await mkdtemp(resolve('.artifacts/source-git-test/repo-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main');
  await writeFile(resolve(root, 'README.md'), ['gh', 'p_', 'x'.repeat(36)].join(''));
  git('add', 'README.md');
  await writeFile(resolve(root, 'README.md'), 'Working copy is harmless.');
  assert.deepEqual((await checkGitIndex(root)).findings, [{ path: 'README.md', categories: ['git-index-github-token'] }]);
  git('add', 'README.md');
  assert.deepEqual((await checkGitIndex(root)).findings, []);
});
