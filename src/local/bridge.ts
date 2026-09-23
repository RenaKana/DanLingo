import { browser } from 'wxt/browser';
import { LOCAL_CHANNEL } from './types.ts';
import type { LocalControl, LocalReply } from './types.ts';
import { ProviderError } from '../translation/provider.ts';
let creating: Promise<void> | undefined;
export async function ensureLocalOffscreen(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    const url = browser.runtime.getURL('/offscreen.html');
    const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (!contexts.length) await browser.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'], justification: 'Run one shared local GGUF model in a dedicated worker and retain selected model blobs across settings windows.' });
  })();
  try { await creating; } finally { creating = undefined; }
}
/** Background-only: the caller must gate UI controls with its existing trustedUi check. */
export async function localControl(control: LocalControl): Promise<LocalReply> {
  await ensureLocalOffscreen();
  return browser.runtime.sendMessage({ channel: LOCAL_CHANNEL, ...control });
}

/** Provider fetch adapter: strictly IPC, never calls the browser/network fetch. */
export function createLocalFetch(modelId: string): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal; if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await ensureLocalOffscreen().catch(() => { throw new ProviderError('LOCAL_OFFSCREEN_UNAVAILABLE'); });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const id = crypto.randomUUID();
    let body: any;
    try { body = JSON.parse(String(init?.body)); } catch { throw new ProviderError('LOCAL_REQUEST_INVALID'); }
    if (!body || !Array.isArray(body.messages) || body.messages.some((entry: any) => !entry || !['system', 'user', 'assistant'].includes(entry.role) || typeof entry.content !== 'string') || JSON.stringify(body.messages).length > 100_000) throw new ProviderError('LOCAL_REQUEST_INVALID');
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      void browser.runtime.sendMessage({ channel: LOCAL_CHANNEL, action: 'abort', id }).catch(() => {});
      rejectAbort(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response: LocalReply = await Promise.race([browser.runtime.sendMessage({ channel: LOCAL_CHANNEL, action: 'complete', id, modelId, body: { messages: body.messages, max_tokens: body.max_tokens ?? body.max_completion_tokens,
        strategy: body.danlingo_strategy ?? 'normal', temperature: body.temperature, reasoning: body.reasoning,
        cache_prompt: body.cache_prompt } }).catch(() => { throw new ProviderError('LOCAL_OFFSCREEN_UNAVAILABLE'); }), aborted]);
      if (!response?.ok) throw new ProviderError(/^LOCAL_[A-Z0-9_]+$/.test(response?.error ?? '') ? response.error! : 'LOCAL_OFFSCREEN_UNAVAILABLE');
      // Preserve the provider's selected response framing. This is one complete
      // final SSE delta, not a claim of token streaming or measured first-token time.
      if (body.stream) {
        const result = response.result as any;
        const chunk = { choices: [{ index: 0, delta: { content: result?.choices?.[0]?.message?.content ?? '' }, finish_reason: 'stop' }], usage: result?.usage };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify(response.result), { status: 200, headers: { 'content-type': 'application/json' } });
    } finally { signal?.removeEventListener('abort', onAbort); }
  }) as typeof fetch;
}
