import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Anonymous, bounded GET only. HTTP/API failures are evidence, never retried. */
export async function getPublic(url, maxBytes = 16 * 1024 * 1024) {
  const uri = new URL(url);
  if (uri.protocol !== 'https:' || (uri.port && uri.port !== '443') ||
      uri.username || uri.password ||
      !['api.bilibili.com', 'www.bilibili.com', 's1.hdslb.com'].includes(uri.hostname)) {
    throw new Error('URL outside public probe allowlist');
  }
  let result;
  let bytes;
  if (process.platform === 'win32') {
    const output = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-File',
      fileURLToPath(new URL('./bilibili-http.ps1', import.meta.url)),
      '-Uri', uri.href, '-MaxBytes', String(maxBytes)], {
      encoding: 'utf8', timeout: 40_000, maxBuffer: 24 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = JSON.parse(output.replace(/^\uFEFF/, ''));
    bytes = Buffer.from(result.bodyBase64, 'base64');
  } else {
    const start = performance.now();
    const response = await fetch(uri, { redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { referer: 'https://www.bilibili.com/', 'user-agent': 'DanLingo-P0-readonly-probe' } });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Response exceeds probe byte limit');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    result = { status: response.status, contentType: response.headers.get('content-type'),
      elapsedMs: Math.round(performance.now() - start), fetchedAt: new Date().toISOString() };
  }
  if (bytes.length > maxBytes) throw new Error('Response exceeds probe byte limit');
  return { bytes, evidence: { url: uri.href, status: result.status,
    contentType: result.contentType, fetchedAt: result.fetchedAt, elapsedMs: result.elapsedMs,
    bytes: bytes.length, sha256: sha256(bytes), credentials: 'anonymous; no cookies or tokens' } };
}
