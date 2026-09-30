import { loadTimingsText } from '../../src/local/source-progress';
import { UiError } from '../../src/i18n/text.ts';
import { browser } from 'wxt/browser';
import { onlineBudgetText } from '../../src/ui/online-budget';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  endpointOrigin,
  reasoningCapabilities,
  providerTimeoutMs,
} from '../../src/core/config';
import { ConnectionError, connectionDisplay, connectionErrorMessage, resolveConnection } from '../../src/core/connection';
import type { Settings } from '../../src/core/types';
import { selectModelEffort, type ModelCatalog } from '../../src/core/model-catalog';
import { mountDirectoryUI, type DirectoryAction } from './directory-ui';
import { createLocalSourcePicker } from './local-source-picker';
import { directoryErrorMessage } from '../../src/local/directory-errors';
import type { DirectoryInfo, DirectoryScanStatus } from '../../src/local/directory-types';
import { LOCAL_SUPPORT } from '../../src/local/gguf';
import type { LocalModelInfo, LocalState } from '../../src/local/types';
import { sanitizeRuntimeDiagnostics } from '../../src/ui/live-diagnostics';
import { mountPerformanceUI } from './performance-ui';
import { mountLocalPerformanceUI } from './local-performance-ui';
import { mountSettingsLayout } from './layout';
import { mountSettingsHelp } from './help-ui';
import { renderModelTestOutput } from './model-test-ui';
import { mountHybridUI } from './hybrid-ui';
import { initTheme } from '../../src/ui/theme';
import { mountCombobox } from '../../src/ui/combobox';
import { mountUserFilterStatus, userFilterSourceLabel, userFilterSourceSelectionText, type UserFilterStatusView } from '../../src/ui/user-filter-status';
import { mountTargetLanguageSelect } from '../../src/ui/languages';
import type { LocalRuntimeStatus } from '../../src/local/auto-load';
import { estimateLocalMemory, localMemoryRuntimeKey } from '../../src/local/memory-estimate';
import { resolveLocalConfig, normalizeLocalConfig } from '../../src/local/config';
import { translationLanguageIssue, translationLanguageMessage } from '../../src/local/translation-profile';
import { SERVICE_PRESETS } from '../../src/core/service-history';
import type { ServiceAddress } from '../../src/core/service-history';
import { getTranslationShortcut, translationShortcutManagementUrl } from '../../src/core/translation-shortcut';
import '../../src/ui/base.css';
import './options.css';
import './service-a.css';
import { formatNumber, formatDate, initLocale, localizeMessage, onLocaleChange, resolveLocale, setLocale, t } from '../../src/i18n';
import { bindLocalizedAttribute, bindLocalizedText } from '../../src/ui/localized-text';

