import { browser } from 'wxt/browser';
import { readDirectory, readFileReference, registerDirectory } from '../../src/local/storage';
import { registerModelFilesInWorker } from '../../src/local/file-registration-client';
import type { ReadOnlyFileHandle, DirectoryScanStatus } from '../../src/local/directory-types';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import { sourceProgressText } from '../../src/local/source-progress';
import '../../src/ui/base.css';
import './style.css';
import { initLocale, localizeMessage, t } from '../../src/i18n';
import { bindLocalizedAttribute, bindLocalizedText } from '../../src/ui/localized-text';

const connected = await browser.runtime.sendMessage({ type: 'settings-ui-connect' });
if (!connected?.ok || connected.embedded || window.top !== window) throw new Error('SETTINGS_SESSION_REJECTED');
void initLocale(document);
const button = document.getElementById('folder-authorize') as HTMLButtonElement;
const fileButton = document.getElementById('file-authorize') as HTMLButtonElement;
const status = document.getElementById('folder-auth-status')!;
const fragment = location.hash.slice(1);
const fileId = fragment.startsWith('file:') ? decodeURIComponent(fragment.slice(5)) : '';
const directoryId = fileId || fragment === 'files' ? '' : decodeURIComponent(fragment);
const existing = directoryId ? await readDirectory(directoryId) : undefined;
const existingFile = fileId ? await readFileReference(fileId) : undefined;
const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: 'read'; id: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
const filePicker = (window as unknown as { showOpenFilePicker?: (options: unknown) => Promise<ReadOnlyFileHandle[]> }).showOpenFilePicker;
if (directoryId && !existing) { button.disabled = true; bindLocalizedText(status, () => localizeMessage(directoryErrorMessage('LOCAL_DIRECTORY_NOT_FOUND'))); }
else if (!picker) { button.disabled = true; bindLocalizedText(status, () => localizeMessage(directoryErrorMessage('LOCAL_DIRECTORY_UNSUPPORTED'))); }
else if (existing) {
  bindLocalizedText(button, () => t('m_ffc0e45b2cad'));
  bindLocalizedText(document.getElementById('folder-description')!, () => t('m_1f7ee4f2ac03', { p0: existing.name }));
}
if (fileId) {
  button.hidden = true;
  bindLocalizedText(fileButton, () => t('m_ffc0e45b2cad'));
  if (!existingFile?.fileHandles?.length) { fileButton.disabled = true; bindLocalizedText(status, () => t('m_f02eefab9479')); }
  bindLocalizedText(document.getElementById('folder-description')!, () => t('m_d880359ca22a', { p0: existingFile?.info.name ?? t('m_f4f41a31b451') }));
} else if (existing) fileButton.hidden = true;
else if (!filePicker) { fileButton.disabled = true; bindLocalizedAttribute(fileButton, 'title', () => localizeMessage(directoryErrorMessage('LOCAL_FILE_HANDLE_UNSUPPORTED'))); }
document.getElementById('folder-close')!.addEventListener('click', () => window.close());
button.addEventListener('click', async () => {
  button.disabled = true; fileButton.disabled = true; status.className = 'status'; status.textContent = '';
  let polling: ReturnType<typeof setInterval> | undefined;
  try {
    // The permission/picker call must be the first asynchronous operation after the gesture.
    const handle = existing ? existing.handle : await picker!.call(window, { mode: 'read', id: 'danlingo-models' });
    if (await (handle as any).requestPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    const registered = await registerDirectory(handle as any);
    bindLocalizedText(status, () => t('m_89992c8d9a99'));
    let pending = false;
    polling = setInterval(() => {
      if (pending) return; pending = true;
      void browser.runtime.sendMessage({ type: 'local-control', control: { action: 'directory-status' } }).then(reply => {
        if (reply?.scan) bindLocalizedText(status, () => sourceProgressText(reply.scan));
      }).catch(() => {}).finally(() => { pending = false; });
    }, 400);
    const result = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'directory-scan', directoryId: registered.id } });
    if (!result?.ok) throw new Error(result?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    if (result.scan?.phase === 'error') throw new Error(result.scan.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    clearInterval(polling);
    if (result.scan?.phase !== 'cancelled') {
      bindLocalizedText(status, () => t('localSource.confirming'));
      const modelIds = (result.models ?? []).filter((model: any) => model.source?.directoryId === registered.id && model.availability === 'ready').map((model: any) => model.id);
      const confirmed = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'files-changed', modelIds } });
      if (!confirmed?.ok || confirmed.issues?.length) throw new Error(confirmed?.issues?.[0]?.error ?? confirmed?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    }
    bindLocalizedText(status, () => result.scan?.phase === 'cancelled' ? t('m_788b5c53f2c5')
      : `${t('m_f34314a690aa', { p0: registered.name, p1: result.scan?.issues?.length ? t('m_55cf53ac51e8', { p0: result.scan.issues.length }) : '' })}${result.scan ? '\n' + sourceProgressText(result.scan) : ''}`);
  } catch (error) {
    bindLocalizedText(status, () => error instanceof DOMException && error.name === 'AbortError' ? t('m_fb953f40438b') : localizeMessage(directoryErrorMessage(error)));
    status.className = 'status error';
  } finally { clearInterval(polling); button.disabled = !picker; fileButton.disabled = !filePicker; }
});

fileButton.addEventListener('click', async () => {
  button.disabled = true; fileButton.disabled = true; status.className = 'status'; status.textContent = '';
  try {
    // Keep the native picker/permission request directly attached to the user gesture.
    const handles = existingFile?.fileHandles ?? await filePicker!.call(window, {
      id: 'danlingo-model-files', multiple: true, excludeAcceptAllOption: true,
      types: [{ description: t('m_da37ffcc54cc'), accept: { 'application/octet-stream': ['.gguf'] } }],
    });
    // Start every request while the selection/user gesture is still active.
    const permissions = await Promise.all(handles.map(handle => handle.requestPermission({ mode: 'read' })));
    if (permissions.some(permission => permission !== 'granted')) throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    bindLocalizedText(status, () => t('m_45b2d8ebb98f'));
    let lastProgress: DirectoryScanStatus | undefined;
    const result = await registerModelFilesInWorker(handles, existingFile?.info.id, { onProgress: progress => {
      lastProgress = progress;
      bindLocalizedText(status, () => sourceProgressText(progress));
    } });
    bindLocalizedText(status, () => t('localSource.confirming'));
    const notified = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'files-changed', modelIds: result.models.map(model => model.id) } });
    if (!notified?.ok) throw new Error(notified?.error ?? 'LOCAL_STORAGE_UNAVAILABLE');
    if (notified.issues?.length) throw new Error(notified.issues[0].error);
    const issues = () => result.issues.map(issue => `${issue.path}：${localizeMessage(directoryErrorMessage(issue.error))}`).join('\n');
    bindLocalizedText(status, () => `${result.models.length ? t('m_0d943ac017e6', { p0: result.models.length }) : t('m_0fbbe9823198')}${lastProgress ? '\n' + sourceProgressText({ ...lastProgress, phase: 'complete' }) : ''}${result.issues.length ? '\n' + issues() : ''}`);
    status.className = result.models.length ? 'status' : 'status error';
  } catch (error) {
    bindLocalizedText(status, () => error instanceof DOMException && error.name === 'AbortError' ? t('m_870840853b86') : localizeMessage(directoryErrorMessage(error)));
    status.className = 'status error';
  } finally { button.disabled = !picker; fileButton.disabled = !filePicker && !existingFile; }
});
