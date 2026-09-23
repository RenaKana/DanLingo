// Self-contained: the GPU guard embeds this function into the native worker.
// Buffer bytes cover explicit app createBuffer/destroy lifetime, not physical VRAM.
export function installGpuMeter(device, report, measureTiming = false) {
  const createBuffer = device.createBuffer.bind(device);
  const timestampQueries = !!(measureTiming && device.features?.has('timestamp-query'));
  // 1024 passes cover deep-model encoders; retain a fixed eight-record ceiling.
  // Resolve/readback buffers together remain <= 256 KiB (query storage excluded).
  const maxRecords = 64, maxTimestamps = 2048;
  const records = new Set(), commandRecords = new WeakMap(), reads = new Set();
  let allocatedBytes = 0, peakAllocatedBytes = 0, executionMs;
  let timedComputePasses = 0, missedComputePasses = 0, timingReadFailures = 0;
  let peakTimingRecords = 0, recordLimitMisses = 0, encoderLimitMisses = 0;
  let notificationQueued = false, stopped = false;
  // Wall-clock API latency includes validation and asynchronous wait, never GPU execution.
  // Counts include completed failed attempts; concurrent durations can overlap.
  const pipeline = { pipelineCreationMs: 0, pipelineCreationCount: 0, pipelineCreationPending: 0,
    pipelineCreationMaxMs: 0, pipelineCreationFailures: 0, pipelineCreationAsyncMs: 0,
    pipelineCreationAsyncCount: 0, pipelineCreationAsyncMaxMs: 0, pipelineCreationSyncMs: 0, pipelineCreationSyncCount: 0, pipelineCreationSyncMaxMs: 0 };
  const pipelineLabels = new Set(), flashPipelines = new WeakSet(), flashKernels = new WeakMap();
  let flashAttentionObserved = false, flashAttentionKernel;
  const namesFrom = (descriptor, result) => [descriptor?.label, descriptor?.compute?.entryPoint, result?.label]
    .filter(value => typeof value === 'string' && /^[A-Za-z0-9_. -]{1,80}$/.test(value));
  const observePipeline = (value, names) => {
    for (const name of [...names, ...namesFrom(undefined, value)]) {
      if (pipelineLabels.size < 32) pipelineLabels.add(name);
      if (/^flash_attn_(?:vec|vec_reduce|tile|vec_blk_kvt\d+_wg\d+|vec_reduce_dstf32_hsv\d+_wg\d+)$/.test(name) && value && typeof value === 'object') {
        flashPipelines.add(value); flashKernels.set(value, name);
      }
    }
  };
  const observePass = pass => {
    if (typeof pass.setPipeline !== 'function') return pass;
    let selected;
    const setPipeline = pass.setPipeline.bind(pass);
    pass.setPipeline = function (value, ...args) { const result = setPipeline(value, ...args); selected = value; return result; };
    for (const name of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
      if (typeof pass[name] !== 'function') continue;
      const dispatch = pass[name].bind(pass);
      pass[name] = function (...args) {
        const result = dispatch(...args);
        const hasWork = name === 'dispatchWorkgroupsIndirect' || (args[0] > 0 && (args[1] ?? 1) > 0 && (args[2] ?? 1) > 0);
        // Evidence of an encoded dispatch; completed warmup/inference supplies the execution boundary.
        if (!flashAttentionObserved && !stopped && hasWork && flashPipelines.has(selected)) {
          flashAttentionObserved = true; flashAttentionKernel = flashKernels.get(selected); notify();
        }
        return result;
      };
    }
    return pass;
  };
  const now = () => globalThis.performance?.now() ?? Date.now();
  const snapshot = () => ({ allocatedBytes, peakAllocatedBytes, timestampQueries,
    ...(executionMs === undefined ? {} : { executionMs }), timedComputePasses,
    missedComputePasses, timingReadFailures, pendingTimingRecords: records.size, peakTimingRecords,
    recordLimitMisses, encoderLimitMisses, ...pipeline, pipelineLabels: [...pipelineLabels], flashAttentionObserved,
    ...(flashAttentionKernel ? { flashAttentionKernel } : {}) });
  const emit = () => { notificationQueued = false; try { report(snapshot()); } catch { /* Diagnostics cannot interrupt inference. */ } };
  const notify = () => { if (!notificationQueued) { notificationQueued = true; queueMicrotask(emit); } };
  const finishPipeline = (started, asynchronous, failed) => {
    const ms = Math.max(0, now() - started);
    pipeline.pipelineCreationMs += ms; pipeline.pipelineCreationCount++;
    pipeline.pipelineCreationMaxMs = Math.max(pipeline.pipelineCreationMaxMs, ms);
    if (failed) pipeline.pipelineCreationFailures++;
    if (asynchronous) {
      pipeline.pipelineCreationPending--; pipeline.pipelineCreationAsyncMs += ms; pipeline.pipelineCreationAsyncCount++;
      pipeline.pipelineCreationAsyncMaxMs = Math.max(pipeline.pipelineCreationAsyncMaxMs, ms);
    } else { pipeline.pipelineCreationSyncMs += ms; pipeline.pipelineCreationSyncCount++; pipeline.pipelineCreationSyncMaxMs = Math.max(pipeline.pipelineCreationSyncMaxMs, ms); }
    notify();
  };
  if (typeof device.createComputePipelineAsync === 'function') {
    const createPipelineAsync = device.createComputePipelineAsync.bind(device);
    device.createComputePipelineAsync = function (...args) {
      const names = namesFrom(args[0]);
      const started = now(); pipeline.pipelineCreationPending++; notify();
      let result;
      try { result = createPipelineAsync(...args); }
      catch (error) { finishPipeline(started, true, true); throw error; }
      return Promise.resolve(result).then(
        value => { observePipeline(value, names); finishPipeline(started, true, false); return value; },
        error => { finishPipeline(started, true, true); throw error; },
      );
    };
  }
  if (typeof device.createComputePipeline === 'function') {
    const createPipeline = device.createComputePipeline.bind(device);
    device.createComputePipeline = function (...args) {
      const started = now();
      try { const names = namesFrom(args[0]); const value = createPipeline(...args); observePipeline(value, names); finishPipeline(started, false, false); return value; }
      catch (error) { finishPipeline(started, false, true); throw error; }
    };
  }
  const release = record => {
    if (record.released) return;
    record.released = true;
    for (const resource of [record.readback, record.resolve, record.queries]) {
      try { resource?.destroy(); } catch { /* Device loss can precede cleanup. */ }
    }
    records.delete(record);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; allocatedBytes = 0;
    for (const record of records) release(record);
    notify();
  };
  device.createBuffer = function (...args) {
    const buffer = createBuffer(...args);
    // GPUBuffer.size is the actual validated size; descriptors alone are not allocation proof.
    const bytes = Number.isFinite(buffer.size) && buffer.size >= 0 ? buffer.size : 0;
    const destroy = buffer.destroy.bind(buffer);
    let destroyed = false;
    allocatedBytes += bytes; peakAllocatedBytes = Math.max(peakAllocatedBytes, allocatedBytes); notify();
    buffer.destroy = function (...destroyArgs) {
      const result = destroy(...destroyArgs);
      if (!destroyed) { destroyed = true; if (!stopped) allocatedBytes = Math.max(0, allocatedBytes - bytes); notify(); }
      return result;
    };
    return buffer;
  };
  if (typeof device.destroy === 'function') {
    const destroyDevice = device.destroy.bind(device);
    device.destroy = function (...args) { const result = destroyDevice(...args); stop(); return result; };
  }
  device.lost?.then(stop, stop);
  {
    const createEncoder = device.createCommandEncoder.bind(device);
    const createQueries = timestampQueries ? device.createQuerySet.bind(device) : undefined;
    device.createCommandEncoder = function (...args) {
      const encoder = createEncoder(...args);
      const beginComputePass = encoder.beginComputePass.bind(encoder), finish = encoder.finish.bind(encoder);
      let record;
      encoder.beginComputePass = function (descriptor, ...rest) {
        if (!timestampQueries) return observePass(beginComputePass(descriptor, ...rest));
        if (stopped || descriptor?.timestampWrites || (record && record.count >= maxTimestamps) || (!record && records.size >= maxRecords)) {
          if (!record && records.size >= maxRecords) recordLimitMisses++;
          if (record && record.count >= maxTimestamps) encoderLimitMisses++;
          missedComputePasses++; notify(); return observePass(beginComputePass(descriptor, ...rest));
        }
        if (!record) {
          try {
            record = { queries: createQueries({ type: 'timestamp', count: maxTimestamps }), count: 0, submitted: false, released: false };
            records.add(record);
            peakTimingRecords = Math.max(peakTimingRecords, records.size);
          } catch { missedComputePasses++; notify(); return observePass(beginComputePass(descriptor, ...rest)); }
        }
        const start = record.count;
        const pass = beginComputePass({ ...descriptor, timestampWrites: { querySet: record.queries, beginningOfPassWriteIndex: start, endOfPassWriteIndex: start + 1 } }, ...rest);
        record.count += 2;
        return observePass(pass);
      };
      encoder.finish = function (...finishArgs) {
        if (record && !record.released && record.count) {
          try {
            const size = record.count * 8;
            // Use the bound original factory: instrumentation buffers are excluded from app bytes.
            record.resolve = createBuffer({ size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            record.readback = createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            encoder.resolveQuerySet(record.queries, 0, record.count, record.resolve, 0);
            encoder.copyBufferToBuffer(record.resolve, 0, record.readback, 0, size);
          } catch { missedComputePasses += record.count / 2; timingReadFailures++; release(record); notify(); }
        }
        let command;
        try { command = finish(...finishArgs); }
        catch (error) { if (record) release(record); throw error; }
        if (record && !record.released) {
          if (record.count) commandRecords.set(command, record); else release(record);
        }
        return command;
      };
      return encoder;
    };
  }
  if (timestampQueries) {
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = function (commands) {
      const submitted = Array.from(commands);
      let result;
      try { result = submit(submitted); }
      catch (error) {
        for (const command of submitted) {
          const record = commandRecords.get(command);
          if (record && !record.submitted && !record.released) { missedComputePasses += record.count / 2; release(record); }
        }
        notify(); throw error;
      }
      for (const command of submitted) {
        const record = commandRecords.get(command);
        if (!record || record.submitted || record.released) continue;
        record.submitted = true;
        const read = (async () => {
          try {
            // mapAsync waits for this submitted copy, never substitutes queue wall time for GPU time.
            await record.readback.mapAsync(GPUMapMode.READ);
            if (record.released) return;
            const data = new DataView(record.readback.getMappedRange());
            let nanoseconds = 0n;
            for (let i = 0; i < record.count; i += 2) {
              const start = data.getBigUint64(i * 8, true), end = data.getBigUint64((i + 1) * 8, true);
              if (end >= start) { nanoseconds += end - start; timedComputePasses++; }
              else missedComputePasses++;
            }
            executionMs = (executionMs ?? 0) + Number(nanoseconds) / 1e6;
            record.readback.unmap();
          } catch { if (!stopped) { timingReadFailures++; missedComputePasses += record.count / 2; } }
          finally { release(record); notify(); }
        })();
        reads.add(read); void read.finally(() => reads.delete(read));
      }
      return result;
    };
  }
  notify();
  return { snapshot, async flush() { await Promise.all([...reads]); if (notificationQueued) await Promise.resolve(); return snapshot(); } };
}
