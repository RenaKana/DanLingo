import type { DirectoryScanStatus } from './directory-types.ts';
import type { LocalState } from './types.ts';
import { formatNumber, t } from '../i18n/text.ts';

const labels: Record<string, string> = {
  enumerating: 'localSource.enumerating', 'reading-files': 'localSource.readingFiles',
  'reading-header': 'localSource.readingHeader', persisting: 'localSource.registering',
};
export function sourceProgressText(scan: DirectoryScanStatus): string {
  const elapsed = scan.phase === 'scanning' && scan.startedAt ? Date.now() - scan.startedAt : scan.elapsedMs;
  const parts = [t('m_9283ad773ce2', { p0: scan.checkedFiles, p1: scan.modelsFound, p2: formatNumber(Number((elapsed / 1000).toFixed(1))) })];
  if (scan.phase === 'scanning' && scan.stage) parts.unshift(`${t(labels[scan.stage] ?? 'localSource.readingFiles')}${scan.currentFile ? ` · ${scan.currentFile}` : ''}`);
  if (scan.timings) parts.push(t('localSource.scanTimings', {
    enumeration: Math.round(scan.timings.enumerationMs), files: Math.round(scan.timings.fileAccessMs),
    headers: Math.round(scan.timings.headerMs), registration: Math.round(scan.timings.registrationMs),
  }));
  return parts.join('\n');
}

export function loadTimingsText(timings: NonNullable<LocalState['loadTimings']>): string {
  return t('localSource.loadTimings', { files: Math.round(timings.sourceMs ?? 0), headers: Math.round(timings.metadataMs ?? 0),
    initialization: Math.round(timings.initializingMs ?? 0), weights: Math.round(timings.weightsMs ?? 0) });
}
