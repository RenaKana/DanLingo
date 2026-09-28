// The updater owns this disposable output. Never point WXT at a browser load folder.
import { realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { build } from 'wxt';

const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw new Error('Usage: workspace-build.mjs <workspace> <temporary-output>');
// Check lexical ancestors before resolving links. This also protects direct calls
// that do not enter through the Python updater's path checks.
for (const input of [resolve(rootArg, '.staging'), resolve(outputArg)]) {
  let current = input;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Build paths must not contain directory links');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
const staging = await realpath(resolve(rootArg, '.staging'));
const output = await realpath(outputArg);
const child = relative(staging, output);
if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Build output must be a new workspace staging directory');
await build({ root: process.cwd(), outDir: output });
