// Replace only the native runtime inside an isolated benchmark artifact.
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

export async function replaceNativeRuntime(workerSource, runtimeSource) {
  const source = await readFile('node_modules/@wllama/wllama/esm/index.js', 'utf8');
  const expression = source.match(/^var WLLAMA_EMSCRIPTEN_CODE = ([\s\S]*?);\r?\n(?=var |\/\/)/m)?.[1];
  if (!expression) throw new Error('PINNED_NATIVE_RUNTIME_CONSTANT_MISSING');
  const original = runInNewContext(expression, {}, { timeout: 1000 }).replace('var Module', 'var ___Module');
  if (workerSource.split(original).length !== 2) throw new Error('PINNED_NATIVE_RUNTIME_ANCHOR_CHANGED');
  if (!runtimeSource.includes('var Module=') || !runtimeSource.includes('wllama_action')) throw new Error('NATIVE_RUNTIME_INVALID');
  const replacement = runtimeSource.replace(/^\/\/# sourceMappingURL=.*$/gm, '').replace('var Module', 'var ___Module');
  return workerSource.replace(original, () => replacement);
}
