import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { installGpuGuard } from '../src/local/gpu-worker-guard.js';
import { installGpuMeter } from '../src/local/gpu-meter.js';
import { loadLocalNativeBundle } from './local-native-bundle.mjs';

// wllama 3.6.1 normally constructs a Blob worker. MV3 requires packaged scripts.
// Extract ONLY the three pinned, published source constants at BUILD time. No eval
// or downloaded executable code exists in the extension at runtime.
export function localWllamaAssets() {
  const directory = resolve('node_modules/@wllama/wllama');
  if (JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).version !== '3.6.1') throw new Error('Review local worker packaging before changing wllama 3.6.1');
  const source = readFileSync(resolve(directory, 'esm/index.js'), 'utf8');
  const native = loadLocalNativeBundle();
  const constants = {};
  for (const name of ['LLAMA_CPP_WORKER_CODE', 'WLLAMA_EMSCRIPTEN_CODE', 'JSPI_STUB']) {
    const expression = source.match(new RegExp(`^var ${name} = ([\\s\\S]*?);\\r?\\n(?=var |\\/\\/)`, 'm'))?.[1];
    if (!expression) throw new Error(`Pinned wllama packaging changed: ${name}`);
    constants[name] = runInNewContext(expression, {}, { timeout: 1000 });
  }
  const moduleCode = constants.JSPI_STUB + native.runtime;
  const worker = [
    'const RUN_OPTIONS = {pathConfig:{"wllama.wasm":new URL("./wllama.wasm",import.meta.url).href},nbThread:Number(new URL(import.meta.url).searchParams.get("threads"))||0,compat:false};',
    `(${installGpuGuard.toString()})(${installGpuMeter.toString()});`,
    `function wModuleInit(){${moduleCode.replace('var Module', 'var ___Module')}; return Module;}`,
    constants.LLAMA_CPP_WORKER_CODE,
  ].join('\n');
  let includesInferenceEngine = false;
  return {
    name: 'danlingo-packaged-wllama',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/@wllama/wllama/esm/index.js') && !id.replaceAll('\\', '/').includes('/@wllama+wllama@3.6.1/')) return;
      if (!code.includes('var createWorker = (workerCode) => {')) return;
      includesInferenceEngine = true;
      let patched = code.replace(/var createWorker = \(workerCode\) => \{[\s\S]*?\n\};/, `var createWorker = (workerCode) => {
        const firstLine = String(workerCode).split("\\n")[0];
        const rawOptions = firstLine.match(/^const RUN_OPTIONS = (.+?);+$/)?.[1];
        if (!rawOptions) throw new Error("LOCAL_PACKAGED_WORKER_OPTIONS_INVALID");
        const options = JSON.parse(rawOptions);
        const url = new URL("/local/wllama-worker.js", globalThis.location.href);
        url.searchParams.set("threads", String(options.nbThread || 0));
        if (globalThis.__DANLINGO_GPU_TIMING__) url.searchParams.set("measureGpu", "1");
        const worker = new Worker(url, {type:"module"});
        let flushSequence = 0, pendingFlush;
        const rejectFlush = () => {
          if (!pendingFlush) return;
          const pending = pendingFlush; pendingFlush = undefined; clearTimeout(pending.timer);
          pending.reject(new Error("LOCAL_GPU_TIMING_UNAVAILABLE"));
        };
        worker.addEventListener("error", rejectFlush);
        const terminate = worker.terminate.bind(worker);
        worker.terminate = (...args) => { rejectFlush(); return terminate(...args); };
        worker.addEventListener("message", event => {
          if (event.data?.verb === "danlingo.gpu.flushed") {
            event.stopImmediatePropagation();
            if (pendingFlush?.id === event.data.id) {
              const pending = pendingFlush; pendingFlush = undefined; clearTimeout(pending.timer);
              if (event.data.error) pending.reject(new Error("LOCAL_GPU_TIMING_UNAVAILABLE"));
              else pending.resolve(event.data.metrics);
            }
          } else if (event.data?.verb === "danlingo.gpu") {
            event.stopImmediatePropagation();
            globalThis.dispatchEvent(new CustomEvent("danlingo-local-gpu", {detail:event.data.args[0]}));
          }
        });
        globalThis.__DANLINGO_GPU_FLUSH__ = () => {
          if (pendingFlush) return Promise.reject(new Error("LOCAL_GPU_TIMING_BUSY"));
          return new Promise((resolve, reject) => {
            const id = ++flushSequence;
            const timer = setTimeout(() => { pendingFlush = undefined; reject(new Error("LOCAL_GPU_TIMING_TIMEOUT")); }, 5000);
            pendingFlush = {id, resolve, reject, timer};
            try { worker.postMessage({verb:"danlingo.gpu.flush", id}); }
            catch { clearTimeout(timer); pendingFlush = undefined; reject(new Error("LOCAL_GPU_TIMING_UNAVAILABLE")); }
          });
        };
        return worker;
      };`);
      if (patched === code) throw new Error('Pinned wllama worker replacement failed');
      // Symbols must describe the paired native binary, including its local cache policy patch.
      const mapExpression = /^var WASM_SOURCE_MAP = \{[\s\S]*?\r?\n\};/gm;
      if ([...patched.matchAll(mapExpression)].length !== 1) throw new Error('Pinned wllama symbol map changed');
      patched = patched.replace(mapExpression, () => `var WASM_SOURCE_MAP = ${JSON.stringify(native.sourceMap)};`);
      return { code: patched, map: null };
    },
    generateBundle() {
      // Vite forwards worker-bundle assets to its parent build. Emit once where
      // the engine is actually bundled, not again for every WXT content script.
      if (!includesInferenceEngine) return;
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: readFileSync(resolve('LICENSE')) });
      this.emitFile({ type: 'asset', fileName: 'local/wllama-worker.js', source: worker });
      this.emitFile({ type: 'asset', fileName: 'local/wllama.wasm', source: native.wasm });
      this.emitFile({ type: 'asset', fileName: 'local/native-build.json', source: JSON.stringify(native.info) });
      this.emitFile({ type: 'asset', fileName: 'local/WLLAMA-LICENSE.txt', source: readFileSync(resolve(directory, 'LICENCE')) });
      this.emitFile({ type: 'asset', fileName: 'local/LLAMA-LICENSE.txt', source: readFileSync(resolve('vendor/wllama-3.6.1-webgpu/LLAMA-LICENSE.txt')) });
    },
  };
}
