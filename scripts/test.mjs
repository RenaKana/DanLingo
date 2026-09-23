// Discover offline tests without shell glob expansion (Windows/Linux/macOS).
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const browserTests = new Set(['test/translation/indexeddb.test.mjs', 'test/translation/directory-model.test.mjs']);
const args = process.argv.slice(2);
if (args.some(arg => !['--browser', '--list'].includes(arg))) throw new Error('Usage: node scripts/test.mjs [--browser] [--list]');
const files = [];
async function discover(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Test symlink is not supported: ${directory}/${entry.name}`);
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await discover(file);
    else if (entry.name.endsWith('.test.mjs') && browserTests.has(file) === args.includes('--browser')) files.push(file);
  }
}
await discover('test');
if (!args.includes('--browser')) await discover('scripts');
files.sort();
if (!files.length) throw new Error('No tests discovered');
if (args.includes('--list')) console.log(files.join('\n'));
else {
  console.log(`Running ${files.length} ${args.includes('--browser') ? 'browser' : 'offline'} test files`);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=4', ...files.map(file => relative(root, resolve(root, file)))], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
