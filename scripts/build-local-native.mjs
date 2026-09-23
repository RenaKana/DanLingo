#!/usr/bin/env node
// Rebuild the reviewed native patch without modifying installed packages or vendor assets.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, '.artifacts/local-native');
const packageRoot = path.join(root, 'node_modules/@wllama/wllama');
const pins = {
  wllamaVersion: '3.6.1',
  llamaCommit: '83d855c5a6d70487121edbf4020b25c96b7a04e7',
  emdawnVersion: 'v20260317.182325',
  buildImage: 'emscripten/emsdk@sha256:460fff8f8ac87e11b16447fbd66538a686eafa0e4fb977aa0989ed19fe2079f7',
};
const originalHashes = {
  'CMakeLists.txt': 'e3469b9c125fd6f7d552291f24c6d07ec61ed8767c17e138b38388040647c5d3',
  'cpp/wllama-context.h': '480fe2d9168d3de0117da6d96161f41f86a491f8011ff9bb11c8bedde6488a88',
};
const mapScriptHash = 'c87add0de1c4071b174214a841ff2dad6da6b32274fd7e437920fae0d076e269';
const patchBefore = '    // load model\n    llama_backend_init();';
const patchAfter = '    // Host prompt snapshots stall all active WebGPU sequences during state readback.\n    params.cache_ram_mib = 0;\n\n' + patchBefore;
const archives = [
  {
    name: 'llama-83d855c.zip',
    url: `https://codeload.github.com/ggml-org/llama.cpp/zip/${pins.llamaCommit}`,
    sha256: '09796ba19b616ce9a6d4f4746ddee2dd0172a898997627efca555068191aa352',
    destination: 'source/llama.cpp', prefix: `llama.cpp-${pins.llamaCommit}`,
  },
  {
    name: 'emdawnwebgpu-v20260317.182325.zip',
    url: 'https://github.com/google/dawn/releases/download/v20260317.182325/emdawnwebgpu_pkg-v20260317.182325.zip',
    sha256: '8dcae86c630d76b6794b271c6572becba36f4237d132bee121a56638c3d76575',
    destination: 'source/build/emdawn',
  },
];
const commands = [
  ['emcmake', 'cmake', '-S', '/source', '-B', '/source/build',
    '-DGGML_WEBGPU=ON', '-DGGML_WEBGPU_JSPI=ON',
    '-DEMDAWNWEBGPU_DIR=/source/build/emdawn/emdawnwebgpu_pkg',
    '-DWLLAMA_TEST_BACKEND=OFF', '-DLLAMA_BUILD_NUMBER=10663', '-DLLAMA_BUILD_COMMIT=83d855c'],
  ['cmake', '--build', '/source/build', '--target', 'wllama', '--parallel', '8'],
];

