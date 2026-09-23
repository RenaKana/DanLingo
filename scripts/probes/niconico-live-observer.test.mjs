// Isolated observer fixture only; no browser, network, Provider or production response injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installObserver, attachNativeObserver, installEarlyNativeObserver, inspectNativeRestoration, auditNativeSlotLifecycles } from '../niconico-live-observer.mjs';

function fixture() {
  const context = vm.createContext({ console });
  vm.runInContext(`
    class Target { addEventListener() {} removeEventListener() {} dispatchEvent(event) { return event.expected; } }
    class Canvas { measureText(text) { return { width: text.length }; } }
    const originalDispatch = Target.prototype.dispatchEvent, originalMeasure = Canvas.prototype.measureText;
    globalThis.EventTarget = Target; globalThis.CanvasRenderingContext2D = Canvas;
    globalThis.window = new Target(); globalThis.location = { pathname: '/watch/lv123' };
    globalThis.performance = { timeOrigin: 100000, now: () => 10 };
    let visible = false;
    const filterNames = ['site-style'];
    const processor = { makeStagingSlot(slot, chat, settings) { return { width: settings.content.length }; } };
    const originalMake = processor.makeStagingSlot;
    const native = { addToRender() {}, renderer: { layerProcessorList: [{ processor, getStagingFilterNameList: () => [...filterNames] }] } };
    const element = { __reactFiber$fixture: { stateNode: native } };
    globalThis.document = { querySelectorAll: () => visible ? [element] : [] };
    const install = ${installObserver.toString()}, attach = ${attachNativeObserver.toString()}, early = ${installEarlyNativeObserver.toString()}, inspect = ${inspectNativeRestoration.toString()};
    install();
  `, context);
  return { run: code => vm.runInContext(code, context) };
}

test('early infrastructure is reused without wrapping production again and native baseline remains restorable', () => {
  const h = fixture();
  assert.equal(h.run('attach({ infrastructureOnly: true }).enabledControlsAtInstall'), 0);
  assert.equal(h.run('window.__DL_NICO_EXTENSION_EVIDENCE__.native'), undefined);
  h.run(`
    const wire = EventTarget.prototype.dispatchEvent;
    const productionDispatch = function(event) { return Reflect.apply(wire, this, [event]); };
    EventTarget.prototype.dispatchEvent = productionDispatch; visible = true;
  `);
  assert.equal(h.run('attach({ requirePristine: true }).baseline.beforeProductFilter'), true);
  assert.equal(h.run('EventTarget.prototype.dispatchEvent === productionDispatch'), true);
  assert.equal(h.run('window.__DL_NICO_EXTENSION_EVIDENCE__.originalDispatch === wire'), true);
  assert.equal(h.run('attach({ requirePristine: true }).found'), true);
  assert.equal(h.run(`new EventTarget().dispatchEvent({ type: 'onMessage', expected: 7, detail: { message: {
    meta: { id: 'actual-fixture-id', at: { seconds: 123, nanos: 1000 } },
    payload: { case: 'message', value: { data: { case: 'chat', value: { no: 1, content: 'fixture' } } } }
  } } })`), 7);
  assert.equal(h.run('window.__DL_NICO_EXTENSION_EVIDENCE__.wireRows.length'), 1);
  assert.equal(h.run(`processor.makeStagingSlot({}, { content: 'fixture', no: 1, date: 123 }, { content: 'fixture' }).width`), 7);
  assert.equal(h.run('window.__DL_NICO_EXTENSION_EVIDENCE__.stages.length'), 1);
  h.run(`EventTarget.prototype.dispatchEvent = wire; for (const restore of window.__DL_NICO_EXTENSION_EVIDENCE__.restorers) restore();`);
  assert.equal(h.run('EventTarget.prototype.dispatchEvent === originalDispatch'), true);
  assert.equal(h.run('processor.makeStagingSlot === originalMake'), true);
  assert.equal(h.run('CanvasRenderingContext2D.prototype.measureText === originalMeasure'), true);
});

test('late native filter and unverifiable early dispatcher baselines are explicitly rejected', () => {
  const h = fixture(); h.run(`visible = true; filterNames.push('danlingo-live-text-v1');`);
  assert.equal(h.run('attach({ requirePristine: true }).blocked'), true);
  assert.equal(h.run('window.__DL_NICO_EXTENSION_EVIDENCE__.native'), undefined);
  assert.equal(h.run('EventTarget.prototype.dispatchEvent === originalDispatch'), true);
  // The fixture dispatcher is JavaScript, so it must not impersonate a pristine browser builtin.
  h.run('early(attach)');
  assert.equal(h.run('window.__DL_NICO_EXTENSION_EVIDENCE__.earlyNativeObserver.status'), 'INCOMPLETE');
});

