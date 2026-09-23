import type { DirectoryInfo, DirectoryScanStatus } from '../../src/local/directory-types';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import type { LocalModelInfo } from '../../src/local/types';

export type DirectoryAction = 'scan' | 'cancel' | 'authorize' | 'authorize-file' | 'remove' | 'remove-model';
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function mountDirectoryUI(action: (action: DirectoryAction, id?: string) => Promise<void>) {
  const rows = document.getElementById('local-directories')!;
  const status = document.getElementById('local-scan-status')!;
  const issues = document.getElementById('local-scan-issues')!;
  const refresh = document.getElementById('local-folder-refresh') as HTMLButtonElement;
  const cancel = document.getElementById('local-scan-cancel') as HTMLButtonElement;
  const manager = document.getElementById('local-model-manager')!;
  const modelRows = document.getElementById('local-model-entries')!;
  let signature = '', issueSignature = '', modelSignature = '';
  document.getElementById('local-folder-add')!.addEventListener('click', () => { void action('authorize'); });
  document.getElementById('local-file-add')!.addEventListener('click', () => { void action('authorize-file'); });
  refresh.addEventListener('click', () => { void action('scan'); });
  cancel.addEventListener('click', () => { void action('cancel'); });
  const makeButton = (label: string, run: () => void) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', run); return button; };
  return {
    render(directories: DirectoryInfo[], scan?: DirectoryScanStatus, busy = false, models: LocalModelInfo[] = []) {
      const next = JSON.stringify(directories);
      if (signature !== next) {
        signature = next; rows.replaceChildren();
        if (!directories.length) { const empty = document.createElement('p'); empty.className = 'subtle'; empty.textContent = '可添加文件夹或直接选择模型文件，只读引用原文件。'; rows.append(empty); }
        for (const directory of directories) {
          const row = document.createElement('div'); row.className = 'local-directory'; row.dataset.directoryId = directory.id;
          const description = document.createElement('div'); description.className = 'local-directory-description';
          const name = document.createElement('strong'); name.textContent = directory.name;
          const detail = document.createElement('span'); detail.className = 'subtle';
          detail.textContent = directory.status === 'ready' ? '只读 · 包含子文件夹' : directoryErrorMessage(directory.error ?? 'LOCAL_DIRECTORY_PERMISSION_REQUIRED');
          description.append(name, detail);
          const actions = document.createElement('div'); actions.className = 'row local-directory-actions';
          actions.append(makeButton('刷新', () => { void action('scan', directory.id); }));
          if (directory.status !== 'ready') actions.append(makeButton('重新授权', () => { void action('authorize', directory.id); }));
          const confirmation = document.createElement('div'); confirmation.className = 'confirm'; confirmation.hidden = true;
          const text = document.createElement('p'); text.textContent = `移除“${directory.name}”的登记？原文件不受影响；若正在使用其中的模型，将卸载并清空选择。`;
          const confirmActions = document.createElement('div'); confirmActions.className = 'row';
          confirmActions.append(makeButton('确认移除', () => { confirmation.hidden = true; void action('remove', directory.id); }), makeButton('取消', () => { confirmation.hidden = true; }));
          confirmation.append(text, confirmActions);
          actions.append(makeButton('移除', () => { confirmation.hidden = false; })); row.append(description, actions, confirmation); rows.append(row);
        }
      }
      const references = models.filter(model => model.source);
      const nextModels = JSON.stringify(references);
      manager.hidden = !references.length;
      if (modelSignature !== nextModels) {
        modelSignature = nextModels; modelRows.replaceChildren();
        document.getElementById('local-model-manager-summary')!.textContent = `管理模型（${references.length}）`;
        for (const model of references) {
          const row = document.createElement('div'); row.className = 'local-model-entry'; row.dataset.modelId = model.id;
          const description = document.createElement('div'); description.className = 'local-directory-description';
          const name = document.createElement('strong'); name.textContent = model.name;
          const detail = document.createElement('span'); detail.className = 'subtle';
          detail.textContent = `${model.source!.directoryName}/${model.source!.files[0]?.path ?? model.name} · ${model.architecture} · ${model.quantization}${model.availability && model.availability !== 'ready' ? ' · 暂不可用' : ''}`;
          description.append(name, detail);
          const actions = document.createElement('div'); actions.className = 'row local-directory-actions';
          if (model.source?.kind === 'files' && model.availability === 'permission-required') actions.append(makeButton('重新授权', () => { void action('authorize-file', model.id); }));
          const remove = makeButton('移除', () => { void action('remove-model', model.id); }); remove.setAttribute('aria-label', `移除模型 ${model.name}`);
          actions.append(remove); row.append(description, actions); modelRows.append(row);
        }
      }
      refresh.disabled = busy || !directories.length && !references.length; cancel.hidden = !busy;
      for (const button of modelRows.querySelectorAll('button')) button.disabled = busy;
      const relevantScan = scan?.directoryId ? directories.some(directory => directory.id === scan.directoryId) : true;
      const stage = scan?.stage === 'fingerprinting' ? ` · 验证内容 ${formatBytes(scan.fingerprintedBytes ?? 0)} / ${formatBytes(scan.totalFingerprintBytes ?? 0)}`
        : scan?.stage === 'persisting' ? ' · 正在保存结果' : scan?.stage === 'enumerating' ? ' · 正在检查文件' : '';
      status.textContent = relevantScan && scan && scan.phase !== 'idle'
        ? `${busy ? '识别中' : scan.phase === 'cancelled' ? '已取消，保留原列表' : scan.phase === 'error' ? directoryErrorMessage(scan.error) : '识别完成'}${busy ? stage : ''} · 已检查 ${scan.checkedFiles} 个文件 · 已识别 ${scan.modelsFound} 个模型 · ${(scan.elapsedMs / 1000).toFixed(1)} 秒`
        : '';
      status.className = scan?.phase === 'error' ? 'status error span' : 'status span';
      const allIssues = directories.flatMap(directory =>
        (directory.id === scan?.directoryId ? scan.issues : directory.issues ?? []).map(issue => ({ ...issue, path: `${directory.name}/${issue.path}` })));
      const nextIssues = JSON.stringify(allIssues);
      if (issueSignature !== nextIssues) {
        issueSignature = nextIssues; issues.replaceChildren(); issues.hidden = !allIssues.length;
        if (allIssues.length) {
          const summary = document.createElement('summary'); summary.textContent = `${allIssues.length} 项识别问题`; issues.append(summary);
          const list = document.createElement('ul');
          for (const issue of allIssues) { const item = document.createElement('li'); item.textContent = `${issue.path}：${directoryErrorMessage(issue.error)}`; list.append(item); }
          issues.append(list);
        }
      }
    },
  };
}
