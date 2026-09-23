import { browser } from 'wxt/browser';
import { readDirectory, readFileReference, registerDirectory } from '../../src/local/storage';
import { registerModelFilesInWorker } from '../../src/local/file-registration-client';
import type { ReadOnlyFileHandle } from '../../src/local/directory-types';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import '../../src/ui/base.css';
import './style.css';

const connected = await browser.runtime.sendMessage({ type: 'settings-ui-connect' });
if (!connected?.ok || connected.embedded || window.top !== window) throw new Error('SETTINGS_SESSION_REJECTED');
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
if (directoryId && !existing) { button.disabled = true; status.textContent = directoryErrorMessage('LOCAL_DIRECTORY_NOT_FOUND'); }
else if (!picker) { button.disabled = true; status.textContent = directoryErrorMessage('LOCAL_DIRECTORY_UNSUPPORTED'); }
else if (existing) {
  button.textContent = '重新授权读取';
  document.getElementById('folder-description')!.textContent = `重新授权“${existing.name}”的读取权限。不会修改或复制模型文件。`;
}
if (fileId) {
  button.hidden = true;
  fileButton.textContent = '重新授权读取';
  if (!existingFile?.fileHandles?.length) { fileButton.disabled = true; status.textContent = '模型已移除，请重新添加文件。'; }
  document.getElementById('folder-description')!.textContent = `重新授权“${existingFile?.info.name ?? '模型文件'}”的读取权限，不修改或复制原文件。`;
} else if (existing) fileButton.hidden = true;
else if (!filePicker) { fileButton.disabled = true; fileButton.title = directoryErrorMessage('LOCAL_FILE_HANDLE_UNSUPPORTED'); }
document.getElementById('folder-close')!.addEventListener('click', () => window.close());
button.addEventListener('click', async () => {
  button.disabled = true; fileButton.disabled = true; status.className = 'status'; status.textContent = '';
  let polling: ReturnType<typeof setInterval> | undefined;
  try {
    // The permission/picker call must be the first asynchronous operation after the gesture.
    const handle = existing ? existing.handle : await picker!.call(window, { mode: 'read', id: 'danlingo-models' });
    if (existing && await (handle as any).requestPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    const registered = await registerDirectory(handle as any);
    status.textContent = '已授权，只读识别模型中…';
    let pending = false;
    polling = setInterval(() => {
      if (pending) return; pending = true;
      void browser.runtime.sendMessage({ type: 'local-control', control: { action: 'directory-status' } }).then(reply => {
        if (reply?.scan) status.textContent = `已检查 ${reply.scan.checkedFiles} 个文件 · 已识别 ${reply.scan.modelsFound} 个模型 · ${(reply.scan.elapsedMs / 1000).toFixed(1)} 秒`;
      }).catch(() => {}).finally(() => { pending = false; });
    }, 400);
    const result = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'directory-scan', directoryId: registered.id } });
    if (!result?.ok) throw new Error(result?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    if (result.scan?.phase === 'error') throw new Error(result.scan.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    status.textContent = result.scan?.phase === 'cancelled' ? '已取消扫描，保留上次列表。'
      : `已登记“${registered.name}”。请返回设置页手动选用模型${result.scan?.issues?.length ? `；${result.scan.issues.length} 项识别问题可在设置页查看` : ''}。`;
  } catch (error) {
    status.textContent = error instanceof DOMException && error.name === 'AbortError' ? '已取消选择，未更改文件夹。' : directoryErrorMessage(error);
    status.className = 'status error';
  } finally { clearInterval(polling); button.disabled = !picker; fileButton.disabled = !filePicker; }
});

fileButton.addEventListener('click', async () => {
  button.disabled = true; fileButton.disabled = true; status.className = 'status'; status.textContent = '';
  try {
    // Keep the native picker/permission request directly attached to the user gesture.
    const handles = existingFile?.fileHandles ?? await filePicker!.call(window, {
      id: 'danlingo-model-files', multiple: true, excludeAcceptAllOption: true,
      types: [{ description: 'GGUF 模型（分片请全部选择）', accept: { 'application/octet-stream': ['.gguf'] } }],
    });
    if (existingFile) for (const handle of handles) {
      if (await handle.requestPermission({ mode: 'read' }) !== 'granted') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED');
    }
    status.textContent = '只读识别所选文件中…';
    const result = await registerModelFilesInWorker(handles, existingFile?.info.id, { onProgress: progress => {
      if (progress.stage === 'fingerprinting') status.textContent = `正在验证文件内容… ${progress.fingerprintedBytes ?? 0} / ${progress.totalFingerprintBytes ?? 0} 字节`;
      else if (progress.stage === 'persisting') status.textContent = '正在保存模型引用…';
      else status.textContent = `正在读取所选文件… 已检查 ${progress.checkedFiles} 个文件`;
    } });
    const notified = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'files-changed' } });
    if (!notified?.ok) throw new Error(notified?.error ?? 'LOCAL_STORAGE_UNAVAILABLE');
    const issues = result.issues.map(issue => `${issue.path}：${directoryErrorMessage(issue.error)}`).join('\n');
    status.textContent = `${result.models.length ? `已登记 ${result.models.length} 个模型，请返回设置页手动选用。` : '没有可登记的完整模型。'}${issues ? '\n' + issues : ''}`;
    status.className = result.models.length ? 'status' : 'status error';
  } catch (error) {
    status.textContent = error instanceof DOMException && error.name === 'AbortError' ? '已取消选择，模型列表未更改。' : directoryErrorMessage(error);
    status.className = 'status error';
  } finally { button.disabled = !picker; fileButton.disabled = !filePicker && !existingFile; }
});
