// De-identified source-widget fixture only; no native page, adapter or model is involved.
import { mountRenderPreview, type RenderExistingTranslation, type RenderPreviewClock,
  type RenderPreviewLiveIdentity, type RenderPreviewLiveState, type RenderPreviewUiMode } from '../src/ui/render-preview.ts';
import type { DisplayPlanEvent } from '../src/core/display-plan.ts';
import { setLocale } from '../src/i18n/text.ts';

const resourceId = 'av123:cid456';
let clock: RenderPreviewClock = { resourceId, epoch: 1, mediaTimeMs: 9000, paused: false, contentActive: true };
let events: DisplayPlanEvent[] = [];
const actions: boolean[] = [];
const liveActions: ('start' | 'stop')[] = [], modes: RenderPreviewUiMode[] = [];
const shadow = document.getElementById('render-host')!.attachShadow({ mode: 'open' });
const hostStyle = document.createElement('style');
hostStyle.textContent = 'details{min-width:0;max-width:380px}';
shadow.append(hostStyle);
const mount = document.createElement('div'); shadow.append(mount);
const app = mountRenderPreview(mount, {
  getClock: () => ({ ...clock }), onToggle: enabled => { actions.push(enabled); },
  onLiveAction: action => { liveActions.push(action); }, onModeChange: mode => { modes.push(mode); },
});
setLocale('zh-CN');

const event = (id: string, mediaTimeMs: number, originalText: string,
  unknown = false, eventEpoch = clock.epoch): DisplayPlanEvent => ({
  id, sourceId: `fixture-thread:${id}`, originalText, mediaTimeMs, resourceId,
  epoch: eventEpoch, bucket: Math.floor(mediaTimeMs / 1000), startMs: Math.floor(mediaTimeMs / 1000) * 1000,
  selectedAtMs: mediaTimeMs - 3000, selectedWallTimeMs: 1000, leadMs: 3000,
  coldStart: false, unknown, needsTranslation: true, sourceRevision: 1, ruleRevision: 1,
  planRevision: 1, state: 'frozen', reason: 'selected',
});
const seed = (row: DisplayPlanEvent, text: string, availableAtWallMs = Math.max(0, performance.now() - 10)): RenderExistingTranslation => ({
  id: row.id, sourceId: row.sourceId, resourceId: row.resourceId, epoch: row.epoch,
  originalText: row.originalText, targetLanguage: 'zh', text, availableAtWallMs,
  availableAtMediaMs: row.mediaTimeMs - 500, origin: 'export',
});
const fixture = {
  event, seed, actions, liveActions, modes,
  liveSeed(row: DisplayPlanEvent, text: string, patch: Partial<RenderExistingTranslation> = {}): RenderExistingTranslation {
    return { ...seed(row, text), origin: 'live-local', runId: 'fixture-run', requestId: 'fixture-request',
      resultId: 'fixture-result', configIdentity: 'fixture-config', ...patch } as RenderExistingTranslation;
  },
  get clock() { return { ...clock }; },
  setClock(mediaTimeMs: number, patch: Partial<RenderPreviewClock> = {}) {
    clock = { ...clock, mediaTimeMs, ...patch };
  },
  feed(next: DisplayPlanEvent[], existingTranslations: RenderExistingTranslation[] = [],
    contextValid = true, eligibilityById: Record<string, 'exclude' | 'retain' | 'unknown'> = {},
    liveIdentity?: RenderPreviewLiveIdentity) {
    events = next;
    return app.feed({ resourceId: clock.resourceId, epoch: clock.epoch, contextValid,
      targetLanguage: 'zh', events, existingTranslations, eligibilityById, liveIdentity });
  },
  repeat(existingTranslations: RenderExistingTranslation[] = [], liveIdentity?: RenderPreviewLiveIdentity) {
    return this.feed(events, existingTranslations, true, {}, liveIdentity);
  },
  report(includeText = false) { return app.report(includeText); },
  enabled(value: boolean) { app.setEnabled(value); },
  setMode(value: RenderPreviewUiMode) { app.setMode(value); },
  setLiveState(value: RenderPreviewLiveState) { app.setLiveState(value); },
  reveal() { app.reveal(); },
  cleanup() { app.cleanup(); },
  dispose() { app.dispose(); },
};
(window as typeof window & { __renderFixture?: typeof fixture }).__renderFixture = fixture;
