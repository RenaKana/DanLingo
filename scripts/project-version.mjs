import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function getProjectReleaseInfo(root = projectRoot) {
  const resolvedRoot = resolve(root);
  const packageJson = JSON.parse(readFileSync(resolve(resolvedRoot, 'package.json'), 'utf8'));
  if (typeof packageJson.name !== 'string' || !packageJson.name.trim()
    || typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('Project package.json must define a name and version');
  }
  const archiveName = `${packageJson.name}-${packageJson.version}-chrome.zip`;
  return {
    name: packageJson.name,
    version: packageJson.version,
    archiveName,
    archivePath: resolve(resolvedRoot, '.output', archiveName),
  };
}
