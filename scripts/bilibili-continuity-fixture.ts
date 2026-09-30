import { REVIEWED_DANMAKU_BUILDS } from '../src/platforms/bilibili/native-builds.ts';
import { attachBilibiliNative, parseBilibiliVideoUrl, resolveBilibiliBinding } from '../src/platforms/bilibili/video.ts';
import { resourceFromUrl } from '../src/core/resource.ts';
import { VideoScheduler } from '../src/core/scheduler.ts';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { createProgress } from '../src/ui/progress.ts';
import { localizeMessage } from '../src/i18n/text.ts';
import backendMessages from '../src/i18n/backend-messages.json';

const selectedVersion = new URL(location.href).searchParams.get('native-version') ?? '1.1.24';
const nativeBuild = REVIEWED_DANMAKU_BUILDS.find(build => build.version === selectedVersion);
if (!nativeBuild) throw new Error('Fixture requires a reviewed native build');
const pauseScenario = new URL(location.href).searchParams.has('paused');
const href = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1';
const plannedSupply = { enabled: true, configIdentity: 'fixture-config', sourceLanguage: 'auto', targetLanguage: 'ja' };
const original: [string, string] = ['第一条中文弹幕', '第二条中文弹幕'];
const translated: [string, string] = ['一番目の翻訳', '二番目の翻訳'];
const rows = [1, 2].map((id, index) => ({ dmid: String(id), text: original[index]!, stime: 4.5 + index * .1,
  mode: 1, rawMode: 1, pool: 0, on: false, uhash: `author-${id}`, size: 25, color: 16777215, weight: 20 }));
if (pauseScenario) rows[0]!.stime = .5;
type Row = typeof rows[number];
type Model = { textData: Row; text: string; size: number; element: HTMLElement; firstShow: () => string };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $('fixture-shell');
const playerWrap = $('playerWrap');
const stage = $('screen-danmaku');
const checks = new Map<string, { success: boolean; detail: string }>();
const models: Model[] = [];
const messages: any[] = [];
const listeners = new Map<string, Set<() => void>>();
const requested = new Set<string>();
const baseline: { epoch: number; selected: { id: string; deadlineAtEpochMs: number }[] } = { epoch: -1, selected: [] };
let mono = 100, wall = 1000, mediaTime = 0, rate = 1;
let timeWrites = 0, rateWrites = 0, pauseCalls = 0, playCalls = 0, fetchCalls = 0, resultCount = 0;
let consumed = false;
let attachment: ReturnType<typeof attachBilibiliNative>;
let scheduler: VideoScheduler | undefined;
let progress: ReturnType<typeof createProgress> | undefined;
const pauseReplies: (() => void)[] = [];
const pauseSettings = { ...DEFAULT_SETTINGS, enabled: true, bilibiliOwnedRelease: true,
  targetLanguage: 'ja', sourceLanguage: 'auto', concurrency: 1, videoBatchSize: 2 };
const pauseClock = () => ({ mediaTimeMs: mediaTime * 1000, durationMs: 120000, playbackRate: rate,
  paused: video.paused, seeking: video.seeking, contentActive: true, commentsVisible: true });
const supplyReport = () => attachment.nativeSupply.report() as { ready: number; counts: Record<string, number>;
  state: string; pausedReason: string | null };

