import type { LocalGpuInfo } from './types.ts';

export const emptyGpuInfo = (): LocalGpuInfo => ({ vendor: '', architecture: '', deviceCreated: false, offloadedLayers: 0, totalLayers: 0, verified: false });

/** Retain only numeric/backend metadata from native logs; never retain prompts, templates or raw lines. */
export function observeGpuLog(info: LocalGpuInfo, value: unknown): void {
  if (typeof value !== 'string' || value.length > 1024) return;
  for (const line of value.split('\n')) {
    const text = line.trim();
    const layers = text.match(/^\w+:\s+offloaded (\d+)\/(\d+) layers to GPU$/);
    if (layers) { info.offloadedLayers = Number(layers[1]); info.totalLayers = Number(layers[2]); }
    const buffer = text.match(/^\w+:\s+(WebGPU\d*)\s+model buffer size\s*=\s*(\d+(?:\.\d+)?) MiB$/i);
    if (buffer) { info.nativeBackend = buffer[1]; info.modelBufferMiB = Number(buffer[2]); }
  }
}

export function verifyGpuOffload(info: LocalGpuInfo): void {
  if (!info.deviceCreated || !info.vendor || !info.nativeBackend || !(info.modelBufferMiB! > 0) || !(info.totalLayers > 0) || info.offloadedLayers !== info.totalLayers) throw new Error('LOCAL_GPU_OFFLOAD_UNVERIFIED');
  info.verified = true;
}
