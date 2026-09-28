import { needsTranslation } from '../core/messages.ts';
import { sameSource } from '../core/source-stream.ts';
import type { SourceMessage } from '../core/types.ts';
import type { VideoEligibilityUpdate } from '../core/video-policy.ts';
import { protectText } from '../translation/text.ts';

type Observation = VideoEligibilityUpdate['items'][number];

export interface ExperimentRange {
  fromMs: number;
  toMs: number;
  prefetchSeconds: number;
}

export interface ExperimentFilterUpdate {
  revision: number;
  reset: boolean;
  ready: boolean;
  items: { id: string; originalText: string; state: 'filtered' | 'unknown' }[];
}

export function validExperimentRange(value: unknown): value is ExperimentRange {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.fromMs) && (v.fromMs as number) >= 0 &&
    Number.isSafeInteger(v.toMs) && (v.toMs as number) > (v.fromMs as number) && (v.toMs as number) <= 86_400_000 &&
    Number.isSafeInteger(v.prefetchSeconds) && (v.prefetchSeconds as number) >= 5 && (v.prefetchSeconds as number) <= 3600;
}

export function parseExperimentFilter(value: unknown): ExperimentFilterUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || typeof v.reset !== 'boolean' ||
      typeof v.ready !== 'boolean' || !Array.isArray(v.items) || v.items.length > 200) return null;
  const items: ExperimentFilterUpdate['items'] = [], seen = new Set<string>();
  for (const row of v.items) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 400 || seen.has(row.id) ||
        typeof row.originalText !== 'string' || !row.originalText || row.originalText.length > 1000 ||
        (row.state !== 'filtered' && row.state !== 'unknown')) return null;
    seen.add(row.id); items.push({ id: row.id, originalText: row.originalText, state: row.state });
  }
  return { revision: v.revision as number, reset: v.reset, ready: v.ready, items };
}

/** Mirrors only the loaded rows and merges the experimental filter over ordinary observations. */
export class BilibiliExperimentWatch {
  private sources = new Map<string, SourceMessage>();
  private normal = new Map<string, Observation>();
  private filtered = new Map<string, Observation>();
  private normalRevision = -1;
  private filterRevision = -1;
  private mergedRevision = 0;
  private epoch = 0;
  private display: VideoEligibilityUpdate['display'] = 'unknown';
  private capability: VideoEligibilityUpdate['capability'] = 'unknown';
  private emit: (update: VideoEligibilityUpdate) => void;

  constructor(emit: (update: VideoEligibilityUpdate) => void) { this.emit = emit; }

  resetSources(): void { this.sources.clear(); this.normal.clear(); this.filtered.clear(); }

  updateSources(upserts: SourceMessage[], removes: string[], reset: boolean): void {
    if (reset) this.resetSources();
    for (const id of removes) { this.sources.delete(id); this.normal.delete(id); this.filtered.delete(id); }
    for (const row of upserts) {
      const prior = this.sources.get(row.id);
      if (prior && !sameSource(prior, row)) { this.normal.delete(row.id); this.filtered.delete(row.id); }
      this.sources.set(row.id, row);
    }
  }

  preview(range: ExperimentRange, sourceLanguage: string, targetLanguage: string) {
    return [...this.sources.values()].filter(row => row.mediaTimeMs >= range.fromMs && row.mediaTimeMs <= range.toMs)
      .sort((a, b) => a.mediaTimeMs - b.mediaTimeMs || a.id.localeCompare(b.id))
      .map(row => ({ id: row.id, text: row.originalText, mediaTimeMs: row.mediaTimeMs,
        translationEligible: row.translatable && needsTranslation(row.originalText, targetLanguage, sourceLanguage) && !protectText(row.originalText).reason }));
  }

  source(id: string): SourceMessage | undefined { return this.sources.get(id); }
  allSources(): SourceMessage[] { return [...this.sources.values()]; }
  currentEligibility(): VideoEligibilityUpdate {
    return { epoch: this.epoch, revision: 0, reset: true, capability: this.capability, display: this.display,
      items: [...this.sources.keys()].map(id => this.merged(id)).filter((row): row is Observation => row !== null) };
  }

  setEpoch(epoch: number, force = false): void {
    if (this.epoch === epoch && !force) return;
    this.epoch = epoch; this.normal.clear(); this.filtered.clear();
    this.normalRevision = -1; this.filterRevision = -1;
    this.display = 'unknown'; this.capability = 'unknown';
  }

  observeClock(commentsVisible?: boolean): void {
    if (commentsVisible !== undefined) this.display = commentsVisible ? 'visible' : 'hidden';
  }

  normalUpdate(update: VideoEligibilityUpdate): void {
    if (update.epoch !== this.epoch || update.revision <= this.normalRevision) return;
    this.normalRevision = update.revision;
    if (update.reset) this.normal.clear();
    this.display = update.display; this.capability = update.capability;
    for (const row of update.items) if (this.matches(row)) this.normal.set(row.id, row);
    this.publish(update.items, update.reset);
  }

  filterUpdate(update: ExperimentFilterUpdate): boolean {
    if (update.revision <= this.filterRevision) return false;
    this.filterRevision = update.revision;
    if (update.reset) this.filtered.clear();
    for (const row of update.items) {
      if (!this.matches(row)) continue;
      if (row.state === 'filtered') this.filtered.set(row.id, row);
      else this.filtered.delete(row.id);
    }
    this.publish(update.items, update.reset);
    return true;
  }

  clearFilter(): void {
    this.filtered.clear(); this.filterRevision = -1;
    this.publish([], true);
  }

  private matches(row: { id: string; originalText: string }): boolean {
    return this.sources.get(row.id)?.originalText === row.originalText;
  }

  private merged(id: string): Observation | null {
    const source = this.sources.get(id);
    if (!source) return null;
    const early = this.filtered.get(id);
    if (early?.originalText === source.originalText) return early;
    const ordinary = this.normal.get(id);
    return ordinary?.originalText === source.originalText ? ordinary : { id, originalText: source.originalText, state: 'unknown' };
  }

  private publish(changed: { id: string }[], reset: boolean): void {
    const ids = reset ? [...this.sources.keys()] : [...new Set(changed.map(row => row.id))];
    const items = ids.map(id => this.merged(id)).filter((item): item is Observation => item !== null);
    if (!items.length) {
      this.emit({ epoch: this.epoch, revision: ++this.mergedRevision, reset, capability: this.capability, display: this.display, items: [] });
      return;
    }
    for (let index = 0; index < items.length; index += 200) {
      this.emit({ epoch: this.epoch, revision: ++this.mergedRevision, reset: reset && index === 0,
        capability: this.capability, display: this.display, items: items.slice(index, index + 200) });
    }
  }
}
