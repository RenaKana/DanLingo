// Isolated extension fixture: no platform page, provider request, or personal profile.
import { createProgress } from '../src/ui/progress';
import { DEFAULT_SETTINGS } from '../src/core/config';
import type { SchedulerStats } from '../src/core/scheduler';
import type { Settings } from '../src/core/types';

const settings = { ...DEFAULT_SETTINGS, enabled: true, displayMode: 'translated' as const, prefetchSeconds: 5 };
const saves: Array<{ scope: Settings['translationScope']; seconds: number }> = [];
let retries = 0;
let progress: ReturnType<typeof createProgress>;
const nativeSupply = { visible: true, planned: true, state: 'running', status: '未来 5 秒规划运行中',
  actionText: '', actionHidden: true, actionDisabled: true, candidates: 12, selected: 8,
  submitted: 6, cacheHits: 2, adopted: 4, skipped: 1,
  hybrid: {
    local: { actualRequests: 4, inputItems: 5, inputChars: 80, cacheHits: 1, timelyQualified: 3 },
    online: { actualRequests: 2, inputItems: 3, inputChars: 50, cacheHits: 0, timelyQualified: 2 },
    subscriptions: 8, uniqueTasks: 7, mergedInputs: 1, expired: 0,
  },
};
const render = () => {
  progress.update(settings, stats, '', true, false, { translated: 5, original: 2 });
  progress.updateNativeSupply(nativeSupply);
};
progress = createProgress(async (scope, seconds) => {
  saves.push({ scope, seconds });
  settings.translationScope = scope;
  settings.prefetchSeconds = seconds;
  render();
}, () => { retries++; });
const stats: SchedulerStats = {
  candidates: 24, total: 15, filtered: 3, eligibilityUnknown: 2, effectiveScope: 'window', displayState: 'visible',
  skipped: { special: 1, language: 1, emoticon: 0 }, messages: 10, translated: 7, cacheHits: 2,
  queued: 2, inflight: 1, failed: 1, expired: 0, nearTotal: 5, nearPrepared: 4, sourceComplete: false,
};
progress.attach('fixture-video', 'fixture-id');
render();
(window as typeof window & { __vodFixture?: { hidden: () => void; show: () => void; retry: () => void; updateProgress: () => number;
  state: () => { saves: Array<{ scope: Settings['translationScope']; seconds: number }>; retries: number };
  dispose: () => void } }).__vodFixture = {
  hidden() { stats.displayState = 'hidden'; render(); },
  show() { stats.displayState = 'visible'; render(); },
  retry() { document.querySelector('#danlingo-progress')?.shadowRoot?.getElementById('retry')?.click(); },
  updateProgress() { stats.translated++; render(); return stats.translated; },
  state() { return { saves: saves.slice(), retries }; },
  dispose() { progress.dispose(); },
};
