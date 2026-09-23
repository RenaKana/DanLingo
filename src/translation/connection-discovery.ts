import { resolveConnection } from '../core/connection.ts';
import type { ProviderSettings } from '../core/types.ts';
import { discoverModels, ProviderError } from './provider.ts';

/** User-triggered discovery only. At most two read-only, same-prefix candidates. */
export async function discoverConnectionModels(settings: ProviderSettings, apiKey: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  const connection = resolveConnection(settings);
  const discover = (endpoint: string, endpointMode = connection.endpointMode) => discoverModels({
    endpoint, endpointMode, protocolOverride: connection.protocol, allowLocalHttp: settings.allowLocalHttp,
    apiKey, signal: options.signal, timeoutMs: settings.requestTimeoutMs,
  }, options.fetch);
  if (!connection.requiresManualPath) return { models: await discover(settings.endpoint) };
  const first = new URL(connection.configuredCompletionEndpoint);
  const second = new URL(first); second.pathname = first.pathname.replace(/\/+$/, '') + '/v1';
  for (const [index, candidate] of [first, second].entries()) {
    try {
      const models = await discover(candidate.href, 'base');
      return { models, effectiveEndpoint: candidate.href, effectiveEndpointMode: 'base' as const };
    } catch (error) {
      // Authentication and quota errors are authoritative; never try another URL with that key.
      if (!(error instanceof ProviderError) || !['http-404', 'http-405'].includes(error.message) || index === 1) throw error;
    }
  }
  throw new ProviderError('http-404');
}
