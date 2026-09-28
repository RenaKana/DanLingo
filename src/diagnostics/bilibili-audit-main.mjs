import { attachPretranslationAudit } from './bilibili-pretranslation.mjs';
import { BRIDGE, resolveBilibiliBinding, readBilibiliDanmakuVisibility } from '../platforms/bilibili/video.ts';
import { auditUrl } from './bilibili-audit-cache.ts';
import { inspectNativeBranches } from './bilibili-native-branches.mjs';
import { nativeWeightContract, verifyNativeWeightContract, readWeightDependencies, decideWeightShadow,
  WEIGHT_RULE_VERSION } from './bilibili-weight-shadow.mjs';
import { experimentFilterRows, createExperimentFilterPublisher } from './bilibili-experiment-native.mjs';

const CHANNEL = 'danlingo.bilibili.audit.v1';
const RUNNER_ENVIRONMENT_FIELDS = ['playerRect', 'videoRect', 'window', 'mode', 'native', 'playback'];

function copyEvidence(value) { return value == null ? null : structuredClone(value); }
export function runnerEnvironmentComparable(sample) {
  if (!sample || RUNNER_ENVIRONMENT_FIELDS.some(field => !Object.hasOwn(sample, field))) return null;
  const validRect = rect => rect && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0;
  if (!validRect(sample.playerRect) || !validRect(sample.videoRect)) return null;
  const rectSize = rect => rect ? { width: rect.width, height: rect.height } : null;
  return { playerRect: rectSize(sample.playerRect), videoRect: rectSize(sample.videoRect),
    window: sample.window, mode: sample.mode, native: sample.native,
    playback: sample.playback ? { seeking: sample.playback.seeking, playbackRate: sample.playback.playbackRate,
      paused: sample.playback.paused, visibility: sample.playback.visibility } : null };
}
export function runnerEnvironmentSignature(sample) {
  const comparable = runnerEnvironmentComparable(sample);
  return comparable ? JSON.stringify(comparable) : null;
}

/** Compare measured-playback environment samples; scrolling is recorded but does not invalidate comparability. */
export function updateRunnerEnvironmentEvidence(previous, sample, at = Date.now()) {
  const state = previous ?? { status: 'unknown', signature: null, baseline: null, last: null, changes: [], changesDropped: 0 };
  const comparable = runnerEnvironmentComparable(sample);
  if (!comparable)
    return { ...state, status: 'unknown', unknownObserved: true };
  if (!state.baseline) return { ...state, status: state.unknownObserved ? 'unknown' : 'stable', signature: runnerEnvironmentSignature(sample),
    baseline: copyEvidence(sample), last: copyEvidence(sample) };

  const changes = [...state.changes];
  const beforeComparable = runnerEnvironmentComparable(state.last);
  for (const field of RUNNER_ENVIRONMENT_FIELDS) {
    const before = beforeComparable?.[field] ?? null, after = comparable[field] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ at, field, severity: 'hard', changed: true, from: copyEvidence(before), to: copyEvidence(after) });
  }
  for (const [field, project] of [['playerPosition', 'playerRect'], ['videoPosition', 'videoRect']]) {
    const before = state.last?.[project] ? { left: state.last[project].left, top: state.last[project].top } : null;
    const after = sample[project] ? { left: sample[project].left, top: sample[project].top } : null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ at, field, severity: 'context', changed: false, from: copyEvidence(before), to: copyEvidence(after) });
  }
  for (const field of ['scroll']) {
    const before = state.last?.[field] ?? null, after = sample[field] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ at, field, severity: 'context', changed: false, from: copyEvidence(before), to: copyEvidence(after) });
  }
  const dropped = Math.max(0, changes.length - 64);
  if (dropped) changes.splice(0, dropped);
  const hardChange = state.status === 'changed' || changes.some(change => change.severity === 'hard');
  return { ...state, status: hardChange ? 'changed' : state.unknownObserved ? 'unknown' : 'stable', last: copyEvidence(sample), changes,
    changesDropped: (state.changesDropped ?? 0) + dropped };
}

export function runnerEnvironmentSummary(state) {
  return { status: state?.status ?? 'unknown', signature: state?.signature ?? null,
    comparable: runnerEnvironmentComparable(state?.last), changes: state?.changes ?? [],
    ...(state?.changesDropped ? { changesDropped: state.changesDropped } : {}) };
}