const video = {
  get currentTime() { return mediaTime; }, set currentTime(value: number) { timeWrites++; mediaTime = value; },
  duration: 120, get playbackRate() { return rate; }, set playbackRate(value: number) { rateWrites++; rate = value; },
  paused: pauseScenario, seeking: false, readyState: 4, ended: false, isConnected: true,
  played: { length: 1 }, buffered: { length: 0 },
  pause() { pauseCalls++; this.paused = true; },
  play() { playCalls++; this.paused = false; return Promise.resolve(); },
  addEventListener(type: string, callback: () => void) {
    const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set);
  },
  removeEventListener(type: string, callback: () => void) { listeners.get(type)?.delete(callback); },
};
const setting = { visible: true, area: 100, fontSize: 1, limit: 300, preTime: 1, noDanmakuXTypes: [] };
const manager = {
  config: { setting }, containerSize: { width: 500, height: 280 },
  container: playerWrap, dataBase: { dmArray: structuredClone(rows), timeLine: { list: rows } },
  lastTime: 0, cDmlist: [] as Model[], visualArray: [] as Model[],
  validate() { return true; },
  fetchAndInitDm(render: number) {
    fetchCalls++;
    this.lastTime = render + setting.preTime;
    this.insert(rows);
    danmaku.timeController.lastFetchDmTime = render;
    return 'fetched';
  },
  insert(entries: Row[]) {
    danmaku.hooks.beforeRender([], entries.slice());
    for (const row of entries) {
      if (!this.validate() || row.on) continue;
      row.on = true;
      this.initRender(row);
    }
  },
  initRender(source: Row) {
    const element = document.createElement('div');
    element.textContent = source.text;
    const model: Model = { textData: source, text: source.text, size: source.size, element,
      firstShow() { stage.append(element); return 'shown'; } };
    models.push(model); this.cDmlist.push(model); model.firstShow();
    return model;
  },
};
const danmaku = { manager, config: { setting }, timeController: { renderTime: 0, lastFetchDmTime: 0 },
  isRunning: true, hooks: { beforeRender(_active: Row[], _entries: Row[]) {} },
  getMetadata: () => nativeBuild,
  clear() { manager.cDmlist.length = 0; manager.visualArray.length = 0; stage.replaceChildren(); } };
const player = { getManifest: () => ({ aid: '2', cid: '62131', bvid: 'BV1xx411c7mD', p: 1 }),
  danmaku: { getDanmakuX: () => danmaku }, mediaElement: () => video };
// Only this in-memory fixture bundle uses a synthetic Bilibili href on localhost.
(globalThis as any).__DL_FIXTURE_BILIBILI_HREF__ = href;
(window as any).player = player;
const binding = resolveBilibiliBinding(player, href);
if (!binding) throw new Error('Synthetic Bilibili native binding failed');
const rules = { read: () => ({ known: true, revision: 4, fingerprint: 'fixture-rule-4',
  reason: null, nativeSettings: { visible: setting.visible },
  match: () => ({ state: 'retain', reason: 'allowed' }) }) };

