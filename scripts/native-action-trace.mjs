// Diagnostic-only instrumentation of the isolated benchmark copy, never the product build.
// Preserves the pinned JSPI FIFO and records only action names, IDs and numeric timing.
export function traceNativeActions(source) {
  function replaceOnce(before, after) {
    if (source.split(before).length !== 2) throw new Error('NATIVE_TRACE_ANCHOR_CHANGED: ' + before.slice(0, 60));
    source = source.replace(before, after);
  }
  replaceOnce('const runWasmCall = async (callbackId, fn) => {', `const dlActionTrace = { actions: {}, slow: [], gpu: {}, gpuSlow: [], stacks: [], nativeLogs: [], lastPosted: 0 };
let dlCurrentAction = null;
setInterval(() => {
  postMessage({ verb: 'danlingo.gpu', args: [{ metrics: { nativeActionTrace: {
    actions: dlActionTrace.actions, slow: dlActionTrace.slow, gpu: dlActionTrace.gpu, gpuSlow: dlActionTrace.gpuSlow,
    stacks: dlActionTrace.stacks, nativeLogs: dlActionTrace.nativeLogs, at: performance.now(),
    current: dlCurrentAction, queued: wasmCallQueue.length,
  } } }] });
}, 1000);
const dlStackKeys = new Set();
const dlObserveNativeLog = text => {
  if (typeof text !== 'string') return;
  const event = /context checkpoints disabled/i.test(text) ? 'checkpoint-disabled'
    : /context checkpoints enabled/i.test(text) ? 'checkpoint-enabled'
    : /created context checkpoint/i.test(text) ? 'checkpoint-created'
    : /restored context checkpoint/i.test(text) ? 'checkpoint-restored'
    : /checkpoint/i.test(text) ? 'checkpoint'
    : /saving idle slot to prompt cache/i.test(text) ? 'save-idle-slot'
    : /prompt cache update took/i.test(text) ? 'prompt-cache-update-time'
    : /updating prompt cache/i.test(text) ? 'prompt-cache-update'
    : /saving prompt with length/i.test(text) ? 'save-prompt-state' : null;
  if (!event) return;
  dlActionTrace.nativeLogs.push({ event, callbackId: dlCurrentAction?.callbackId,
    action: dlCurrentAction?.action, at: performance.now(), numbers: (text.match(/[0-9]+(?:[.][0-9]+)?/g) ?? []).slice(0, 12).map(Number) });
  if (dlActionTrace.nativeLogs.length > 128) dlActionTrace.nativeLogs.shift();
};
const dlWrapGpuAsync = (prototype, method) => {
  if (!prototype || typeof prototype[method] !== 'function') return;
  const original = prototype[method];
  prototype[method] = function(...args) {
    const started = performance.now(), action = dlCurrentAction;
    const bytes = method === 'mapAsync' ? Number(args[2] ?? Math.max(0, this.size - (args[1] ?? 0))) : undefined;
    const bufferBytes = method === 'mapAsync' ? this.size : undefined;
    if (method === 'mapAsync' && action) {
      action.mapCount++; action.mapBytes += bytes;
      const bucket = bytes <= 16 ? '<=16' : bytes <= 4096 ? '<=4096' : bytes <= 65536 ? '<=65536' : '>65536';
      action.mapSizes[bucket] = (action.mapSizes[bucket] ?? 0) + 1;
      // Capture at most 16 distinct WASM stacks, with no prompt/log contents.
      if (bytes > 16 && action.mapCount > 8 && started - action.started > 200 && dlActionTrace.stacks.length < 16) {
        const savedLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 40;
        let frames;
        try { frames = (new Error().stack ?? '').split('\\n').filter(line => /wasm-function/.test(line)).slice(0, 32); }
        finally { Error.stackTraceLimit = savedLimit; }
        const key = frames.join('\\n');
        if (key && !dlStackKeys.has(key)) { dlStackKeys.add(key); dlActionTrace.stacks.push({ callbackId: action.callbackId,
          action: action.action, at: started, bytes, mapCount: action.mapCount, frames }); }
      }
    }
    const end = () => {
      const ended = performance.now(), ms = ended - started;
      const row = dlActionTrace.gpu[method] ??= { count: 0, totalMs: 0, maxMs: 0, bytes: 0 };
      row.count++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); row.bytes += bytes ?? 0;
      if (ms > 100) { dlActionTrace.gpuSlow.push({ method, ...action, started, ended, ms, bytes, bufferBytes }); if(dlActionTrace.gpuSlow.length > 128) dlActionTrace.gpuSlow.shift(); }
    };
    const promise = original.apply(this, args);
    return promise.then(value => { end(); return value; }, error => { end(); throw error; });
  };
};
dlWrapGpuAsync(globalThis.GPUBuffer?.prototype, 'mapAsync');
dlWrapGpuAsync(globalThis.GPUQueue?.prototype, 'onSubmittedWorkDone');
const dlFinishTrace = (trace, started, callbackId) => {
  const ended = performance.now(), waitMs = started - trace.enqueued, executionMs = ended - started;
  const row = dlActionTrace.actions[trace.action] ??= { count: 0, waitMs: 0, executionMs: 0, maxWaitMs: 0, maxExecutionMs: 0, maxQueueDepth: 0 };
  row.count++; row.waitMs += waitMs; row.executionMs += executionMs;
  row.maxWaitMs = Math.max(row.maxWaitMs, waitMs); row.maxExecutionMs = Math.max(row.maxExecutionMs, executionMs); row.maxQueueDepth = Math.max(row.maxQueueDepth, trace.depth);
  if (waitMs > 100 || executionMs > 100) {
    dlActionTrace.slow.push({ callbackId, action: trace.action, enqueued: trace.enqueued, started, ended, waitMs, executionMs, queueDepth: trace.depth,
      mapCount: dlCurrentAction?.mapCount, mapBytes: dlCurrentAction?.mapBytes, mapSizes: dlCurrentAction?.mapSizes });
    if (dlActionTrace.slow.length > 256) dlActionTrace.slow.shift();
  }
  if (ended - dlActionTrace.lastPosted >= 500) {
    dlActionTrace.lastPosted = ended;
    postMessage({ verb: 'danlingo.gpu', args: [{ metrics: { nativeActionTrace: { actions: dlActionTrace.actions, slow: dlActionTrace.slow, gpu: dlActionTrace.gpu, gpuSlow: dlActionTrace.gpuSlow, stacks: dlActionTrace.stacks, nativeLogs: dlActionTrace.nativeLogs, at: ended } } }] });
  }
};
const runWasmCall = async (callbackId, fn, trace = { action: 'lifecycle', enqueued: performance.now(), depth: wasmCallQueue.length }) => {`);
  replaceOnce('wasmCallQueue.push({ callbackId, fn });', 'wasmCallQueue.push({ callbackId, fn, trace });');
  replaceOnce('wasmCallBusy = true;\n  try {\n    await fn();', 'wasmCallBusy = true;\n  const dlStarted = performance.now();\n  dlCurrentAction = { callbackId, action: trace.action, started: dlStarted, mapCount: 0, mapBytes: 0, mapSizes: {} };\n  try {\n    await fn();');
  replaceOnce('} finally {\n    wasmCallBusy = false;', '} finally {\n    dlFinishTrace(trace, dlStarted, callbackId);\n    dlCurrentAction = null;\n    wasmCallBusy = false;');
  replaceOnce('if (next) runWasmCall(next.callbackId, next.fn);', 'if (next) runWasmCall(next.callbackId, next.fn, next.trace);');
  replaceOnce('await runWasmCall(callbackId, () => runAction(e.data));', `await runWasmCall(callbackId, () => runAction(e.data), { action: /^[a-z_]{1,40}$/.test(args[0]) ? args[0] : 'unknown', enqueued: performance.now(), depth: wasmCallQueue.length });`);
  replaceOnce('const logLine = cppLogToJSLog(text);', 'const logLine = cppLogToJSLog(text);\n      dlObserveNativeLog(logLine.text);');
  return source;
}
