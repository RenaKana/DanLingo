// Browser-only fixture for the production widgets. No provider requests or user data.
import { createLiveRepairs } from '../src/ui/live-repairs';
import { createLiveStatus } from '../src/ui/live-status';
import { createProgress } from '../src/ui/progress';
import { DEFAULT_SETTINGS } from '../src/core/config';
import { BilibiliRepairDom } from '../src/platforms/bilibili-live/repairs-dom';
import { BilibiliRepairs } from '../src/platforms/bilibili-live/repairs';

const calls: unknown[] = [];
let release: ((value: any) => void) | undefined;
const repairs = createLiveRepairs({ request(value) { calls.push(value); return new Promise(done => release = done); }, scan() {} });
const status = createLiveStatus(); status.repairControl(repairs.host);
status.attach(document.querySelector<HTMLElement>('#live-player'));
status.update({ scenario: 'live', state: 'ready', connection: 'connected', messages: 2, translated: 1, original: 1, cacheHits: 0,
  queued: 0, coverage: 'all', recentEligible: 2, recentTranslated: 1 } as any, 'model-id/unchanged');
repairs.capture('original', 'User original 日本語', 'queued'); repairs.delivered('original', false);
repairs.capture('translated', 'Another original', 'queued'); repairs.prepared('translated', 'User translation 中文');
const progress = createProgress(async () => { calls.push('scope'); }, () => { calls.push('retry'); });
progress.attach('fixture-video', 'fixture-id');
progress.update({ ...DEFAULT_SETTINGS, enabled: true, displayMode: 'translated' }, { sourceComplete: true, messages: 10, total: 10, translated: 7, failed: 1,
  nearPrepared: 4, nearTotal: 5, skipped: { special: 0, language: 0, emoticon: 0 } } as any, '', true);
const ledger = new BilibiliRepairs({ now: Date.now, active: () => true, eligible: () => true, timeoutMs: () => 15000, send: value => calls.push(value) });
ledger.capture({ sourceId: 'dm:123456789', nativeId: '123456789', originalText: 'Native original 日本語' } as any);
const native = new BilibiliRepairDom({ ledger, active: () => true }); native.scan();
(window as any).__widgetFixture = { calls, repairs, resolve() { release?.({ id: (calls.at(-1) as any).requestId, status: 'translated', text: 'Manual result unchanged' }); },
  dispose() { repairs.dispose(); status.dispose(); progress.dispose(); native.dispose(); ledger.dispose(); } };