test('active restoration preserves exact site rules registered after early capture and removes only its own filter', () => {
  const h = fixture();
  h.run(`visible = true; filterNames.length = 0; attach();
    window.__DL_NICO_EXTENSION_EVIDENCE__.earlyNativeObserver = { status: 'PASS' };
    filterNames.push('transparency-effect', 'site-style', 'danlingo-live-text-v1');
    inspect({ captureBeforeDisable: true }); filterNames.pop();`);
  assert.equal(h.run('inspect().restored.filters'), true);
  assert.equal(h.run('JSON.stringify(inspect().filterRestoration.initialBaseline)'), '[[]]');
  assert.equal(h.run('JSON.stringify(inspect().filterRestoration.beforeDisable.names)'), '[["transparency-effect","site-style","danlingo-live-text-v1"]]');
  assert.equal(h.run('JSON.stringify(inspect().filterRestoration.actual)'), '[["transparency-effect","site-style"]]');
  h.run(`filterNames.pop();`); assert.equal(h.run('inspect().restored.filters'), false, 'lost site rule must fail');
  h.run(`filterNames.push('site-style', 'unexpected-site-rule');`); assert.equal(h.run('inspect().restored.filters'), false, 'extra rule must fail');
  h.run(`filterNames.pop(); filterNames.reverse();`); assert.equal(h.run('inspect().restored.filters'), false, 'reordered rules must fail');
  h.run(`filterNames.reverse(); filterNames.push('danlingo-live-text-v1');`); assert.equal(h.run('inspect().restored.filters'), false, 'remaining extension filter must fail');
  h.run(`filterNames.pop(); native.renderer.layerProcessorList = [{ ...native.renderer.layerProcessorList[0] }];`);
  assert.equal(h.run('inspect().restored.filters'), false, 'replacement layer cannot establish restoration identity');
});

test('default restoration retains the strict initial baseline and active mode requires an observed owned filter', () => {
  const h = fixture(); h.run(`visible = true; filterNames.length = 0; attach();
    filterNames.push('transparency-effect', 'danlingo-live-text-v1'); inspect({ captureBeforeDisable: true }); filterNames.pop();`);
  assert.equal(h.run('inspect().filterRestoration.mode'), 'strict-initial-baseline');
  assert.equal(h.run('inspect().restored.filters'), false, 'default mode must still reject differences from its initial baseline');
  h.run(`filterNames.length = 0;`); assert.equal(h.run('inspect().restored.filters'), true);
  h.run(`window.__DL_NICO_EXTENSION_EVIDENCE__.earlyNativeObserver = { status: 'PASS' }; inspect({ captureBeforeDisable: true });`);
  assert.equal(h.run('inspect().restored.filters'), false, 'active mode cannot pass without observing the extension filter before disable');
});

function lifecycleFixture() {
  const h = fixture();
  h.run(`
    const layer = native.renderer.layerProcessorList[0];
    const repository = layer.slotRepository = {
      stagingList: [],
      reset() { for (const slot of this.stagingList) slot.chat = null; this.stagingList.length = 0; return 'reset-result'; },
      setToStaging(slot) { this.stagingList.push(slot); return slot; },
      backToReserved(slot) { slot.chat = null; this.stagingList.splice(this.stagingList.indexOf(slot), 1); return 'reserved-result'; }
    };
    const chat = { no: 7, date: 123, date_usec: 9, content: 'original', vposMs: 2000 };
    const slotA = {}, slotB = {};
    processor.makeStagingSlot = function(slot, chat, settings, extra) {
      if (extra) throw extra;
      slot.chat = chat; slot.width = settings.content.length; return slot;
    };
    const nativeMake = processor.makeStagingSlot, nativeReset = repository.reset, nativeSet = repository.setToStaging;
    layer.clear = function() { return repository.reset(); };
    const put = (slot, source = chat) => {
      const result = processor.makeStagingSlot(slot, source, { content: 'translated', visible: true });
      return repository.setToStaging(result);
    };
    layer.refreshComments = function() { this.clear(); return put(slotA); };
    visible = true; attach(); window.__DL_NICO_EXTENSION_EVIDENCE__.phase = 'baseline';
  `);
  return { ...h, observation: () => JSON.parse(h.run(`JSON.stringify({ stages: window.__DL_NICO_EXTENSION_EVIDENCE__.stages,
    nativeLifecycle: window.__DL_NICO_EXTENSION_EVIDENCE__.nativeLifecycle })`)) };
}
const auditFixture = observation => auditNativeSlotLifecycles(observation, { phase: 'baseline', observedUntil: 100020,
  sources: [{ id: 'observed-source', receivedAt: 100000, nativeSourceIdentity: { no: 7, dateSeconds: 123, dateUsec: 9, key: '[7,123,9]' } }] });