function shadow(): any { return messages.filter(item => item.type === 'bilibili-shadow' && item.policy === 'owned').at(-1); }
function content(payload: Record<string, unknown>) {
  attachment.onMessage({ data: { bridge: 'danlingo.native.v1', from: 'content',
    session: attachment.session, resourceId: binding!.identity.resourceId,
    urlResourceId: binding!.identity.urlResourceId, ...payload } });
}
function check(label: string, success: boolean, detail: string) {
  checks.set(label, { success, detail });
  if (!success) throw new Error(`${label}: ${detail}`);
}
function unchanged(label: string) {
  const actual = shadow();
  const selected = actual?.items?.map((row: any) => ({ id: row.id, deadlineAtEpochMs: row.deadlineAtEpochMs }));
  check(label, actual?.known === true && actual.predictionEpoch === baseline.epoch &&
    JSON.stringify(selected) === JSON.stringify(baseline.selected),
    `epoch ${baseline.epoch} → ${actual?.predictionEpoch}; deadlines ${JSON.stringify(selected)}`);
}
function ready(index: number) {
  const row = rows[index]!, forecast = shadow();
  const selected = forecast?.items?.find((item: any) => item.sourceId === row.dmid);
  if (!selected) throw new Error(`No eligible forecast for ${row.dmid}`);
  content({ type: 'prepared', generation: 0, plannedSupply: true, items: [{
    id: selected.id, sourceId: row.dmid, originalText: row.text, text: translated[index]!,
    status: 'translated', epoch: attachment.epoch, predictionEpoch: forecast.predictionEpoch,
    ruleRevision: forecast.ruleRevision, deadlineAtEpochMs: selected.deadlineAtEpochMs,
    configIdentity: plannedSupply.configIdentity,
  }] });
  resultCount++;
  check(`${index + 1} 号译文就绪`, supplyReport().ready === index + 1,
    `ready=${supplyReport().ready}; 返回时 t=${wall}ms`);
}
function resize(width: number, height: number) {
  Object.assign(manager.containerSize, { width, height });
  playerWrap.classList.toggle('wide', width > 500);
  attachment.tick();
  if (!consumed) unchanged(`有效尺寸 ${width} × ${height} 保留计划`);
  updateView();
}
function metric(name: string, value: unknown) {
  const title = document.createElement('dt'); title.textContent = name;
  const content = document.createElement('dd'); content.textContent = String(value);
  $('metrics').append(title, content);
}
function updateView() {
  const update = shadow(), report = supplyReport();
  const owned: any = messages.findLast(item => item.type === 'snapshot')?.nativeSupply?.ownedRelease;
  $('metrics').replaceChildren();
  metric('播放时钟', `${video.currentTime.toFixed(1)} s`);
  metric('模拟墙钟', `${wall} ms`);
  metric('native 尺寸', `${manager.containerSize.width} × ${manager.containerSize.height}`);
  metric('predictionEpoch', update?.predictionEpoch ?? '—');
  metric('原截止时间', baseline.selected.map(row => `${row.deadlineAtEpochMs} ms`).join(', ') || '—');
  metric('ready 数', report.ready);
  metric('采用数', report.counts.adopted ?? 0);
  metric('模拟提交条数', requested.size);
  metric('返回数', resultCount);
  metric('native fetch 次数', fetchCalls);
  metric('已选择 / 密封桶', `${owned?.totals?.selected ?? 0} / ${owned?.sealedBuckets ?? 0}`);
  metric('供给状态', report.state + (report.pausedReason ? ` (${report.pausedReason})` : ''));
  metric('播放写入', `${pauseCalls} pause / ${playCalls} play / ${timeWrites} time / ${rateWrites} rate`);
  const body = $('rows'); body.replaceChildren();
  for (let index = 0; index < rows.length; index++) {
    const tr = document.createElement('tr');
    const row = rows[index]!;
    const displayed = models.find(model => model.textData.dmid === row.dmid);
    for (const value of [row.text, displayed?.text ?? (index < resultCount ? translated[index]! : '待返回'),
      displayed ? '已由 native initRender 采用' : index < resultCount ? '已准备' : '等待模拟返回']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    body.append(tr);
  }
  const node = $('checks'); node.replaceChildren();
  for (const [name, result] of checks) {
    const entry = document.createElement('div'); entry.className = result.success ? 'pass' : 'fail';
    entry.textContent = `${result.success ? '✓' : '×'} ${name}：${result.detail}`; node.append(entry);
  }
  for (const [id, done] of [['late-result', resultCount === 2], ['before-deadline', mediaTime >= 3.4],
    ['consume', consumed], ['repeat-consume', consumed]] as [string, boolean][])
    $(id).toggleAttribute('disabled', done && id !== 'repeat-consume');
  if (progress && scheduler) {
    progress.update(pauseSettings, scheduler.getStats(), '', true, true,
      { translated: report.counts.adopted ?? 0, original: 0 }, true);
    progress.updateNativeSupply({ visible: true, planned: true, state: video.paused ? 'paused' : 'running',
      status: () => localizeMessage(video.paused ? backendMessages.m_65d14a1760b8 : '运行中'),
      actionText: '', actionHidden: true, actionDisabled: true,
      candidates: rows.length, selected: update?.items.length ?? 0, submitted: requested.size,
      cacheHits: 0, adopted: report.counts.adopted ?? 0, skipped: 0 });
  }
}
function run(label: string, action: () => void | Promise<void>) {
  return async () => {
    try { await action(); }
    catch (error) { checks.set(label, { success: false, detail: String(error) }); }
    updateView();
  };
}

attachment = attachBilibiliNative(binding, { now: () => mono, epochNow: () => wall,
  post: payload => {
    messages.push(payload);
    if (payload.type === 'bilibili-shadow' && payload.policy === 'owned') scheduler?.updateShadow(payload as any);
  }, shadowRules: rules as any });
if (pauseScenario) {
  document.querySelector('h1')!.textContent = 'Bilibili 暂停准备';
  $('enter-fullscreen').parentElement!.hidden = true;
  $('pause-controls').hidden = false;
  scheduler = new VideoScheduler({ settings: pauseSettings, now: () => mono, nowEpochMs: () => wall,
    reset() {}, prepared: items => {
      content({ type: 'prepared', generation: 0, plannedSupply: true,
        items: items.map(item => ({ ...item, configIdentity: plannedSupply.configIdentity })) });
      resultCount += items.length;
    }, request: async (_resource, items, _signal, _priority, onResult) => {
      items.forEach(item => requested.add(item.id));
      return new Promise(resolve => pauseReplies.push(() => {
        const output = items.map(item => ({ id: item.id, status: 'translated' as const,
          text: translated[rows.findIndex(row => row.dmid === item.sourceId)]! }));
        output.forEach(onResult); resolve(output);
      }));
    } });
  scheduler.snapshot(binding.identity.resourceId, 'pause-fixture', pauseClock(), rows.map(row => ({
    id: JSON.stringify(['bilibili', binding.identity.resourceId, row.dmid]), sourceId: row.dmid,
    resourceId: binding.identity.resourceId, platform: 'bilibili', originalText: row.text,
    mediaTimeMs: row.stime * 1000, renderAtMs: (row.stime - 1) * 1000,
    translatable: true, style: { commands: [] },
  })), 0);
  playerWrap.dataset.danlingoPlayer = 'pause-fixture';
  progress = createProgress(async () => {}, () => {});
  progress.attach('pause-fixture', binding.identity.resourceId, 'bilibili');
}
content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
  bilibiliOwnedRelease: true, bilibiliShadowScheduler: false, plannedSupply });