/** Convert only dependency identities to opaque session IDs; never export native objects. */
export function weightShadowTracker(current, root, contract, initialDependencies) {
  const identities = new WeakMap();
  let nextIdentity = 0, boundary = null;
  const scalar = value => {
    if (value === undefined) return 'undefined';
    if (value === null || !['object', 'function'].includes(typeof value)) return value;
    if (!identities.has(value)) identities.set(value, `ref:${++nextIdentity}`);
    return identities.get(value);
  };
  const serialize = deps => ({ valid: deps.valid, reason: deps.reason, area: deps.area, domArea: deps.domArea,
    dependencyFingerprint: deps.dependencyFingerprint?.map(scalar) ?? null,
    boundaryFingerprint: deps.boundaryFingerprint?.map(scalar) ?? null });
  const baseline = serialize(initialDependencies);
  return {
    readContext() {
      const raw = readWeightDependencies(current, root);
      const next = serialize(raw);
      const currentBoundary = next.boundaryFingerprint;
      // The first read happens after the observer installs its own wrappers.
      boundary ??= currentBoundary;
      const fingerprint = JSON.stringify([contract.sha256, next.valid, next.reason, next.dependencyFingerprint, currentBoundary]);
      return { fingerprint, ruleVersion: WEIGHT_RULE_VERSION, contract, baseline, current: next,
        boundaryBaseline: boundary?.slice() ?? null };
    },
    predict: decideWeightShadow,
  };
}
// Only own data descriptors: do not evaluate arbitrary native getters.
export function modelElements(model, depth = 2, seen = new Set(), path = '') {
  if (!model || typeof model !== 'object' || seen.has(model)) return [];
  seen.add(model);
  if (typeof Element !== 'undefined' && model instanceof Element) return [{ element: model, path }];
  if (depth < 0 || Array.isArray(model)) return [];
  return Object.entries(Object.getOwnPropertyDescriptors(model)).flatMap(([key, descriptor]) =>
    'value' in descriptor && key !== 'textData' ? modelElements(descriptor.value, depth - 1, seen, path ? `${path}.${key}` : key) : []);
}

/** Class alone or DOM attachment alone is insufficient. Require rendered geometry and unoccluded pixels. */
export function visibleGeometry(element, root) {
  if (document.visibilityState !== 'visible' || !element.isConnected || !root?.isConnected ||
      !element.matches('.bili-danmaku-x-dm.bili-danmaku-x-show') || !root.contains(element)) return null;
  let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0 || style.contentVisibility === 'hidden') return null;
    if (parent !== element && (parent === root || /(hidden|clip|scroll|auto)/.test(style.overflow + style.overflowX + style.overflowY))) {
      const box = parent.getBoundingClientRect();
      clip = { left: Math.max(clip.left, box.left), top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
    }
  }
  const box = { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top), right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) };
  if (box.right - box.left < 2 || box.bottom - box.top < 2) return null;
  // Danmaku often has pointer-events:none. elementsFromPoint cannot prove its absence;
  // record occlusion separately, never relabel a failed hit-test as native rejection.
  const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
  const top = document.elementFromPoint(x, y);
  if (!top || !(root.contains(top) || top.contains(element))) return null;
  return { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top };
}

