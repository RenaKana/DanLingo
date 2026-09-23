import type { OnlineBudgetState } from '../core/online-budget.ts';

export function onlineBudgetText(state?: OnlineBudgetState): string {
  if (!state || state.status === 'unavailable') return '在线请求计数不可用，已停止在线发送。';
  const usage = `今日在线请求 ${state.used} / ${state.limit} · 剩余 ${state.remaining}`;
  return state.status === 'exhausted' ? `${usage}。已达每日上限，次日或调高上限后恢复新请求。` : usage;
}
