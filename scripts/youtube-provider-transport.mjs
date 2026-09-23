// Browser-level routing also sees the production provider's previously bound fetch.
export async function installProviderTransport(context, { endpoint, maxPosts = 200 }) {
  const states = new Map();
  const totals = { posts: 0, active: 0, peak: 0, blocked: 0, failures: 0, statuses: {}, headerMs: [], bodyMs: [], stopped: false };
  const settle = (request, failed) => {
    const started = states.get(request); if (started === undefined) return;
    states.delete(request); totals.active--; totals.bodyMs.push(performance.now() - started); if (failed) totals.failures++;
  };
  const onResponse = response => {
    const started = states.get(response.request()); if (started === undefined) return;
    const status = response.status(); totals.headerMs.push(performance.now() - started);
    totals.statuses[status] = (totals.statuses[status] || 0) + 1;
    if ([401, 403, 429].includes(status)) totals.stopped = true;
  };
  const onFinished = request => settle(request, false), onFailed = request => settle(request, true);
  context.on('response', onResponse); context.on('requestfinished', onFinished); context.on('requestfailed', onFailed);
  const route = async handler => {
    const request = handler.request(); let body;
    try { body = request.postDataJSON(); } catch { /* Invalid protocol is blocked before transport. */ }
    if (request.url() !== endpoint || request.method() !== 'POST' || body?.model !== 'deepseek-flash' || body?.stream === true
      || totals.stopped || totals.posts >= maxPosts) { totals.blocked++; await handler.abort('blockedbyclient'); return; }
    states.set(request, performance.now()); totals.posts++; totals.active++; totals.peak = Math.max(totals.peak, totals.active);
    await handler.continue().catch(() => settle(request, true));
  };
  await context.route(endpoint, route);
  return {
    snapshot: () => ({ ...totals, statuses: { ...totals.statuses }, headerMs: [...totals.headerMs], bodyMs: [...totals.bodyMs] }),
    stop: () => { totals.stopped = true; },
    async close() {
      totals.stopped = true; await context.unroute(endpoint, route).catch(() => {});
      context.off('response', onResponse); context.off('requestfinished', onFinished); context.off('requestfailed', onFailed);
    },
  };
}
