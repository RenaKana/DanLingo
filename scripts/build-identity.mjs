import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRECTORIES = ['entrypoints', 'src', 'public', 'scripts'];
const SOURCE_FILES = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'wxt.config.ts'];
const IGNORED_DIRECTORIES = new Set(['.git', '.output', '.wxt', '.artifacts', '.staging', 'node_modules']);

function listFiles(root, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) listFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push({ path: relative(root, path).replaceAll('\\', '/'), absolutePath: path });
    }
  }
}

/** Stable identity for the built extension's source and build inputs. */
export function createBuildIdentity(rootPath, now = Date.now()) {
  const root = resolve(rootPath.startsWith('file:') ? fileURLToPath(rootPath) : rootPath);
  const projectRoot = root.endsWith('.ts') ? resolve(root, '..') : root;
  const files = SOURCE_FILES.map(path => ({ path, absolutePath: resolve(projectRoot, path) }));
  for (const directory of SOURCE_DIRECTORIES) listFiles(projectRoot, resolve(projectRoot, directory), files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const fingerprint = createHash('sha256');
  for (const file of files) {
    fingerprint.update(file.path).update('\0').update(readFileSync(file.absolutePath)).update('\0');
  }

  let commit = 'no-git';
  try {
    commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || commit;
  } catch { /* Source fingerprint remains available outside a Git checkout. */ }

  const { version } = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  const sourceHash = fingerprint.digest('hex');
  const builtAt = new Date(now).toISOString();
  return Object.freeze({ version, commit, sourceHash, builtAt,
    buildId: `${version}-${now}-${commit}-${sourceHash}` });
}

/** Emit the build identity beside the runner page that uses it as its baseline. */
export function buildIdentityAsset(buildIdentity) {
  const source = `${JSON.stringify(buildIdentity, null, 2)}\n`;
  return {
    name: 'danlingo-build-identity-asset',
    generateBundle(_options, bundle) {
      const hasRunnerPage = Object.values(bundle).some(item => {
        const names = [item.fileName, item.name].filter(Boolean);
        return names.some(name => name.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.html$/, '') === 'dispatch-runner');
      });
      if (!hasRunnerPage) return;
      this.emitFile({ type: 'asset', fileName: 'runtime-identity.json', source });
    },
  };
}
