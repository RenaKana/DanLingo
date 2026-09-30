import { sourceProgressText } from '../../src/local/source-progress';
import type { DirectoryInfo, DirectoryScanStatus } from '../../src/local/directory-types';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import type { LocalModelInfo } from '../../src/local/types';
import { formatNumber, localizeMessage, t } from '../../src/i18n';
import { bindLocalizedAttribute, bindLocalizedText } from '../../src/ui/localized-text';

export type DirectoryAction = 'scan' | 'cancel' | 'authorize' | 'authorize-file' | 'remove' | 'remove-model' | 'load-model';
export interface ModelManagerState { selectedId?: string; loadedId?: string; loadingId?: string; busy?: boolean }
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} KB`;
  return `${formatNumber(Number((bytes / (1024 * 1024)).toFixed(1)))} MB`;
}
export function mountDirectoryUI(action: (action: DirectoryAction, id?: string) => Promise<void>) {
  const rows = document.getElementById('local-directories')!;
  const status = document.getElementById('local-scan-status')!;
  const issues = document.getElementById('local-scan-issues')!;
  const refresh = document.getElementById('local-folder-refresh') as HTMLButtonElement;
  const cancel = document.getElementById('local-scan-cancel') as HTMLButtonElement;
  const manager = document.getElementById('local-model-manager')!;
  const modelRows = document.getElementById('local-model-entries')!;
  const stopSlot = document.getElementById('local-stop-slot')!;
  const stop = document.getElementById('local-stop') as HTMLButtonElement;
  let signature = '', issueSignature = '', modelSignature = '';
  document.getElementById('local-folder-add')!.addEventListener('click', () => { void action('authorize'); });
  document.getElementById('local-file-add')!.addEventListener('click', () => { void action('authorize-file'); });
  refresh.addEventListener('click', () => { void action('scan'); });
  cancel.addEventListener('click', () => { void action('cancel'); });
  const makeButton = (label: () => string, run: () => void) => { const button = document.createElement('button'); button.type = 'button'; bindLocalizedText(button, label); button.addEventListener('click', run); return button; };
  return {
    render(directories: DirectoryInfo[], scan?: DirectoryScanStatus, busy = false, models: LocalModelInfo[] = [], state: ModelManagerState = {}) {
      const next = JSON.stringify(directories);
      if (signature !== next) {
        signature = next; rows.replaceChildren();
        for (const directory of directories) {
          const row = document.createElement('div'); row.className = 'local-directory'; row.dataset.directoryId = directory.id;
          const description = document.createElement('div'); description.className = 'local-directory-description';
          const name = document.createElement('strong'); name.textContent = directory.name;
          const detail = document.createElement('span'); detail.className = 'subtle';
          bindLocalizedText(detail, () => directory.status === 'ready' ? t('m_234a9ed40ca2') : localizeMessage(directoryErrorMessage(directory.error ?? 'LOCAL_DIRECTORY_PERMISSION_REQUIRED')));
          description.append(name, detail);
          const actions = document.createElement('div'); actions.className = 'row local-directory-actions';
          actions.append(makeButton(() => t('m_aee887434131'), () => { void action('scan', directory.id); }));
          if (directory.status !== 'ready') actions.append(makeButton(() => t('m_6a84698a4758'), () => { void action('authorize', directory.id); }));
          const confirmation = document.createElement('div'); confirmation.className = 'confirm'; confirmation.hidden = true;
          const text = document.createElement('p'); bindLocalizedText(text, () => t('m_779638a3aad8', { p0: directory.name }));
          const confirmActions = document.createElement('div'); confirmActions.className = 'row';
          confirmActions.append(makeButton(() => t('m_ee7dea070d88'), () => { confirmation.hidden = true; void action('remove', directory.id); }), makeButton(() => t('m_2cd0f3be8738'), () => { confirmation.hidden = true; }));
          confirmation.append(text, confirmActions);
          actions.append(makeButton(() => t('m_6135d4159e89'), () => { confirmation.hidden = false; })); row.append(description, actions, confirmation); rows.append(row);
        }
      }
      const references = models;
      const nextModels = JSON.stringify(references);
      manager.hidden = false;
      if (modelSignature !== nextModels) {
        stopSlot.append(stop);
        modelSignature = nextModels; modelRows.replaceChildren();
        bindLocalizedText(document.getElementById('local-model-manager-summary')!, () => t('m_0d12cbfd2899', { p0: references.length }));
        if (!references.length) { const empty = document.createElement('p'); empty.className = 'subtle'; bindLocalizedText(empty, () => t('modelManager.empty')); modelRows.append(empty); }
        for (const model of references) {
          const row = document.createElement('div'); row.className = 'local-model-entry'; row.dataset.modelId = model.id;
          const description = document.createElement('div'); description.className = 'local-directory-description';
          const name = document.createElement('strong'); name.textContent = model.name;
          const heading = document.createElement('div'); heading.className = 'local-model-heading';
          const source = document.createElement('span'); source.className = 'badge local-source-kind';
          bindLocalizedText(source, () => model.source?.kind === 'files' ? t('modelManager.file') : model.source ? t('modelManager.directory') : t('m_7970e2877557'));
          const stateBadge = document.createElement('span'); stateBadge.className = 'badge local-model-state';
          heading.append(name, source, stateBadge);
          const detail = document.createElement('span'); detail.className = 'subtle';
          bindLocalizedText(detail, () => `${model.source?.kind === 'directory' ? model.source.directoryName + '/' : ''}${model.source?.files[0]?.path ?? model.name} · ${formatBytes(model.bytes)} · ${model.architecture} · ${model.quantization}${model.availability && model.availability !== 'ready' ? t('m_dfa7df6e11c5') : ''}`);
          description.append(heading, detail);
          const actions = document.createElement('div'); actions.className = 'row local-directory-actions';
          if (model.source?.kind === 'files' && model.availability === 'permission-required') actions.append(makeButton(() => t('m_6a84698a4758'), () => { void action('authorize-file', model.id); }));
          const remove = makeButton(() => t('m_6135d4159e89'), () => { void action('remove-model', model.id); }); bindLocalizedAttribute(remove, 'aria-label', () => t('m_6e66526ad717', { p0: model.name }));
          remove.dataset.modelAction = 'remove';
          const load = makeButton(() => t('modelManager.load'), () => { void action('load-model', model.id); }); load.dataset.modelAction = 'load';
          bindLocalizedAttribute(load, 'aria-label', () => `${t('modelManager.load')} ${model.name}`);
          actions.append(load, remove); row.append(description, actions); modelRows.append(row);
        }
      }
      refresh.disabled = busy || !!state.busy || !directories.length && !references.some(model => model.source); cancel.hidden = !busy;
      for (const button of rows.querySelectorAll('button')) button.disabled = busy || !!state.busy;
      const activeId = state.loadingId ?? state.loadedId;
      let activeRowFound = false;
      for (const row of modelRows.querySelectorAll<HTMLElement>('[data-model-id]')) {
        const model = models.find(item => item.id === row.dataset.modelId)!;
        const load = row.querySelector<HTMLButtonElement>('[data-model-action="load"]')!;
        const active = model.id === activeId;
        load.hidden = active;
        if (active) { load.parentElement!.insertBefore(stop, load); activeRowFound = true; }
        for (const button of row.querySelectorAll('button')) {
          if (button !== stop) button.disabled = busy || !!state.busy || button.dataset.modelAction === 'load' && !!model.availability && model.availability !== 'ready';
        }
        const badge = row.querySelector<HTMLElement>('.local-model-state')!;
        bindLocalizedText(badge, () => [state.selectedId === model.id ? t('modelManager.selected') : '', state.loadingId === model.id ? t('m_d04fcbda737f') : state.loadedId === model.id ? t('modelManager.loaded') : ''].filter(Boolean).join(' · '));
        badge.hidden = !badge.textContent;
      }
      if (!activeRowFound) stopSlot.append(stop);
      const relevantScan = scan?.directoryId ? directories.some(directory => directory.id === scan.directoryId) : true;
      bindLocalizedText(status, () => scan && (busy || scan.phase !== 'idle')
        ? [scan.phase === 'cancelled' ? t('m_0e4401553264') : scan.phase === 'error' ? localizeMessage(directoryErrorMessage(scan.error)) : '', sourceProgressText(scan)].filter(Boolean).join('\n') : '');
      status.className = scan?.phase === 'error' ? 'status error span' : 'status span';
      const allIssues = directories.flatMap(directory =>
        (directory.id === scan?.directoryId ? scan.issues : directory.issues ?? []).map(issue => ({ ...issue, path: `${directory.name}/${issue.path}` })));
      const nextIssues = JSON.stringify(allIssues);
      if (issueSignature !== nextIssues) {
        issueSignature = nextIssues; issues.replaceChildren(); issues.hidden = !allIssues.length;
        if (allIssues.length) {
          const summary = document.createElement('summary'); bindLocalizedText(summary, () => t('m_095f3518fd06', { p0: allIssues.length })); issues.append(summary);
          const list = document.createElement('ul');
          for (const issue of allIssues) { const item = document.createElement('li'); bindLocalizedText(item, () => `${issue.path}：${localizeMessage(directoryErrorMessage(issue.error))}`); list.append(item); }
          issues.append(list);
        }
      }
    },
  };
}
