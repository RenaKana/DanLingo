// Serialized into the packaged native worker. Never logs payloads or executable remote code.
export function installGpuGuard(installMeter) {
  let meter, flushing = false;
  // Installed before Wllama's onmessage: diagnostics never enter its callback queue.
  self.addEventListener?.('message', event => {
    if (event.data?.verb !== 'danlingo.gpu.flush') return;
    event.stopImmediatePropagation();
    const id = event.data.id;
    if (!Number.isSafeInteger(id)) return;
    if (flushing) { self.postMessage({ verb: 'danlingo.gpu.flushed', id, error: 'LOCAL_GPU_TIMING_BUSY' }); return; }
    flushing = true;
    Promise.resolve().then(() => {
      if (!meter) throw new Error('LOCAL_GPU_TIMING_UNAVAILABLE');
      return meter.flush();
    }).then(metrics => { flushing = false; self.postMessage({ verb: 'danlingo.gpu.flushed', id, metrics }); },
      () => { flushing = false; self.postMessage({ verb: 'danlingo.gpu.flushed', id, error: 'LOCAL_GPU_TIMING_UNAVAILABLE' }); });
  });
  const report = value => self.postMessage({ verb: 'danlingo.gpu', args: [value] });
  const fail = code => { report({ error: code }); throw new Error(code); };
  const gpu = navigator.gpu;
  if (!gpu) { report({ error: 'LOCAL_WEBGPU_UNSUPPORTED' }); return; }
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async options => {
    let adapter;
    try { adapter = await requestAdapter({ ...options, powerPreference: 'high-performance', forceFallbackAdapter: false }); }
    catch { return fail('LOCAL_WEBGPU_UNSUPPORTED'); }
    if (!adapter) return fail('LOCAL_WEBGPU_UNSUPPORTED');
    const info = adapter.info;
    if (!info || info.isFallbackAdapter !== false || /swiftshader|software|llvmpipe|lavapipe|basic render/i.test([info.vendor, info.architecture, info.description].join(' '))) return fail('LOCAL_GPU_SOFTWARE_ADAPTER');
    const safe = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 80) : '';
    report({ adapter: { vendor: safe(info.vendor), architecture: safe(info.architecture) } });
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async descriptor => {
      let device;
      const measureTiming = !!self.location && new URL(self.location.href).searchParams.get('measureGpu') === '1';
      const features = new Set(descriptor?.requiredFeatures ?? []);
      if (measureTiming && adapter.features?.has('timestamp-query')) features.add('timestamp-query');
      try { device = await requestDevice({ ...descriptor, requiredFeatures: [...features] }); } catch { return fail('LOCAL_GPU_DEVICE_FAILED'); }
      if (installMeter) meter = installMeter(device, metrics => report({ metrics }), measureTiming);
      report({ deviceCreated: true });
      device.lost.then(() => report({ error: 'LOCAL_GPU_DEVICE_LOST' }));
      device.addEventListener('uncapturederror', () => report({ error: 'LOCAL_GPU_DEVICE_FAILED' }));
      return device;
    };
    return adapter;
  };
}
