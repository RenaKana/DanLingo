/** Host restarts lose in-memory requests. Recovery only drains page demand and revokes the old permit. */
export async function recoverLivePreviewWithoutNewCalls(options: {
  pageReady: boolean;
  drainPage: () => Promise<{ report?: { plan?: { B?: { supplyStopped?: boolean } } } }>;
  stopHost: () => Promise<{ grant?: { state?: string } | null }>;
  exportPage: () => Promise<unknown>;
}) {
  let pageSupplyStopped = false;
  let pageError: string | null = options.pageReady ? null : 'target-document-unavailable';
  if (options.pageReady) {
    try {
      const drained = await options.drainPage();
      if (drained.report?.plan?.B?.supplyStopped !== true)
        throw new Error('page-supply-stop-unconfirmed');
      pageSupplyStopped = true;
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'page-drain-unavailable';
    }
  }
  const host = await options.stopHost();
  if (host.grant?.state !== 'stopped') throw new Error('host-permit-revocation-unconfirmed');
  let page: unknown = null;
  if (pageSupplyStopped) {
    try { page = await options.exportPage(); }
    catch (error) { pageError = error instanceof Error ? error.message : 'page-export-unavailable'; }
  }
  return { page, pageError, pageSupplyStopped, host };
}
