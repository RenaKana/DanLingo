/** Exact, audited engine builds. Controller rule signatures are independent. */
export const NATIVE_ENGINE_BUILDS = Object.freeze([
  Object.freeze({ version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00', adapter: 'danmaku-x-v1' as const }),
  Object.freeze({ version: '1.1.22', lastCompiled: '2026-07-14T14:26:03+08:00', adapter: 'danmaku-x-v1' as const }),
  Object.freeze({ version: '1.1.21', lastCompiled: '2026-04-09T15:46:43+08:00', adapter: 'danmaku-x-v1' as const }),
]);

export type ReviewedDanmakuBuild = typeof NATIVE_ENGINE_BUILDS[number];
// Preserve the public metadata-only shape used by diagnostics and fixtures.
export const REVIEWED_DANMAKU_BUILDS = Object.freeze(NATIVE_ENGINE_BUILDS.map(({ version, lastCompiled }) =>
  Object.freeze({ version, lastCompiled })));
export const DANMAKU_VERSION = NATIVE_ENGINE_BUILDS[0]!.version;
export const DANMAKU_LAST_COMPILED = NATIVE_ENGINE_BUILDS[0]!.lastCompiled;

export function findReviewedDanmakuBuild(metadata: unknown): ReviewedDanmakuBuild | null {
  if (!metadata || typeof metadata !== 'object') return null;
  try {
    const { version, lastCompiled } = metadata as Record<string, unknown>;
    return NATIVE_ENGINE_BUILDS.find(build => build.version === version && build.lastCompiled === lastCompiled) ?? null;
  } catch { return null; }
}

export function isReviewedDanmakuBuild(metadata: unknown): boolean {
  return findReviewedDanmakuBuild(metadata) !== null;
}
