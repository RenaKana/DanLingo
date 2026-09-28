// Opt-in observation. Never used by production scheduling or rendering decisions.
import { BILIBILI_ADAPTER_SELECTION_PROBE, resolveBilibiliBinding, sourceRowsFromPool, readBilibiliDanmakuVisibility } from '../platforms/bilibili/video.ts';
import { bilibiliSourceEventId } from '../core/messages.ts';
import { nativeRuleInputs } from './bilibili-native-branches.mjs';

/**
 * Run in the page MAIN world, with translation disabled independently.
 * Only observe calls the native player was already making. Never call validate,
 * insert, initRender, a model, a provider or an extension bridge ourselves.
 * Native admission/model construction is NOT proof of an actual display event.
 */
export function attachPretranslationAudit(player, href, options = {}) {
  const binding = resolveBilibiliBinding(player, href);
  if (!binding) throw new Error('Unsupported build/identity/native boundary; no hooks installed');
  const now = options.now ?? (() => performance.now());
  const maxRecords = options.maxRecords ?? 20000;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 50000) throw new Error('maxRecords must be 1..50000');
  const session = options.session ?? globalThis.crypto.randomUUID();
  const { video, manager, identity } = binding;
  const events = new Map(), admissions = [], restores = [], listeners = [], stack = [];
  let activeInit = null;
  const adapterSelection = (source, selection) => {
    observe(() => {
      const active = activeInit;
      if (!active || active.source !== source ||
          selection?.source?.dmid !== active.row.dmid ||
          selection.source.id !== bilibiliSourceEventId(identity.resourceId, active.row.dmid) ||
          selection.source.originalText !== source.text ||
          typeof selection.adapterSession !== 'string' || !Number.isSafeInteger(selection.epoch) ||
          typeof selection.selectedTranslation !== 'boolean' || !Number.isFinite(selection.selectedAtMs) ||
          (selection.selectedTranslation &&
            (selection.preparedIdentity?.id !== selection.source.id ||
             selection.preparedIdentity.originalText !== selection.source.originalText ||
             typeof selection.preparedIdentity.text !== 'string'))) return;
      const value = {
        source: selection.source, adapterSession: selection.adapterSession, epoch: selection.epoch,
        selectedTranslation: selection.selectedTranslation, choice: selection.selectedTranslation ? 'translated' : 'original',
        selectedAtMs: selection.selectedAtMs,
        preparedIdentity: selection.selectedTranslation ? selection.preparedIdentity : null,
      };
      active.point.adapterSelection = value;
      active.admission.adapterSelection = value;
    });
  };
  const candidateIds = new Set();
  const shadowSources = new Map();
  let epoch = 0, contextRevision = 0, stopped = false, truncated = false;
  let rejectedIds = 0, observationErrors = 0, lastDisplay = readBilibiliDanmakuVisibility(video);
  let timer = null, stopReason = null, nextOccurrence = 0;
  const changes = [];
  const shadow = options.shadow && typeof options.shadow.readContext === 'function' && typeof options.shadow.predict === 'function'
    ? options.shadow : null;
  const shadowContexts = [];
  let shadowContext = null, shadowTruncated = false, ruleConflictReported = false;
  const clock = () => ({ monotonicMs: now(), videoTimeMs: video.currentTime * 1000,
    playbackRate: video.playbackRate, paused: video.paused, contextRevision });
  const nativeId = item => {
    const id = typeof item?.dmid === 'string' && /^\d+$/.test(item.dmid) ? item.dmid : item?.id_str;
    if (typeof id === 'string' && /^\d+$/.test(id)) return id;
    rejectedIds++; return null; // Never round-trip a 64-bit dmid through Number.
  };
  function change(reason, newEpoch = false) {
    if (stopped) return;
    if (newEpoch) epoch++;
    contextRevision++;
    if (changes.length < 256) changes.push({ reason, epoch, ...clock() });
    else truncated = true;
  }
  function invalidatePrediction(prediction, by) {
    if (!prediction || prediction.invalidatedAt) return;
    prediction.invalidatedAt = clock();
    prediction.invalidatedBy = by;
  }
  function invalidateShadowPredictions(by, fingerprint) {
    for (const row of events.values()) for (const prediction of row.shadowPredictions ?? []) {
      if (!fingerprint || prediction.contextFingerprint === fingerprint) invalidatePrediction(prediction, by);
    }
  }
  function refreshShadowContext() {
    if (!shadow || stopped) return null;
    try {
      const next = shadow.readContext();
      if (!next || typeof next !== 'object' || Array.isArray(next) || typeof next.fingerprint !== 'string' ||
          !next.fingerprint || next.fingerprint.length > 512) throw new Error('invalid-shadow-context');
      const snapshot = structuredClone(next);
      const serialized = JSON.stringify(snapshot);
      if (serialized.length > 8192) throw new Error('oversized-shadow-context');
      if (shadowContext && snapshot.fingerprint !== shadowContext.fingerprint) {
        const previousFingerprint = shadowContext.fingerprint;
        change('native-weight-rule-dependency');
        invalidateShadowPredictions('native-weight-rule-dependency', previousFingerprint);
      }
      shadowContext = snapshot;
      const last = shadowContexts.at(-1);
      if (!last || last.fingerprint !== snapshot.fingerprint || last.contextRevision !== contextRevision) {
        if (shadowContexts.length < 256) shadowContexts.push({
          at: clock(), contextRevision, fingerprint: snapshot.fingerprint, context: snapshot,
        });
        else shadowTruncated = true;
      }
      return snapshot;
    } catch {
      observationErrors++;
      if (shadowContext) {
        const previousFingerprint = shadowContext.fingerprint;
        change('native-weight-rule-context-unavailable');
        invalidateShadowPredictions('native-weight-rule-context-unavailable', previousFingerprint);
        shadowContext = null;
      }
      return null;
    }
  }
  function comparableNativeInput(input) {
    if (!input || typeof input !== 'object') return '';
    return JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key => [key, input[key]])));
  }
  function recordShadowPrediction(row, input, context) {
    if (!shadow || !context || row.insertObserved || row.validateFirst || row.initRenderFirst) return;
    row.shadowPredictions ??= [];
    if (row.shadowPredictions.some(prediction => prediction.contextRevision === contextRevision)) return;
    if (row.shadowPredictions.length >= 8) { shadowTruncated = true; return; }
    try {
      const copiedInput = structuredClone(input);
      const copiedContext = structuredClone(context);
      const activeStateUnavailable = input?.onTruthy === null || ['accessor', 'inherited'].includes(input?.onKind);
      const active = input?.onTruthy === true && !activeStateUnavailable;
      const result = activeStateUnavailable ? { decision: 'unknown', reason: 'source-active-state-unavailable', ruleVersion: null }
        : active ? { decision: 'unknown', reason: 'source-already-active', ruleVersion: null }
          : shadow.predict(copiedInput, copiedContext);
      if (!result || typeof result !== 'object' || !['exclude', 'retain', 'unknown'].includes(result.decision))
        throw new Error('invalid-shadow-prediction');
      row.shadowPredictions.push({
        ...clock(), session, cid: identity.cid, dmid: row.dmid, epoch, contextRevision,
        nativeInput: copiedInput, contextFingerprint: context.fingerprint,
        decision: result.decision,
        reason: typeof result.reason === 'string' ? result.reason.slice(0, 160) : null,
        ruleVersion: typeof result.ruleVersion === 'string' ? result.ruleVersion.slice(0, 100) : null,
        outcomes: { validCalls: 0, passed: 0, rejected: 0, unknownReturn: 0, firstConflict: null },
      });
    } catch { observationErrors++; }
  }
  function shadowValidityAtCall(row, input, context) {
    if (!shadow) return {};
    const predictions = row.shadowPredictions ?? [];
    const index = predictions.length - 1;
    const prediction = index >= 0 ? predictions[index] : null;
    if (!prediction) return { shadowPredictionIndex: null, shadowPredictionValidAtCall: null };
    if (!prediction.invalidatedAt && comparableNativeInput(input) !== comparableNativeInput(prediction.nativeInput))
      invalidatePrediction(prediction, 'native-input-changed');
    const valid = !!context && !prediction.invalidatedAt && prediction.contextRevision === contextRevision &&
      prediction.contextFingerprint === context.fingerprint && comparableNativeInput(input) === comparableNativeInput(prediction.nativeInput);
    return { shadowPredictionIndex: index, shadowPredictionValidAtCall: valid };
  }
  function shadowValidityForVisibility(row, input, context) {
    if (!shadow) return {};
    const predictions = row.shadowPredictions ?? [];
    const index = predictions.length - 1;
    const prediction = index >= 0 ? predictions[index] : null;
    if (prediction && !prediction.invalidatedAt && input &&
        comparableNativeInput(input) !== comparableNativeInput(prediction.nativeInput))
      invalidatePrediction(prediction, 'native-input-changed');
    const valid = !!context && !!prediction && !prediction.invalidatedAt && prediction.contextRevision === contextRevision &&
      prediction.contextFingerprint === context.fingerprint && !!input &&
      comparableNativeInput(input) === comparableNativeInput(prediction.nativeInput);
    return { shadowPredictionIndex: prediction ? index : null, shadowPredictionValidAtVisible: valid };
  }
  function record(item) {
    const dmid = nativeId(item);
    if (!dmid) return null;
    const key = JSON.stringify([session, identity.cid, dmid, epoch]);
    let row = events.get(key);
    if (!row) {
      if (events.size >= maxRecords) { truncated = true; return null; }
      row = { key, session, cid: identity.cid, dmid, epoch,
        plannedVideoTimeMs: Number.isFinite(item.stime) ? item.stime * 1000 : null,
        decodedObserved: null, candidateObserved: null, pluginTranslatable: null,
        insertObserved: null, validateFirst: null, validateLast: null,
        validateCalls: 0, validatePassedCalls: 0, validateRejectedCalls: 0,
        initRenderFirst: null, initRenderLast: null, initRenderCalls: 0,
        firstVisible: null, cacheHit: null, inflightHit: null, wouldCreateNewTask: null,
        visibleUnknownReason: 'No audited render lifecycle plus screenshot correlation in this probe',
      };
      events.set(key, row);
    }
    return row;
  }
  // All observations fail independently; preserve native returns and exceptions.
  const observe = fn => { if (!stopped) try { fn(); } catch { observationErrors++; } };
  function wrap(target, name, factory) {
    const own = Object.getOwnPropertyDescriptor(target, name);
    const original = target[name];
    if (typeof original !== 'function' || (own && (!('value' in own) || !own.writable))) throw new Error(`Unwritable ${name}`);
    const wrapper = factory(original);
    Object.defineProperty(target, name, { ...(own ?? { configurable: true, writable: true }), value: wrapper });
    restores.push(() => {
      if (target[name] !== wrapper) return false; // Preserve any later wrapper.
      if (own) Object.defineProperty(target, name, own);
      else delete target[name];
      return true;
    });
  }
  function stop(reason = 'manual') {
    if (stopped) return { stopped: true, reason: stopReason };
    stopped = true; stopReason = reason;
    if (timer !== null) globalThis.clearInterval(timer);
    for (const remove of listeners.splice(0)) remove();
    const restored = restores.splice(0).reverse().map(fn => { try { return fn(); } catch { return false; } });
    if (globalThis[BILIBILI_ADAPTER_SELECTION_PROBE] === adapterSelection)
      delete globalThis[BILIBILI_ADAPTER_SELECTION_PROBE];
    shadowSources.clear();
    return { stopped, reason, restored, laterWrapperPreserved: restored.some(value => !value) };
  }
  function sample() {
    if (stopped) return;
    observe(() => {
      const current = resolveBilibiliBinding(player, options.href?.() ?? href);
      if (!current || current.manager !== manager || current.video !== video ||
          current.identity.resourceId !== identity.resourceId || current.identity.urlResourceId !== identity.urlResourceId) {
        stop('binding-or-CID-changed'); return;
      }
      const display = readBilibiliDanmakuVisibility(video);
      if (display !== lastDisplay) { lastDisplay = display; change('native-display-switch'); }
      const pool = manager.dataBase.dmArray;
      // Retain the production adapter's exact ID/type/special-mode eligibility.
      const candidates = new Map(sourceRowsFromPool(pool, identity).map(row => [row.sourceId, row]));
      const context = refreshShadowContext();
      for (const item of pool) {
        const row = record(item);
        if (!row) continue;
        row.decodedObserved ??= clock();
        const candidate = candidates.get(row.dmid);
        if (candidate) {
          if (shadow) shadowSources.set(row.key, item);
          row.candidateObserved ??= clock();
          const input = nativeRuleInputs(item);
          row.nativeInputAtCandidate ??= input;
          recordShadowPrediction(row, input, context);
          row.pluginTranslatable = candidate.translatable;
          if (options.onCandidates && !candidateIds.has(candidate.id)) {
            candidateIds.add(candidate.id);
            options.onCandidates({ ...candidate, observed: clock() });
          }
        }
      }
    });
  }
  function listen(target, event, fn) {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(event, fn);
    listeners.push(() => target.removeEventListener(event, fn));
  }
  try {
    wrap(manager, 'insert', original => function(...args) {
      if (stopped || this !== manager || !Array.isArray(args[0])) return Reflect.apply(original, this, args);
      const frame = { items: new Set(args[0]), occurrence: ++nextOccurrence, shadowValidations: new Map() };
      observe(() => { for (const item of args[0]) { const row = record(item); if (row) row.insertObserved ??= clock(); } });
      stack.push(frame);
      try { return Reflect.apply(original, this, args); } finally { stack.pop(); }
    });
    wrap(manager, 'validate', original => function(...args) {
      let input = null, context = null, shadowAtCall = {};
      const observedInput = this === manager && stack.at(-1)?.items.has(args[0]);
      observe(() => {
        if (observedInput) {
          context = refreshShadowContext();
          input = nativeRuleInputs(args[0]);
          const row = record(args[0]);
          if (row) shadowAtCall = shadowValidityAtCall(row, input, context);
        }
      });
      const callStarted = shadow && observedInput ? clock() : null;
      const result = Reflect.apply(original, this, args);
      observe(() => {
        if (this !== manager || !stack.at(-1)?.items.has(args[0])) return;
        const row = record(args[0]);
        if (!row) return;
        const point = { ...clock(), nativeReturn: typeof result === 'boolean' ? result : null,
          nativeInputBeforeCall: input,
          occurrence: stack.at(-1).occurrence,
          ...shadowAtCall,
          ...(callStarted ? { callStarted } : {}) };
        if (shadow) {
          const prediction = row.shadowPredictions?.[shadowAtCall.shadowPredictionIndex];
          stack.at(-1).shadowValidations.set(args[0], {
            occurrence: stack.at(-1).occurrence,
            nativeReturn: point.nativeReturn,
            shadowPredictionIndex: Number.isInteger(shadowAtCall.shadowPredictionIndex)
              ? shadowAtCall.shadowPredictionIndex : null,
            shadowPredictionDecision: prediction?.decision ?? null,
            shadowPredictionValidAtCall: shadowAtCall.shadowPredictionValidAtCall === true,
          });
        }
        if (shadowAtCall.shadowPredictionValidAtCall === true) {
          const prediction = row.shadowPredictions?.[shadowAtCall.shadowPredictionIndex];
          if (prediction) {
            const outcomes = prediction.outcomes ??= { validCalls: 0, passed: 0, rejected: 0, unknownReturn: 0, firstConflict: null };
            outcomes.validCalls++;
            if (result === true) outcomes.passed++;
            else if (result === false) outcomes.rejected++;
            else outcomes.unknownReturn++;
            if (prediction.decision === 'exclude' && result === true && !outcomes.firstConflict)
              outcomes.firstConflict = { callStarted, ...clock(), nativeReturn: true };
          }
        }
        row.validateFirst ??= point; row.validateLast = point; row.validateCalls++;
        if (result === true) row.validatePassedCalls++;
        if (result === false) row.validateRejectedCalls++;
        // This records the return only, not an invented blacklist/weight reason.
      });
      return result;
    });
    wrap(manager, 'initRender', original => function(...args) {
      let active = null;
      observe(() => {
        if (this !== manager || !stack.at(-1)?.items.has(args[0])) return;
        const row = record(args[0]);
        if (!row) return;
        const frame = stack.at(-1), validation = frame.shadowValidations.get(args[0]);
        const matchingValidation = validation?.occurrence === frame.occurrence ? validation : null;
        const predictionIndex = matchingValidation?.shadowPredictionIndex ?? null;
        const prediction = predictionIndex === null ? null : row.shadowPredictions?.[predictionIndex] ?? null;
        const onAtEntry = args[0]?.on === true;
        const point = { ...clock(), occurrence: frame.occurrence, onAtEntry,
          ...(shadow ? {
            shadowPredictionIndex: predictionIndex,
            shadowPredictionDecision: matchingValidation?.shadowPredictionDecision ?? null,
            shadowPredictionValidAtCall: matchingValidation?.shadowPredictionValidAtCall ?? null,
            shadowValidationNativeReturn: matchingValidation?.nativeReturn ?? null,
            shadowPredictionValidAtAdmission: matchingValidation?.nativeReturn === true &&
              matchingValidation?.shadowPredictionValidAtCall === true,
            shadowRuleConflict: onAtEntry === true && matchingValidation?.nativeReturn === true &&
              matchingValidation?.shadowPredictionValidAtCall === true && prediction?.decision === 'exclude',
          } : {}) };
        row.initRenderFirst ??= point; row.initRenderLast = point; row.initRenderCalls++;
        const admission = {
          admissionId: JSON.stringify([session, identity.cid, row.dmid, epoch, point.occurrence, row.initRenderCalls]),
          sourceKey: row.key, ...point, firstVisible: null,
        };
        if (admissions.length < maxRecords || point.shadowRuleConflict === true) admissions.push(admission);
        else truncated = true;
        active = { source: args[0], row, point, admission };
        if (point.shadowRuleConflict === true && !ruleConflictReported) {
          ruleConflictReported = true;
          try { options.onRuleConflict?.(structuredClone(admission)); } catch { observationErrors++; }
        }
      });
      // Forward immediately. Native measurement/display timing remains unproven;
      // this observer does not infer a visible event from the boundary.
      const previous = activeInit;
      activeInit = active;
      try { return Reflect.apply(original, this, args); }
      finally { activeInit = previous; }
    });
    if (Object.hasOwn(globalThis, BILIBILI_ADAPTER_SELECTION_PROBE))
      throw new Error('Adapter selection probe already active');
    Object.defineProperty(globalThis, BILIBILI_ADAPTER_SELECTION_PROBE, {
      configurable: true, value: adapterSelection,
    });
    listen(video, 'seeking', () => { change('seeking', true); sample(); });
    listen(video, 'ratechange', () => change('ratechange'));
    listen(video, 'resize', () => change('video-intrinsic-resize'));
    listen(globalThis, 'resize', () => change('viewport-resize'));
    listen(globalThis, 'pagehide', () => stop('pagehide'));
    sample();
    if (!stopped && options.timer !== false) timer = globalThis.setInterval(sample, 500);
  } catch (error) { stop('installation-failed'); throw error; }
  return {
    sample, stop,
    observeVisible(dmid, point) {
      if (stopped) return;
      const context = refreshShadowContext();
      const row = events.get(JSON.stringify([session, identity.cid, dmid, epoch]));
      if (!row) return;
      let input = null;
      if (shadow) {
        const source = shadowSources.get(row.key);
        if (source) try { input = nativeRuleInputs(source); } catch { observationErrors++; }
      }
      const validity = shadowValidityForVisibility(row, input, context);
      row.firstVisible ??= { ...point, ...validity };
      row.visibleUnknownReason = null;
      const admission = admissions.findLast(item => item.sourceKey === row.key && !item.firstVisible);
      if (admission) admission.firstVisible = { ...point, ...validity };
    },
    get counts() { return { records: events.size, admissions: admissions.length }; },
    // Call after a known settings/fullscreen action; unknown settings stay unknown.
    markContextChange: label => {
      if (!['filter-settings', 'density-settings', 'fullscreen', 'container-resize'].includes(label)) throw new Error('Use an allowed non-sensitive context label');
      change(label);
    },
    snapshot() {
      return structuredClone({ schema: 1, evidence: 'NATIVE_STAGE_OBSERVATION_NOT_VISIBLE_EVENTS', session,
        identity, metadata: binding.danmaku.getMetadata(), epoch, contextRevision, stopped, stopReason,
        truncated, rejectedIds, observationErrors, display: lastDisplay, changes,
        shadow: shadow ? { enabled: true, contexts: shadowContexts, truncated: shadowTruncated,
          predictionLimitPerSource: 8 } : null,
        modelCallsMadeByProbe: 0, modelCallsMadeByOtherCode: null,
        settingsAutomaticTracking: false, candidateSamplingIntervalMs: 500,
        metrics: { candidatePrecision: null, displayEventCoverage: null, timelyTranslationCoverage: null,
          effectiveLeadTimeMs: null, fullTranslationLatencyMs: null, newTranslationUseRate: null },
        records: [...events.values()], admissions,
      });
    },
  };
}
