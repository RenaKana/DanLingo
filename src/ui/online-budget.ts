import type { OnlineBudgetState } from '../core/online-budget.ts';
import { t } from '../i18n/text.ts';

export function onlineBudgetText(state?: OnlineBudgetState): string {
  if (!state || state.status === 'unavailable') return t('m_0d5d7207cfdf');
  if (state.limit === 0) return state.used !== null && Number.isFinite(state.used)
    ? t('budget.unlimitedUsage', { count: state.used }) : t('budget.unlimited');
  if (state.used === null || state.remaining === null || !Number.isFinite(state.used) || !Number.isFinite(state.remaining) || !Number.isFinite(state.limit)) return t('m_0d5d7207cfdf');
  const usage = t('m_93022426d610', { p0: state.used, p1: state.limit, p2: state.remaining });
  return state.status === 'exhausted' ? t('m_1fdf3bb1384a', { p0: usage }) : usage;
}