attachment.tick();
const initial = shadow();
baseline.epoch = initial?.predictionEpoch;
baseline.selected = initial?.items?.map((row: any) => ({ id: row.id, deadlineAtEpochMs: row.deadlineAtEpochMs })) ?? [];
if (!pauseScenario) for (const row of baseline.selected) requested.add(row.id);
check('起始选择两条', initial?.known === true && baseline.selected.length === 2,
  `已选择 ${baseline.selected.length} 条；请求 ${requested.size} 条`);
if (!pauseScenario) ready(0);
else check('冷启动暂停也派发', requested.size === 2 && video.currentTime === 0, '当前窗口 2 条已进入模拟请求');

$('pause-result').onclick = run('暂停返回', async () => {
  pauseReplies.splice(0).forEach(reply => reply());
  await Promise.resolve(); await Promise.resolve();
  check('暂停中译文完成', supplyReport().ready === 2 && models.length === 0, '2 条准备完成，视频仍停在 0 秒');
});
$('pause-hold').onclick = run('长暂停', () => {
  if (resultCount !== 2) throw new Error('先返回模拟译文');
  for (let i = 0; i < 90; i++) {
    wall += 1000; mono += 1000;
    content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
      bilibiliOwnedRelease: true, plannedSupply });
    scheduler?.snapshot(binding!.identity.resourceId, 'pause-fixture', pauseClock(), undefined, 0);
    attachment.tick();
  }
  check('长暂停不重复且不向后扩展', requested.size === 2 && supplyReport().ready === 2 && mediaTime === 0,
    '90 秒后仍只提交 2 条，保留 2 条译文');
});
$('pause-resume').onclick = run('恢复采用', () => {
  video.paused = false;
  listeners.get('playing')?.forEach(callback => callback());
  attachment.tick(); scheduler?.snapshot(binding!.identity.resourceId, 'pause-fixture', pauseClock(), undefined, 0);
  manager.fetchAndInitDm(0);
  check('恢复立即采用开头译文', models.length === 1 && models[0]?.text === translated[0], translated[0]);
  check('无播放控制或重发', pauseCalls + playCalls + timeWrites + rateWrites === 0 && requested.size === 2,
    '由夹具按钮模拟用户恢复；产品播放写入 0、提交仍为 2');
});

