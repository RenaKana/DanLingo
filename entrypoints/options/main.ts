import { browser } from 'wxt/browser';
import { onlineBudgetText } from '../../src/ui/online-budget';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  endpointOrigin,
  normalizeReasoningEffort,
  reasoningCapabilities,
  providerTimeoutMs,
} from '../../src/core/config';
import { connectionDisplay, resolveConnection } from '../../src/core/connection';
import type { Settings } from '../../src/core/types';
import { mountDirectoryUI, type DirectoryAction } from './directory-ui';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import type { DirectoryInfo, DirectoryScanStatus } from '../../src/local/directory-types';
import { LOCAL_SUPPORT } from '../../src/local/gguf';
import type { LocalModelInfo, LocalState } from '../../src/local/types';
import { sanitizeRuntimeDiagnostics } from '../../src/ui/live-diagnostics';
import { mountPerformanceUI } from './performance-ui';
import { mountLocalPerformanceUI } from './local-performance-ui';
import { mountSettingsLayout } from './layout';
import { initTheme } from '../../src/ui/theme';
import { mountCombobox } from '../../src/ui/combobox';
import { TARGET_LANGUAGES } from '../../src/ui/languages';
import type { LocalRuntimeStatus } from '../../src/local/auto-load';
import { estimateLocalMemory, localMemoryRuntimeKey } from '../../src/local/memory-estimate';
import { resolveLocalConfig, normalizeLocalConfig } from '../../src/local/config';
import { translationLanguageIssue, translationLanguageMessage } from '../../src/local/translation-profile';
import { SERVICE_PRESETS } from '../../src/core/service-history';
import type { ServiceAddress } from '../../src/core/service-history';
import { getTranslationShortcut, translationShortcutManagementUrl } from '../../src/core/translation-shortcut';
import '../../src/ui/base.css';
import './options.css';