const hash = (data) => createHash('sha256').update(data).digest('hex');
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function verifyHash(file, expected) {
  const actual = await fileHash(file);
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${file}: ${actual}`);
}
async function json(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}
async function download(url, output, redirects = 0) {
  if (redirects > 8 || new URL(url).protocol !== 'https:') throw new Error('Unsafe download redirect');
  // Explicit certificate validation also applies if the caller disabled Node's global default.
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: true }, resolve);
    request.setTimeout(60_000, () => request.destroy(new Error('Download timed out')));
    request.once('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (!response.headers.location) throw new Error('Download redirect has no location');
    return download(new URL(response.headers.location, url).href, output, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Download failed: HTTP ${response.statusCode} (${url})`);
  }
  await pipeline(response, createWriteStream(output, { flags: 'wx' }));
}
async function sourceFiles(directory, prefix = 'cpp') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${entry.name}`);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && /\.(cpp|h|hpp)$/.test(entry.name)) files.push(relative);
  }
  return files.sort();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/build-local-native.mjs [--prepare-only]\nCreates a fresh .artifacts/local-native/build-* directory. Requires Docker already running and the pinned image already installed.\n--prepare-only verifies/copies inputs and caches/downloads archives; writes a build plan without Docker or compilation.\nOutputs stay in the owned directory; vendor files are never installed automatically.');
    return;
  }
  if (args.some((arg) => arg !== '--prepare-only')) throw new Error('Unknown argument; use --help');
  const provenanceFile = path.join(root, 'vendor/wllama-3.6.1-webgpu/build-info.json');
  const provenanceBytes = await readFile(provenanceFile);
  const provenance = JSON.parse(provenanceBytes);
  for (const [key, value] of Object.entries(pins)) {
    if (provenance[key] !== value) throw new Error(`Provenance ${key} must equal ${value}`);
  }
  if (provenance.archives?.llamaSha256 !== archives[0].sha256 || provenance.archives?.emdawnSha256 !== archives[1].sha256) {
    throw new Error('Provenance archive hashes do not match the reviewed pins');
  }
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.version !== pins.wllamaVersion) throw new Error(`Expected wllama ${pins.wllamaVersion}, got ${pkg.version}`);
  for (const [relative, expected] of Object.entries(originalHashes)) {
    const recorded = provenance.inputHashes?.find((entry) => entry.path === `node_modules/@wllama/wllama/${relative}`);
    if (recorded?.sha256 !== expected) throw new Error(`Missing or changed provenance hash: ${relative}`);
    await verifyHash(path.join(packageRoot, relative), expected);
  }
  const mapScript = path.join(packageRoot, 'scripts/build_source_map.js');
  await verifyHash(mapScript, mapScriptHash);
  if (!args.includes('--prepare-only')) {
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    await run('docker', ['image', 'inspect', pins.buildImage, '--format', '{{.Id}}']);
  }
  await mkdir(artifactRoot, { recursive: true });
  const owned = await mkdtemp(path.join(artifactRoot, 'build-'));
  console.log(`Owned build directory: ${owned}`);
  const inputHashes = [];
  for (const relative of ['CMakeLists.txt', ...await sourceFiles(path.join(packageRoot, 'cpp'))]) {
    const from = path.join(packageRoot, relative);
    const to = path.join(owned, 'source', relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    inputHashes.push({ path: `node_modules/@wllama/wllama/${relative}`, sha256: await fileHash(to) });
  }
  const contextPath = path.join(owned, 'source/cpp/wllama-context.h');
  const original = await readFile(contextPath, 'utf8');
  if (original.split(patchBefore).length !== 2) throw new Error('Expected exactly one model-load patch anchor');
  await writeFile(contextPath, original.replace(patchBefore, patchAfter));
  await copyFile(path.join(root, 'scripts/local-native-prepare.py'), path.join(owned, 'prepare.py'));
  await mkdir(path.join(owned, 'archives'));
  for (const archive of archives) {
    const cache = path.join(artifactRoot, archive.name);
    const output = path.join(owned, 'archives', archive.name);
    let cached;
    try { cached = await lstat(cache); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cached) {
      if (!cached.isFile() || cached.isSymbolicLink()) throw new Error(`Cache is not a regular file: ${cache}`);
      await verifyHash(cache, archive.sha256);
      await copyFile(cache, output);
    } else {
      console.log(`Downloading ${archive.name}`);
      await download(archive.url, output);
    }
    await verifyHash(output, archive.sha256);
  }
  const plan = {
    schemaVersion: 1, ...pins, emscriptenVersion: '4.0.20', nativePolicy: { cacheRamMiB: 0 },
    provenanceSha256: hash(provenanceBytes), inputHashes, archives, commands,
    patch: { file: 'cpp/wllama-context.h', before: patchBefore, after: patchAfter,
      originalSha256: originalHashes['cpp/wllama-context.h'], patchedSha256: await fileHash(contextPath),
      sha256: hash(JSON.stringify({ before: patchBefore, after: patchAfter })) },
    toolingHashes: { buildScript: await fileHash(fileURLToPath(import.meta.url)),
      prepareScript: await fileHash(path.join(owned, 'prepare.py')), sourceMapScript: mapScriptHash },
  };
  await json(path.join(owned, 'build-plan.json'), plan);
  if (args.includes('--prepare-only')) {
    console.log(`Prepared; no container run. Plan: ${path.join(owned, 'build-plan.json')}`);
    return;
  }
  const container = `danlingo-native-${randomUUID()}`;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    void run('docker', ['stop', '--time', '5', container]).catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await run('docker', ['run', '--rm', '--pull=never', '--name', container, '--cpus=8', '--memory=12g',
      '--network=none', '--mount', `type=bind,source=${owned},target=/work`,
      // Match the reviewed build's __FILE__ strings and linked data addresses.
      '--mount', `type=bind,source=${path.join(owned, 'source')},target=/source`,
      '--workdir', '/work', pins.buildImage, 'python3', '/work/prepare.py']);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    // This random name belongs solely to this invocation; never touch other containers or files.
    await run('docker', ['rm', '--force', container]).catch(() => {});
  }
  if (cancelled) throw new Error('Build cancelled');
  const result = path.join(owned, 'result');
  await mkdir(result);
  for (const name of ['wllama.js', 'wllama.wasm']) await copyFile(path.join(owned, 'source/build', name), path.join(result, name));
  await verifyHash(mapScript, mapScriptHash);
  // The package parser splits --input on ':', so never pass a Windows absolute path here.
  await run(process.execPath, [mapScript, '--input', 'default:source/build', '--output', 'result/source-map.ts'], owned);
  const mapText = await readFile(path.join(result, 'source-map.ts'), 'utf8');
  const mapBody = mapText.match(/export const WASM_SOURCE_MAP: Record<string, string> = (\{[\s\S]*\});\s*$/)?.[1];
  if (!mapBody) throw new Error('Unexpected pinned source-map output');
  // The reviewed vendor source map uses compact JSON and one trailing LF.
  await writeFile(path.join(result, 'source-map.json'), JSON.stringify(JSON.parse(mapBody)) + '\n', { flag: 'wx' });
  const files = {};
  for (const name of ['wllama.js', 'wllama.wasm', 'source-map.json']) {
    files[name] = { sha256: await fileHash(path.join(result, name)), bytes: (await lstat(path.join(result, name))).size };
  }
  await json(path.join(result, 'build-info.json'), { ...plan,
    archives: { llamaSha256: archives[0].sha256, emdawnSha256: archives[1].sha256 },
    archiveInputs: archives, files, compilerImage: pins.buildImage,
    createdAt: new Date().toISOString(), nodeVersion: process.version });
  console.log(`Built and hashed; review before promotion: ${result}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
