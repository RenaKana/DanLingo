// Produce a reviewable source snapshot. Never initializes Git, commits or publishes.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = new Set(['README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'LICENSE.md',
  '.gitignore', '.gitattributes', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'wxt.config.ts']);
const documents = new Set(['docs/README.md', 'docs/USAGE.md', 'docs/DEVELOPMENT.md',
  'docs/ARCHITECTURE.md', 'docs/PRIVACY.md', 'docs/GITHUB_RELEASE.md', 'docs/RELEASE_VALIDATION.md']);
const extensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.yaml', '.yml', '.ps1', '.py', '.patch']);
const folders = new Set(['entrypoints', 'src', 'test', 'scripts', 'public', 'vendor', '.github']);
const nativeFiles = new Set(['README.md', 'build-info.json', 'native-policy.patch', 'source-map.json',
  'wllama.js', 'wllama.wasm', 'WLLAMA-LICENSE.txt', 'LLAMA-LICENSE.txt']);
// Exact synthetic URL literals used by existing rejection tests, reviewed individually.
// A different URL in the same file remains a finding; these are not whole-file exemptions.
const reviewedTestUrls = {
  'scripts/probes/bilibili-probe.test.mjs': ['f817e225bc7fd694d867f914ea8510787f031295742e9ea00d1ce10b8741708c'],
  'test/core/bilibili-emotes.test.mjs': ['1578e51796705f347bdcf7dbfc018b675753f3bb0091355510e1e72022d8a091'],
  'test/core/config.test.mjs': ['4848914d11ccd43afc980dd54a443ddf847fdacdb57a5786f2d05d3e4b7ac365'],
  'test/translation/translation.test.mjs': ['6703504596b81bd9a7ce59ce6db11e299c0104b5eb645c28fd304b0746faaf0a'],
};

export function isSourceFile(path) {
  if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (rootFiles.has(path) || documents.has(path)) return true;
  const parts = path.split('/');
  if (!folders.has(parts[0])) return false;
  if (parts.some(part => /^(?:node_modules|\.git|\.artifacts|\.output|\.wxt|\.pnpm-store|__pycache__|profiles?|browsers)$/i.test(part)
    || /(?:^|[-_])profiles?(?:$|[-_])/i.test(part))) return false;
  const name = parts.at(-1);
  if (path === 'scripts/verify-credential-safety.mjs') return true;
  if (/^\.env(?:\.|$)|(?:credential|secret|api[-_]?key)|(?:^|[-_])output\.|测试用/i.test(name)) return false;
  if (path.startsWith('vendor/')) return parts.length === 3 && parts[1] === 'wllama-3.6.1-webgpu' && nativeFiles.has(name);
  if (path.startsWith('scripts/') && extname(path) === '.md') return path === 'scripts/README.md';
  if (extname(path) === '.txt') return path === 'public/THIRD_PARTY_NOTICES.txt';
  return extensions.has(extname(path));
}