// Authenticate before mounting anything that reads extension storage or sends privileged messages.
const embedded = new URL(location.href).searchParams.has('embedded');
const connected = await browser.runtime.sendMessage({ type: 'settings-ui-connect' });
if (!connected?.ok || embedded && !connected.embedded) {
  const locale = resolveLocale('auto', browser.i18n.getUILanguage()); setLocale(locale);
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  document.body.replaceChildren(document.createTextNode(t('m_ed222ea3e8f6')));
  throw new Error('SETTINGS_SESSION_REJECTED');
}
const layout = mountSettingsLayout();
// Text inputs can match :focus-visible after a mouse click; track keyboard navigation explicitly.
document.documentElement.dataset.focusInput = 'pointer';
document.addEventListener('pointerdown', () => { document.documentElement.dataset.focusInput = 'pointer'; }, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Tab') document.documentElement.dataset.focusInput = 'keyboard';
}, true);
void initLocale(document, document.getElementById('ui-locale') as HTMLSelectElement);
initTheme(document.getElementById('theme') as HTMLSelectElement);

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
const fields: Record<string, keyof Settings> = {
  endpoint: 'endpoint', model: 'model', backend: 'backend', 'target-language': 'targetLanguage', 'source-language': 'sourceLanguage',
  'local-preload-entry': 'localPreloadOnEntry',
  'local-idle-unload-enabled': 'localIdleUnloadEnabled', 'local-idle-unload-minutes': 'localIdleUnloadMinutes',
  'online-request-limit': 'onlineRequestLimitPerDay',
  'translation-scope': 'translationScope', 'display-mode': 'displayMode', prefetch: 'prefetchSeconds', urgent: 'urgentSeconds',
  'bilibili-user-filters': 'bilibiliUserFilters',
  'bilibili-owned-release': 'bilibiliOwnedRelease',
  'batch-size': 'batchSize', 'video-batch-size': 'videoBatchSize', 'batch-chars': 'maxBatchChars', 'online-concurrency': 'onlineConcurrency', 'local-concurrency': 'localConcurrency', timeout: 'requestTimeoutMs',
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
let modelCatalog: ModelCatalog | undefined;
let catalogEndpoint = '';
let localModels: LocalModelInfo[] = [];
let performanceUI: ReturnType<typeof mountPerformanceUI> | undefined;
let hybridUI: ReturnType<typeof mountHybridUI> | undefined;
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
let onlinePerformanceActive = false;
let serviceAddresses: ServiceAddress[] = [];
let credentialState: { origin?: string; hasKey: boolean; remembered: boolean } = { hasKey: false, remembered: false };
const endpointCombo = mountCombobox(input('endpoint'), [], { displayValue: 'value', onSelect: (option, previousValue) => {
  const previousOrigin = (() => { try { return endpointOrigin(previousValue, input('local-http').checked); } catch { return ''; } })();
  if (new URL(option.value).origin !== previousOrigin && input('api-key').value) { input('api-key').value = ''; markDirty('api-key'); }
  const address = serviceAddresses.find(row => row.endpoint === option.value);
  select('endpoint-mode').value = 'auto'; select('protocol-override').value = 'auto';
  input('local-http').checked = address?.allowLocalHttp ?? false;
  for (const id of ['endpoint-mode', 'protocol-override', 'local-http']) markDirty(id);
} });
const modelCombo = mountCombobox(input('model'));
const languageSelect = mountTargetLanguageSelect(select('target-language'));
let catalogRevision = 0;
let selectionSaving = false;
let loadingModelId = '';
let sourceRegistrationPending = false;
let sourceProgress: DirectoryScanStatus | undefined;
let localRuntime: LocalRuntimeStatus | undefined;
const destinationFields = ['endpoint', 'api-key', 'local-http', 'backend', 'endpoint-mode', 'protocol-override'];
const testFields = [...destinationFields, 'model', 'profile', 'thinking-effort', 'source-language', 'live-source-language', 'target-language', 'timeout', 'thinking-timeout', 'superchat-thinking', 'superchat-timeout', 'model-test-text', 'local-model-test-text', 'model-test-context'];
const dirty = new Set<string>();
const label = (key: string) => () => t(key);
const thinkingLabels: Record<string, () => string> = {
  default: label('m_a636bd2d57ff'), off: label('m_92618f81aee5'), on: label('m_12936984d608'), minimal: label('m_477e3eac4043'),
  low: label('m_aa9e366f68d3'), medium: label('m_a567bdaa1136'), high: label('m_b1c27820fec2'), max: label('m_10bec0878f8c'), xhigh: label('m_a3bf1e847715'),
};
const profileLabels: Record<string, () => string> = {
  auto: label('m_1b43fb7df76a'), minimax: () => 'MiniMax', deepseek: () => 'DeepSeek', gemini: () => 'Gemini', 'chat-completions': () => 'Chat Completions',
};
const localPhaseLabels: Record<LocalState['phase'], () => string> = {
  idle: label('m_43523cac435e'), loading: label('m_d04fcbda737f'), warming: label('m_975f1e9c14fe'), ready: label('m_ab27f80d046f'), generating: label('m_1d0d8fae36fa'), error: label('m_0bc1fb72ae1b'),
};
const localStageLabels: Record<string, () => string> = {
  checking: label('m_26db8fe96dbd'), fingerprinting: label('m_5947862d854e'), persisting: label('m_4fe41ddd6024'), 'reading-file': label('localSource.readingFiles'), 'reading-header': label('localSource.readingHeader'),
  'checking-gpu': label('m_97b31eeff2ea'), 'initializing-wasm': label('m_f0014b3f4b8a'), 'loading-weights': label('m_e73b6c4c325e'), loaded: label('m_92c0c81b6957'),
};
function message(text: string | (() => string), error = false, id = 'result') {
  const el = document.getElementById(id)!;
  bindLocalizedText(el, typeof text === 'function' ? text : () => text);
  el.className = 'status' + (error ? ' error' : '');
}
function snapshot(ids: string[]) {
  return JSON.stringify(ids.map(id => input(id).type === 'checkbox' ? input(id).checked : input(id).value));
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return t('m_260790e3c333');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(Number((bytes / 1024).toFixed(1)))} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${formatNumber(Number((bytes / 1024 / 1024).toFixed(1)))} MiB`;
  return `${formatNumber(Number((bytes / 1024 / 1024 / 1024).toFixed(2)))} GiB`;
}
function localErrorMessage(error: unknown, fallback = t('m_ddc0d10923e8')): string {
  if (error instanceof Error && /^LOCAL_(?:DIRECTORY_|SOURCE_|SCAN_)/.test(error.message)) return localizeMessage(directoryErrorMessage(error));
  const raw = error instanceof Error ? error.message : '';
  const code = /^LOCAL_[A-Z0-9_]+$/.test(raw) ? raw : '';
  const labels: Record<string, () => string> = {
    LOCAL_SELECT_SINGLE_COMPLETE_GGUF: () => t('m_2456fa56748a'), LOCAL_FORMAT_UNSUPPORTED: () => t('m_5cf5b7153aac'),
    LOCAL_SHARD_SET_INCOMPLETE: () => t('m_e5a043f13c1f'), LOCAL_SHARD_DUPLICATE: () => t('m_a4759d4e716b'),
    LOCAL_SHARD_MIXED: () => t('m_5ba0c81d2fc9'), LOCAL_SHARD_METADATA_INVALID: () => t('m_2c70b88b645a'),
    LOCAL_SHARD_ORDER_INVALID: () => t('m_1ae0ad57dc12'), LOCAL_FILE_SIZE_INVALID: () => t('m_717971f16a81'),
    LOCAL_SHARD_METADATA_MISSING: () => t('m_2178eb9b599a'), LOCAL_ARCHITECTURE_MISSING: () => t('m_9ae197551937'),
    LOCAL_NATIVE_UNSUPPORTED: () => t('m_a45f05fc6534'),
    LOCAL_NOT_GGUF: () => t('m_aafc89acfeaa'), LOCAL_GGUF_VERSION_UNSUPPORTED: () => t('m_1f323404a27b'),
    LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE: () => t('m_900eaeb51b13'), LOCAL_ARCHITECTURE_UNSUPPORTED: () => t('m_28ca73370ea5'),
    LOCAL_QUANTIZATION_UNSUPPORTED: () => t('m_e993110ba770'), LOCAL_TOKENIZER_MISSING: () => t('m_b8ca280cae2d'),
    LOCAL_CHAT_TEMPLATE_MISSING: () => t('m_be82469a446b'), LOCAL_MODEL_NOT_IMPORTED: () => t('m_dc5e2e260b10'),
    LOCAL_BROWSER_JSPI_UNSUPPORTED: () => t('m_12b118c1aa6a'), LOCAL_BROWSER_MEMORY64_UNSUPPORTED: () => t('m_e3fb58afc680'),
    LOCAL_WEBGPU_UNSUPPORTED: () => t('m_e79e5b0556ff'),
    LOCAL_GPU_SOFTWARE_ADAPTER: () => t('m_713a9c5be1f9'),
    LOCAL_GPU_DEVICE_FAILED: () => t('m_0441dd81fb57'),
    LOCAL_GPU_DEVICE_LOST: () => t('m_fd0e663f6744'),
    LOCAL_GPU_OFFLOAD_UNVERIFIED: () => t('m_f033efbaffc6'),
    LOCAL_MODEL_LOAD_REJECTED: () => t('m_2b0f031baa9f'), LOCAL_MODEL_NOT_LOADED: () => t('m_f8db012cd6eb'),
    LOCAL_CHAT_TEMPLATE_UNSUPPORTED: () => t('m_0691afc603de'),
    LOCAL_NLLB_UNSUPPORTED: () => t('m_20258af59a51'),
    LOCAL_VOCAB_ONLY: () => t('m_d6fce6fb28bd'),
    LOCAL_TRANSLATION_SOURCE_REQUIRED: () => translationLanguageMessage('LOCAL_TRANSLATION_SOURCE_REQUIRED')!,
    LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED: () => translationLanguageMessage('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED')!,
    LOCAL_MODEL_CHANGED: () => t('m_4a04eb274aa5'), LOCAL_CANCELLED: () => t('m_b9f6d5862a96'), LOCAL_QUEUE_FULL: () => t('m_c9f4a48209be'),
    LOCAL_OFFSCREEN_UNAVAILABLE: () => t('m_11d38137b22a'), LOCAL_STORAGE_UNAVAILABLE: () => t('m_bfad9f598891'),
    LOCAL_STORAGE_QUOTA_OR_IO: () => t('m_f7ac8d375d0a'), LOCAL_INFERENCE_FAILED: () => t('m_d520f08bd2cf'),
    LOCAL_WORKER_FAILED: () => t('m_52c9a77e4fed'), LOCAL_IMPORT_WORKER_FAILED: () => t('m_1d4106f312d9'), LOCAL_REQUEST_INVALID: () => t('m_a9f3446215ec'),
    LOCAL_CONFIG_INVALID: () => t('m_36914e8d81eb'),
    LOCAL_CONTEXT_CAPACITY_EXCEEDED: () => t('m_dd1f630577d7'),
    LOCAL_CONTEXT_EXCEEDS_MODEL: () => t('m_3ef6b962254e'),
    LOCAL_FLASH_ATTENTION_UNAVAILABLE: () => t('m_10f09efc1058'),
    LOCAL_BENCHMARK_BUSY: () => t('m_5eadc2f13988'),
    LOCAL_BENCHMARK_SAME_LANGUAGE: () => t('m_8dc36d455099'),
    LOCAL_BENCHMARK_CORPUS_UNAVAILABLE: () => t('m_417b9a11c997'),
    LOCAL_WORKER_SHUTDOWN_FAILED: () => t('m_a1eff3e3e1f9'),
    LOCAL_MODEL_LOADING: () => t('m_5a2644140130'), LOCAL_AUTOLOAD_PAUSED: () => t('m_086e68f6abc0'),
    LOCAL_LOAD_TIMEOUT: () => t('m_e8acf5acb8f3'), LOCAL_REASONING_UNSUPPORTED: () => t('m_aa62ae2e0f78'),
  };
  if (labels[code]) return labels[code]();
  if (raw && !code) {
    const rendered = localizeMessage(raw);
    return rendered === t('error.unknown') ? fallback : rendered;
  }
  return fallback;
}
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConnectionError) return localizeMessage(connectionErrorMessage(error));
  const hybridErrors: Record<string, string> = {
    HYBRID_PLAN_REQUIRED: t('hybrid.error.HYBRID_PLAN_REQUIRED'),
    HYBRID_KEY_REQUIRED: t('hybrid.error.HYBRID_KEY_REQUIRED'),
    HYBRID_CAPACITY_REQUIRED: t('hybrid.error.HYBRID_CAPACITY_REQUIRED'),
    HYBRID_CAPACITY_INVALID: t('hybrid.error.HYBRID_CAPACITY_INVALID'),
  };
  if (error instanceof Error) { const label = hybridErrors[error.message]; if (label) return label; }
  if (error instanceof Error && error.message === 'unsupported-thinking-effort') return t('m_35f6bd1f62ce');
  if (error instanceof Error && /^LOCAL_/.test(error.message)) return localErrorMessage(error);
  const rendered = localizeMessage(error);
  return rendered === t('error.unknown') ? fallback : rendered;
}
function markDirty(id: string) {
  dirty.add(id); formRevision++;
  message(() => (saving ? t('m_18f9c48b9e08') : t('m_5e531ad82437')));
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
function syncPerformance() {
  performanceUI?.sync({ ...settings, backend: select('backend').value === 'local' ? 'local' : 'online',
    endpoint: input('endpoint').value.trim(), model: input('model').value.trim() }, localModels, models);
}
function showModels() { modelCombo.setOptions(models.map(model => ({ value: model, label: model }))); syncPerformance(); }
function renderServiceHistory() {
  const seen = new Set(serviceAddresses.map(row => row.endpoint));
  endpointCombo.setOptions([
    ...serviceAddresses.map(row => ({ value: row.endpoint, label: row.endpoint, renderLabel: () => t('m_da7a1fc7ad1f', { p0: row.endpoint, p1: formatDate(row.verifiedAt) }) })),
    ...SERVICE_PRESETS.filter(row => !seen.has(row.endpoint)).map(row => ({ value: row.endpoint, label: `${row.name} · ${row.endpoint}`, aliases: [row.name] })),
  ]);
}
async function readServiceHistory() {
  const response = await browser.runtime.sendMessage({ type: 'service-history' });
  if (!response?.ok) return;
  serviceAddresses = response.addresses ?? [];
  renderServiceHistory();
}
function invalidateTest() {
  testRevision++;
  for (const id of ['test-result', 'local-test-result']) message(() => '', false, id);
}
function currentCompletionEndpoint() {
  return resolveConnection({ endpoint: input('endpoint').value, allowLocalHttp: input('local-http').checked,
    endpointMode: select('endpoint-mode').value as Settings['endpointMode'],
    protocolOverride: select('protocol-override').value as Settings['protocolOverride'] }).configuredCompletionEndpoint;
}
function currentModelReasoning(model: string): Settings['modelReasoning'] {
  const effort = selectModelEffort(modelCatalog, model);
  if (!effort || !modelCatalog || !catalogEndpoint) return;
  try {
    const endpoint = currentCompletionEndpoint();
    if (endpoint !== catalogEndpoint) return;
    return { model, endpoint, fetchedAt: modelCatalog.fetchedAt, effort };
  } catch { return; }
}
function currentReasoningCapabilities(profile: Settings['profile']) {
  const model = input('model').value.trim() || settings.model;
  const modelReasoning = currentModelReasoning(model);
  return reasoningCapabilities({ profile, model, endpoint: modelReasoning?.endpoint,
    modelReasoning });
}
function refreshReasoningChoices() {
  const profile = selectedProfile();
  showThinking(profile, select('thinking-effort').value as Settings['thinkingEffort']);
  showSuperchatThinking(profile, select('superchat-thinking').value as Settings['superChatThinkingEffort']);
  renderConnection();
}
function clearModels() {
  catalogRevision++; models = []; modelCatalog = undefined; catalogEndpoint = '';
  showModels(); refreshReasoningChoices(); message(() => (''), false, 'models-result'); input('models-cache').textContent = '';
}
async function readCatalog() {
  const revision = ++catalogRevision;
  if (!input('endpoint').value.trim()) return;
  try {
    const requested = readForm(false, true, { backend: 'online' });
    const response = await browser.runtime.sendMessage({ type: 'model-catalog', settings: requested, apiKey: input('api-key').value });
    if (revision !== catalogRevision) return;
    if (!response?.ok) throw new Error(response?.error || t('m_4e03197f1202'));
    modelCatalog = response.catalog as ModelCatalog | undefined;
    catalogEndpoint = requested.endpoint;
    models = modelCatalog?.models ?? []; showModels(); refreshReasoningChoices();
    bindLocalizedText(input('models-cache'), () => response.catalog?.fetchedAt ? t('m_3c17b769a83d', { p0: formatDate(response.catalog.fetchedAt) }) : '');
  } catch { if (revision === catalogRevision) bindLocalizedText(input('models-cache'), () => t('m_ed6e18c268fe')); }
}
function showThinking(profile: Settings['profile'], effort: Settings['thinkingEffort']) {
  const capabilities = currentReasoningCapabilities(profile);
  const selectEl = select('thinking-effort');
  selectEl.replaceChildren(...capabilities.efforts.map(value => localizedOption(value, () => !capabilities.verified && value === 'default' ? t('m_02c99682f183') : thinkingLabels[value]?.() ?? value)));
  if (effort && !capabilities.efforts.includes(effort)) { const previous = localizedOption(effort, () => t('m_064844fefa8a', { p0: effort })); previous.disabled = true; selectEl.append(previous); }
  selectEl.value = effort || capabilities.defaultEffort;
}
function localizedOption(value: string, render: () => string): HTMLOptionElement {
  const option = new Option('', value); bindLocalizedText(option, render); return option;
}
function showSuperchatThinking(profile: Settings['profile'], effort: Settings['superChatThinkingEffort'] = 'inherit') {
  const capabilities = currentReasoningCapabilities(profile);
  const selectEl = select('superchat-thinking');
  selectEl.replaceChildren(localizedOption('inherit', () => t('m_99a19a8ee7f3')), ...capabilities.efforts.map(value => localizedOption(value, () => thinkingLabels[value]?.() ?? value)));
  if (effort && effort !== 'inherit' && !capabilities.efforts.includes(effort)) { const previous = localizedOption(effort, () => t('m_064844fefa8a', { p0: effort })); previous.disabled = true; selectEl.append(previous); }
  selectEl.value = effort || 'inherit';
}
function showScope() {
  const windowOnly = select('translation-scope').value !== 'all';
  const field = document.getElementById('prefetch-field')!;
  field.hidden = !windowOnly; field.style.display = windowOnly ? '' : 'none'; input('prefetch').disabled = !windowOnly;
}
function showLocalIdleUnload() {
  input('local-idle-unload-minutes').disabled = !input('local-idle-unload-enabled').checked;
}
function showBilibiliTimeoutRetry() {
  for (const platform of ['bilibili', 'youtube', 'niconico']) {
    const enabled = input(platform + '-timeout-retry').checked;
    input(platform + '-timeout-retry-extra').disabled = !enabled;
    select(platform + '-timeout-retry-mode').disabled = !enabled;
    document.getElementById(platform + '-retry-options')!.hidden = !enabled;
  }
}
function readForm(requireModel = true, connectionOnly = false, test?: { backend: 'local' | 'online'; model?: string }): Settings {
  const value: Record<string, unknown> = { ...settings };
  for (const [id, key] of Object.entries(fields)) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    value[key] = el.type === 'checkbox' ? (el as HTMLInputElement).checked : el.type === 'number' || id === 'live-buffer' ? Number(el.value) : el.value;
  }
  if (test) { value.backend = test.backend; if (test.model !== undefined) value.model = test.model; }
  value.endpointInput = input('endpoint').value.trim();
  value.targetLanguage = languageSelect.value();
  try { value.localPerformance = value.backend === 'local' || !test && hybridUI?.enabled() ? localPerformanceUI.read() : settings.localPerformance; }
  catch (error) {
    layout.reveal(input(Number(input('lp-microBatch').value) > Number(input('lp-batch').value) ? 'lp-microBatch' : 'lp-mode'));
    throw error;
  }
  value.endpointMode = 'auto';
  value.protocolOverride = 'auto';
  value.connectionOverride = undefined;
  value.reasoningProfileOverride = select('profile').value;
  value.localModelId = settings.localModelId ?? '';
  // A backend-specific probe is independent of the active translation route.
  // Keep hybrid and the other backend's draft out of its validation and payload.
  value.bilibiliHybrid = test ? { ...settings.bilibiliHybrid, enabled: false } : hybridUI?.read() ?? settings.bilibiliHybrid;
  if (test?.backend === 'local') { value.endpoint = ''; value.endpointInput = ''; }
  if (requireModel && String(value.backend) === 'local' && !value.localModelId) { layout.reveal(document.getElementById('local-model-manager')!); throw new UiError('modelManager.choose'); }
  if (!test && requireModel && hybridUI?.enabled() && !value.bilibiliOwnedRelease) { layout.reveal(input('bilibili-owned-release')); throw new Error('HYBRID_PLAN_REQUIRED'); }
  if (!test && requireModel && hybridUI?.enabled() && !value.localModelId) { layout.reveal(document.getElementById('local-model-manager')!); throw new UiError('modelManager.choose'); }
  if (!test && requireModel && hybridUI?.enabled() && !String(value.endpoint ?? '').trim()) { layout.reveal(input('endpoint')); throw new UiError('online.endpointRequired'); }
  if (!test && requireModel && hybridUI?.enabled() && !String(value.model ?? '').trim()) { layout.reveal(input('model')); throw new UiError('m_57904a95b74a'); }
  if (String(value.backend) !== 'local' && !String(value.endpoint ?? '').trim() && (requireModel || connectionOnly)) { layout.reveal(input('endpoint')); throw new UiError('online.endpointRequired'); }
  if (requireModel && String(value.backend) !== 'local' && !String(value.model ?? '').trim()) { layout.reveal(input('model')); throw new UiError('m_57904a95b74a'); }
  return normalizeSettings(connectionOnly ? { ...value, thinkingEffort: undefined, superChatThinkingEffort: 'inherit' } : value,
    { modelReasoning: currentModelReasoning(String(value.model ?? '').trim()) });
}
function busy(value: boolean) {
  saving = value;
  layout.task('service', value, 'service', () => t('m_766dffe4b5ea'));
  for (const id of ['save', 'get-models', 'test-model', 'test-local-model']) (document.getElementById(id) as HTMLButtonElement).disabled = value;
  renderLocalActions();
}
function renderConnection() {
  const status = document.getElementById('connection-status')!;
  try {
    const backend = select('backend').value === 'local' ? 'local' : 'online';
    const endpoint = input('endpoint').value.trim();
    if (backend === 'local' || !endpoint) { bindLocalizedText(status, () => t(backend === 'local' ? 'm_0ce1116c7473' : 'online.unconfigured')); status.className = 'subtle'; return; }
    const connection = resolveConnection({ endpoint, allowLocalHttp: input('local-http').checked, backend: 'online', protocolOverride: 'auto', endpointMode: 'auto' });
    const display = connectionDisplay(connection);
    const source = () => display.protocolSource === 'auto' ? t('m_dbf0ab0b0404') : t('m_3a170345d247');
    const path = () => connection.requiresManualPath ? t('m_49482cbe1224') : t('m_6603a8e2e1aa');
    bindLocalizedText(status, () => t('m_8c03a60a90b4', { p0: source(), p1: display.address, p2: input('model').value || t('m_04fbe1f84206'), p3: thinkingLabels[select('thinking-effort').value]?.() ?? t('m_04fbe1f84206'), p4: connection.requiresManualPath ? ' · ' + path() : '' }));
    status.className = 'subtle';
  } catch (error) { bindLocalizedText(status, () => errorMessage(error, t('m_b7b656b54bdf'))); status.className = 'status error'; }
}
function showBackend() {
  layout.refreshServiceTitle();
  const local = select('backend').value === 'local';
  const hybrid = input('bilibili-hybrid').checked;
  syncPerformance();
  for (const el of document.querySelectorAll<HTMLElement>('[data-backend]')) el.hidden = el.dataset.running !== 'true' && el.dataset.backend !== 'both' && !hybrid && el.dataset.backend !== (local ? 'local' : 'online');
  localPerformanceUI.setEnabled(local || hybrid);
  bindLocalizedText(document.getElementById('save')!, () => local && !hybrid ? t('m_89514494e648') : t('m_da84b511f856'));
  bindLocalizedAttribute(input('api-key'), 'placeholder', () => local && !hybrid ? t('m_cc7cd771e3f0') : t('m_9a5bf1f8dda0'));
  bindLocalizedText(document.getElementById('local-support')!, () => {
    const rendered = localizeMessage(LOCAL_SUPPORT);
    return rendered === t('error.unknown') ? LOCAL_SUPPORT : rendered;
  });
  for (const id of ['endpoint', 'api-key', 'remember', 'local-http', 'profile', 'endpoint-mode', 'protocol-override', 'thinking-effort', 'superchat-thinking']) {
    (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).disabled = local && !hybrid;
  }
  modelCombo.setDisabled(local && !hybrid);
  endpointCombo.setDisabled(local && !hybrid);
  renderLocalActions();
  let sameOrigin = false;
  try { sameOrigin = endpointOrigin(input('endpoint').value, input('local-http').checked) === credentialState.origin; } catch { /* Invalid draft URL has no credential binding. */ }
  bindLocalizedText(input('key-state'), () => local && !hybrid ? t('m_be0a14b35dad') : input('api-key').value ? t('m_9b3ef63cf32e')
    : sameOrigin && credentialState.hasKey ? credentialState.remembered ? t('m_f8e5db8c00aa') : t('m_a61235030c8d') : t('m_e8a94b2d86bf'));
  renderConnection();
}
function renderLocalModels() {
  syncPerformance();
  const model = localModels.find(item => item.id === settings.localModelId);
  const meta = document.getElementById('local-model-meta')!;
  bindLocalizedText(meta, () => model?.translationProfile ? model.translationProfile === 'seed-x' ? t('m_d4a22c904a26') : t('m_3ad926cf8251') : '');
  bindLocalizedAttribute(meta, 'title', () => model ? `${model.files.join(', ')} · tokenizer ${model.tokenizer}${model.template ? t('m_e3c9471f49fa') : ''}` : '');
  localPerformanceUI.setModel(model);
  localPerformanceUI.refresh();
  renderLocalActions(); renderVram();
}
function renderVram() {
  const target = document.getElementById('local-vram')!, model = localModels.find(model => model.id === (settings.localModelId ?? ''));
  if (!model) { bindLocalizedText(target, () => ''); return; }
  try {
    const draft = localPerformanceUI.read(), runtime = resolveLocalConfig(draft, model.id);
    const observed = localState?.model?.id === model.id && localState.runtime && localState.gpu ? {
      modelId: model.id, runtimeKey: localMemoryRuntimeKey(localState.runtime),
      modelBytes: localState.gpu.modelBufferMiB === undefined ? undefined : localState.gpu.modelBufferMiB * 1048576,
      kvBytes: localState.gpu.kvBufferMiB === undefined ? undefined : localState.gpu.kvBufferMiB * 1048576,
      computeBytes: localState.gpu.computeBufferMiB === undefined ? undefined : localState.gpu.computeBufferMiB * 1048576,
    } : undefined;
    const value = estimateLocalMemory(model, runtime, observed);
    const labels: Record<string, () => string> = { modelBytes: () => t('m_db18831a0457'), kvBytes: () => t('m_19741f1b2b94'), computeBytes: () => t('m_c1a5b7e932eb') };
    const parts = () => Object.entries(labels).filter(([key]) => value[key as keyof typeof value] !== undefined).map(([key, render]) => `${render()} ${formatBytes(value[key as 'modelBytes']!)}`);
    const parametersDiffer = !!localState?.runtime && localState.model?.id === model.id && JSON.stringify(normalizeLocalConfig(localState.requested)) !== JSON.stringify(draft);
    bindLocalizedText(target, () => t('settings.memoryUsage', {
      p0: value.totalBytes === undefined ? t('m_0363eaf0c85e') : value.lowerBound ? t('m_6ba4b8c07bdf') + formatBytes(value.totalBytes) + t('m_41ce230bffd0') : t('m_5890c084b931') + formatBytes(value.totalBytes),
      p1: parts().join(' · '), p2: value.missing.length ? t('m_463071aaadb9') + value.missing.map(key => labels[key]?.() ?? key).join('、') : '',
    }) + (value.notes.includes('LOCAL_MEMORY_ARCHITECTURE_UNKNOWN') ? '\n' + t('m_b175a22ecb11') : '') + (parametersDiffer ? t('m_20a8d4c5f3ae') : ''));
  } catch { bindLocalizedText(target, () => t('m_b1de58aca38a')); }
}
function renderLocalLanguageIssues(): string[] {
  const modelId = (settings.localModelId ?? '');
  const model = localState?.model?.id === modelId ? localState.model : localModels.find(model => model.id === modelId);
  const profile = select('backend').value === 'local' || hybridUI?.enabled() ? model?.translationProfile : undefined;
  const issues: string[] = [];
  for (const [id, label] of [['source-language', t('m_cfe7e8b4befd')], ['live-source-language', t('m_e1f1e6d62cff')]] as const) {
    const control = select(id), hintId = id + '-local-hint';
    let hint = document.getElementById(hintId);
    if (!hint) {
      hint = document.createElement('span'); hint.id = hintId; hint.className = 'status error';
      control.after(hint); control.setAttribute('aria-describedby', hintId);
    }
    const code = translationLanguageIssue(profile, control.value, languageSelect.value());
    bindLocalizedText(hint, () => code === 'LOCAL_TRANSLATION_SOURCE_REQUIRED' ? t('m_f137d83307ad')
      : code ? localizeMessage(translationLanguageMessage(code)) : ''); hint.hidden = !code;
    if (code) issues.push(code === 'LOCAL_TRANSLATION_SOURCE_REQUIRED' ? t('m_7e15b0e92cd5', { p0: label }) : t('m_174e04797313', { p0: label }));
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
  const languageIssues = () => renderLocalLanguageIssues();
  const target = document.getElementById('local-state')!;
  const summary = document.getElementById('local-state-summary')!;
  if (!state) { bindLocalizedText(target, () => t('m_51c888a1d8a5')); bindLocalizedText(summary, () => t('m_51c888a1d8a5')); return; }
  const indexedModel = state.model ? localModels.find(model => model.id === state.model!.id) : undefined;
  const modelName = state.model ? state.model.name || indexedModel?.name : undefined;
  const modelBytes = state.model?.bytes ?? indexedModel?.bytes;
  const showLanguageIssues = ['ready', 'generating'].includes(state.phase) && state.model?.id === (settings.localModelId ?? '');
  bindLocalizedText(summary, () => `${localPhaseLabels[state.phase]()}${state.model ? ' · ' + (modelName || t('m_75fdd01c2979')) : ''}${state.stage && ['loading', 'warming'].includes(state.phase) ? ' · ' + (localStageLabels[state.stage]?.() ?? state.stage) : ''}${localRuntime?.paused ? t('m_3009e3dc51c9') : ''}${state.error || localRuntime?.error ? ' · ' + localErrorMessage(new Error(state.error ?? localRuntime?.error)) : ''}${showLanguageIssues && languageIssues().length ? t('m_57aab11ece24') + languageIssues().join('；') : ''}`);
  summary.className = state.phase === 'error' ? 'status error span' : 'status span';
  if (showLanguageIssues && languageIssues().length) {
    summary.className = 'status error span';
  }
  layout.task('model', localLoadPending || ['loading', 'warming'].includes(state.phase), 'service', () => t('m_e6ef0409f9df'));
  bindLocalizedText(target, () => {
  const parts = [`${localPhaseLabels[state.phase]()} · ${state.backend}`];
  if (state.gpu) {
    const gpu = state.gpu;
    parts.push(`GPU：${[gpu.vendor, gpu.architecture].filter(Boolean).join(' ') || t('m_79c8fcb1eb4e')}`);
    parts.push(gpu.verified ? t('m_3bf710cbd7d8', { p0: gpu.offloadedLayers, p1: gpu.totalLayers }) : t('m_9bd2a670dbe1'));
    if (gpu.modelBufferMiB !== undefined) parts.push(t('m_17f862702df7', { p0: formatNumber(Number(gpu.modelBufferMiB.toFixed(1))) }));
  }
  if (state.model) parts.push(t('m_5af0be67704b', { p0: modelName ?? t('m_75fdd01c2979'), p1: modelBytes !== undefined ? ' · ' + formatBytes(modelBytes) : '' }));
  if (state.stage) parts.push(`${localStageLabels[state.stage]?.() ?? state.stage}${state.currentFile ? ` · ${state.currentFile}` : ''}`);
  if (state.loadTimings) parts.push(loadTimingsText(state.loadTimings));
  if (state.loadMs !== undefined) parts.push(t('m_6a375f6dd2bb', { p0: Math.round(state.loadMs) }));
  parts.push(t('m_9446171b0985', { p0: state.runtime?.parallel ?? t('m_43523cac435e'), p1: state.active, p2: state.queued, p3: state.completed, p4: state.failed, p5: state.cancelled }));
  if (state.runtime) parts.push(t('m_478ef2c9071a', { p0: settings.localConcurrency, p1: Math.min(settings.localConcurrency, state.runtime.parallel) }));
  if (state.lastMetrics) parts.push(t('m_072a4558f606', { p0: Math.round(state.lastMetrics.queueMs), p1: Math.round(state.lastMetrics.inferenceMs) }));
  if (state.runtime) parts.push(t('m_b20f59593374', { p0: state.runtime.contextTokens, p1: state.runtime.batch, p2: state.runtime.microBatch, p3: state.runtime.cpuThreadsActual ?? t('m_4d8c1c5b4283'), p4: state.gpu?.flashAttentionObserved ? t('m_37c1450d6855') : state.gpu?.flashAttention === false ? t('m_3fd47edce45b') : t('m_c098e854e60b') }));
  if (state.warmupMs !== undefined) parts.push(t('m_31717999fb2e', { p0: Math.round(state.warmupMs) }));
  if (state.gpu?.allocatedBytes !== undefined) parts.push(t('m_8df4bdfeb0b0', { p0: formatBytes(state.gpu.allocatedBytes) }));
  if (state.fallbackReasons?.length) parts.push(t('m_a2b27c13d253', { p0: state.fallbackReasons.join('；') }));
  if (state.warnings?.length) parts.push(t('m_1b6094b97912', { p0: state.warnings.map(code => code === 'LOCAL_CONTEXT_ABOVE_TRAINING_LIMIT' ? t('m_94963f59267a') : code).join('；') }));
  if (state.error) parts.push(t('m_063abdaa463d', { p0: localErrorMessage(new Error(state.error)) }));
  return parts.join(' · ');
  }); target.className = state.phase === 'error' ? 'status error' : 'status';
  renderVram();
}
function modelActionsBusy() {
  return localDeleting || selectionSaving || saving || localLoadPending || sourceRegistrationPending || directoryScanBusy || directoryRequestPending || onlinePerformanceActive || localPerformanceUI.active() || ['loading', 'warming', 'generating'].includes(localState?.phase ?? '');
}
function renderLocalActions() {
  const benchmarkBusy = localPerformanceUI.active() || onlinePerformanceActive, state = localState;
  const blocked = modelActionsBusy();
  localPerformanceUI.setBlocked(blocked);
  for (const id of ['save', 'get-models', 'test-model', 'test-local-model']) (document.getElementById(id) as HTMLButtonElement).disabled = saving || localDeleting || selectionSaving || localLoadPending || sourceRegistrationPending || id !== 'save' && benchmarkBusy;
  (document.getElementById('local-folder-add') as HTMLButtonElement).disabled = blocked;
  (document.getElementById('local-file-add') as HTMLButtonElement).disabled = blocked;
  const stop = document.getElementById('local-stop') as HTMLButtonElement;
  bindLocalizedText(stop, () => localLoadPending || ['loading', 'warming'].includes(state?.phase ?? '') ? t('m_47402380923a') : t('m_6d54df246d5e'));
  stop.disabled = localDeleting || benchmarkBusy || sourceRegistrationPending || !localLoadPending && (!state || state.phase === 'idle');
  directoryUI.render(localDirectories, sourceProgress ?? directoryScan, directoryScanBusy || directoryRequestPending || sourceRegistrationPending, localModels, {
    selectedId: settings.localModelId, loadingId: localLoadPending ? loadingModelId : ['loading', 'warming'].includes(state?.phase ?? '') ? state?.model?.id : undefined,
    loadedId: ['ready', 'generating'].includes(state?.phase ?? '') ? state?.model?.id : undefined, busy: blocked,
  });
}
function focusModelRow(id?: string) {
  const row = [...document.querySelectorAll<HTMLElement>('[data-model-id]')].find(row => row.dataset.modelId === id);
  (row?.querySelector<HTMLButtonElement>('[data-model-action="remove"]') ?? document.getElementById('local-folder-add')!).focus();
}
async function removeModel(modelId: string) {
  const index = localModels.findIndex(model => model.id === modelId);
  const candidate = localModels[index];
  if (!candidate || modelActionsBusy()) return;
  const adjacentId = (localModels[index + 1] ?? localModels[index - 1])?.id;
  let removed = false;
  localDeleting = true; localLoadPending = false; ++localCommandRevision;
  layout.task('delete-model', true, 'service', () => t('m_24cddfdc575b')); renderLocalActions();
  message(() => (t('m_4fd4f40094d4')), false, 'local-result');
  try {
    const response = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'delete', modelId: candidate.id } });
    if (!response?.ok) throw new Error(response?.error || t('m_2026b0d30e91'));
    const selectedId = typeof response.settings?.localModelId === 'string' ? response.settings.localModelId : '';
    localModels = response.models ?? []; settings.localModelId = selectedId;
    if (hybridUI?.enabled()) void hybridUI.refresh();
    localRuntime = response.localRuntime ?? localRuntime; localLoadPending = false;
    renderLocalModels(); renderLocalState(response.state);
    removed = true;
    message(() => (candidate.source ? t('m_f4bb8ec46ebc', { p0: candidate.name }) : t('m_7a55bf017f15', { p0: candidate.name })), false, 'local-result');
    message(() => (dirty.size ? t('m_5089f219e5be') : t('m_5f09e4beb618')));
  } catch (error) { message(() => (localErrorMessage(error)), true, 'local-result'); }
  finally {
    localDeleting = false; layout.task('delete-model', false); await refreshLocalState(); renderLocalActions();
    focusModelRow(removed ? adjacentId : candidate.id);
  }
}
function scheduleLocalPoll() {
  clearTimeout(localPollTimer);
  if (directoryScanBusy || directoryRequestPending || sourceRegistrationPending || localLoadPending || localState && ['loading', 'warming', 'generating'].includes(localState.phase)) localPollTimer = setTimeout(() => { void refreshLocalState(); }, 350);
}
async function refreshLocalState() {
  if (localPollInFlight) return;
  localPollInFlight = true;
  try {
    const response = await browser.runtime.sendMessage({ type: 'local-control', control: { action: 'list' } });
    if (!response?.ok) throw new Error(response?.error || t('m_803c822c88ef'));
    localModels = Array.isArray(response.models) ? response.models : [];
    localDirectories = response.directories ?? [];
    directoryScan = response.scan; directoryScanBusy = response.scanBusy === true;
    await sourcePicker.refreshHandles(localDirectories, localModels);
    localRuntime = response.localRuntime ?? localRuntime;
    renderLocalModels(); renderLocalState(response.state);
  } catch (error) {
    const target = document.getElementById('local-state')!;
    bindLocalizedText(target, () => localErrorMessage(error, t('m_7c9eeafe4a93'))); target.className = 'status error';
  } finally { localPollInFlight = false; scheduleLocalPoll(); }
}
async function localCommand(control: { action: 'load' | 'cancel' | 'unload'; modelId?: string }) {
  const result = document.getElementById('local-result')!;
  const revision = ++localCommandRevision;
  localLoadPending = control.action === 'load';
  bindLocalizedText(result, () => localLoadPending ? t('m_d89c9fbcf9ee') : t('m_574ec7517de1'));
  renderLocalState(localState); scheduleLocalPoll();
  try {
    const response = await browser.runtime.sendMessage({ type: 'local-control', control: control.action === 'load' ? { ...control, config: localPerformanceUI.read() } : control });
    if (revision !== localCommandRevision) return;
    if (!response?.ok) throw new Error(response?.error || t('m_f98ae5bf0d8c'));
    if (response.models) localModels = response.models;
    renderLocalModels(); renderLocalState(response.state);
    bindLocalizedText(result, () => control.action === 'load' ? t('m_6e89c062fca7') : control.action === 'unload' ? t('m_a643cbd58dab') : t('m_b9f6d5862a96')); result.className = 'status';
  } catch (error) { if (revision === localCommandRevision) { bindLocalizedText(result, () => localErrorMessage(error)); result.className = 'status error'; } }
  finally { if (revision === localCommandRevision) localLoadPending = false; await refreshLocalState(); }
}
async function directoryAction(action: DirectoryAction, id?: string) {
  if (action === 'cancel' && sourceRegistrationPending) { await sourcePicker.cancel(); return; }
  if (action !== 'cancel' && modelActionsBusy()) return;
  if (action === 'load-model') { await loadModel(id ?? ''); return; }
  if (action === 'remove-model') { await removeModel(id ?? ''); return; }
  if (action === 'authorize' || action === 'authorize-file') {
    await sourcePicker.choose(action === 'authorize' ? 'directory' : 'files', id);
    return;
  }
  if (action === 'scan') { sourceProgress = undefined; directoryRequestPending = true; scheduleLocalPoll(); renderLocalActions(); }
  try {
    const reply = await browser.runtime.sendMessage({ type: 'local-control', control: { action: `directory-${action}`, ...(id ? { directoryId: id } : {}) } });
    if (!reply?.ok) throw new Error(reply?.error ?? 'LOCAL_DIRECTORY_SCAN_FAILED');
    if (reply.settings) {
      const previous = settings.localModelId;
      settings.localModelId = reply.settings.localModelId ?? '';
      if (hybridUI?.enabled() && previous !== settings.localModelId) void hybridUI.refresh();
    }
    if (reply.fileIssues?.length) message(() => reply.fileIssues.map((issue: { path: string; error: string }) => `${issue.path}: ${localizeMessage(directoryErrorMessage(issue.error))}`).join('\n'), true, 'local-result');
  } catch (error) { message(() => localErrorMessage(error), true, 'local-result'); }
  finally { if (action === 'scan') directoryRequestPending = false; await refreshLocalState(); }
}
async function loadModel(modelId: string) {
  const model = localModels.find(item => item.id === modelId);
  if (modelActionsBusy() || !model || model.availability && model.availability !== 'ready') return;
  let config;
  try { config = localPerformanceUI.read(); }
  catch (error) { message(() => localErrorMessage(error), true, 'local-result'); return; }
  invalidateTest();
  const revision = ++localCommandRevision;
  localLoadPending = true; selectionSaving = true; loadingModelId = modelId;
  message(() => t('m_d89c9fbcf9ee'), false, 'local-result');
  renderLocalState(localState); scheduleLocalPoll();
  try {
    const reply = await browser.runtime.sendMessage({ type: 'select-local-model', modelId, load: true, config });
    // A load can fail or be cancelled after the choice was saved.
    if (reply?.settings) settings.localModelId = reply.settings.localModelId ?? '';
    if (hybridUI?.enabled()) void hybridUI.refresh();
    if (revision !== localCommandRevision) return;
    localRuntime = reply?.localRuntime ?? localRuntime;
    if (reply?.state) renderLocalState(reply.state);
    if (!reply?.ok) throw new Error(reply?.error || t('m_f98ae5bf0d8c'));
    message(() => t('m_6e89c062fca7'), false, 'local-result');
    message(() => dirty.size ? t('m_afbdd6b65d43') : t('m_cc8aa89f6c55'));
  } catch (error) { if (revision === localCommandRevision) message(() => localErrorMessage(error), true, 'local-result'); }
  finally {
    selectionSaving = false;
    if (revision === localCommandRevision) { localLoadPending = false; loadingModelId = ''; }
    await refreshLocalState(); renderLocalModels(); renderLocalState(localState);
  }
}
function fill(response: any) {
  if (!response?.ok) throw new Error(response?.error || t('m_b3a4c2d4da9c'));
  bindLocalizedText(input('online-budget-status'), () => onlineBudgetText(response.onlineBudget));
  const previousDestination = snapshot(destinationFields);
  const previousTest = snapshot(testFields);
  settings = normalizeSettings(response.settings, { stored: true });
  credentialState = { origin: settings.endpoint ? endpointOrigin(settings.endpoint, settings.allowLocalHttp) : undefined, hasKey: response.hasOnlineKey ?? (settings.backend !== 'local' && response.hasKey), remembered: response.remembered === true };
  if (!dirty.has('local-performance')) localPerformanceUI.fill(settings.localPerformance);
  for (const [id, key] of Object.entries(fields)) {
    if (dirty.has(id)) continue;
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    if (id === 'endpoint') el.value = String(settings.endpointInput ?? settings[key]);
    else if (id === 'target-language') languageSelect.setValue(settings.targetLanguage);
    else if (el.type === 'checkbox') (el as HTMLInputElement).checked = settings[key] === true;
    else el.value = String(settings[key] ?? '');
  }
  if (!dirty.has('profile')) {
    let inferred: Settings['profile'] = 'chat-completions';
    try {
      const { brand } = resolveConnection({ endpoint: input('endpoint').value, allowLocalHttp: input('local-http').checked });
      if (brand !== 'unknown') inferred = brand;
    } catch { /* Keep a saved manual dialect when the address is incomplete. */ }
    select('profile').value = settings.reasoningProfileOverride ?? (settings.profile === inferred ? 'auto' : settings.profile);
  }
  select('endpoint-mode').value = 'auto';
  select('protocol-override').value = 'auto';
  if (!dirty.has('superchat-thinking')) select('superchat-thinking').value = settings.superChatThinkingEffort ?? 'inherit';
  showThinking(selectedProfile(), dirty.has('thinking-effort') ? select('thinking-effort').value as Settings['thinkingEffort'] : settings.thinkingEffort);
  showSuperchatThinking(selectedProfile(), dirty.has('superchat-thinking') ? select('superchat-thinking').value as Settings['superChatThinkingEffort'] : settings.superChatThinkingEffort ?? 'inherit');
  if (!dirty.has('bilibili-hybrid')) hybridUI?.fill(settings.bilibiliHybrid);
  showScope(); showLocalIdleUnload(); showBilibiliTimeoutRetry(); showBackend(); renderLocalModels(); renderLocalState(localState);
  if (!dirty.has('remember')) input('remember').checked = response.remembered === true;
  if (previousDestination !== snapshot(destinationFields)) { clearModels(); providerRevision++; void readCatalog(); }
  if (previousTest !== snapshot(testFields)) { invalidateTest(); providerRevision++; }
  localRuntime = response.localRuntime ?? localRuntime;
  showModels();
  showBackend();
}
async function refresh() {
  const response = await browser.runtime.sendMessage({ type: 'overview' }); fill(response);
  bindLocalizedText(input('cache-state'), () => response.cache ? t('m_2883656935bd', { p0: response.cache.entries, p1: Math.ceil(response.cache.bytes / 1024) }) : '');
  input('diagnostics').textContent = JSON.stringify(sanitizeRuntimeDiagnostics(response), null, 2);
  renderLocalDiagnostics(response);
  await refreshLocalState();
}
function renderLocalDiagnostics(response: unknown) {
  const local = sanitizeRuntimeDiagnostics(response).globalEngine.local;
  bindLocalizedText(input('local-engine-diagnostics'), () => local ? t('m_0debac083dd7', { p0: local.counts.queuedDeadline ?? 0, p1: local.counts.runningDeadline ?? 0, p2: local.counts.requestTimeout ?? 0, p3: local.counts.qualityRejected ?? 0, p4: local.counts.forcedCalls ?? 0 }) : '');
}
async function exportDiagnostics() {
  const button = document.getElementById('export-diagnostics') as HTMLButtonElement;
  if (button.disabled) return;
  button.disabled = true; message(() => (t('m_638709a842a0')), false, 'diagnostics-result');
  try {
    const response = await browser.runtime.sendMessage({ type: 'live-diagnostics' });
    if (!response?.ok) throw new Error(response?.error || t('m_c2a9f299030d'));
    renderLocalDiagnostics(response);
    const payload = sanitizeRuntimeDiagnostics(response);
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'danlingo-runtime-diagnostics.json'; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); }
    finally { URL.revokeObjectURL(url); }
    message(() => (response.status ? t('m_65fb960a533f') : t('m_b06405a01d0b')), false, 'diagnostics-result');
  } catch (error) { message(() => (errorMessage(error, t('m_1509629cfed7'))), true, 'diagnostics-result'); }
  finally { button.disabled = false; }
}
async function saveSettings(autoClose = false): Promise<boolean> {
  if (saving) { message(() => (t('m_643d7531338d')), true); return false; }
  if (selectionSaving || localDeleting) { message(() => (t('m_63f01d99fe64')), true); return false; }
  if (!layout.validate()) { message(() => (t('m_61689b8b2b7f')), true); return false; }
  busy(true); message(() => (t('m_6bdb4435095e')));
  try {
    await hybridUI?.ensureSelected();
    const normalized = readForm(); const revision = formRevision; const submittedKey = input('api-key').value; const submittedRemember = input('remember').checked;
    if (normalized.backend !== 'local' || hybridUI?.enabled()) {
      const origin = endpointOrigin(normalized.endpoint, normalized.allowLocalHttp);
      if (hybridUI?.enabled() && !submittedKey && (!credentialState.hasKey || credentialState.origin !== origin)) {
        layout.reveal(input('api-key')); throw new Error('HYBRID_KEY_REQUIRED');
      }
      if (autoClose) {
        if (!await browser.permissions.contains({ origins: [origin + '/*'] })) throw new UiError('m_ffad0837a6bc');
      } else if (!await browser.permissions.request({ origins: [origin + '/*'] })) throw new UiError('m_e0bb6a927847');
    }
    const result = await browser.runtime.sendMessage({ type: 'save', settings: normalized, apiKey: submittedKey, remember: submittedRemember });
    if (!result?.ok) throw new Error(result?.error || t('m_6309a3bb5ba4'));
    if (revision === formRevision) dirty.clear(); fill(result);
    if (input('api-key').value === submittedKey) input('api-key').value = '';
    message(() => (dirty.size ? t('m_e64dc7df2196') : t('m_1bd91a7d0c53'))); await refresh(); return !dirty.size;
  } catch (error) { message(() => (t('m_6ade7baf8737') + errorMessage(error, t('m_a2577bae3cfc'))), true); return false; }
  finally { busy(false); }
}
document.getElementById('settings-form')!.addEventListener('submit', event => {
  event.preventDefault(); void saveSettings();
});
for (const event of ['input', 'change']) document.getElementById('settings-form')!.addEventListener(event, e => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  if (target.id in fields || target.id === 'remember' || target.id === 'api-key' || ['profile', 'thinking-effort', 'superchat-thinking'].includes(target.id)) markDirty(target.id);
  if (testFields.includes(target.id)) invalidateTest();
  if (target.id === 'local-idle-unload-enabled') showLocalIdleUnload();
  if (destinationFields.includes(target.id)) { clearModels(); void readCatalog(); }
  if ([...destinationFields, 'model'].includes(target.id)) providerRevision++;
  if (target.id === 'model') syncPerformance();
  if (['backend', 'endpoint', 'local-http', 'endpoint-mode', 'protocol-override', 'api-key'].includes(target.id)) { showBackend(); }
  if (target.id.endsWith('-timeout-retry')) showBilibiliTimeoutRetry();
  if (['backend', 'model', 'endpoint', 'local-http'].includes(target.id)) {
    const previous = select('thinking-effort').value, previousSC = select('superchat-thinking').value;
    showThinking(selectedProfile(), previous as Settings['thinkingEffort']); showSuperchatThinking(selectedProfile(), previousSC as Settings['superChatThinkingEffort']);
  }
  if (testFields.includes(target.id)) renderConnection();
  if (['backend', 'source-language', 'live-source-language', 'target-language'].includes(target.id)) renderLocalState(localState);
  if (hybridUI?.enabled() && ['backend', 'model', 'endpoint', 'local-http', 'profile', 'thinking-effort',
    'source-language', 'live-source-language', 'target-language', 'local-concurrency', 'online-concurrency', 'timeout', 'thinking-timeout',
    'batch-size', 'batch-chars', 'live-adaptive',
    'endpoint-mode', 'protocol-override'].includes(target.id)) void hybridUI.refresh();
});
select('profile').addEventListener('change', () => {
  refreshReasoningChoices();
});
select('translation-scope').addEventListener('change', showScope);
document.getElementById('local-stop')!.addEventListener('click', () => { void localCommand({ action: localLoadPending || ['loading', 'warming'].includes(localState?.phase ?? '') ? 'cancel' : 'unload' }); });
document.getElementById('get-models')!.addEventListener('click', async () => {
  if (saving) return;
  busy(true); message(() => (t('m_511a3880b9b9')), false, 'models-result'); const revision = providerRevision;
  const catalogRequest = ++catalogRevision;
  try {
    const normalized = readForm(false, true, { backend: 'online' });
    const submittedKey = input('api-key').value; const origin = endpointOrigin(normalized.endpoint, normalized.allowLocalHttp);
    if (!await browser.permissions.request({ origins: [origin + '/*'] })) throw new UiError('m_5c6b58748487');
    if (revision !== providerRevision) throw new UiError('m_2f2a14b4b16d');
    const result = await browser.runtime.sendMessage({ type: 'models', settings: normalized, apiKey: submittedKey });
    if (revision !== providerRevision) throw new UiError('m_2f2a14b4b16d');
    if (catalogRequest !== catalogRevision) return;
    if (!result?.ok) throw new Error(result?.error || t('m_b3a0e7fec424'));
    if (!Array.isArray(result.models) || !result.models.length) throw new UiError('m_3421b10a28f4');
    if (result.effectiveEndpoint) {
      input('endpoint').value = result.effectiveEndpoint; select('endpoint-mode').value = 'auto'; markDirty('endpoint'); renderConnection();
    }
    modelCatalog = { models: result.models, fetchedAt: result.fetchedAt, capabilities: result.capabilities };
    catalogEndpoint = currentCompletionEndpoint();
    models = modelCatalog.models;
    if (!input('model').value.trim()) { input('model').value = models[0]!; markDirty('model'); invalidateTest(); }
    showModels(); bindLocalizedText(input('models-cache'), () => t('m_3c17b769a83d', { p0: formatDate(result.fetchedAt) }));
    message(() => (t('m_d541191d70a4', { p0: models.length })), false, 'models-result');
    void readServiceHistory();
    refreshReasoningChoices();
  } catch (error) { if (revision !== providerRevision) return; message(() => (errorMessage(error, t('m_b3a0e7fec424')) + t('m_9b6e0c624428')), true, 'models-result'); }
  finally { busy(false); }
});
async function runModelTest(backend: 'online' | 'local') {
  if (saving) return;
  const resultId = backend === 'online' ? 'test-result' : 'local-test-result';
  const output = document.getElementById(resultId + '-output')!; output.hidden = true;
  const textId = backend === 'online' ? 'model-test-text' : 'local-model-test-text';
  busy(true); const revision = testRevision; message(() => (t('m_ff3f7614f8e7')), false, resultId);
  try {
    const normalized = readForm(true, false, { backend });
    const submittedKey = backend === 'online' ? input('api-key').value : '';
    if (backend === 'online') {
      const origin = endpointOrigin(normalized.endpoint, normalized.allowLocalHttp);
      if (!await browser.permissions.request({ origins: [origin + '/*'] })) throw new UiError('m_5c6b58748487');
    }
    if (revision !== testRevision) return;
    const testModelName = backend === 'local'
      ? localModels.find(model => model.id === normalized.localModelId)?.name
        ?? (localState?.model?.id === normalized.localModelId ? localState?.model?.name : undefined) ?? t('m_44ac539067ed')
      : normalized.model;
    message(() => (t('m_eeff17c695e6', { p0: testModelName, p1: Math.ceil(providerTimeoutMs(normalized) / 1000) })), false, resultId);
    const result = await browser.runtime.sendMessage({ type: 'test-model', settings: normalized, apiKey: submittedKey,
      text: (document.getElementById(textId) as HTMLTextAreaElement).value,
      ...(backend === 'local' ? { context: select('model-test-context').value } : {}) });
    if (revision !== testRevision) return;
    if (!result?.ok) throw new Error(result?.error || t('m_d3b1da3088dd'));
    if (backend === 'online') void readServiceHistory();
    const verification = () => result.verification === 'basic-language-check' ? t('m_20d0aaef5c92') : t('m_a3e6a2003aba');
    message(verification, false, resultId);
    renderModelTestOutput(output, result);
  } catch (error) { if (revision === testRevision) message(() => (errorMessage(error, t('m_d3b1da3088dd'))), true, resultId); }
  finally { busy(false); }
}
document.getElementById('test-model')!.addEventListener('click', () => { void runModelTest('online'); });
document.getElementById('test-local-model')!.addEventListener('click', () => { void runModelTest('local'); });
const actions: Array<[string, string, string]> = [['clear-cache', 'clear-cache', 'm_5265ad8f9163'], ['delete-key', 'delete-key', 'm_f954966d0999']];
for (const [id, type, textKey] of actions) {
  const trigger = document.getElementById(id) as HTMLButtonElement, box = document.getElementById(id + '-confirm')!;
  const confirm = box.querySelector<HTMLButtonElement>('[data-confirm]')!, dismiss = box.querySelector<HTMLButtonElement>('[data-dismiss]')!;
  trigger.addEventListener('click', () => { box.hidden = false; confirm.focus(); });
  dismiss.addEventListener('click', () => { box.hidden = true; trigger.focus(); });
  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return; trigger.disabled = confirm.disabled = dismiss.disabled = true; message(() => (t('m_574ec7517de1')), false, id + '-result');
    try { const result = await browser.runtime.sendMessage({ type }); if (!result?.ok) throw new Error(result?.error || t('m_0c3b4cf7aa25')); await refresh(); box.hidden = true; message(() => t(textKey), false, id + '-result'); }
    catch { message(() => (t('m_608e2da1bf2d')), true, id + '-result'); }
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
  try { fill(response); void refreshLocalState(); } catch (error) { message(() => (errorMessage(error, t('m_e5ed04984086'))), true); }
});
const localPerformanceUI = mountLocalPerformanceUI({ container: layout.localPerformance, benchmarkContainer: layout.localBenchmark, superchatContainer: layout.localSuperchat, activity: active => layout.task('local-test', active), modelId: () => (settings.localModelId ?? ''), changed: () => { markDirty('local-performance'); invalidateTest(); renderVram(); if (hybridUI?.enabled()) void hybridUI.refresh(); }, state: renderLocalState, busyChanged: () => renderLocalState(localState), translationSettings: () => ({ sourceLanguage: select('live-source-language').value, targetLanguage: languageSelect.value() }) });
hybridUI = mountHybridUI({ container: document.getElementById('hybrid-host')!, readSettings: () => readForm(false),
  requestCapacity: draft => browser.runtime.sendMessage({ type: 'hybrid-capacity', settings: draft }),
  changed: () => markDirty('bilibili-hybrid'), enabledChanged: showBackend, reveal: layout.reveal });
const directoryUI = mountDirectoryUI(directoryAction);
const sourcePicker = createLocalSourcePicker({
  busy: value => { sourceRegistrationPending = value; renderLocalActions(); scheduleLocalPoll(); },
  progress: value => { sourceProgress = value; renderLocalActions(); },
  result: (render, error) => message(render, error, 'local-result'),
  refresh: refreshLocalState,
});
performanceUI = mountPerformanceUI({ container: layout.onlinePerformance,
  activity: active => { onlinePerformanceActive = active; layout.task('online-test', active); renderLocalActions(); },
  readSettings: (backend, model) => readForm(false, false, { backend, model }), readKey: () => input('api-key').value,
  configureOnline: () => {
    select('backend').value = 'online'; select('backend').dispatchEvent(new Event('change', { bubbles: true }));
    layout.reveal(input('endpoint'));
  },
});
mountSettingsHelp();
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
let closing = false;
async function closeEmbedded(save = false) {
  if (closing) return;
  if (localDeleting) { message(() => (t('m_df3091ed7a71')), true); return; }
  if (save) {
    closing = true;
    try {
      if (selectionSaving || saving) { message(() => (t('m_ea87fa06bcc7')), true); return; }
      if (dirty.size && !await saveSettings(true)) return;
      if (dirty.size) return;
      await browser.runtime.sendMessage({ type: 'settings-frame-close' });
    } finally { closing = false; }
    return;
  }
  if (dirty.size && !window.confirm(t('m_0e440d4ed0d6'))) return;
  await browser.runtime.sendMessage({ type: 'settings-frame-close' });
}
if (embedded) {
  document.documentElement.classList.add('embedded-settings');
  const close = document.createElement('button'); close.type = 'button'; close.className = 'settings-close'; bindLocalizedText(close, () => t('m_77b17fc4a52a'));
  close.addEventListener('click', () => { void closeEmbedded(); }); document.querySelector('.page-header')!.append(close);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); void closeEmbedded(); } });
}
async function refreshShortcut() {
  try {
    const shortcut = await getTranslationShortcut(browser.commands);
    bindLocalizedText(input('translation-shortcut'), () => shortcut || t('m_2f5f1d6fbfb0'));
  }
  catch { bindLocalizedText(input('translation-shortcut'), () => t('m_f36cac96220b')); }
}
document.getElementById('customize-shortcut')!.addEventListener('click', () => {
  const target = translationShortcutManagementUrl(/\bEdg\//.test(navigator.userAgent) ? 'edge' : 'chrome');
  void browser.tabs.create({ url: target }).then(() => { bindLocalizedText(input('shortcut-result'), () => t('m_4bf8e6d85519')); })
    .catch(() => { bindLocalizedText(input('shortcut-result'), () => t('m_6412257bcd55')); });
});
window.addEventListener('focus', () => {
  void refreshShortcut();
  if (select('backend').value === 'local') void refreshLocalState();
});
void refreshShortcut();
void refresh().then(() => { void readCatalog(); void readServiceHistory(); if (!dirty.size) message(() => (t('m_1bd91a7d0c53'))); }).catch(error => message(() => (errorMessage(error, t('m_e5ed04984086'))), true));

// Refresh only the counter: never replace an unsaved settings draft.
let readingBudget = false;
const budgetTimer = setInterval(async () => {
  if (readingBudget || document.hidden) return;
  readingBudget = true;
  try {
    const reply = await browser.runtime.sendMessage({ type: 'online-budget-status' });
    bindLocalizedText(input('online-budget-status'), () => onlineBudgetText(reply?.ok ? reply.onlineBudget : undefined));
  } catch { bindLocalizedText(input('online-budget-status'), () => onlineBudgetText()); }
  finally { readingBudget = false; }
}, 1500);
window.addEventListener('pagehide', () => clearInterval(budgetTimer));

const userFilterStatus = mountUserFilterStatus(document.getElementById('bilibili-user-filter-status')!);
const userFilterSourceRow = document.getElementById('bilibili-user-filter-source-row')!;
const userFilterSource = select('bilibili-user-filter-source');
bindLocalizedText(document.getElementById('bilibili-user-filter-source-label')!, () => userFilterSourceSelectionText().label);
let userFilterSources: Array<{ tabId: number; resourceId: string }> = [];
let selectedUserFilterTab: number | undefined;
let userFilterSourceSignature = '';
let userFilterRevision = 0;
let readingUserFilters = false;
function renderUserFilterSources(force = false) {
  const signature = JSON.stringify(userFilterSources);
  userFilterSourceRow.hidden = userFilterSources.length < 2;
  if (signature === userFilterSourceSignature && !force) { userFilterSource.value = String(selectedUserFilterTab ?? ''); return; }
  userFilterSourceSignature = signature;
  userFilterSource.replaceChildren(new Option(userFilterSourceSelectionText().placeholder, ''),
    ...userFilterSources.map(source => new Option(userFilterSourceLabel(source.resourceId, source.tabId), String(source.tabId))));
  userFilterSource.value = String(selectedUserFilterTab ?? '');
}
const unsubscribeUserFilterLocale = onLocaleChange(() => renderUserFilterSources(true));
function clearUserFilterStatus(readFailed = false) {
  const source = userFilterSources.find(item => item.tabId === selectedUserFilterTab);
  userFilterStatus.update({ connected: !!source, stale: false, featureEnabled: settings.bilibiliUserFilters,
    ...(source ? { tabId: source.tabId, resourceId: source.resourceId } : {}), readFailed });
}
async function pollUserFilterStatus() {
  if (readingUserFilters || document.hidden) return;
  readingUserFilters = true;
  const revision = ++userFilterRevision;
  try {
    const reply = await browser.runtime.sendMessage({ type: 'bilibili-user-filter-status',
      ...(selectedUserFilterTab === undefined ? {} : { tabId: selectedUserFilterTab }) });
    if (revision !== userFilterRevision) return;
    if (!reply?.ok || !Array.isArray(reply.sources)) throw new Error('user-filter-status-unavailable');
    userFilterSources = reply.sources.filter((source: any) => Number.isSafeInteger(source?.tabId) && source.tabId >= 0
      && typeof source.resourceId === 'string' && source.resourceId.length <= 100).slice(0, 30);
    if (selectedUserFilterTab === undefined && userFilterSources.some(source => source.tabId === reply.selectedTabId))
      selectedUserFilterTab = reply.selectedTabId;
    if (userFilterSources.length === 1) selectedUserFilterTab = userFilterSources[0]!.tabId;
    else if (!userFilterSources.some(source => source.tabId === selectedUserFilterTab)) selectedUserFilterTab = undefined;
    renderUserFilterSources();
    const source = userFilterSources.find(item => item.tabId === selectedUserFilterTab);
    const view = reply.view as UserFilterStatusView | undefined;
    if (!source || !view || view.tabId !== source.tabId || view.resourceId !== source.resourceId) {
      clearUserFilterStatus(); return;
    }
    userFilterStatus.update(view);
  } catch {
    if (revision === userFilterRevision) clearUserFilterStatus(true);
  } finally { if (revision === userFilterRevision) readingUserFilters = false; }
}
userFilterSource.addEventListener('change', () => {
  const tabId = Number(userFilterSource.value);
  selectedUserFilterTab = userFilterSource.value && userFilterSources.some(source => source.tabId === tabId) ? tabId : undefined;
  userFilterRevision++; readingUserFilters = false; clearUserFilterStatus();
  void pollUserFilterStatus();
});
clearUserFilterStatus();
void pollUserFilterStatus();
const userFilterTimer = setInterval(() => { void pollUserFilterStatus(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollUserFilterStatus(); });
window.addEventListener('pagehide', () => {
  clearInterval(userFilterTimer); userFilterRevision++; unsubscribeUserFilterLocale(); userFilterStatus.dispose();
});
