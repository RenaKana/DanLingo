import { resolveConnection } from '../core/connection.ts';
import type { ProviderSettings } from '../core/types.ts';
import { discoverModelCatalog, ProviderError } from './provider.ts';
import type { DiscoveredModelCatalog } from './provider.ts';

/** User-triggered discovery only. At most two read-only, same-prefix candidates. */
export async function discoverConnectionModels(settings: ProviderSettings, apiKey: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<DiscoveredModelCatalog & { effectiveEndpoint?: string; effectiveEndpointMode?: 'base' }> {
  const connection = resolveConnection(settings);
  const discover = (endpoint: string, endpointMode = connection.endpointMode) => discoverModelCatalog({
    endpoint, endpointMode, protocolOverride: connection.protocol, allowLocalHttp: settings.allowLocalHttp,
    apiKey, signal: options.signal, timeoutMs: settings.requestTimeoutMs,
  }, options.fetch);
  if (!connection.requiresManualPath) return await discover(settings.endpoint);
  const first = new URL(connection.configuredCompletionEndpoint);
  const second = new URL(first); second.pathname = first.pathname.replace(/\/+$/, '') + '/v1';
  for (const [index, candidate] of [first, second].entries()) {
    try {
      const catalog = await discover(candidate.href, 'base');
      return { ...catalog, effectiveEndpoint: candidate.href, effectiveEndpointMode: 'base' as const };
    } catch (error) {
      // Authentication and quota errors are authoritative; never try another URL with that key.
      if (!(error instanceof ProviderError) || !['http-404', 'http-405'].includes(error.message) || index === 1) throw error;
    }
  }
  throw new ProviderError('http-404');
}
