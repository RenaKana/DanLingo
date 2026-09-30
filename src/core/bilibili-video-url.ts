/** A page candidate only; actual playback always requires a native manifest. */
export interface BilibiliUrlIdentity {
  urlResourceId: string;
  page: number;
  bvid?: string;
  aid?: string;
  /** Festival query parameters select the entry video, not later in-player episodes. */
  playbackIdentity?: 'manifest';
}

/** Keep background, content and MAIN-world route recognition identical. */
export function parseBilibiliVideoUrl(value: string): BilibiliUrlIdentity | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.bilibili.com' || url.username || url.password) return null;
    if (url.searchParams.getAll('p').length > 1) return null;
    const pageText = url.searchParams.get('p') ?? '1';
    if (!/^[1-9]\d{0,4}$/.test(pageText)) return null;
    const page = Number(pageText);
    let id = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,19})\/?$/.exec(url.pathname)?.[1];
    if (id) return { urlResourceId: `${id}:p${page}`, page,
      ...(id.startsWith('BV') ? { bvid: id } : { aid: id.slice(2) }) };

    const festival = /^\/festival\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    const playlist = /^\/(?:list|medialist\/play)\/(?:watchlater|(?:ml)?[1-9]\d{0,19})\/?$/.test(url.pathname);
    if (!festival && !playlist) return null;
    for (const key of ['bvid', 'aid', 'oid']) if (url.searchParams.getAll(key).length > 1) return null;
    const bvid = url.searchParams.get('bvid');
    const aid = url.searchParams.get('aid'), oid = url.searchParams.get('oid');
    if (bvid !== null && !/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null;
    for (const value of [aid, oid]) if (value !== null && !/^[1-9]\d{0,19}$/.test(value)) return null;
    if (aid !== null && oid !== null && aid !== oid) return null;
    if (festival && !bvid) return null;
    const videoAid = aid ?? oid;
    // The public playlist page writes the current item's bvid/oid on metadata
    // load. Until then, wait; sid/business_id/the path identify a list, not video.
    if (!bvid && !videoAid) return null;
    id = bvid ?? `av${videoAid}`;
    return { urlResourceId: `${id}:p${page}`, page,
      ...(festival ? { playbackIdentity: 'manifest' as const } : {}),
      ...(bvid ? { bvid } : {}), ...(videoAid ? { aid: videoAid } : {}) };
  } catch { return null; }
}
