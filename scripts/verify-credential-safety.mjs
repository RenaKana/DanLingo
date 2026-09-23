// Read-only exact credential scan. Never prints credential values or matching content.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, extname, basename } from 'node:path';
import { readAuthorizedLiveConfig } from './authorized-live-config.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config-file') throw new Error('Usage: node --experimental-strip-types scripts/verify-credential-safety.mjs --config-file PATH');
const workspace = resolve('.'), configPath = resolve(args[1]);
const config = await readAuthorizedLiveConfig(configPath).catch(() => { throw new Error('Invalid authorized local configuration'); });
const needles = [Buffer.from(config.apiKey, 'utf8'), Buffer.from(config.apiKey, 'utf16le')];
const credentialNames = new Set(['测试用.txt', '默认测试用.txt']);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.txt', '.css', '.html', '.yml', '.yaml', '.toml', '.ps1', '.svg', '.lock']);
const excludedDirectory = name => /^(?:node_modules|\.git|browsers|coverage|test-results|playwright-report)$/i.test(name)
  || /(?:^|[-_])profiles?(?:$|[-_])/i.test(name) || /^anonymous(?:$|-)/i.test(name);
const report = { capturedAt: new Date().toISOString(), status: 'RUNNING', scope: 'Workspace text sources, scripts, docs, tests, unpacked builds and artifact reports',
  files: 0, bytes: 0, matches: [], failures: [], skippedSymlinks: 0, excludedDirectories: 0,
  limitations: ['Original local credential files, browser profiles, dependencies and browser binaries are excluded.',
    'Exact UTF8/UTF16LE matching cannot detect transformed or encrypted values. ZIP payload equality is checked separately.',
    'This scan does not inspect personal browsers, system files or Git history. No Git operation is performed.'] };
async function visit(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) { report.skippedSymlinks++; return; }
  if (info.isDirectory()) {
    if (excludedDirectory(basename(path))) { report.excludedDirectories++; return; }
    for (const entry of await readdir(path)) await visit(resolve(path, entry));
    return;
  }
  if (!info.isFile() || path === configPath || credentialNames.has(basename(path))) return;
  if (!textExtensions.has(extname(path).toLowerCase()) && basename(path) !== '.gitignore') return;
  try {
    const data = await readFile(path); report.files++; report.bytes += data.length;
    const encodings = needles.flatMap((needle, index) => data.includes(needle) ? [index ? 'utf16le' : 'utf8'] : []);
    if (encodings.length) report.matches.push({ path: relative(workspace, path).replaceAll('\\', '/'), encodings });
  } catch { report.failures.push({ path: relative(workspace, path).replaceAll('\\', '/'), error: 'unreadable' }); }
}
try {
  await visit(workspace);
  const ignore = (await readFile(resolve(workspace, '.gitignore'), 'utf8')).split(/\r?\n/);
  report.exactIgnoreRules = ['/测试用.txt', '/默认测试用.txt'].every(rule => ignore.includes(rule));
  const archive = resolve('.output/danlingo-0.2.0-chrome.zip');
  report.candidateArchiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  report.status = !report.matches.length && !report.failures.length && report.exactIgnoreRules ? 'PASS_EXACT_CREDENTIAL_SCAN' : 'INCOMPLETE_CREDENTIAL_SCAN';
} catch { report.status = 'INCOMPLETE_CREDENTIAL_SCAN'; report.failures.push({ error: 'scan-or-candidate-unavailable' }); }
finally { config.apiKey = ''; for (const needle of needles) needle.fill(0); }
const root = resolve('.artifacts/live/credential-scans'); await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'run-')), output = resolve(runDir, 'report.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, status: report.status, files: report.files, bytes: report.bytes,
  matchCount: report.matches.length, failures: report.failures, exactIgnoreRules: report.exactIgnoreRules }));
if (report.status !== 'PASS_EXACT_CREDENTIAL_SCAN') process.exitCode = 1;