export function startAuditMain(diagnosticBuildId = 'unbuilt') {
  if (!auditUrl(location.href)) return;
  let capture = null, raf = 0, lastFrame = 0, token = '', sequence = 0, starting = false, startRevision = 0;
  let experimentFilter = null;
  const send = data => window.postMessage({ channel: CHANNEL, from: 'main', token, ...data, buildId: diagnosticBuildId }, location.origin);
  const binding = () => resolveBilibiliBinding(window.player, location.href);
  function rectEvidence(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
    return { left: Math.round(rect.left * 10) / 10, top: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
  }
  function runnerEnvironmentSample(current, currentCapture) {
    const root = currentCapture.root, video = current.video;
    const context = currentCapture.shadowTracker?.readContext();
    if (!root?.isConnected || !root.contains(video)) return null;
    const playerRect = rectEvidence(root), videoRect = rectEvidence(video);
    if (!playerRect || !videoRect) return null;
    return {
      playerRect, videoRect,
      window: { innerWidth, innerHeight, outerWidth, outerHeight,
        devicePixelRatio: Math.round(devicePixelRatio * 100) / 100 },
      mode: { fullscreen: document.fullscreenElement === root || root.contains(document.fullscreenElement),
        playerClasses: [...root.classList].filter(name => /fullscreen|wide|theater|theatre|mode/i.test(name)).sort(),
        danmakuVisible: readBilibiliDanmakuVisibility(video) },
      native: { contractVerified: currentCapture.shadowContract?.verified === true,
        contractSha256: currentCapture.shadowContract?.sha256 ?? null, valid: context?.current?.valid ?? false,
        area: context?.current?.area ?? null, domArea: context?.current?.domArea ?? null,
        dependencies: context?.current?.dependencyFingerprint ?? null,
        boundary: context?.current?.boundaryBaseline ?? null },
      playback: { seeking: video.seeking, playbackRate: video.playbackRate, paused: video.paused,
        visibility: document.visibilityState },
      scroll: { x: Math.round(scrollX * 10) / 10, y: Math.round(scrollY * 10) / 10 },
    };
  }
  function recordRunnerEnvironment(current, currentCapture, point) {
    try {
      currentCapture.environmentState = updateRunnerEnvironmentEvidence(currentCapture.environmentState,
        runnerEnvironmentSample(current, currentCapture), point.monotonicMs);
    } catch { currentCapture.environmentState = { ...currentCapture.environmentState, status: 'unknown', unknownObserved: true }; }
    currentCapture.runnerEvidence = { environment: runnerEnvironmentSummary(currentCapture.environmentState),
      buildId: diagnosticBuildId, startedAt: currentCapture.startedAt };
    send({ type: 'runner-evidence', runnerEvidence: currentCapture.runnerEvidence });
  }
  function waitForPosition(video, seconds) {
    return new Promise((resolve, reject) => {
      let finished = false, timer;
      const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', verify); video.removeEventListener('error', failed); };
      const done = error => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(); };
      const verify = () => {
        if (video.seeking) return;
        if (!video.paused || !Number.isFinite(video.currentTime) || Math.abs(video.currentTime - seconds) > 0.25)
          done(new Error('定位后播放器状态不匹配'));
        else done();
      };
      const failed = () => done(new Error('播放器定位失败'));
      timer = setTimeout(() => done(new Error('等待播放器定位超时')), 5000);
      video.addEventListener('seeked', verify);
      video.addEventListener('error', failed, { once: true });
      video.pause();
      if (Math.abs(video.currentTime - seconds) <= 0.025 && !video.seeking) queueMicrotask(verify);
      else video.currentTime = seconds;
    });
  }
  async function playAndWait(currentCapture, requestId) {
    const current = binding();
    if (!currentCapture || currentCapture.ended || !current || current.manager !== currentCapture.binding.manager)
      throw new Error('观测尚未开始');
    const video = current.video, before = video.currentTime;
    await video.play();
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      if (currentCapture.ended) throw new Error('观测在播放推进前结束');
      if (!video.paused && !video.seeking && video.playbackRate === 1 && video.currentTime > before + 0.05) {
        send({ type: 'played', requestId, value: { fromSeconds: before, toSeconds: video.currentTime,
          paused: video.paused, seeking: video.seeking, playbackRate: video.playbackRate } });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('视频未能实际推进');
  }
  function describe(current) {
    const models = current.manager.visualArray;
    return { identity: current.identity, metadata: current.danmaku.getMetadata(), time: current.video.currentTime,
      paused: current.video.paused, seeking: current.video.seeking, rate: current.video.playbackRate,
      scroll: { x: Math.round(scrollX * 10) / 10, y: Math.round(scrollY * 10) / 10 },
      display: readBilibiliDanmakuVisibility(current.video),
      adapterSession: current.video.closest('#playerWrap')?.getAttribute('data-danlingo-player') ?? document.querySelector('#playerWrap')?.getAttribute('data-danlingo-player'),
      modelCount: models.length,
      modelShape: models.slice(0, 2).map(model => ({ keys: Object.keys(model), elements: modelElements(model).map(({ element, path }) => ({ path, tag: element.tagName, className: element.className })) })),
      playerScripts: [...document.scripts].map(script => script.src).filter(src => /\/player\/main\/core\./.test(src)),
    };
  }
  function finish(reason, requestId) {
    if (!capture || capture.ended) return;
    stopFilter();
    cancelAnimationFrame(raf);
    capture.ended = { ...capture.clock(), reason };
    capture.restoration = capture.probe.stop(reason);
    send({ type: 'stopped', requestId, ended: capture.ended, restoration: capture.restoration });
  }
  function stopFilter() {
    if (!experimentFilter) return;
    clearInterval(experimentFilter.timer);
    experimentFilter.publisher.stop();
    experimentFilter = null;
  }
  function filterTick() {
    const run = experimentFilter;
    if (!run) return;
    const current = binding();
    if (!capture || capture.ended || !current || current.manager !== capture.binding.manager ||
        current.identity.resourceId !== run.scope.resourceId || current.video.seeking ||
        current.video.playbackRate !== 1 || readBilibiliDanmakuVisibility(current.video) !== true ||
        document.visibilityState !== 'visible') { stopFilter(); return; }
    try { run.publisher.publish(experimentFilterRows(current, capture.shadowTracker, run.filterEnabled)); }
    catch { stopFilter(); finish('experiment-filter-error'); }
  }
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || event.origin !== location.origin || !auditUrl(location.href) ||
        d?.bridge !== BRIDGE || d.from !== 'content' || d.type !== 'bilibili-experiment-control') return;
    if (d.payload?.enabled !== true) {
      if (experimentFilter?.runId === d.payload?.runId) stopFilter();
      return;
    }
    const current = binding();
    if (!capture || capture.ended || !capture.experiment || !capture.shadowTracker || !current ||
        current.manager !== capture.binding.manager || d.resourceId !== current.identity.resourceId ||
        d.urlResourceId !== current.identity.urlResourceId ||
        describe(current).adapterSession !== d.session || !Number.isSafeInteger(d.epoch) ||
        !Number.isSafeInteger(d.sourceGeneration) || typeof d.payload.runId !== 'string') return;
    if (experimentFilter?.runId === d.payload.runId) return;
    stopFilter();
    const scope = { session: d.session, epoch: d.epoch, resourceId: d.resourceId,
      urlResourceId: d.urlResourceId, sourceGeneration: d.sourceGeneration };
    const publisher = createExperimentFilterPublisher(update => window.postMessage({
      bridge: BRIDGE, from: 'native', platform: 'bilibili', type: 'bilibili-experiment-filter',
      ...scope, runId: d.payload.runId, ...update,
    }, location.origin));
    experimentFilter = { scope, publisher, runId: d.payload.runId,
      filterEnabled: d.payload.filterEnabled === true, timer: setInterval(filterTick, 500) };
    filterTick();
  });
  function frame(timestamp) {
    try { sampleFrame(timestamp); }
    catch (error) { finish('visibility-observer-error'); send({ type: 'error', error: String(error.message).slice(0, 180) }); }
  }
  function sampleFrame(timestamp) {
    if (!capture || capture.ended) return;
    raf = requestAnimationFrame(frame);
    if (timestamp - lastFrame < 100) return;
    lastFrame = timestamp;
    const current = binding(), c = capture;
    if (!current || current.manager !== c.binding.manager || current.identity.cid !== c.binding.identity.cid) { finish('binding-changed'); return; }
    const point = c.clock(), video = current.video;
    if (!video.paused && !c.playingStart) {
      c.playingStart = point; c.startedAt = new Date().toISOString();
    }
    const intervalComplete = c.playingStart && ((c.experiment ? point.videoTimeMs >= c.experiment.toMs :
      point.videoTimeMs - c.playingStart.videoTimeMs >= 35000) || video.ended);
    if (intervalComplete) { finish('interval-complete'); return; }
    if (c.playingStart) recordRunnerEnvironment(current, c, point);
    if (video.seeking || video.playbackRate !== 1 || readBilibiliDanmakuVisibility(video) !== true || document.visibilityState !== 'visible') { finish('playback-conditions-changed'); return; }
    if (c.playingStart && video.paused && !video.ended) { finish('paused'); return; }
    let visible = 0, mapped = 0;
    const mappedElements = new Set();
    for (const model of current.manager.visualArray) {
      const source = model?.textData;
      const dmid = typeof source?.dmid === 'string' ? source.dmid : source?.id_str;
      if (typeof dmid !== 'string' || !/^\d+$/.test(dmid)) continue;
      for (const { element, path } of modelElements(model)) {
        if (mappedElements.has(element)) continue;
        const geometry = visibleGeometry(element, c.root);
        if (!geometry) continue;
        mappedElements.add(element); mapped++;
        let id = c.models.get(model);
        if (!id) { id = ++sequence; c.models.set(model, id); }
        const key = `${id}:${dmid}`;
        if (!c.seen.has(key)) {
          c.seen.add(key);
          const event = { eventId: key, dmid, text: element.textContent, modelElementPath: path, ...point, geometry,
            presentAtStart: !c.playingStart, firstVisibleIsSampledUpperBound: true };
          c.visibleEvents.push(event); c.probe.observeVisible(dmid, event);
        }
      }
    }
    for (const element of c.root.querySelectorAll('.bili-danmaku-x-dm.bili-danmaku-x-show')) if (visibleGeometry(element, c.root)) visible++;
    c.frames++;
    c.unmappedVisiblePeak = Math.max(c.unmappedVisiblePeak, visible - mapped);
    if (c.frames % 10 === 0) {
      c.checkpoints.push({ ...point, visible, mapped, counts: c.probe.counts });
      send({ type: 'progress', ...point, visible, mapped, visibleEvents: c.visibleEvents.length, counts: c.probe.counts });
    }
    if (point.monotonicMs - c.started.monotonicMs > 120000) finish('wall-time-limit');
  }
  window.addEventListener('message', async event => {
    const d = event.data;
    if (event.source !== window || event.origin !== location.origin || !auditUrl(location.href) ||
        d?.channel !== CHANNEL || d.from !== 'content' || typeof d.token !== 'string') return;
    let ownsStart = false;
    try {
      if (d.type === 'inspect') { token = d.token; const current = binding(); send({ type: 'inspection', requestId: d.requestId, value: current ? describe(current) : null }); }
      if (d.token !== token) return;
      if (d.type === 'experiment-estimate') {
        const current = binding();
        if (!current || !current.video.paused || (capture && !capture.ended)) throw new Error('请先定位并暂停');
        const root = current.video.closest('.bpx-player-container');
        const dependencies = readWeightDependencies(current, root);
        const contract = await verifyNativeWeightContract(nativeWeightContract(current));
        const latest = binding();
        if (!latest || latest.manager !== current.manager || !current.video.paused) throw new Error('估算期间播放器改变');
        const tracker = weightShadowTracker(current, root, contract, dependencies);
        const result = experimentFilterRows(current, tracker, true);
        const context = tracker.readContext();
        send({ type: 'experiment-estimate', requestId: d.requestId, rows: result.rows, fingerprint: result.fingerprint,
          nativeContract: { verified: contract.verified === true, sha256: contract.sha256 ?? null, reason: contract.reason ?? null },
          nativeConfiguration: { valid: context.current.valid, area: context.current.area, domArea: context.current.domArea,
            reason: context.current.reason ?? null },
          playback: { timeSeconds: current.video.currentTime, paused: current.video.paused, seeking: current.video.seeking,
            playbackRate: current.video.playbackRate, display: readBilibiliDanmakuVisibility(current.video) } });
      }
      if (d.type === 'experiment-position') {
        if (capture && !capture.ended) throw new Error('请先停止本次观测');
        const current = binding();
        if (!current || !Number.isFinite(d.seconds) || d.seconds < 0 || d.seconds >= current.video.duration)
          throw new Error('片段起点无效');
        if (Number.isFinite(d.playbackRate) && d.playbackRate >= 0.1 && d.playbackRate <= 4)
          current.video.playbackRate = d.playbackRate;
        await waitForPosition(current.video, d.seconds);
        const latest = binding();
        if (!latest || latest.manager !== current.manager || latest.identity.resourceId !== current.identity.resourceId)
          throw new Error('定位期间播放器改变');
        send({ type: 'positioned', requestId: d.requestId, seconds: current.video.currentTime,
          paused: current.video.paused, seeking: current.video.seeking, playbackRate: current.video.playbackRate,
          display: readBilibiliDanmakuVisibility(current.video), resourceId: current.identity.resourceId });
      }
      if (d.type === 'inspect-branches') {
        if (capture && !capture.ended) throw new Error('请先停止观测，再导出分支信息');
        const current = binding();
        if (!current) throw new Error('播放器尚未适配');
        send({ type: 'branch-inspection', requestId: d.requestId, value: { ...describe(current), branches: inspectNativeBranches(current) } });
      }
      if (d.type === 'runner-environment') {
        if (capture && !capture.ended) throw new Error('当前观测期间不能准备环境快照');
        const current = binding();
        if (!current || !current.video.paused || current.video.seeking)
          throw new Error('runner环境快照需要暂停且未定位中的播放器');
        const root = current.video.closest('.bpx-player-container');
        if (!root?.isConnected || !root.contains(current.video)) throw new Error('播放器几何信息不可用');
        const dependencies = readWeightDependencies(current, root);
        const contract = await verifyNativeWeightContract(nativeWeightContract(current));
        const latest = binding();
        if (!latest || latest.manager !== current.manager || latest.identity.resourceId !== current.identity.resourceId ||
            !current.video.paused || current.video.seeking)
          throw new Error('读取环境证据期间播放器改变');
        const tracker = weightShadowTracker(current, root, contract, dependencies);
        const sample = runnerEnvironmentSample(current, { root, shadowContract: contract, shadowTracker: tracker });
        const context = tracker.readContext();
        send({ type: 'runner-environment', requestId: d.requestId, resourceId: current.identity.resourceId,
          sample, signature: runnerEnvironmentSignature(sample), comparable: runnerEnvironmentComparable(sample),
          nativeContract: { verified: contract.verified === true, sha256: contract.sha256 ?? null, reason: contract.reason ?? null },
          nativeConfiguration: { valid: context.current.valid, area: context.current.area,
            domArea: context.current.domArea, reason: context.current.reason ?? null },
          playback: { timeSeconds: current.video.currentTime, paused: current.video.paused, seeking: current.video.seeking,
            playbackRate: current.video.playbackRate, display: readBilibiliDanmakuVisibility(current.video) } });
      }
      if (d.type === 'start') {
        if (starting || (capture && !capture.ended)) return;
        starting = true; ownsStart = true;
        const revision = ++startRevision;
        const current = binding();
        if (!current || current.video.playbackRate !== 1 || !current.video.paused || readBilibiliDanmakuVisibility(current.video) !== true)
          throw new Error('请先暂停视频，保持 1 倍速并开启原生弹幕');
        const root = current.video.closest('.bpx-player-container');
        let shadow = null, shadowContract = null;
        if (d.shadow === true || d.experiment) {
          const dependencies = readWeightDependencies(current, root);
          const nativeContract = nativeWeightContract(current);
          shadowContract = await verifyNativeWeightContract(nativeContract);
          if (revision !== startRevision) return;
          const latest = binding();
          if (!latest || latest.manager !== current.manager || latest.identity.cid !== current.identity.cid ||
              !current.video.paused || current.video.playbackRate !== 1) throw new Error('准备影子验证时播放状态已改变');
          shadow = weightShadowTracker(current, root, shadowContract, dependencies);
        }
        if (d.experiment && (!Number.isSafeInteger(d.experiment.fromMs) ||
            Math.abs(d.experiment.fromMs - current.video.currentTime * 1000) > 1000 ||
            !Number.isSafeInteger(d.experiment.toMs) ||
            d.experiment.toMs <= current.video.currentTime * 1000 ||
            d.experiment.toMs > current.video.currentTime * 1000 + 35000))
          throw new Error('本地实验区间必须在当前播放点后的35秒内');
        if (d.requestId && d.experiment && (d.experiment.fromMs !== 52000 || d.experiment.toMs !== 67000 ||
            Math.abs(current.video.currentTime - 52) > 0.25 || current.video.seeking))
          throw new Error('runner实验必须从暂停的52秒开始并覆盖52–67秒');
        const rows = [];
        const clock = () => ({ monotonicMs: performance.now(), videoTimeMs: current.video.currentTime * 1000, playbackRate: current.video.playbackRate, paused: current.video.paused });
        const probe = attachPretranslationAudit(window.player, location.href, { href: () => location.href,
          shadow, onCandidates: row => rows.push(row),
          onRuleConflict: () => finish('rule-conflict') });
        capture = { probe, binding: current, root, clock, shadowContract, shadowTracker: shadow,
          experiment: d.experiment ? { fromMs: d.experiment.fromMs, toMs: d.experiment.toMs } : null,
          started: clock(), playingStart: null, ended: null, inspection: describe(current), candidates: rows,
          visibleEvents: [], checkpoints: [], seen: new Set(), models: new WeakMap(), frames: 0, unmappedVisiblePeak: 0,
          environmentState: null, runnerEvidence: { environment: runnerEnvironmentSummary(null), buildId: diagnosticBuildId, startedAt: null },
          startedAt: null };
        raf = requestAnimationFrame(frame);
        const shadowContext = shadow?.readContext();
        send({ type: 'started', requestId: d.requestId, started: capture.started, identity: current.identity, shadow: !!shadow,
          shadowStatus: shadowContext ? { contractVerified: shadowContract.verified,
            area: shadowContext.current.area, domArea: shadowContext.current.domArea,
            reason: shadowContract.reason ?? shadowContext.current.reason } : null });
      }
      if (d.type === 'play') await playAndWait(capture, d.requestId);
      if (d.type === 'stop') {
        startRevision++;
        const reason = d.reason === 'dispatch-assertion-failed' || d.reason === 'background-stopped'
          ? d.reason : 'manual';
        if (!capture || capture.ended) send({ type: 'stopped', requestId: d.requestId, ended: capture?.ended ?? { reason: 'already-stopped' } });
        else finish(reason, d.requestId);
      }
      if (d.type === 'restore') {
        const current = binding();
        if (!current || typeof d.resourceId === 'string' && d.resourceId !== current.identity.resourceId)
          throw new Error('播放器尚未适配或资源已改变');
        const video = current.video;
        const timeSeconds = Number.isFinite(d.timeSeconds) ? d.timeSeconds : 52;
        const playbackRate = Number.isFinite(d.playbackRate) ? d.playbackRate : 1;
        const paused = d.paused !== false;
        if (timeSeconds < 0 || timeSeconds >= video.duration || playbackRate < 0.1 || playbackRate > 4)
          throw new Error('播放器恢复目标无效');
        if (!video.paused) video.pause();
        if (video.playbackRate !== 1) video.playbackRate = 1;
        await waitForPosition(video, timeSeconds);
        if (video.playbackRate !== playbackRate) video.playbackRate = playbackRate;
        if (!paused) await video.play();
        const x = Number.isFinite(d.scrollX) ? d.scrollX : scrollX;
        const y = Number.isFinite(d.scrollY) ? d.scrollY : scrollY;
        if (Math.abs(scrollX - x) > 0.5 || Math.abs(scrollY - y) > 0.5) window.scrollTo(x, y);
        send({ type: 'restored', requestId: d.requestId, value: { timeSeconds: video.currentTime,
          targetTimeSeconds: timeSeconds, paused: video.paused, seeking: video.seeking, playbackRate: video.playbackRate,
          scroll: { x: scrollX, y: scrollY } } });
      }
      if (d.type === 'drain' && capture) {
        const rows = capture.candidates.splice(0, 200);
        send({ type: 'candidates', rows, remaining: capture.candidates.length });
      }
      if (d.type === 'export' && capture?.ended) {
        send({ type: 'export', requestId: d.requestId, data: { ...capture.probe.snapshot(), schema: 2,
          evidence: 'REAL_NATIVE_CALLS_AND_SAMPLED_DOM_VISIBILITY',
          inspection: capture.inspection, started: capture.started, playingStart: capture.playingStart, ended: capture.ended,
          restoration: capture.restoration, visibleEvents: capture.visibleEvents, checkpoints: capture.checkpoints,
          runnerEvidence: capture.runnerEvidence,
          shadowContract: capture.shadowContract,
          experiment: capture.experiment, performanceTimeOrigin: performance.timeOrigin,
          visibleSamplingMs: 100, frames: capture.frames, unmappedVisiblePeak: capture.unmappedVisiblePeak,
          visibleLimit: 'DOM show class + computed styles + viewport/ancestor clipping + player hit test; sampled upper bound, screenshot review required; overlapping comments are not pixel-segmented',
        } });
      }
    } catch (error) { finish('diagnostic-error'); send({ type: 'error', requestId: d.requestId, error: String(error.message).slice(0, 180) }); }
    finally { if (ownsStart) starting = false; }
  });
  window.addEventListener('pagehide', () => { startRevision++; finish('pagehide'); }, { once: true });
}
