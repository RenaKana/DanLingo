import { browser } from 'wxt/browser';
import { readDirectory, readFileReference, registerDirectory } from '../../src/local/storage';
import { registerModelFilesInWorker } from '../../src/local/file-registration-client';
import type { DirectoryInfo, DirectoryScanStatus, ReadOnlyFileHandle } from '../../src/local/directory-types';
import type { LocalModelInfo } from '../../src/local/types';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import { localizeMessage, t } from '../../src/i18n';

export function createLocalSourcePicker(ui: {
  busy(value: boolean): void;
  progress(value: DirectoryScanStatus | undefined): void;
  result(render: () => string, error?: boolean): void;
  refresh(): Promise<void>;
}) {
  const directories = new Map<string, NonNullable<Awaited<ReturnType<typeof readDirectory>>>>();
  const files = new Map<string, NonNullable<Awaited<ReturnType<typeof readFileReference>>>>();
  let controller: AbortController | undefined;
  let activeKind: 'directory' | 'files' | undefined;
  const control = (action: string, extra = {}) => browser.runtime.sendMessage({ type: 'local-control', control: { action, ...extra } });
  return {
    async refreshHandles(directoryList: DirectoryInfo[], models: LocalModelInfo[]) {
      // Read before the click: requesting permission must retain its user gesture.
      const [directoryEntries, fileEntries] = await Promise.all([
        Promise.all(directoryList.map(item => readDirectory(item.id))),
        Promise.all(models.filter(item => item.source?.kind === 'files').map(item => readFileReference(item.id))),
      ]);
      directories.clear(); files.clear();
      for (const entry of directoryEntries) if (entry) directories.set(entry.id, entry);
      for (const entry of fileEntries) if (entry) files.set(entry.info.id, entry);
    },
    async cancel() {
      controller?.abort();
      if (activeKind === 'directory') await control('directory-cancel');
    },
    async choose(kind: 'directory' | 'files', id?: string) {
      if (controller) return;
      const operation = controller = new AbortController(); activeKind = kind;
      ui.progress(undefined); ui.busy(true); ui.result(() => '');
      try {
        if (window.top !== window) throw new Error('LOCAL_DIRECTORY_UNSUPPORTED');
        if (kind === 'directory') {
          const existing = id ? directories.get(id) : undefined;
          if (id && !existing) throw new Error('LOCAL_DIRECTORY_NOT_FOUND');
          const picker = (window as any).showDirectoryPicker;
          if (!existing && !picker) throw new Error('LOCAL_DIRECTORY_UNSUPPORTED');
          const handle = existing?.handle ?? await picker.call(window, { mode: 'read', id: 'danlingo-models' });
          if (await handle.requestPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
          if (operation.signal.aborted) throw new Error('LOCAL_SCAN_CANCELLED');
          const registered = await registerDirectory(handle);
          ui.result(() => t('m_89992c8d9a99'));
          const result = await control('directory-scan', { directoryId: registered.id });
          if (!result?.ok || result.scan?.phase === 'error') throw new Error(result?.scan?.error ?? result?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
          ui.progress(result.scan);
          if (result.scan?.phase === 'cancelled') { ui.result(() => t('m_788b5c53f2c5')); return; }
          const modelIds = (result.models ?? []).filter((model: LocalModelInfo) => model.source?.kind === 'directory' && model.source.directoryId === registered.id && model.availability === 'ready').map((model: LocalModelInfo) => model.id);
          ui.result(() => t('localSource.confirming'));
          const confirmed = await control('files-changed', { modelIds });
          if (!confirmed?.ok || confirmed.issues?.length) throw new Error(confirmed?.issues?.[0]?.error ?? confirmed?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
          ui.result(() => t('modelManager.registered', { count: modelIds.length }));
        } else {
          const existing = id ? files.get(id) : undefined;
          if (id && !existing?.fileHandles?.length) throw new Error('LOCAL_MODEL_NOT_IMPORTED');
          const picker = (window as any).showOpenFilePicker;
          if (!existing && !picker) throw new Error('LOCAL_FILE_HANDLE_UNSUPPORTED');
          const handles: ReadOnlyFileHandle[] = existing?.fileHandles ?? await picker.call(window, {
            id: 'danlingo-model-files', multiple: true, excludeAcceptAllOption: true,
            types: [{ description: t('m_da37ffcc54cc'), accept: { 'application/octet-stream': ['.gguf'] } }],
          });
          const permissions = await Promise.all(handles.map(handle => handle.requestPermission({ mode: 'read' })));
          if (permissions.some(permission => permission !== 'granted')) throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
          ui.result(() => t('m_45b2d8ebb98f'));
          let progress: DirectoryScanStatus | undefined;
          const result = await registerModelFilesInWorker(handles, id, { signal: operation.signal,
            onProgress: value => { progress = value; ui.progress(value); } });
          ui.result(() => t('localSource.confirming'));
          const confirmed = await control('files-changed', { modelIds: result.models.map(model => model.id) });
          if (!confirmed?.ok || confirmed.issues?.length) throw new Error(confirmed?.issues?.[0]?.error ?? confirmed?.error ?? 'LOCAL_STORAGE_UNAVAILABLE');
          if (progress) ui.progress({ ...progress, phase: 'complete' });
          ui.result(() => [result.models.length ? t('modelManager.registered', { count: result.models.length }) : t('m_0fbbe9823198'),
            ...result.issues.map(issue => `${issue.path}: ${localizeMessage(directoryErrorMessage(issue.error))}`)].join('\n'), !result.models.length);
        }
      } catch (error) {
        const cancelled = operation.signal.aborted || error instanceof DOMException && error.name === 'AbortError';
        ui.result(() => cancelled ? t('m_870840853b86') : localizeMessage(directoryErrorMessage(error)), !cancelled);
      } finally {
        controller = undefined; activeKind = undefined; ui.busy(false); await ui.refresh();
      }
    },
  };
}