export function findSensitiveContent(data, knownSecrets = [], approvedUrlHashes = []) {
  const findings = [];
  if (knownSecrets.some(secret => secret.length >= 8 && [Buffer.from(secret), Buffer.from(secret, 'utf16le')].some(value => data.includes(value)))) findings.push('known-local-credential');
  const text = data.toString('utf8');
  for (const [name, pattern] of [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
    ['provider-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ]) if (pattern.test(text)) findings.push(name);
  const credentialUrls = [...text.matchAll(/https?:\/\/[^\s/:"'<>]+:[^\s/@"'<>]+@[^\s"'<>]+/g)];
  if (credentialUrls.some(match => !approvedUrlHashes.includes(createHash('sha256').update(match[0]).digest('hex')))) findings.push('url-password');
  return findings;
}

export async function collectSource(root = projectRoot) {
  const files = [];
  async function walk(folder = '') {
    for (const entry of await readdir(resolve(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      const canDescend = folders.has(path.split('/')[0]) || path === 'docs';
      // Never follow junctions/symlinks, including a top-level source directory.
      if (entry.isSymbolicLink()) {
        if (canDescend || isSourceFile(path)) throw new Error(`Source symlink requires review: ${path}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (canDescend && (folder !== 'docs') && !/^(?:node_modules|\.git|\.artifacts|\.output|\.wxt|\.pnpm-store|__pycache__|profiles?|browsers)$/i.test(entry.name)) await walk(path);
      } else if (entry.isFile() && isSourceFile(path)) files.push(path);
    }
  }
  await walk();
  return files.sort();
}

/** Check the exact staged bytes as well as working files; ignored tracked files still count. */
export async function checkGitIndex(root = projectRoot, knownSecrets = []) {
  try { await lstat(resolve(root, '.git')); }
  catch (error) { if (error.code === 'ENOENT') return { files: 0, findings: [] }; throw error; }
  const git = (args, options = {}) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options });
  const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Cannot parse Git index');
    return { mode: match[1], oid: match[2], stage: match[3], path: match[4] };
  });
  const findings = [];
  for (const entry of entries) {
    if (entry.stage !== '0' || !['100644', '100755'].includes(entry.mode) || !isSourceFile(entry.path)) {
      findings.push({ path: entry.path, categories: ['git-index-file-not-approved'] });
    }
  }
  if (!entries.length || findings.length) return { files: entries.length, findings };
  const input = entries.map(entry => entry.oid).join('\n') + '\n';
  const metadata = git(['cat-file', '--batch-check'], { input }).toString('utf8').trim().split('\n');
  for (let index = 0; index < metadata.length; index++) {
    const [, type, size] = metadata[index].split(' ');
    if (type !== 'blob' || !Number.isSafeInteger(Number(size)) || Number(size) > 50 * 1024 * 1024) {
      findings.push({ path: entries[index].path, categories: ['git-index-object-requires-review'] });
    }
  }
  if (findings.length) return { files: entries.length, findings };
  const blobs = git(['cat-file', '--batch'], { input });
  let offset = 0;
  for (const entry of entries) {
    const end = blobs.indexOf(10, offset), header = blobs.subarray(offset, end).toString('ascii');
    const [oid, type, sizeText] = header.split(' '), size = Number(sizeText);
    if (end < 0 || oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Cannot read Git index blob');
    offset = end + 1;
    const data = blobs.subarray(offset, offset + size);
    if (data.length !== size || blobs[offset + size] !== 10) throw new Error('Truncated Git index blob');
    offset += size + 1;
    const categories = findSensitiveContent(data, knownSecrets, reviewedTestUrls[entry.path] ?? []);
    if (categories.length) findings.push({ path: entry.path, categories: categories.map(category => 'git-index-' + category) });
  }
  return { files: entries.length, findings };
}

async function knownLocalCredentials() {
  const secrets = [];
  for (const name of ['测试用.txt', '默认测试用.txt']) {
    const file = resolve(projectRoot, name);
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error('Credential file must not be a symlink');
      const content = await readFile(file, 'utf8');
      for (const match of content.matchAll(/^\s*(?:KEY|api_key)\s*[:=：]\s*["']([^"'\r\n]+)["']/gmi)) secrets.push(match[1]);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot safely read local credential exclusion input'); }
  }
  return secrets;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(arg => arg !== '--stage')) throw new Error('Usage: node scripts/source-release.mjs [--stage]');
  const knownSecrets = await knownLocalCredentials();
  const knownLocalCredentialCount = knownSecrets.length;
  const gitIndex = await checkGitIndex(projectRoot, knownSecrets);
  const files = await collectSource();
  const records = [], contents = new Map(), findings = [...gitIndex.findings];
  for (const path of files) {
    const data = await readFile(resolve(projectRoot, path));
    const sensitive = findSensitiveContent(data, knownSecrets, reviewedTestUrls[path] ?? []);
    if (sensitive.length) findings.push({ path, categories: sensitive });
    if (data.length > 50 * 1024 * 1024) findings.push({ path, categories: ['oversized-source-file'] });
    records.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    if (args.includes('--stage')) contents.set(path, data);
  }
  knownSecrets.fill('');
  if (findings.length) {
    console.error(JSON.stringify({ status: 'REVIEW_REQUIRED', files: files.length, findings }, null, 2));
    process.exitCode = 1;
    return;
  }
  const report = {
    status: 'SOURCE_CHECK_PASSED', files: files.length, bytes: records.reduce((total, file) => total + file.bytes, 0),
    knownLocalCredentialCount, gitIndexFiles: gitIndex.files,
    limitations: ['No Git history, archives, screenshots or external accounts scanned.',
      'Pattern checks and exact known-credential checks do not prove absence of all sensitive data.',
      'License, recorded-fixture redistribution and platform acceptance require separate review.'],
  };
  if (args.includes('--stage')) {
    const parent = resolve(projectRoot, '.artifacts/github-prep');
    await mkdir(parent, { recursive: true });
    const output = await mkdtemp(resolve(parent, 'source-'));
    const source = resolve(output, 'repository');
    for (const [path, data] of contents) {
      const target = resolve(source, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
    }
    await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ ...report, records }, null, 2) + '\n', { flag: 'wx' });
    report.sourceDirectory = relative(projectRoot, source).replaceAll('\\', '/');
    report.manifest = relative(projectRoot, resolve(output, 'manifest.json')).replaceAll('\\', '/');
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