$('enter-fullscreen').onclick = run('进入全屏', async () => {
  await shell.requestFullscreen();
  check('进入全屏', document.fullscreenElement === shell, `fullscreenElement=${document.fullscreenElement?.id}`);
});
$('exit-fullscreen').onclick = run('退出全屏', async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  check('退出全屏', !document.fullscreenElement, '全屏退出后计划持续可见');
});
document.addEventListener('fullscreenchange', () => {
  const bounds = playerWrap.getBoundingClientRect();
  try { resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height))); }
  catch (error) { checks.set('全屏尺寸连续性', { success: false, detail: String(error) }); updateView(); }
});
$('repeat-resize').onclick = run('重复 resize', () => {
  for (const [width, height] of [[1280, 720], [500, 280], [960, 540], [500, 280]] as [number, number][]) resize(width, height);
  check('重复 resize 后译文保留', supplyReport().ready === resultCount,
    `ready=${supplyReport().ready}; 模拟请求数=${requested.size}`);
});
$('late-result').onclick = run('延迟译文', () => {
  ready(1);
  unchanged('后到译文沿用原计划');
});
$('before-deadline').onclick = run('原截止前', () => {
  mono += 3400; mediaTime = 3.4; wall = 4300;
  attachment.tick();
  unchanged('原截止前不重新计时');
  check('原截止前未消费', wall < Math.min(...baseline.selected.map(row => row.deadlineAtEpochMs)) && models.length === 0,
    `墙钟 ${wall}ms < 截止 ${baseline.selected[0]!.deadlineAtEpochMs}ms`);
});
$('consume').onclick = run('原窗口消费', () => {
  if (resultCount !== 2 || mediaTime < 3.4) throw new Error('先返回第二条并推进至原截止前');
  mono += 600; mediaTime = 4; wall = 4400;
  attachment.tick(); manager.fetchAndInitDm(4); consumed = true;
  check('原窗口采用两条译文', models.length === 2 &&
    models.every((model, index) => model.text === translated[index]) &&
    supplyReport().counts.adopted === 2,
    `native initRender=${models.map(model => model.text).join(' / ')}; adopted=${supplyReport().counts.adopted}`);
  check('未修改播放状态', pauseCalls === 0 && playCalls === 0 && timeWrites === 0 && rateWrites === 0,
    `pause/play/time/rate=${pauseCalls}/${playCalls}/${timeWrites}/${rateWrites}`);
});
$('repeat-consume').onclick = run('消费后重复 resize', () => {
  if (!consumed) throw new Error('先消费两条弹幕');
  for (const row of models) row.textData.on = false;
  resize(1280, 720); manager.fetchAndInitDm(4); resize(500, 280);
  check('已消费条目不重复', models.length === 2 && supplyReport().counts.adopted === 2,
    `native 模型 ${models.length}; adopted=${supplyReport().counts.adopted}; fetch=${fetchCalls}`);
});

const aliases = [href,
  'https://www.bilibili.com/festival/jzj2023?bvid=BV1xx411c7mD&p=1',
  'https://www.bilibili.com/list/1958703906?bvid=BV1xx411c7mD&oid=2&p=1',
  'https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=2&p=1',
  'https://www.bilibili.com/list/watchlater'];
const routeLines = aliases.map(url => {
  const parsed = parseBilibiliVideoUrl(url), resource = resourceFromUrl(url);
  const bound = resolveBilibiliBinding(player, url);
  return `${new URL(url).pathname}: ${parsed?.urlResourceId ?? '不支持'} / ${resource?.resourceId ?? '无资源'} / native ${bound ? '已匹配' : '未匹配'}`;
});
$('route-checks').textContent = `原生模拟构建 ${nativeBuild.version} / ${nativeBuild.lastCompiled}\n` + routeLines.join('\n');
check('路由解析与 native 身份', aliases.slice(0, 4).every(url => !!resolveBilibiliBinding(player, url)) &&
  !parseBilibiliVideoUrl(aliases[4]!) && !resolveBilibiliBinding(player, aliases[4]!),
  'video、festival、list、watchlater 携带视频 ID 均匹配；无 ID 的 watchlater 等待');
(window as any).__DL_BILI_CONTINUITY__ = { attachment, messages, models, checks, snapshot: () => ({
  shadow: shadow(), supply: attachment.nativeSupply.report(), baseline, requests: requested.size, resultCount,
  models: models.map(model => ({ id: model.textData.dmid, text: model.text })),
  checks: Object.fromEntries(checks), size: { ...manager.containerSize }, wall, mediaTime }) };
updateView();
window.addEventListener('pagehide', () => { scheduler?.dispose(); progress?.dispose(); attachment.stop(); }, { once: true });
