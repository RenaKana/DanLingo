import { resourceFromUrl } from './resource.ts';
import type { AdapterDiagnostic } from './types.ts';

export const DIAGNOSTIC_LEASE_MS = 6000;
export const DIAGNOSTIC_HEARTBEAT_MS = 1000;
const codes = new Set<AdapterDiagnostic['code']>([
  'waiting-player', 'unsupported-version', 'identity-mismatch', 'native-entry-unavailable',
  'invalid-clock', 'waiting-status', 'native-unresponsive', 'content-unresponsive',
]);

export function diagnosticCandidate(href: string): string | null {
  const resource = resourceFromUrl(href);
  return resource?.platform === 'bilibili' && resource.scenario === 'video' ? resource.resourceId : null;
}

/** Strip page-supplied fields; in particular never carry source text, credentials or native IDs. */
export function parseAdapterDiagnostic(value: unknown, candidate: string | null): AdapterDiagnostic | null {
  if (!candidate || !value || typeof value !== 'object') return null;
  const d = value as AdapterDiagnostic;
  if (d.platform !== 'bilibili' || d.scenario !== 'video' || d.urlResourceId !== candidate || !codes.has(d.code)) return null;
  const result: AdapterDiagnostic = { platform: 'bilibili', scenario: 'video', urlResourceId: candidate, code: d.code };
  if (typeof d.nativeVersion === 'string' && /^[a-zA-Z0-9._-]{1,60}$/.test(d.nativeVersion)) result.nativeVersion = d.nativeVersion;
  if (typeof d.nativeCompiled === 'string' && /^[0-9TtZz:+.\-]{1,60}$/.test(d.nativeCompiled)) result.nativeCompiled = d.nativeCompiled;
  return result;
}

export function adapterDiagnostic(candidate: string, code: AdapterDiagnostic['code']): AdapterDiagnostic {
  return { platform: 'bilibili', scenario: 'video', urlResourceId: candidate, code };
}

export function adapterDiagnosticText(d: AdapterDiagnostic): string {
  switch (d.code) {
    case 'unsupported-version': return `当前原生弹幕版本${d.nativeVersion ? ` ${d.nativeVersion}` : ''}尚未支持${d.nativeCompiled ? `（编译于 ${d.nativeCompiled}）` : ''}，保留原文`;
    case 'waiting-player': return '已识别 Bilibili 视频，正在等待原生播放器';
    case 'identity-mismatch': return '无法确认当前 BV/AV、分 P 和 CID 与原生播放器一致，保留原文';
    case 'native-entry-unavailable': return '原生弹幕替换入口不可用，保留原文';
    case 'invalid-clock': return '原生播放器时钟尚未就绪，保留原文';
    case 'waiting-status': return '原生播放器已响应，正在等待扩展后台确认';
    case 'native-unresponsive': return '已识别 Bilibili 视频，未收到原生播放器状态';
    case 'content-unresponsive': return '已识别 Bilibili 视频，但页面脚本未响应';
  }
}
