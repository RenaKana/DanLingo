import { liveBufferMs, MAX_TIMER_DELAY_MS } from './live-budget.ts';
/** A second Bilibili live attempt has its own bounded queue + request budget. */
export const MAX_TIMEOUT_RETRY_EXTRA_MS = 30000;
export function timeoutRetryBudget(bufferMs: number, extraMs: unknown = 1000): number {
  const extra = typeof extraMs === 'number' && Number.isFinite(extraMs)
    ? Math.max(0, Math.min(MAX_TIMEOUT_RETRY_EXTRA_MS, Math.floor(extraMs))) : 1000;
  return Math.min(MAX_TIMER_DELAY_MS, liveBufferMs(bufferMs) + extra);
}

export type TimeoutRetryPlatform = 'bilibili' | 'youtube' | 'niconico';
export interface TimeoutRetrySettings {
  liveBufferMs?: unknown;
  bilibiliTimeoutRetryEnabled?: unknown;
  bilibiliTimeoutRetryExtraMs?: unknown;
  bilibiliTimeoutRetryMode?: unknown;
  youtubeTimeoutRetryEnabled?: unknown;
  youtubeTimeoutRetryExtraMs?: unknown;
  youtubeTimeoutRetryMode?: unknown;
  niconicoTimeoutRetryEnabled?: unknown;
  niconicoTimeoutRetryExtraMs?: unknown;
  niconicoTimeoutRetryMode?: unknown;
}
export interface TimeoutRetryPolicy { timeoutMs: number; hold: boolean }

/** Resolve the one automatic ordinary-message retry policy for a live platform. */
export function getTimeoutRetryPolicy(settings: TimeoutRetrySettings | null | undefined, platform: TimeoutRetryPlatform): TimeoutRetryPolicy | undefined {
  if (!settings) return undefined;
  const prefix = platform === 'bilibili' ? 'bilibili' : platform === 'youtube' ? 'youtube' : 'niconico';
  const enabled = settings[`${prefix}TimeoutRetryEnabled` as keyof TimeoutRetrySettings];
  if (enabled !== true) return undefined;
  const extra = settings[`${prefix}TimeoutRetryExtraMs` as keyof TimeoutRetrySettings];
  const mode = settings[`${prefix}TimeoutRetryMode` as keyof TimeoutRetrySettings];
  return { timeoutMs: timeoutRetryBudget(typeof settings.liveBufferMs === 'number' ? settings.liveBufferMs : 2000, extra), hold: mode !== 'release' };
}
