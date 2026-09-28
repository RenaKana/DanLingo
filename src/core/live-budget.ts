/** Browser timers use signed 32-bit millisecond delays. No product-level preset ceiling. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_LIVE_BUFFER_MS = 3000;
export function validLiveBufferMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_DELAY_MS;
}
export function liveBufferMs(value: unknown): number { return validLiveBufferMs(value) ? value : DEFAULT_LIVE_BUFFER_MS; }