// Authenticate before mounting anything that reads extension storage or sends privileged messages.
const embedded = new URL(location.href).searchParams.has('embedded');
const connected = await browser.runtime.sendMessage({ type: 'settings-ui-connect' });
if (!connected?.ok || embedded && !connected.embedded) {
  document.body.replaceChildren(document.createTextNode('设置会话无效或已过期，请从插件按钮重新打开。'));
  throw new Error('SETTINGS_SESSION_REJECTED');
}
const layout = mountSettingsLayout();
initTheme(document.getElementById('theme') as HTMLSelectElement);

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
const fields: Record<string, keyof Settings> = {
  endpoint: 'endpoint', model: 'model', backend: 'backend', 'target-language': 'targetLanguage', 'source-language': 'sourceLanguage',
  'local-preload-entry': 'localPreloadOnEntry',
  'online-request-limit': 'onlineRequestLimitPerDay',
  'translation-scope': 'translationScope', 'display-mode': 'displayMode', prefetch: 'prefetchSeconds', urgent: 'urgentSeconds',
  'batch-size': 'batchSize', 'batch-chars': 'maxBatchChars', concurrency: 'concurrency', timeout: 'requestTimeoutMs',
  'thinking-timeout': 'thinkingRequestTimeoutMs', 'cache-size': 'cacheMaxEntries', 'cache-days': 'cacheTtlDays',
  enabled: 'enabled', 'local-http': 'allowLocalHttp', 'live-buffer': 'liveBufferMs', 'live-source-language': 'liveSourceLanguage',
  'live-adaptive': 'liveAdaptiveConcurrency', 'endpoint-mode': 'endpointMode', 'protocol-override': 'protocolOverride',
  'bilibili-timeout-retry': 'bilibiliTimeoutRetryEnabled', 'bilibili-timeout-retry-extra': 'bilibiliTimeoutRetryExtraMs',
  'bilibili-timeout-retry-mode': 'bilibiliTimeoutRetryMode',
  'youtube-timeout-retry': 'youtubeTimeoutRetryEnabled', 'youtube-timeout-retry-extra': 'youtubeTimeoutRetryExtraMs', 'youtube-timeout-retry-mode': 'youtubeTimeoutRetryMode',
  'niconico-timeout-retry': 'niconicoTimeoutRetryEnabled', 'niconico-timeout-retry-extra': 'niconicoTimeoutRetryExtraMs', 'niconico-timeout-retry-mode': 'niconicoTimeoutRetryMode',
  'superchat-timeout': 'superChatTimeoutMs', 'thinking-effort': 'thinkingEffort', 'superchat-thinking': 'superChatThinkingEffort',
};
let settings: Settings = { ...DEFAULT_SETTINGS };
let saving = false;
let providerRevision = 0;
let testRevision = 0;
let formRevision = 0;
let models: string[] = [];
let localModels: LocalModelInfo[] = [];
let localState: LocalState | undefined;
let localPollTimer: ReturnType<typeof setTimeout> | undefined;
let localPollInFlight = false;
let localDirectories: DirectoryInfo[] = [];
let directoryScan: DirectoryScanStatus | undefined;
let directoryScanBusy = false;
let directoryRequestPending = false;
let localLoadPending = false;
let localCommandRevision = 0;
let localDeleting = false;
let deleteCandidate: Pick<LocalModelInfo, 'id' | 'name' | 'source'> | undefined;
let serviceAddresses: ServiceAddress[] = [];
let credentialState: { origin?: string; hasKey: boolean; remembered: boolean } = { hasKey: false, remembered: false };
const endpointCombo = mountCombobox(input('endpoint'), [], { displayValue: 'value', onSelect: (option, previousValue) => {
  const previousOrigin = (() => { try { return endpointOrigin(previousValue, input('local-http').checked); } catch { return ''; } })();
  if (new URL(option.value).origin !== previousOrigin && input('api-key').value) { input('api-key').value = ''; markDirty('api-key'); }
  const address = serviceAddresses.find(row => row.endpoint === option.value);
  select('endpoint-mode').value = address?.endpointMode ?? 'base'; select('protocol-override').value = 'auto';
  input('local-http').checked = address?.allowLocalHttp ?? false; select('profile').value = 'auto';
  for (const id of ['endpoint-mode', 'protocol-override', 'local-http', 'profile']) markDirty(id);
} });
const modelCombo = mountCombobox(input('model'));
const languageCombo = mountCombobox(input('target-language'), TARGET_LANGUAGES);
let catalogRevision = 0;
let selectionRevision = 0;
let selectionSaving = false;
let localRuntime: LocalRuntimeStatus | undefined;
const destinationFields = ['endpoint', 'api-key', 'local-http', 'backend', 'endpoint-mode', 'protocol-override'];
const testFields = [...destinationFields, 'model', 'profile', 'thinking-effort', 'source-language', 'live-source-language', 'target-language', 'timeout', 'thinking-timeout', 'superchat-thinking', 'superchat-timeout', 'local-model', 'model-test-text', 'model-test-context'];
const dirty = new Set<string>();
const thinkingLabels: Record<string, string> = {
  default: '服务默认', off: '关闭思考', on: '开启思考', minimal: '最少', low: '低', medium: '中', high: '高', max: '最高（max）', xhigh: '极高（xhigh）',
};
const profileLabels: Record<string, string> = {
  auto: '自动识别', minimax: 'MiniMax', deepseek: 'DeepSeek', gemini: 'Gemini', 'chat-completions': 'Chat Completions',
};
const localPhaseLabels: Record<LocalState['phase'], string> = {
  idle: '未加载', loading: '加载中', warming: '预热中', ready: '已就绪', generating: '推理中', error: '错误',
};
const localStageLabels: Record<string, string> = {
  checking: '正在检查 GGUF 文件…', fingerprinting: '正在校验模型内容…', persisting: '正在保存模型文件…', 'reading-file': '正在读取模型…',
  'checking-gpu': '正在检查 GPU…', 'initializing-wasm': '正在初始化本地运行时…', 'loading-weights': '正在加载 GPU 权重…', loaded: '模型已加载',
};
function message(text: string, error = false, id = 'result') {
  const el = document.getElementById(id)!; el.textContent = text; el.className = 'status' + (error ? ' error' : '');
}
function snapshot(ids: string[]) {
  return JSON.stringify(ids.map(id => input(id).type === 'checkbox' ? input(id).checked : input(id).value));
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
function localErrorMessage(error: unknown, fallback = '本地模型操作失败'): string {
  if (error instanceof Error && /^LOCAL_(?:DIRECTORY_|SOURCE_|SCAN_)/.test(error.message)) return directoryErrorMessage(error);
  const raw = error instanceof Error ? error.message : '';
  const code = /^LOCAL_[A-Z0-9_]+$/.test(raw) ? raw : '';
  const labels: Record<string, string> = {
    LOCAL_SELECT_SINGLE_COMPLETE_GGUF: '请选择一个完整的 GGUF 文件', LOCAL_FORMAT_UNSUPPORTED: '只支持 .gguf 文件',
    LOCAL_SHARD_SET_INCOMPLETE: '分片不完整，请同时选择模型的全部 GGUF 分片', LOCAL_SHARD_DUPLICATE: '选择了重复的 GGUF 分片',
    LOCAL_SHARD_MIXED: '这些 GGUF 分片不属于同一组模型', LOCAL_SHARD_METADATA_INVALID: 'GGUF 分片元数据不完整或不一致',
    LOCAL_SHARD_ORDER_INVALID: 'GGUF 分片文件名与内部编号不一致', LOCAL_FILE_SIZE_INVALID: '文件大小无效或不能安全表示',
    LOCAL_SHARD_METADATA_MISSING: '文件名表明它是分片，但缺少必要的分片元数据', LOCAL_ARCHITECTURE_MISSING: '模型首分片缺少架构元数据',
    LOCAL_NATIVE_UNSUPPORTED: '当前内置推理运行时不支持此模型架构或量化，请选择兼容模型',
    LOCAL_NOT_GGUF: '文件不是有效的 GGUF 模型', LOCAL_GGUF_VERSION_UNSUPPORTED: '仅支持 GGUF v2/v3',
    LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE: 'GGUF 头部无效或超出安全解析预算', LOCAL_ARCHITECTURE_UNSUPPORTED: '当前推理运行时无法加载此模型架构',
    LOCAL_QUANTIZATION_UNSUPPORTED: '模型量化格式暂不支持', LOCAL_TOKENIZER_MISSING: '模型缺少内置 tokenizer',
    LOCAL_CHAT_TEMPLATE_MISSING: '模型缺少聊天模板', LOCAL_MODEL_NOT_IMPORTED: '请先导入这个本地模型',
    LOCAL_BROWSER_JSPI_UNSUPPORTED: '当前浏览器不支持本地模型运行时', LOCAL_BROWSER_MEMORY64_UNSUPPORTED: '当前浏览器不支持本地模型内存需求',
    LOCAL_WEBGPU_UNSUPPORTED: '当前浏览器无法使用 WebGPU，请检查浏览器硬件加速和显卡驱动',
    LOCAL_GPU_SOFTWARE_ADAPTER: '浏览器只提供软件渲染适配器，无法进行硬件 GPU 推理',
    LOCAL_GPU_DEVICE_FAILED: 'GPU 设备初始化失败，请检查硬件加速、显卡驱动和可用显存',
    LOCAL_GPU_DEVICE_LOST: 'GPU 连接已丢失，请重新加载模型',
    LOCAL_GPU_OFFLOAD_UNVERIFIED: '未能确认模型已加载到 GPU，本次加载已停止',
    LOCAL_MODEL_LOAD_REJECTED: '本地引擎未能初始化模型，请检查模型兼容性或诊断信息', LOCAL_MODEL_NOT_LOADED: '本地模型尚未加载',
    LOCAL_CHAT_TEMPLATE_UNSUPPORTED: '当前引擎无法初始化此模型的聊天模板',
    LOCAL_NLLB_UNSUPPORTED: '当前本地引擎不支持 NLLB/mBART，无法加载此模型',
    LOCAL_VOCAB_ONLY: '这是词表文件，不含模型权重，请选择完整模型',
    LOCAL_TRANSLATION_SOURCE_REQUIRED: translationLanguageMessage('LOCAL_TRANSLATION_SOURCE_REQUIRED')!,
    LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED: translationLanguageMessage('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED')!,
    LOCAL_MODEL_CHANGED: '本地模型已切换或卸载', LOCAL_CANCELLED: '本地操作已取消', LOCAL_QUEUE_FULL: '本地推理队列已满',
    LOCAL_OFFSCREEN_UNAVAILABLE: '本地运行容器暂时不可用', LOCAL_STORAGE_UNAVAILABLE: '本地模型存储不可用',
    LOCAL_STORAGE_QUOTA_OR_IO: '本地模型存储空间或读写失败', LOCAL_INFERENCE_FAILED: '本地推理失败',
    LOCAL_WORKER_FAILED: '本地模型运行时失败', LOCAL_IMPORT_WORKER_FAILED: '本地模型导入失败', LOCAL_REQUEST_INVALID: '本地请求格式无效',
    LOCAL_CONFIG_INVALID: '本地性能参数无效，请检查数值范围和批量大小',
    LOCAL_CONTEXT_CAPACITY_EXCEEDED: '上下文容量不足，请减少并行序列或每请求预估长度',
    LOCAL_CONTEXT_EXCEEDS_MODEL: '所选上下文超过模型支持范围，请降低上下文档位',
    LOCAL_FLASH_ATTENTION_UNAVAILABLE: '无法确认 Flash Attention 可用，请选择 Auto 或 Off 后重试',
    LOCAL_BENCHMARK_BUSY: '本地模型正在使用中，请结束当前翻译或测试后再试',
    LOCAL_BENCHMARK_SAME_LANGUAGE: '源语言和目标语言相同，无法做跨语言翻译测试',
    LOCAL_BENCHMARK_CORPUS_UNAVAILABLE: '所选源语言暂无批量测试语料，请用单次测试填写原文',
    LOCAL_WORKER_SHUTDOWN_FAILED: '旧模型未能正常退出，请卸载本地模型后重试',
    LOCAL_MODEL_LOADING: '本地模型正在自动加载，期间保留原文', LOCAL_AUTOLOAD_PAUSED: '自动加载已暂停，请手动加载或关闭再启用翻译',
    LOCAL_LOAD_TIMEOUT: '模型加载超时，请检查文件和 GPU 后手动重试', LOCAL_REASONING_UNSUPPORTED: '模型聊天模板不支持所选思考强度，请重新选择',
  };
  return labels[code] ?? (raw && !code ? raw : fallback);
}
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message === 'unsupported-thinking-effort') return '当前请求配置不支持所选思考强度，请重新选择';
  if (error instanceof Error && /^LOCAL_/.test(error.message)) return localErrorMessage(error);
  return error instanceof Error ? error.message : fallback;
}
function markDirty(id: string) {
  dirty.add(id); formRevision++;
  message(saving ? '正在处理；有未保存的修改' : '未保存的修改');
  if (id === 'api-key') { dirty.add('endpoint'); dirty.add('local-http'); }
  if (id === 'profile' || id === 'thinking-effort') { dirty.add('profile'); dirty.add('thinking-effort'); }
  if (id === 'translation-scope' || id === 'prefetch') { dirty.add('translation-scope'); dirty.add('prefetch'); }
}
function selectedProfile(): Settings['profile'] {
  const value = select('profile').value;
  if (value !== 'auto') return value as Settings['profile'];
  try {
    const { brand } = resolveConnection({ endpoint: input('endpoint').value, allowLocalHttp: input('local-http').checked });
    return brand === 'unknown' ? 'chat-completions' : brand;
  } catch { return settings.profile; }
}
function showModels() { modelCombo.setOptions(models.map(model => ({ value: model, label: model }))); }
async function readServiceHistory() {
  const response = await browser.runtime.sendMessage({ type: 'service-history' });
  if (!response?.ok) return;
  serviceAddresses = response.addresses ?? [];
  const seen = new Set(serviceAddresses.map(row => row.endpoint));
  endpointCombo.setOptions([
    ...serviceAddresses.map(row => ({ value: row.endpoint, label: `${row.endpoint} · 已验证 ${new Date(row.verifiedAt).toLocaleDateString()}` })),
    ...SERVICE_PRESETS.filter(row => !seen.has(row.endpoint)).map(row => ({ value: row.endpoint, label: `${row.name} · ${row.endpoint}`, aliases: [row.name] })),
  ]);
}
function invalidateTest() { testRevision++; message('', false, 'test-result'); }
function clearModels() { catalogRevision++; models = []; showModels(); message('', false, 'models-result'); input('models-cache').textContent = ''; }
async function readCatalog() {
  const revision = ++catalogRevision;
  if (select('backend').value === 'local') return;
  try {
    const response = await browser.runtime.sendMessage({ type: 'model-catalog', settings: readForm(false, true), apiKey: input('api-key').value });
    if (revision !== catalogRevision) return;
    if (!response?.ok) throw new Error(response?.error || '缓存读取失败');
    models = response.catalog?.models ?? []; showModels();
    input('models-cache').textContent = response.catalog?.fetchedAt ? `缓存于 ${new Date(response.catalog.fetchedAt).toLocaleString()}` : '尚无缓存，可手动填写或获取模型';
  } catch { if (revision === catalogRevision) input('models-cache').textContent = '当前服务暂无可用缓存'; }
}
function showThinking(profile: Settings['profile'], effort: Settings['thinkingEffort'], preserveInvalid = false) {
  const currentModel = input('model').value.trim() || settings.model;
  const capabilities = reasoningCapabilities({ profile, model: currentModel });
  const selectEl = select('thinking-effort');
  selectEl.replaceChildren(...capabilities.efforts.map(value => new Option(!capabilities.verified && value === 'default' ? '服务默认（能力未知）' : thinkingLabels[value] ?? value, value)));
  if (preserveInvalid && !capabilities.efforts.includes(effort)) { const previous = new Option(`${effort} · 不支持，请重新选择`, effort); previous.disabled = true; selectEl.append(previous); selectEl.value = effort; return; }
  selectEl.value = capabilities.efforts.includes(effort) ? effort : capabilities.defaultEffort;
}
function showSuperchatThinking(profile: Settings['profile'], effort: Settings['superChatThinkingEffort'] = 'inherit', preserveInvalid = false) {
  const currentModel = input('model').value.trim() || settings.model;
  const capabilities = reasoningCapabilities({ profile, model: currentModel });
  const selectEl = select('superchat-thinking');
  selectEl.replaceChildren(new Option('跟随普通弹幕', 'inherit'), ...capabilities.efforts.map(value => new Option(thinkingLabels[value] ?? value, value)));
  if (preserveInvalid && effort !== 'inherit' && !capabilities.efforts.includes(effort!)) { const previous = new Option(`${effort} · 不支持，请重新选择`, effort); previous.disabled = true; selectEl.append(previous); selectEl.value = effort!; return; }
  selectEl.value = effort === 'inherit' || capabilities.efforts.includes(effort) ? effort : 'inherit';
}
function showScope() {
  const windowOnly = select('translation-scope').value === 'window';
  const field = document.getElementById('prefetch-field')!;
  field.hidden = !windowOnly; field.style.display = windowOnly ? '' : 'none'; input('prefetch').disabled = !windowOnly;
}
function showBilibiliTimeoutRetry() {
  for (const platform of ['bilibili', 'youtube', 'niconico']) {
    const enabled = input(platform + '-timeout-retry').checked;
    input(platform + '-timeout-retry-extra').disabled = !enabled;
    select(platform + '-timeout-retry-mode').disabled = !enabled;
  }
}
function readForm(requireModel = true, connectionOnly = false): Settings {
  const value: Record<string, unknown> = { ...settings };
  for (const [id, key] of Object.entries(fields)) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    value[key] = el.type === 'checkbox' ? (el as HTMLInputElement).checked : el.type === 'number' || id === 'live-buffer' ? Number(el.value) : el.value;
  }
  value.endpointInput = input('endpoint').value.trim();
  value.targetLanguage = languageCombo.value();
  try { value.localPerformance = value.backend === 'local' ? localPerformanceUI.read() : settings.localPerformance; }
  catch (error) {
    layout.reveal(input(Number(input('lp-microBatch').value) > Number(input('lp-batch').value) ? 'lp-microBatch' : 'lp-mode'));
    throw error;
  }
  // The advanced controls already contain any migrated nested overrides.
  value.connectionOverride = undefined;
  const profileValue = select('profile').value;
  if (profileValue === 'auto') value.reasoningProfileOverride = 'auto';
  else {
    value.profile = profileValue;
    if (dirty.has('profile') || settings.reasoningProfileOverride !== undefined) value.reasoningProfileOverride = profileValue;
  }
  const localModelId = select('local-model').value.trim();
  if (localModelId) value.localModelId = localModelId;
  else if (dirty.has('local-model')) value.localModelId = '';
  if (requireModel && String(value.backend) === 'local' && !localModelId && !settings.localModelId) { layout.reveal(select('local-model')); throw new Error('请先添加模型文件夹并手动选用模型'); }
  if (requireModel && String(value.backend) !== 'local' && !String(value.model ?? '').trim()) { layout.reveal(input('model')); throw new Error('请先选择或填写模型'); }
  return normalizeSettings(connectionOnly ? { ...value, thinkingEffort: undefined, superChatThinkingEffort: 'inherit' } : value);
}
function busy(value: boolean) {
  saving = value;
  layout.task('service', value, 'service', '连接操作进行中');
  for (const id of ['save', 'get-models', 'test-model']) (document.getElementById(id) as HTMLButtonElement).disabled = value;
}
function renderConnection() {
  const status = document.getElementById('connection-status')!;
  try {
    const backend = select('backend').value === 'local' ? 'local' : 'online';
    const endpoint = input('endpoint').value.trim();
    const protocolOverride = select('protocol-override').value as Settings['protocolOverride'];
    const endpointMode = select('endpoint-mode').value as Settings['endpointMode'];
    const connection = resolveConnection({ endpoint, allowLocalHttp: input('local-http').checked, backend: 'online', protocolOverride, endpointMode });
    const display = connectionDisplay(connection);
    const brand = profileLabels[display.brand] ?? '未知服务';
    const source = display.protocolSource === 'auto' ? '自动识别：OpenAI 兼容（Chat Completions）' : '手动协议：Chat Completions';
    const path = connection.requiresManualPath ? '自定义路径，模型列表地址需验证' : '标准路径可推导模型列表地址';
    status.textContent = backend === 'local'
      ? '本地 GPU · WebGPU · Super Chat 思考能力由模型聊天模板决定。在线配置已保留。'
      : `${source} · 请求地址：${display.address} · 模型 ${input('model').value || '待选择'} · 思考设置 ${thinkingLabels[select('thinking-effort').value] ?? '待选择'}${connection.requiresManualPath ? ' · ' + path : ''}`;
    status.className = 'subtle';
  } catch (error) { status.textContent = errorMessage(error, '服务地址待检查'); status.className = 'status error'; }
}
function showBackend() {
  const local = select('backend').value === 'local';
  for (const el of document.querySelectorAll<HTMLElement>('[data-backend]')) el.hidden = el.dataset.running !== 'true' && el.dataset.backend !== 'both' && el.dataset.backend !== (local ? 'local' : 'online');
  input('concurrency').max = local ? '2147483647' : '64';
  localPerformanceUI.setEnabled(local);
  document.getElementById('save')!.textContent = local ? '保存本地后端' : '保存并授权服务';
  input('api-key').placeholder = local ? '本地后端不会使用 Key；在线 Key 仍会保留' : '输入 Key；服务域名不变时可留空保留';
  document.getElementById('local-support')!.textContent = LOCAL_SUPPORT;
  for (const id of ['endpoint', 'api-key', 'remember', 'local-http', 'profile', 'endpoint-mode', 'protocol-override', 'thinking-effort', 'superchat-thinking']) {
    (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).disabled = local;
  }
  modelCombo.setDisabled(local);
  endpointCombo.setDisabled(local);
  renderLocalActions();
  let sameOrigin = false;
  try { sameOrigin = endpointOrigin(input('endpoint').value, input('local-http').checked) === credentialState.origin; } catch { /* Invalid draft URL has no credential binding. */ }
  input('key-state').textContent = local ? '本地推理不使用 API Key' : input('api-key').value ? '将使用当前填写的 Key'
    : sameOrigin && credentialState.hasKey ? credentialState.remembered ? '已有 Key · 仅此浏览器保存' : '已有 Key · 本次会话' : '请为此服务填写 Key';
  renderConnection();
}
function renderLocalModels() {
  const modelSelect = select('local-model');
  const selected = settings.localModelId ?? '';
  modelSelect.replaceChildren(new Option('请选择模型', ''), ...localModels.map(model => {
    const source = model.source ? `${model.source.directoryName}/${model.source.files[0]?.path ?? model.name}` : '旧副本';
    const unavailable = !!model.availability && model.availability !== 'ready';
    const option = new Option(`${model.name} · ${formatBytes(model.bytes)} · ${source}${unavailable ? ' · 暂不可用' : ''}`, model.id);
    option.disabled = unavailable; return option;
  }));
  modelSelect.value = localModels.some(model => model.id === selected) ? selected : '';
  renderLocalActions();
  const model = localModels.find(item => item.id === modelSelect.value);
  const meta = document.getElementById('local-model-meta')!;
  meta.textContent = model ? `${model.source ? `${model.source.directoryName}/${model.source.files[0]?.path ?? model.name}\n` : ''}${formatBytes(model.bytes)} · ${model.architecture} · ${model.quantization} · ${model.files.length} 个文件` : '';
  if (model?.translationProfile) meta.textContent += model.translationProfile === 'seed-x'
    ? ' · Seed-X 可能错译，请核对译文' : ' · TranslateGemma 需明确选择源语言和直播源语言';
  meta.title = model ? `${model.files.join(', ')} · tokenizer ${model.tokenizer}${model.template ? ' · 聊天模板' : ''}` : '';
  localPerformanceUI.setModel(model);
  localPerformanceUI.refresh();
  renderVram();
}
function renderVram() {
  const target = document.getElementById('local-vram')!, model = localModels.find(model => model.id === select('local-model').value);
  if (!model) { target.textContent = '预计显存占用：选择模型后显示'; return; }
  try {
    const draft = localPerformanceUI.read(), runtime = resolveLocalConfig(draft, model.id);
    const observed = localState?.model?.id === model.id && localState.runtime && localState.gpu ? {
      modelId: model.id, runtimeKey: localMemoryRuntimeKey(localState.runtime),
      modelBytes: localState.gpu.modelBufferMiB === undefined ? undefined : localState.gpu.modelBufferMiB * 1048576,
      kvBytes: localState.gpu.kvBufferMiB === undefined ? undefined : localState.gpu.kvBufferMiB * 1048576,
      computeBytes: localState.gpu.computeBufferMiB === undefined ? undefined : localState.gpu.computeBufferMiB * 1048576,
    } : undefined;
    const value = estimateLocalMemory(model, runtime, observed);
    const labels: Record<string,string> = {modelBytes:'权重',kvBytes:'统一 KV',computeBytes:'工作缓冲'};
    const parts = Object.entries(labels).filter(([key]) => value[key as keyof typeof value] !== undefined).map(([key,label]) => `${label} ${formatBytes(value[key as 'modelBytes']!)}`);
    target.textContent = `预计显存占用：${value.totalBytes === undefined ? '信息不足' : value.lowerBound ? '已知部分约 ' + formatBytes(value.totalBytes) + '（非总量）' : '约 ' + formatBytes(value.totalBytes)}\n${parts.join(' · ')}${value.missing.length ? '\n缺少：' + value.missing.map(key => labels[key] ?? key).join('、') : ''}\n${value.notes.includes('LOCAL_MEMORY_ARCHITECTURE_UNKNOWN') ? '此架构的 KV 暂无法估算。' : ''}估算不含浏览器与驱动开销，不代表可用显存。`;
    target.title = '统一 KV 只按总上下文计算一次；已跟踪缓冲分配不等于物理显存。';
    if (localState?.runtime && localState.model?.id === model.id && JSON.stringify(normalizeLocalConfig(localState.requested)) !== JSON.stringify(draft)) target.textContent += '\n参数待应用，需重新加载。';
  } catch { target.textContent = '预计显存占用：请先修正本地性能参数'; }
}
function renderLocalLanguageIssues(): string[] {
  const modelId = select('local-model').value;
  const model = localState?.model?.id === modelId ? localState.model : localModels.find(model => model.id === modelId);
  const profile = select('backend').value === 'local' ? model?.translationProfile : undefined;
  const issues: string[] = [];
  for (const [id, label] of [['source-language', '观看设置的源语言'], ['live-source-language', '直播聊天的直播源语言']] as const) {
    const control = select(id), hintId = id + '-local-hint';
    let hint = document.getElementById(hintId);
    if (!hint) {
      hint = document.createElement('span'); hint.id = hintId; hint.className = 'status error';
      control.after(hint); control.setAttribute('aria-describedby', hintId);
    }
    const code = translationLanguageIssue(profile, control.value, languageCombo.value());
    const text = code === 'LOCAL_TRANSLATION_SOURCE_REQUIRED' ? 'TranslateGemma 不支持自动判断，请选择实际源语言。'
      : code ? translationLanguageMessage(code)! : '';
    hint.textContent = text; hint.hidden = !code;
    if (code) issues.push(code === 'LOCAL_TRANSLATION_SOURCE_REQUIRED' ? `${label}需改为实际语言` : `${label}或目标语言不受支持`);
  }
  return issues;
}
function renderLocalState(state: LocalState | undefined) {
  localState = state;
  if (state?.phase === 'ready' && state.model?.translationProfile) {
    const indexed = localModels.find(model => model.id === state.model!.id);
    if (indexed && indexed.translationProfile !== state.model.translationProfile) {
      indexed.translationProfile = state.model.translationProfile;
      indexed.templateCapability = state.model.templateCapability;
      renderLocalModels();
    }
  }
  renderLocalActions();
  const languageIssues = renderLocalLanguageIssues();
  const target = document.getElementById('local-state')!;
  const summary = document.getElementById('local-state-summary')!;
  if (!state) { target.textContent = '本地运行状态未读取'; summary.textContent = target.textContent; return; }
  const indexedModel = state.model ? localModels.find(model => model.id === state.model!.id) : undefined;
  const modelName = state.model ? state.model.name || indexedModel?.name || '所选模型' : undefined;
  const modelBytes = state.model?.bytes ?? indexedModel?.bytes;
  const verificationProgress = state.stage === 'fingerprinting' && state.verificationProgress
    ? `${formatBytes(state.verificationProgress.bytesProcessed)} / ${formatBytes(state.verificationProgress.totalBytes)}` : '';
  summary.textContent = `${localPhaseLabels[state.phase]}${modelName ? ' · ' + modelName : ''}${verificationProgress ? ' · 校验 ' + verificationProgress : ''}${localRuntime?.paused ? ' · 自动加载已暂停，手动加载可恢复' : ''}${state.error || localRuntime?.error ? ' · ' + localErrorMessage(new Error(state.error ?? localRuntime?.error)) : ''}`;
  summary.className = state.phase === 'error' ? 'status error span' : 'status span';
  if (languageIssues.length && ['ready', 'generating'].includes(state.phase) && state.model?.id === select('local-model').value) {
    summary.textContent += ' · 翻译设置待完善：' + languageIssues.join('；');
    summary.className = 'status error span';
  }
  layout.task('model', localLoadPending || ['loading', 'warming'].includes(state.phase), 'service', '模型加载中');
  const parts = [`${localPhaseLabels[state.phase]} · ${state.backend}`];
  if (state.gpu) {
    const gpu = state.gpu;
    parts.push(`GPU：${[gpu.vendor, gpu.architecture].filter(Boolean).join(' ') || '设备信息不可用'}`);
    parts.push(gpu.verified ? `GPU 已加载 ${gpu.offloadedLayers}/${gpu.totalLayers} 层` : 'GPU 权重加载待确认');
    if (gpu.modelBufferMiB !== undefined) parts.push(`GPU 模型缓冲 ${gpu.modelBufferMiB.toFixed(1)} MiB`);
  }
  if (state.model) parts.push(`模型：${modelName}${modelBytes !== undefined ? ' · ' + formatBytes(modelBytes) : ''}`);
  if (state.stage) parts.push(`${localStageLabels[state.stage] ?? state.stage}${verificationProgress ? ` ${verificationProgress}` : ''}`);
  if (state.loadMs !== undefined) parts.push(`加载 ${Math.round(state.loadMs)} ms`);
  parts.push(`原生槽位 ${state.runtime?.parallel ?? '未加载'} · 活跃 ${state.active} · 应用队列 ${state.queued}/128 · 完成 ${state.completed} · 失败 ${state.failed} · 取消 ${state.cancelled}`);
  if (state.runtime) parts.push(`应用请求上限 ${settings.concurrency} · 实际并发上限 ${Math.min(settings.concurrency, state.runtime.parallel)}（可在请求参数调整）`);
  if (state.lastMetrics) parts.push(`最近推理：本地排队 ${Math.round(state.lastMetrics.queueMs)} ms · 推理 ${Math.round(state.lastMetrics.inferenceMs)} ms（不含直播等待）`);
  if (state.runtime) parts.push(`统一上下文 ${state.runtime.contextTokens} · Batch ${state.runtime.batch}/${state.runtime.microBatch} · CPU 线程 ${state.runtime.cpuThreadsActual ?? '未知'} · FA ${state.gpu?.flashAttentionObserved ? '已观察内核' : state.gpu?.flashAttention === false ? '关闭' : '未确认'}`);
  if (state.warmupMs !== undefined) parts.push(`预热 ${Math.round(state.warmupMs)} ms`);
  if (state.gpu?.allocatedBytes !== undefined) parts.push(`已跟踪 GPU 缓冲 ${formatBytes(state.gpu.allocatedBytes)}（非物理显存）`);
  if (state.fallbackReasons?.length) parts.push(`降级：${state.fallbackReasons.join('；')}`);
  if (state.warnings?.length) parts.push(`风险提示：${state.warnings.map(code => code === 'LOCAL_CONTEXT_ABOVE_TRAINING_LIMIT' ? '所选上下文超过训练长度，效果与稳定性需自测' : code).join('；')}`);
  if (state.error) parts.push(`错误：${localErrorMessage(new Error(state.error))}`);
  target.textContent = parts.join(' · '); target.className = state.phase === 'error' ? 'status error' : 'status';
  renderVram();
}
function renderLocalActions() {
  const benchmarkBusy = localPerformanceUI.active(), state = localState;
  const modelBusy = localDeleting || selectionSaving;
  const local = select('backend').value === 'local';
  select('local-model').disabled = !local || !localModels.length || modelBusy;
  (document.getElementById('local-folder-add') as HTMLButtonElement).disabled = modelBusy;
  (document.getElementById('local-file-add') as HTMLButtonElement).disabled = modelBusy;
  const stop = document.getElementById('local-stop') as HTMLButtonElement;
  stop.textContent = localLoadPending || ['loading', 'warming'].includes(state?.phase ?? '') ? '取消加载' : '卸载模型';
  stop.disabled = localDeleting || benchmarkBusy || !localLoadPending && (!state || state.phase === 'idle');
  const selected = select('local-model').value;
  const model = localModels.find(model => model.id === selected);
  (document.getElementById('local-load') as HTMLButtonElement).disabled = modelBusy || benchmarkBusy || localLoadPending || !selected || !!model?.availability && model.availability !== 'ready' || ['loading', 'warming', 'generating'].includes(state?.phase ?? '');
  const deleteButton = document.getElementById('local-delete') as HTMLButtonElement;
  deleteButton.hidden = false;
  deleteButton.textContent = model?.source ? '移除模型' : '删除旧副本';
  deleteButton.title = deleteButton.textContent; deleteButton.setAttribute('aria-label', deleteButton.textContent);
  deleteButton.disabled = !local || modelBusy || saving || benchmarkBusy || !selected;
  (document.getElementById('local-delete-accept') as HTMLButtonElement).disabled = modelBusy || saving || benchmarkBusy || !deleteCandidate;
  (document.getElementById('local-delete-dismiss') as HTMLButtonElement).disabled = localDeleting;
}
function dismissModelDelete() {
  if (localDeleting) return;
  deleteCandidate = undefined; document.getElementById('local-delete-confirm')!.hidden = true;
  renderLocalActions();
}
async function deleteSelectedModel() {
  const candidate = deleteCandidate;
  if (!candidate || localDeleting || selectionSaving || saving || localPerformanceUI.active()) return;
  localDeleting = true; localLoadPending = false; ++localCommandRevision;
  layout.task('delete-model', true, 'service', '正在删除模型'); renderLocalActions();
  message('正在删除…', false, 'local-result');
  try {
    const response = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'delete', modelId: candidate.id } });
    if (!response?.ok) throw new Error(response?.error || '删除失败，请重试');
    const selectedId = typeof response.settings?.localModelId === 'string' ? response.settings.localModelId : '';
    localModels = response.models ?? []; settings.localModelId = selectedId;
    dirty.delete('local-model'); select('local-model').value = selectedId;
    localRuntime = response.localRuntime ?? localRuntime; localLoadPending = false;
    renderLocalModels(); renderLocalState(response.state);
    deleteCandidate = undefined; document.getElementById('local-delete-confirm')!.hidden = true;
    message(candidate.source ? `已移除 ${candidate.name} 的登记，原文件未删除` : `已删除 ${candidate.name} 的扩展内副本`, false, 'local-result');
    message(dirty.size ? '模型列表已更新；其他修改未保存' : '模型列表已更新');
  } catch (error) { message(localErrorMessage(error), true, 'local-result'); }
  finally {
    localDeleting = false; layout.task('delete-model', false); await refreshLocalState(); renderLocalActions();
    if (!deleteCandidate) (localModels.length ? select('local-model') : document.getElementById('local-folder-add')!).focus();
  }
}
function scheduleLocalPoll() {
  clearTimeout(localPollTimer);
  if (directoryScanBusy || directoryRequestPending || localLoadPending || localState && ['loading', 'warming', 'generating'].includes(localState.phase)) localPollTimer = setTimeout(() => { void refreshLocalState(); }, 350);
}
async function refreshLocalState() {
  if (localPollInFlight) return;
  localPollInFlight = true;
  try {
    const response = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'list' } });
    if (!response?.ok) throw new Error(response?.error || '本地状态读取失败');
    localModels = Array.isArray(response.models) ? response.models : [];
    localDirectories = response.directories ?? [];
    directoryScan = response.scan; directoryScanBusy = response.scanBusy === true;
    directoryUI.render(localDirectories, directoryScan, directoryScanBusy || directoryRequestPending, localModels);
    localRuntime = response.localRuntime ?? localRuntime;
    renderLocalModels(); renderLocalState(response.state);
  } catch (error) {
    const target = document.getElementById('local-state')!;
    target.textContent = localErrorMessage(error, '本地状态暂时不可用'); target.className = 'status error';
  } finally { localPollInFlight = false; scheduleLocalPoll(); }
}
async function localCommand(control: { action: 'load' | 'cancel' | 'unload'; modelId?: string }) {
  const result = document.getElementById('local-result')!;
  const revision = ++localCommandRevision;
  localLoadPending = control.action === 'load';
  result.textContent = localLoadPending ? '正在加载选中模型…' : '正在处理…';
  renderLocalState(localState); scheduleLocalPoll();
  try {
    const response = await browser.runtime.sendMessage({ type: 'local-control', control: control.action === 'load' ? { ...control, config: localPerformanceUI.read() } : control });
    if (revision !== localCommandRevision) return;
    if (!response?.ok) throw new Error(response?.error || '本地操作失败');
    if (response.models) localModels = response.models;
    renderLocalModels(); renderLocalState(response.state);
    result.textContent = control.action === 'load' ? '本地模型加载完成' : control.action === 'unload' ? '本地模型已卸载' : '本地操作已取消'; result.className = 'status';
  } catch (error) { if (revision === localCommandRevision) { result.textContent = localErrorMessage(error); result.className = 'status error'; } }
  finally { if (revision === localCommandRevision) localLoadPending = false; await refreshLocalState(); }
}
async function directoryAction(action: DirectoryAction, directoryId?: string) {
  if (action === 'remove-model') { requestModelRemoval(directoryId ?? ''); return; }
  if (action === 'authorize' || action === 'authorize-file') {
    try { const reply = await browser.runtime.sendMessage({ type: 'open-model-folders', ...(action === 'authorize-file' ? { files: true, modelId: directoryId } : { directoryId }) }); if (!reply?.ok) throw new Error(reply?.error); }
    catch { message('无法打开文件夹授权窗口，请重试', true, 'local-result'); }
    return;
  }
  if (action === 'scan' && directoryRequestPending) return;
  if (action === 'scan') { directoryRequestPending = true; scheduleLocalPoll(); }
  try {
    const reply = await browser.runtime.sendMessage({ type: 'local-control', control: { action: `directory-${action}`, ...(directoryId ? { directoryId } : {}) } });
    if (!reply?.ok) throw new Error(reply?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    if (reply.settings) settings.localModelId = reply.settings.localModelId ?? '';
    if (reply.fileIssues?.length) message(reply.fileIssues.map((issue: { path: string; error: string }) => `${issue.path}：${directoryErrorMessage(issue.error)}`).join('\n'), true, 'local-result');
  } catch (error) { message(localErrorMessage(error), true, 'local-result'); }
  finally { if (action === 'scan') directoryRequestPending = false; await refreshLocalState(); }
}
async function persistModelSelection(modelId: string) {
  dismissModelDelete();
  const revision = ++selectionRevision, previous = settings.localModelId ?? '';
  selectionSaving = true; dirty.add('local-model'); renderLocalActions();
  try {
    const reply = await browser.runtime.sendMessage({ type: 'select-local-model', modelId });
    if (revision !== selectionRevision) return;
    if (!reply?.ok) throw new Error(reply?.error || '模型选择保存失败');
    // Only this field is committed; all other form drafts stay untouched.
    settings.localModelId = modelId; dirty.delete('local-model'); select('local-model').value = modelId;
    localRuntime = reply.localRuntime ?? localRuntime;
    message(dirty.size ? '模型选择已保存；其他修改尚未保存' : '模型选择已保存');
  } catch (error) { if (revision === selectionRevision) { select('local-model').value = previous; dirty.delete('local-model'); } throw error; }
  finally { if (revision === selectionRevision) { selectionSaving = false; renderLocalModels(); renderLocalState(localState); } }
}
function fill(response: any) {
  if (!response?.ok) throw new Error(response?.error || '无法读取配置');
  input('online-budget-status').textContent = onlineBudgetText(response.onlineBudget);
  const previousDestination = snapshot(destinationFields);
  const previousTest = snapshot(testFields);
  settings = normalizeSettings(response.settings, { stored: true });
  credentialState = { origin: endpointOrigin(settings.endpoint, settings.allowLocalHttp), hasKey: response.hasOnlineKey ?? (settings.backend !== 'local' && response.hasKey), remembered: response.remembered === true };
  if (!dirty.has('local-performance')) localPerformanceUI.fill(settings.localPerformance);
  for (const [id, key] of Object.entries(fields)) {
    if (dirty.has(id)) continue;
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    if (id === 'endpoint') el.value = String(settings.endpointInput ?? settings[key]);
    else if (id === 'target-language') languageCombo.setValue(settings.targetLanguage);
    else if (el.type === 'checkbox') (el as HTMLInputElement).checked = settings[key] === true;
    else el.value = String(settings[key] ?? '');
  }
  if (!dirty.has('profile')) select('profile').value = settings.reasoningProfileOverride ?? settings.profile;
  if (!dirty.has('endpoint-mode')) select('endpoint-mode').value = settings.connectionOverride?.endpointMode ?? settings.endpointMode ?? 'auto';
  if (!dirty.has('protocol-override')) select('protocol-override').value = settings.connectionOverride?.protocol ?? settings.protocolOverride ?? 'auto';
  if (!dirty.has('superchat-thinking')) select('superchat-thinking').value = settings.superChatThinkingEffort ?? 'inherit';
  if (!dirty.has('local-model')) select('local-model').value = settings.localModelId ?? '';
  if (!dirty.has('thinking-effort')) showThinking(selectedProfile(), settings.thinkingEffort, true);
  showSuperchatThinking(selectedProfile(), dirty.has('superchat-thinking') ? select('superchat-thinking').value as Settings['superChatThinkingEffort'] : settings.superChatThinkingEffort ?? 'inherit', true);
  showScope(); showBilibiliTimeoutRetry(); showBackend(); renderLocalModels(); renderLocalState(localState);
  if (!dirty.has('remember')) input('remember').checked = response.remembered === true;
  if (previousDestination !== snapshot(destinationFields)) { clearModels(); providerRevision++; void readCatalog(); }
  if (previousTest !== snapshot(testFields)) { invalidateTest(); providerRevision++; }
  localRuntime = response.localRuntime ?? localRuntime;
  showModels();
  showBackend();
}
async function refresh() {
  const response = await browser.runtime.sendMessage({ type: 'overview' }); fill(response);
  input('cache-state').textContent = response.cache ? `${response.cache.entries} 条 · ${Math.ceil(response.cache.bytes / 1024)} KiB` : '';
  input('diagnostics').textContent = JSON.stringify({ status: response.status, cache: response.cache, engine: response.engine }, null, 2);
  renderLocalDiagnostics(response);
  await refreshLocalState();
}
function renderLocalDiagnostics(response: unknown) {
  const local = sanitizeRuntimeDiagnostics(response).globalEngine.local;
  input('local-engine-diagnostics').textContent = local ? `本地累计：引擎排队到期 ${local.counts.queuedDeadline ?? 0} · 已派发后到期 ${local.counts.runningDeadline ?? 0}（包含本地排队和推理） · 请求超时 ${local.counts.requestTimeout ?? 0} · 语言/截断拒收 ${local.counts.qualityRejected ?? 0} · 强制重译实际请求 ${local.counts.forcedCalls ?? 0}` : '';
}
async function exportDiagnostics() {
  const button = document.getElementById('export-diagnostics') as HTMLButtonElement;
  if (button.disabled) return;
  button.disabled = true; message('正在获取最新诊断…', false, 'diagnostics-result');
  try {
    const response = await browser.runtime.sendMessage({ type: 'live-diagnostics' });
    if (!response?.ok) throw new Error(response?.error || '无法读取诊断');
    renderLocalDiagnostics(response);
    const payload = sanitizeRuntimeDiagnostics(response);
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'danlingo-runtime-diagnostics.json'; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); }
    finally { URL.revokeObjectURL(url); }
    message(response.status ? '已导出安全诊断 JSON' : '未发现直播统计，已导出全局引擎诊断', false, 'diagnostics-result');
  } catch (error) { message(errorMessage(error, '诊断导出失败'), true, 'diagnostics-result'); }
  finally { button.disabled = false; }
}
async function saveSettings(autoClose = false): Promise<boolean> {
  if (saving) { message('连接操作进行中，请稍后再关闭', true); return false; }
  if (selectionSaving || localDeleting) { message('模型操作尚未完成，请稍候', true); return false; }
  if (!layout.validate()) { message('请检查标出的设置，修改尚未保存', true); return false; }
  busy(true); message('正在保存…');
  try {
    const normalized = readForm(); const revision = formRevision; const submittedKey = input('api-key').value; const submittedRemember = input('remember').checked;
    if (normalized.backend !== 'local') {
      const origin = endpointOrigin(normalized.endpoint, normalized.allowLocalHttp);
      if (autoClose) {
        if (!await browser.permissions.contains({ origins: [origin + '/*'] })) throw new Error('此服务尚未授权，请点击“保存并授权服务”后关闭');
      } else if (!await browser.permissions.request({ origins: [origin + '/*'] })) throw new Error('未授权服务地址，配置未保存');
    }
    const result = await browser.runtime.sendMessage({ type: 'save', settings: normalized, apiKey: submittedKey, remember: submittedRemember });
    if (!result?.ok) throw new Error(result?.error || '保存失败');
    if (revision === formRevision) dirty.clear(); fill(result);
    if (input('api-key').value === submittedKey) input('api-key').value = '';
    message(dirty.size ? '已保存；仍有未保存的修改' : '已保存'); await refresh(); return !dirty.size;
  } catch (error) { message('保存失败：' + errorMessage(error, '请重试'), true); return false; }
  finally { busy(false); }
}
document.getElementById('settings-form')!.addEventListener('submit', event => {
  event.preventDefault(); void saveSettings();
});
for (const event of ['input', 'change']) document.getElementById('settings-form')!.addEventListener(event, e => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  if (target.id in fields || target.id === 'remember' || target.id === 'api-key' || ['profile', 'thinking-effort', 'superchat-thinking', 'local-model'].includes(target.id)) markDirty(target.id);
  if (testFields.includes(target.id)) invalidateTest();
  if (destinationFields.includes(target.id)) { clearModels(); void readCatalog(); }
  if ([...destinationFields, 'model'].includes(target.id)) providerRevision++;
  if (['backend', 'endpoint', 'local-http', 'endpoint-mode', 'protocol-override', 'api-key'].includes(target.id)) { showBackend(); }
  if (target.id.endsWith('-timeout-retry')) showBilibiliTimeoutRetry();
  if (['backend', 'model', 'endpoint', 'local-http'].includes(target.id)) {
    const previous = select('thinking-effort').value, previousSC = select('superchat-thinking').value;
    showThinking(selectedProfile(), previous as Settings['thinkingEffort']); showSuperchatThinking(selectedProfile(), previousSC as Settings['superChatThinkingEffort']);
    if (select('thinking-effort').value !== previous) markDirty('thinking-effort');
    if (select('superchat-thinking').value !== previousSC) markDirty('superchat-thinking');
  }
  if (testFields.includes(target.id)) renderConnection();
  if (['backend', 'source-language', 'live-source-language', 'target-language'].includes(target.id)) renderLocalState(localState);
});
select('profile').addEventListener('change', () => {
  const profile = selectedProfile();
  showThinking(profile, normalizeReasoningEffort({ profile, model: input('model').value || settings.model }, undefined));
  showSuperchatThinking(profile, 'inherit'); renderConnection();
});
select('translation-scope').addEventListener('change', showScope);
select('local-model').addEventListener('change', () => { void persistModelSelection(select('local-model').value).catch(error => message(localErrorMessage(error), true, 'local-result')); });
document.getElementById('local-stop')!.addEventListener('click', () => { void localCommand({ action: localLoadPending || ['loading', 'warming'].includes(localState?.phase ?? '') ? 'cancel' : 'unload' }); });
document.getElementById('local-load')!.addEventListener('click', () => { const modelId = select('local-model').value; if (modelId) void localCommand({ action: 'load', modelId }); });
function requestModelRemoval(id: string) {
  const model = localModels.find(item => item.id === id);
  if (!model || localDeleting || selectionSaving || saving || localPerformanceUI.active()) return;
  deleteCandidate = { id: model.id, name: model.name, source: model.source };
  document.getElementById('local-delete-description')!.textContent = model.source
    ? `移除“${model.name}”的登记？原始 GGUF 文件不受影响；若正在使用，会先卸载并清空选择。${model.source.kind === 'directory' ? '该模型不会随目录刷新重新出现。' : ''}`
    : `删除“${model.name}”的扩展内副本？原始 GGUF 文件不受影响；若正在使用，会先卸载。`;
  document.getElementById('local-delete-accept')!.textContent = model.source ? '确认移除' : '删除副本';
  document.getElementById('local-delete-confirm')!.hidden = false; renderLocalActions();
  document.getElementById('local-delete-confirm')!.scrollIntoView({ block: 'nearest' });
  document.getElementById('local-delete-dismiss')!.focus();
}
document.getElementById('local-delete')!.addEventListener('click', () => requestModelRemoval(select('local-model').value));
document.getElementById('local-delete-dismiss')!.addEventListener('click', () => { dismissModelDelete(); document.getElementById('local-delete')!.focus(); });
document.getElementById('local-delete-accept')!.addEventListener('click', () => { void deleteSelectedModel(); });
document.getElementById('get-models')!.addEventListener('click', async () => {
  if (saving) return;
  busy(true); message('正在获取模型…', false, 'models-result'); const revision = providerRevision;
  try {
    const normalized = readForm(false, true);
    if (normalized.backend === 'local') {
      const local = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'list' } });
      if (!local?.ok) throw new Error(local?.error || '本地模型列表读取失败');
      localModels = Array.isArray(local.models) ? local.models : []; renderLocalModels(); renderLocalState(local.state);
      if (!localModels.length) throw new Error('尚未导入本地 GGUF 模型');
      message(`已找到 ${localModels.length} 个本地模型，请选择并加载。`, false, 'models-result');
      return;
    }
    const submittedKey = input('api-key').value; const origin = endpointOrigin(normalized.endpoint, normalized.allowLocalHttp);
    if (!await browser.permissions.request({ origins: [origin + '/*'] })) throw new Error('未授权服务地址');
    if (revision !== providerRevision) throw new Error('输入已变化，请重新获取模型');
    const result = await browser.runtime.sendMessage({ type: 'models', settings: normalized, apiKey: submittedKey });
    if (revision !== providerRevision) throw new Error('输入已变化，请重新获取模型');
    if (!result?.ok) throw new Error(result?.error || '模型查询失败');
    if (!Array.isArray(result.models) || !result.models.length) throw new Error('服务未返回可用模型，仍可手动填写');
    models = result.models;
    if (result.effectiveEndpoint) {
      input('endpoint').value = result.effectiveEndpoint; select('endpoint-mode').value = result.effectiveEndpointMode ?? 'base'; markDirty('endpoint'); markDirty('endpoint-mode'); renderConnection();
    }
    if (!input('model').value.trim()) { input('model').value = models[0]!; markDirty('model'); invalidateTest(); }
    catalogRevision++; showModels(); input('models-cache').textContent = `缓存于 ${new Date(result.fetchedAt).toLocaleString()}`;
    message(`已获取 ${models.length} 个模型，可选择或直接编辑。`, false, 'models-result');
    void readServiceHistory();
    showThinking(selectedProfile(), select('thinking-effort').value as Settings['thinkingEffort']);
    showSuperchatThinking(selectedProfile(), select('superchat-thinking').value as Settings['superChatThinkingEffort']); renderConnection();
  } catch (error) { if (revision !== providerRevision) return; message(errorMessage(error, '模型查询失败') + '；保留已有列表和输入', true, 'models-result'); }
  finally { busy(false); }
});
document.getElementById('test-model')!.addEventListener('click', async () => {
  if (saving) return;
  busy(true); const revision = testRevision; message('正在测试模型…', false, 'test-result');
  try {
    const normalized = readForm(); const submittedKey = input('api-key').value;
    if (normalized.backend !== 'local') {
      const origin = endpointOrigin(normalized.endpoint, normalized.allowLocalHttp);
      if (!await browser.permissions.request({ origins: [origin + '/*'] })) throw new Error('未授权服务地址');
    }
    if (revision !== testRevision) return;
    const testModelName = normalized.backend === 'local'
      ? localModels.find(model => model.id === normalized.localModelId)?.name
        ?? (localState?.model?.id === normalized.localModelId ? localState?.model?.name : undefined) ?? '本地模型'
      : normalized.model;
    message(`正在测试 ${testModelName}，最长等待 ${Math.ceil(providerTimeoutMs(normalized) / 1000)} 秒…`, false, 'test-result');
    const result = await browser.runtime.sendMessage({ type: 'test-model', settings: normalized, apiKey: submittedKey,
      text: (document.getElementById('model-test-text') as HTMLTextAreaElement).value,
      context: select('model-test-context').value });
    if (revision !== testRevision) return;
    if (!result?.ok) throw new Error(result?.error || '模型测试失败');
    void readServiceHistory();
    const verification = result.verification === 'basic-language-check' ? '格式与语言检查通过' : '格式检查通过';
    const timing = result.local ? `\n本地排队 ${Math.round(result.local.queueMs)} ms · 推理 ${Math.round(result.local.inferenceMs)} ms` : '';
    message(`${result.model} · ${verification} · 单条 ${(result.elapsedMs / 1000).toFixed(2)} 秒\n目标 ${result.targetLanguage ?? normalized.targetLanguage} · ${result.promptMode === 'hy-mt' ? 'HY-MT 直接翻译' : '结构化翻译'}\n${result.sourceText} → ${result.text}${timing}\n此耗时不代表直播及时率。`, false, 'test-result');
  } catch (error) { if (revision === testRevision) message(errorMessage(error, '模型测试失败'), true, 'test-result'); }
  finally { busy(false); }
});
const actions: Array<[string, string, string]> = [['clear-cache', 'clear-cache', '缓存已清空'], ['delete-key', 'delete-key', 'Key 已删除']];
for (const [id, type, text] of actions) {
  const trigger = document.getElementById(id) as HTMLButtonElement, box = document.getElementById(id + '-confirm')!;
  const confirm = box.querySelector<HTMLButtonElement>('[data-confirm]')!, dismiss = box.querySelector<HTMLButtonElement>('[data-dismiss]')!;
  trigger.addEventListener('click', () => { box.hidden = false; confirm.focus(); });
  dismiss.addEventListener('click', () => { box.hidden = true; trigger.focus(); });
  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return; trigger.disabled = confirm.disabled = dismiss.disabled = true; message('正在处理…', false, id + '-result');
    try { const result = await browser.runtime.sendMessage({ type }); if (!result?.ok) throw new Error(result?.error || '操作失败'); await refresh(); box.hidden = true; message(text, false, id + '-result'); }
    catch { message('操作未完成，请重试', true, id + '-result'); }
    finally { trigger.disabled = confirm.disabled = dismiss.disabled = false; if (box.hidden) trigger.focus(); }
  });
}
document.getElementById('export-diagnostics')!.addEventListener('click', () => { void exportDiagnostics(); });
browser.runtime.onMessage.addListener((response: any) => {
  if (response?.type === 'settings-frame-close-request' && embedded) { void closeEmbedded(response.save === true); return; }
  if (response?.type === 'local-runtime-updated') { localRuntime = response.localRuntime; void refreshLocalState(); return; }
  if (response?.type === 'local-models-updated') { void refreshLocalState(); return; }
  if (response?.type !== 'settings-updated') return;
  providerRevision++; invalidateTest();
  try { fill(response); void refreshLocalState(); } catch (error) { message(errorMessage(error, '配置读取失败'), true); }
});
const localPerformanceUI = mountLocalPerformanceUI({ container: layout.localPerformance, benchmarkContainer: layout.localBenchmark, superchatContainer: layout.localSuperchat, activity: active => layout.task('local-test', active), modelId: () => select('local-model').value, changed: () => { markDirty('local-performance'); invalidateTest(); renderVram(); }, state: renderLocalState, busyChanged: () => renderLocalState(localState), translationSettings: () => ({ sourceLanguage: select('live-source-language').value, targetLanguage: languageCombo.value() }) });
const directoryUI = mountDirectoryUI(directoryAction);
mountPerformanceUI({ container: layout.onlinePerformance, activity: active => layout.task('online-test', active), readSettings: () => readForm(), readKey: () => input('api-key').value });
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
let closing = false;
async function closeEmbedded(save = false) {
  if (closing) return;
  if (localDeleting) { message('正在删除模型，请稍候', true); return; }
  if (save) {
    closing = true;
    try {
      if (selectionSaving || saving) { message('操作尚未完成，请稍后再关闭', true); return; }
      if (dirty.size && !await saveSettings(true)) return;
      if (dirty.size) return;
      await browser.runtime.sendMessage({ type: 'settings-frame-close' });
    } finally { closing = false; }
    return;
  }
  if (dirty.size && !window.confirm('有未保存的修改，放弃修改并关闭设置？')) return;
  await browser.runtime.sendMessage({ type: 'settings-frame-close' });
}
if (embedded) {
  document.documentElement.classList.add('embedded-settings');
  const close = document.createElement('button'); close.type = 'button'; close.className = 'settings-close'; close.textContent = '关闭设置';
  close.addEventListener('click', () => { void closeEmbedded(); }); document.querySelector('.page-header')!.append(close);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); void closeEmbedded(); } });
}
async function refreshShortcut() {
  try { input('translation-shortcut').textContent = await getTranslationShortcut(browser.commands) || '未设置'; }
  catch { input('translation-shortcut').textContent = '暂不可用'; }
}
document.getElementById('customize-shortcut')!.addEventListener('click', () => {
  const target = translationShortcutManagementUrl(/\bEdg\//.test(navigator.userAgent) ? 'edge' : 'chrome');
  void browser.tabs.create({ url: target }).then(() => { input('shortcut-result').textContent = '在浏览器中找到 DanLingo，即可修改快捷键'; })
    .catch(() => { input('shortcut-result').textContent = '请在浏览器的扩展管理 → 键盘快捷键中修改'; });
});
window.addEventListener('focus', () => {
  void refreshShortcut();
  if (select('backend').value === 'local') void refreshLocalState();
});
void refreshShortcut();
void refresh().then(() => { void readCatalog(); void readServiceHistory(); if (!dirty.size) message('已保存'); }).catch(error => message(errorMessage(error, '配置读取失败'), true));

// Refresh only the counter: never replace an unsaved settings draft.
let readingBudget = false;
const budgetTimer = setInterval(async () => {
  if (readingBudget || document.hidden) return;
  readingBudget = true;
  try {
    const reply = await browser.runtime.sendMessage({ type: 'online-budget-status' });
    input('online-budget-status').textContent = onlineBudgetText(reply?.ok ? reply.onlineBudget : undefined);
  } catch { input('online-budget-status').textContent = onlineBudgetText(); }
  finally { readingBudget = false; }
}, 1500);
window.addEventListener('pagehide', () => clearInterval(budgetTimer));
