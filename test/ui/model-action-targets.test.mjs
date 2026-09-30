import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { DEFAULT_SETTINGS, endpointOrigin, normalizeSettings, providerTimeoutMs } from '../../src/core/config.ts';

const source = await readFile(new URL('../../entrypoints/options/main.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('options/main.ts', source, ts.ScriptTarget.Latest, true);
const transpile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function declaration(name) {
  const node = file.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
    || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => item.name.getText(file) === name));
  assert.ok(node, `${name} must exist in the options page`);
  return node.getText(file);
}

function clickRegistration(id) {
  const node = file.statements.find(statement => ts.isExpressionStatement(statement)
    && statement.getText(file).includes(`document.getElementById('${id}')!.addEventListener('click'`));
  assert.ok(node, `${id} must register a click handler`);
  return node.getText(file);
}

const fieldsCode = transpile(declaration('fields'));
const actionsCode = transpile([
  'message', 'readForm', 'busy', 'runModelTest', 'saveSettings',
].map(declaration).join('\n') + '\n' + [
  'get-models', 'test-model', 'test-local-model',
].map(clickRegistration).join('\n'));
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ backend = 'online', hybrid = false, localModelId = 'local-model-id', endpoint = 'https://api.example.com/v1',
  model = 'online-model', localDraftInvalid = false, ownedRelease = true } = {}) {
  const settings = { ...DEFAULT_SETTINGS, backend, endpoint, model, localModelId,
    bilibiliOwnedRelease: ownedRelease,
    bilibiliHybrid: { enabled: hybrid, profiles: [], adaptive: false, onlineStreaming: false } };
  const originalSettings = plain(settings);
  const context = vm.createContext({});
  vm.runInContext(fieldsCode + '\nglobalThis.fieldNames = Object.entries(fields);', context);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, type: 'text', value: '', checked: false, textContent: '', className: '', disabled: false,
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
    });
    return elements.get(id);
  };
  for (const [id, key] of context.fieldNames) {
    const control = element(id), value = settings[key];
    control.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text';
    control.value = value === undefined ? '' : String(value);
    control.checked = value === true;
  }
  for (const id of ['api-key', 'remember', 'model-test-text', 'local-model-test-text', 'model-test-context',
    'profile', 'lp-batch', 'lp-microBatch', 'local-model-manager', 'bilibili-hybrid', 'models-cache',
    'models-result', 'test-result', 'local-test-result', 'result', 'save', 'get-models', 'test-model', 'test-local-model']) element(id);
  element('api-key').value = 'draft-online-key';
  element('profile').value = 'chat-completions';
  element('model-test-text').value = 'online sample';
  element('local-model-test-text').value = 'local sample';
  element('model-test-context').value = 'video';
  element('bilibili-hybrid').checked = hybrid;
  element('lp-batch').value = '512';
  element('lp-microBatch').value = '256';
  const calls = [], permissions = [], reveals = [];
  const localPerformance = { reads: 0, invalid: localDraftInvalid, read() {
    this.reads++;
    if (this.invalid) throw new Error('LOCAL_CONFIG_INVALID');
    return {};
  } };
  const hybridDraft = { reads: 0, read() {
    this.reads++;
    return { enabled: hybrid, profiles: [], adaptive: false, onlineStreaming: false };
  }, enabled: () => hybrid, ensureSelected: async () => {} };
  const browser = {
    permissions: { async request(request) { permissions.push(request); return true; }, async contains() { return true; } },
    runtime: { async sendMessage(message) {
      calls.push(message);
      if (message.type === 'models') return { ok: true, models: ['online-model'], fetchedAt: 100 };
      if (message.type === 'test-model') return { ok: true, model: message.settings.backend === 'local' ? 'local-model-id' : 'online-model',
        verification: 'basic-language-check', elapsedMs: 50, sourceText: message.text, text: 'translated' };
      throw new Error(`Unexpected ${message.type} request`);
    } },
  };
  Object.assign(context, {
    initialSettings: settings, document: { getElementById: element }, browser,
    input: element, select: element, languageSelect: { value: () => 'zh-Hans' },
    localPerformanceUI: localPerformance, hybridUI: hybridDraft,
    layout: { task() {}, validate: () => true, reveal: target => reveals.push(target.id) },
    DEFAULT_SETTINGS, normalizeSettings, endpointOrigin, providerTimeoutMs,
    currentModelReasoning: () => undefined,
    currentCompletionEndpoint: () => endpoint,
    showModels() {}, refreshReasoningChoices() {}, readServiceHistory() {}, renderLocalActions() {},
    markDirty(id) { context.dirtyIds.push(id); }, invalidateTest() {}, renderConnection() {},
    bindLocalizedText(target, render) { target.textContent = render(); },
    formatDate: value => String(value), formatNumber: value => String(value),
    t: key => key, errorMessage: error => error.message,
    renderModelTestOutput(target, result) { target.rendered = plain(result); },
    UiError: class extends Error {},
    dirtyIds: [],
  });
  vm.runInContext(`
    let settings = initialSettings, saving = false, selectionSaving = false, localDeleting = false;
    let providerRevision = 0, catalogRevision = 0, testRevision = 0, formRevision = 0;
    let modelCatalog, catalogEndpoint = '', models = [], localState;
    const localModels = [{ id: 'local-model-id', name: 'Local model' }];
    const dirty = new Set();
    ${actionsCode}
    globalThis.actions = { readForm, saveSettings, current: () => settings };
  `, context);
  return {
    element, calls, permissions, reveals, settings, originalSettings, localPerformance, hybridDraft,
    actions: context.actions, dirtyIds: context.dirtyIds,
    async click(id) { await element(id).listeners.get('click')(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('online discovery and test target the online draft despite a local hybrid route and invalid local draft', async () => {
  const h = harness({ backend: 'local', hybrid: true, localModelId: '', localDraftInvalid: true });
  await h.click('get-models');
  await h.click('test-model');
  assert.deepEqual(h.calls.map(call => call.type), ['models', 'test-model']);
  for (const call of h.calls) {
    assert.equal(call.settings.backend, 'online');
    assert.equal(call.settings.bilibiliHybrid.enabled, false);
    assert.equal(call.settings.endpoint, 'https://api.example.com/v1/chat/completions');
    assert.equal(call.settings.model, 'online-model');
    assert.equal(call.apiKey, 'draft-online-key');
  }
  assert.equal(h.calls[1].text, 'online sample');
  assert.equal('context' in h.calls[1], false);
  assert.equal(h.permissions.length, 2);
  assert.equal(h.localPerformance.reads, 0, 'the online actions do not validate an unrelated local draft');
  assert.equal(h.hybridDraft.reads, 0, 'the online actions do not validate hybrid capacity');
  assert.equal(h.element('models-result').textContent, 'm_d541191d70a4');
  assert.equal(h.element('test-result').textContent, 'm_20d0aaef5c92');
  assert.equal(h.element('test-result-output').rendered.sourceText, 'online sample');
  assert.equal(h.element('local-test-result').textContent, '');
  assert.equal(h.element('backend').value, 'local');
  assert.equal(h.element('model').value, 'online-model');
  assert.deepEqual(plain(h.actions.current()), h.originalSettings);
  assert.deepEqual(h.dirtyIds, []);
});

test('local test targets the chosen local model without online endpoint, key, or host permission', async () => {
  const h = harness({ backend: 'online', hybrid: true, endpoint: 'invalid online address', model: '' });
  h.element('test-result').textContent = 'online status retained';
  await h.click('test-local-model');
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.type, 'test-model');
  assert.equal(call.settings.backend, 'local');
  assert.equal(call.settings.localModelId, 'local-model-id');
  assert.equal(call.settings.endpoint, '');
  assert.equal(call.settings.endpointInput, undefined);
  assert.equal(call.settings.bilibiliHybrid.enabled, false);
  assert.equal(call.apiKey, '');
  assert.equal(call.text, 'local sample');
  assert.equal(call.context, 'video');
  assert.equal(h.permissions.length, 0);
  assert.equal(h.localPerformance.reads, 1);
  assert.equal(h.element('local-test-result').textContent, 'm_20d0aaef5c92');
  assert.equal(h.element('local-test-result-output').rendered.sourceText, 'local sample');
  assert.equal(h.element('test-result').textContent, 'online status retained');
  assert.equal(h.element('backend').value, 'online');
  assert.equal(h.element('endpoint').value, 'invalid online address');
  assert.equal(h.element('model').value, '');
  assert.equal(h.element('api-key').value, 'draft-online-key');
  assert.deepEqual(plain(h.actions.current()), h.originalSettings);
  assert.deepEqual(h.dirtyIds, []);
});

test('save still validates the full hybrid route and does not submit an incomplete draft', async () => {
  const h = harness({ backend: 'online', hybrid: true, ownedRelease: false });
  assert.equal(await h.actions.saveSettings(), false);
  assert.equal(h.element('result').textContent, 'm_6ade7baf8737HYBRID_PLAN_REQUIRED');
  assert.deepEqual(h.reveals, ['bilibili-owned-release']);
  assert.equal(h.localPerformance.reads, 1);
  assert.equal(h.hybridDraft.reads, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.permissions.length, 0);
  assert.deepEqual(plain(h.actions.current()), h.originalSettings);

  const missingLocal = harness({ backend: 'online', hybrid: true, localModelId: '' });
  assert.equal(await missingLocal.actions.saveSettings(), false);
  assert.deepEqual(missingLocal.reveals, ['local-model-manager']);
  assert.deepEqual(missingLocal.calls, []);
});