test('clear and refresh retain two raw creations while proving the old native slot left before restaging', () => {
  const h = lifecycleFixture();
  assert.equal(h.run('put(slotA) === slotA'), true);
  assert.equal(h.run('layer.refreshComments() === slotA'), true);
  const observation = h.observation(), audit = auditFixture(observation);
  assert.equal(observation.stages.length, 2);
  assert.equal(observation.stages[0].outputSlotId, observation.stages[1].outputSlotId, 'reused slot retains its observed identity');
  assert.equal(audit.repeatedCreationCount, 1);
  assert.equal(audit.noConcurrentNativeSlots, true);
  assert.equal(audit.rows[0].repetitions[0].classification, 'observed-recreation-after-removal');
  assert.equal(audit.rows[0].repetitions[0].removal.operation, 'repository.reset');
  assert.ok(observation.nativeLifecycle.events.some(event => event.operation === 'layer.refreshComments'));
  h.run('for (const restore of window.__DL_NICO_EXTENSION_EVIDENCE__.restorers) restore()');
  assert.equal(h.run('repository.reset === nativeReset && repository.setToStaging === nativeSet && processor.makeStagingSlot === nativeMake'), true);
});

test('two simultaneously staged slots with one native source remain a native duplicate despite one protocol outcome', () => {
  const h = lifecycleFixture(); h.run('put(slotA); put(slotB)');
  const observation = h.observation(); observation.delivered = [{ sourceId: 'observed-source' }];
  const audit = auditFixture(observation);
  assert.equal(audit.evidenceComplete, true);
  assert.equal(audit.repeatedCreationCount, 1);
  assert.equal(audit.concurrentSourceCount, 1);
  assert.equal(audit.noConcurrentNativeSlots, false);
  assert.equal(audit.rows[0].repetitions[0].classification, 'observed-concurrent-native-slots');
  assert.equal(audit.rows[0].concurrentObservations[0].slots.length, 2);
});

test('a missing old-slot removal or first admission stays unverified instead of borrowing a later admission', () => {
  const h = lifecycleFixture(); h.run('put(slotA); layer.refreshComments()');
  const observation = h.observation();
  const withoutRemoval = structuredClone(observation);
  withoutRemoval.nativeLifecycle.events = withoutRemoval.nativeLifecycle.events.filter(event => event.operation !== 'repository.reset');
  assert.equal(auditFixture(withoutRemoval).noConcurrentNativeSlots, null);
  assert.equal(auditFixture(withoutRemoval).rows[0].repetitions[0].classification, 'unverified-prior-slot-exit');
  const withoutAdmission = structuredClone(observation), secondMake = observation.stages[1].sequence;
  withoutAdmission.nativeLifecycle.events = withoutAdmission.nativeLifecycle.events.filter(event => !(event.operation === 'repository.setToStaging' && event.sequence < secondMake));
  assert.equal(auditFixture(withoutAdmission).rows[0].allCreationsObservedInRepository, false);
  assert.equal(auditFixture(withoutAdmission).noConcurrentNativeSlots, null);
  assert.equal(auditFixture({ stages: observation.stages }).noConcurrentNativeSlots, null, 'old reports lack lifecycle proof');
});

test('bounded observation and original native exceptions never fabricate a complete capture or alter rendering', () => {
  const h = lifecycleFixture();
  h.run(`window.__DL_NICO_EXTENSION_EVIDENCE__.nativeLifecycle.limits.events = 2; put(slotA); put(slotB);`);
  assert.equal(h.run('repository.stagingList.length'), 2, 'limit only stops recording');
  assert.equal(h.observation().nativeLifecycle.truncated, true);
  assert.equal(auditFixture(h.observation()).noConcurrentNativeSlots, null);
  assert.equal(h.run(`(() => { const failure = new Error('native failure'); try { processor.makeStagingSlot({}, chat, {}, failure); } catch (error) { return error === failure; } })()`), true);
  const current = lifecycleFixture(); current.run('put(slotA)');
  const observation = current.observation(); observation.nativeLifecycle.currentHooks = false;
  assert.equal(auditFixture(observation).noConcurrentNativeSlots, null, 'replaced observation hooks cannot establish full coverage');
});
