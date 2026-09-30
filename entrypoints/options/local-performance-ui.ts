import { browser } from 'wxt/browser';
import { normalizeLocalConfig, resolveLocalConfig, applyLocalRecommendation } from '../../src/local/config';
import type { LocalPerformanceConfig, LocalControl, LocalReply, LocalState, LocalModelInfo } from '../../src/local/types';
import { modelTemplateCapability } from '../../src/local/reasoning';
import type { LocalBenchmarkReport } from '../../src/local/benchmark-runner';
import { getLocale, localize, localizeMessage, onLocaleChange, t, UiError } from '../../src/i18n';
import { bindLocalizedAttribute, bindLocalizedText } from '../../src/ui/localized-text';

export function mountLocalPerformanceUI(options: { container: HTMLElement; benchmarkContainer: HTMLElement; superchatContainer: HTMLElement; activity(active: boolean): void; modelId(): string; changed(): void; state(state?: LocalState): void; busyChanged(): void; translationSettings?: () => { sourceLanguage: string; targetLanguage: string } | undefined }) {
  const panel = document.createElement('div'); panel.className = 'span local-performance';
  const text = (id: string) => `<span data-i18n="${id}"></span>`;
  const option = (value: string, id: string) => `<option value="${value}" data-i18n="${id}"></option>`;
  const pick = (key: string, labelId: string, values: Array<[string, string]>) => `<label>${text(labelId)}<select id="lp-${key}">${values.map(([value, id]) => option(value, id)).join('')}</select></label>`;
  const number = (key: string, labelId: string, min: number, step = '1') => `<label>${text(labelId)}<input id="lp-${key}" type="number" min="${min}" step="${step}" required></label>`;
  const numberOrAuto = (key: string, labelId: string, min: number, step = '1') => `<label>${text(labelId)}<span class="inline-field"><select id="lp-${key}-mode">${option('auto', 'performance.option.auto')}${option('custom', 'm_4eafa9e925b3')}</select><input id="lp-${key}-value" type="number" min="${min}" step="${step}" required></span></label>`;
  const tri: Array<[string, string]> = [['auto', 'performance.option.auto'], ['off', 'm_3fd47edce45b'], ['on', 'm_8da97ddda990']];
  panel.innerHTML = `<style>.local-performance [hidden]{display:none!important}.local-performance{min-width:0}.local-performance details{margin-top:14px}.local-performance .row{margin-top:12px}.local-performance svg{width:100%;height:auto;display:block}.local-performance pre{max-height:340px}.local-performance .chart-grid{display:grid;gap:12px}.local-performance .metric-list{white-space:pre-line}.local-performance input[type=number]{width:100%}</style>
    <div class="grid">${pick('mode', 'm_d32c4dd9b63a', [['auto','m_f4a4b9422ceb'],['low-memory','m_e3316d7637d1'],['balanced','m_df544e46aa4d'],['high-performance','m_4fbe6bf6f691'],['custom','m_4eafa9e925b3']])}<div id="lp-summary" class="subtle" role="status"></div></div>
    <details id="lp-capacity" open><summary data-i18n="m_3bc5d38ef64c"></summary><div class="grid">
      ${number('parallel','m_ed2a6bba94ef',1)}${numberOrAuto('contextTokens','m_dc755ab5570f',1)}
      ${number('estimatedTokensPerRequest','m_685b49a2e0f6',1)}${pick('batchPreset','m_2acdeee0d0b9', [['compatibility','m_2b8533a76807'],['balanced','m_6a2738c6bfc7'],['throughput','m_c6c0a5fb3ab8'],['custom','m_4eafa9e925b3']])}
      ${number('batch','m_320b5d80f8cf',1)}${number('microBatch','m_d9cd6e90503a',1)}
      ${pick('flashAttention','m_9c46a3de7716',tri)}${numberOrAuto('cpuThreads','m_290505a7ff35',1)}
      <label class="check"><input id="lp-warmup" type="checkbox">${text('m_2318cc377cab')}</label><label class="check"><input id="lp-measureGpu" type="checkbox">${text('m_67683411e145')}</label><label class="check"><input id="lp-allowAutoFallback" type="checkbox">${text('m_2ab2ef60dd82')}</label>
    </div><p class="subtle" data-help="m_3bc5d38ef64c" data-i18n="m_aaac380652a7"></p></details>
    <details open><summary data-i18n="m_dc83ee271478"></summary><div class="grid">
      ${number('temperature','m_b958ce8b871a',0,'any')}${pick('superChatReasoning','m_800392eac5fb',tri)}
      ${number('normalMaxTokens','m_60306e85df5f',1)}${number('superChatMaxTokens','m_c6bdc7b4fd98',1)}${number('manualMaxTokens','m_44482da483fb',1)}
      ${pick('promptMode','m_e51da3f7bf33',[['auto','performance.option.auto'],['hy-mt','m_d7501b035b87'],['json','m_db1a21a0bc2e']])}${pick('languageValidation','m_3b0dfce307bf',[['strict','m_8460a55f2e45'],['off','m_3fd47edce45b']])}
      <label class="check"><input id="lp-reusePromptCache" type="checkbox">${text('m_9d35867032e6')}</label>
    </div><p class="subtle" data-help="m_dc83ee271478" data-i18n="m_cbf1dc20202e"></p></details>
    <details id="lb-panel"><summary data-i18n="m_da7d187f43f6"></summary><div class="grid">
      <label><span data-i18n="m_b3f23c6aecad"></span><input id="lb-parallels" value="1,2,4,8,16" required></label>
      <label><span data-i18n="m_df241b1bda02"></span><input id="lb-count" type="number" min="1" max="256" value="32" required></label>
      <label><span data-i18n="m_511fa6215eb0"></span><input id="lb-budget" type="number" min="1000" max="600000" value="60000" required></label>
      <label><span data-i18n="m_9c60e9a30271"></span><input id="lb-concurrency" type="number" min="1" max="2147483647" value="32" required></label>
      <div class="row span"><label class="check"><input id="lb-short" type="checkbox" checked>${text('m_fac695ef1b5f')}</label><label class="check"><input id="lb-normal" type="checkbox" checked>${text('m_9f1a4751fb5f')}</label><label class="check"><input id="lb-long" type="checkbox" checked>${text('m_215ebca85988')}</label></div>
    </div><div class="row"><button id="lb-start" type="button" data-i18n="m_21f42d45babb"></button><button id="lb-stop" type="button" disabled data-i18n="m_ca4d973c0b00"></button><button id="lb-export" type="button" disabled data-i18n="m_fb48367b485c"></button><button id="lb-apply" type="button" disabled data-i18n="m_8262d39027d5"></button></div>
    <p id="lb-status" class="status" role="status" aria-live="polite" data-i18n="m_62cdc8713bcf">未运行</p><div id="lb-charts" class="chart-grid"></div><div id="lb-results"></div>
    <p class="subtle" data-help="m_da7d187f43f6" data-i18n="m_9e086a57f016"></p>
    </details>`;
  options.container.append(panel);
  const benchmarkPanel = panel.querySelector<HTMLDetailsElement>('#lb-panel')!;
  benchmarkPanel.open = true; options.benchmarkContainer.classList.add('local-benchmark'); options.benchmarkContainer.append(benchmarkPanel);
  const sc = document.createElement('div'); sc.className = 'grid';
  sc.append(panel.querySelector('#lp-superChatReasoning')!.closest('label')!, panel.querySelector('#lp-superChatMaxTokens')!.closest('label')!);
  options.superchatContainer.append(sc);
  const reasoningNote = document.createElement('p'); reasoningNote.className = 'subtle'; reasoningNote.dataset.help = 'm_800392eac5fb'; sc.after(reasoningNote);
  localize(panel); localize(benchmarkPanel); localize(sc);
  // These controls belong to the benchmark action, never to settings submission.
  for (const field of benchmarkPanel.querySelectorAll<HTMLInputElement>('input')) field.setAttribute('form', 'local-benchmark-controls');
  const el = (id: string) => document.getElementById(id) as HTMLInputElement;
  let config = normalizeLocalConfig(), report: LocalBenchmarkReport | null = null;
  let pending = false, timer: ReturnType<typeof setTimeout> | undefined, polling = false, enabled = false, blocked = false, actionError: unknown = null;
  const active = () => pending || report?.status === 'running' || report?.status === 'stopping';
  const canApply = () => {
    if (active() || report?.status !== 'completed' || !report.recommendedVariant || report.modelId !== options.modelId()) return false;
    const groups = report.groups.filter(g => g.variantId === report!.recommendedVariant!.variantId);
    return groups.length > 0 && (report.options.workloads ?? ['short','normal','long']).every(w => groups.some(g => g.workload === w && g.status === 'completed' && g.completed === g.expected && g.expected >= 2 * (g.runtime?.parallel ?? g.config.parallel)));
  };
  function read(): LocalPerformanceConfig {
    const value: Record<string, unknown> = { ...config };
    for (const key of Object.keys(config)) {
      if (key === 'contextTokens' || key === 'cpuThreads') continue;
      const field = el('lp-' + key); if (!field) continue;
      value[key] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value;
    }
    value.contextTokens = el('lp-contextTokens-mode').value === 'auto' ? 'auto' : Number(el('lp-contextTokens-value').value);
    value.cpuThreads = el('lp-cpuThreads-mode').value === 'auto' ? 'auto' : Number(el('lp-cpuThreads-value').value);
    return normalizeLocalConfig(value);
  }
  function summary() {
    const custom = el('lp-mode').value === 'custom';
    if (custom) (el('lp-capacity') as unknown as HTMLDetailsElement).open = true;
    for (const root of [panel, sc, benchmarkPanel]) for (const field of root.querySelectorAll<HTMLInputElement>('input,select')) field.disabled = !enabled;
    for (const key of ['parallel','estimatedTokensPerRequest','batchPreset']) el('lp-' + key).disabled = !enabled || !custom;
    el('lp-contextTokens-mode').disabled = !enabled || !custom;
    el('lp-contextTokens-value').disabled = !enabled || !custom || el('lp-contextTokens-mode').value === 'auto';
    for (const key of ['batch','microBatch']) el('lp-' + key).disabled = !enabled || !custom || el('lp-batchPreset').value !== 'custom';
    const recommended = el('lp-mode').value === 'auto' && config.autoRecommendation?.modelId === options.modelId();
    el('lp-flashAttention').disabled = !enabled || recommended;
    el('lp-cpuThreads-mode').disabled = !enabled || recommended;
    el('lp-cpuThreads-value').disabled = !enabled || recommended || el('lp-cpuThreads-mode').value === 'auto';
    try { const value = read(), r = resolveLocalConfig(value, options.modelId()); bindLocalizedText(el('lp-summary'), () => t('m_e81b46bd36fb', { p0: r.parallel, p1: r.contextTokens, p2: r.batch, p3: r.microBatch, p4: r.flashAttention, p5: r.cpuThreads, p6: value.mode === 'auto' ? value.autoRecommendation?.modelId === options.modelId() ? t('m_6250d6b6f0bb') : t('m_edf5b4b2edbb') : '' })); }
    catch { bindLocalizedText(el('lp-summary'), () => t('m_7d500d1ec07a')); }
  }
  function fill(next?: Partial<LocalPerformanceConfig>) {
    config = normalizeLocalConfig(next);
    for (const [key,value] of Object.entries(config)) {
      if (key === 'contextTokens' || key === 'cpuThreads') continue;
      const field = el('lp-' + key); if (field) { if (field.type === 'checkbox') field.checked = value === true; else field.value = String(value); }
    }
    const contextTokens = config.contextTokens === 'auto' ? 'auto' : 'custom';
    el('lp-contextTokens-mode').value = contextTokens;
    el('lp-contextTokens-value').value = String(config.contextTokens === 'auto' ? 2048 : config.contextTokens);
    const cpuThreads = config.cpuThreads === 'auto' ? 'auto' : 'custom';
    el('lp-cpuThreads-mode').value = cpuThreads;
    el('lp-cpuThreads-value').value = String(config.cpuThreads === 'auto' ? 1 : config.cpuThreads);
    summary();
  }
  for (const root of [panel, sc]) for (const type of ['input', 'change']) root.addEventListener(type, event => { if ((event.target as HTMLElement).id.startsWith('lp-')) { options.changed(); summary(); } });
  const localizedNumber = (n: number, digits: number) => new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const fmt = (n: number | null | undefined, digits = 1) => n == null ? t('m_4d8c1c5b4283') : localizedNumber(n, digits);
  const percent = (n: number | null | undefined) => n == null ? t('m_4d8c1c5b4283') : `${localizedNumber(n * 100, 1)}%`;
  const workloadText = (workload: string): string => {
    if (workload === 'short') return t('m_fac695ef1b5f');
    if (workload === 'normal') return t('m_9f1a4751fb5f');
    if (workload === 'long') return t('m_0c6e81dbbd50');
    return localizeMessage(workload);
  };
  const groupStatusText = (status: string): string => {
    if (status === 'running') return t('m_1f0eb99b7ed0');
    if (status === 'completed') return t('m_f28461bb49c8');
    if (status === 'cancelled') return t('m_f006455e3baf');
    if (status === 'failed') return t('m_28384d7afd2e');
    if (status === 'runtime-mismatch') return t('performance.status.runtimeMismatch');
    return localizeMessage(status);
  };
  function chart(labelId: string, key: 'requestsPerSecond' | 'meanMs' | 'p95Ms') {
    const label = () => t(labelId);
    const box = document.createElement('div'), title = document.createElement('div'); title.className = 'subtle'; bindLocalizedText(title, label); box.append(title);
    box.tabIndex = 0; box.setAttribute('role', 'region'); bindLocalizedAttribute(box, 'aria-label', () => label() + t('m_0b6866ce9e6f'));
    const groups = report!.groups.filter(g => g.status === 'completed');
    const value = (g: typeof groups[number]) => key === 'requestsPerSecond' ? g.stats.requestsPerSecond : g.stats.endToEndMs[key];
    const points = groups.map(value).filter((n): n is number => n != null); if (!points.length) return box;
    const max = Math.max(...points, .001), parallels = [...new Set(groups.map(g => g.runtime?.parallel ?? g.config.parallel))].sort((a,b) => a-b);
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 580 160'); svg.setAttribute('role','img'); bindLocalizedAttribute(svg, 'aria-label', () => label() + t('m_43ac17430ec0'));
    const add = (tag: string, attrs: Record<string,string>, text?: string) => { const node = document.createElementNS(svg.namespaceURI,tag); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); if(text) node.textContent=text; svg.append(node); };
    const addText = (attrs: Record<string,string>, render: () => string) => { const node = document.createElementNS(svg.namespaceURI,'text'); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); bindLocalizedText(node, render); svg.append(node); };
    add('path',{d:'M48 12V130H558',fill:'none',stroke:'var(--border)'});
    addText({x:'0',y:'18','font-size':'11',fill:'var(--muted)'}, () => fmt(max)); addText({x:'24',y:'132','font-size':'11',fill:'var(--muted)'}, () => localizedNumber(0, 0));
    const x = (p: number) => 60 + (parallels.length === 1 ? 0 : parallels.indexOf(p) / (parallels.length - 1) * 480);
    parallels.forEach(p => addText({x:String(x(p)),y:'149','font-size':'11',fill:'var(--muted)'}, () => localizedNumber(p, 0)));
    const workloads = [['short','m_fac695ef1b5f'],['normal','m_9f1a4751fb5f'],['long','m_0c6e81dbbd50']] as const;
    workloads.forEach(([workload,labelKey],index) => { const rows = groups.filter(g => g.workload === workload && value(g) != null).sort((a,b) => (a.runtime?.parallel ?? a.config.parallel)-(b.runtime?.parallel ?? b.config.parallel)); const color = ['var(--accent)','#5c91d5','#bb873c'][index]!;
      add('polyline',{points:rows.map(g => `${x(g.runtime?.parallel ?? g.config.parallel)},${130-value(g)!/max*112}`).join(' '),fill:'none',stroke:color,'stroke-width':'2'});
      rows.forEach(g => { add('circle',{cx:String(x(g.runtime?.parallel ?? g.config.parallel)),cy:String(130-value(g)!/max*112),r:'3',fill:color}); });
      addText({x:String(160+index*110),y:'12','font-size':'11',fill:color}, () => t(labelKey));
    }); box.append(svg); return box;
  }
  function render(next: LocalBenchmarkReport | null) {
    report = next; el('lb-start').disabled = blocked || !enabled || active() || !options.modelId(); el('lb-stop').disabled = !active(); el('lb-export').disabled = !enabled || !next;
    el('lb-apply').disabled = !enabled || !canApply();
    options.activity(active()); options.busyChanged();
    if (!next) {
      if (actionError !== null) { bindLocalizedText(el('lb-status'), () => localizeMessage(actionError)); el('lb-status').className='status error'; }
      else { bindLocalizedText(el('lb-status'), () => t('m_62cdc8713bcf')); el('lb-status').className='status'; }
      el('lb-charts').replaceChildren(); el('lb-results').replaceChildren(); return;
    }
    const phaseText = () => ({loading:t('m_8f8f90778463'),preflight:t('m_9d925a170509'),warmup:t('m_2051831c1a77'),measuring:t('m_c7d9b81a063e'),restoring:t('m_5ebcdd9eaa2b'),done:t('m_c7b24e7997e9')}[next.phase]);
    bindLocalizedText(el('lb-status'), () => actionError !== null ? localizeMessage(actionError) : t('m_9a61249495ee', {
      p0: ({running:t('m_1f0eb99b7ed0'),stopping:t('m_72eea71385de'),completed:t('m_f28461bb49c8'),cancelled:t('m_f006455e3baf'),failed:t('m_28384d7afd2e')})[next.status],
      p1: phaseText(), p2: next.groups.reduce((n,g)=>n+g.completed,0),
      p3: next.error ? ' · '+localizeMessage(next.error) : '',
      p4: next.restoreError ? t('m_8cef1332b3ea')+localizeMessage(next.restoreError) : '',
      p5: next.status === 'completed' ? next.recommendedVariant ? t('m_2cdd729ae00e')+next.recommendedVariant.name : t('m_1b04a75c5a76') : '',
    }));
    el('lb-status').className = actionError !== null || next.error || next.restoreError ? 'status error' : 'status';
    const chartKeys = ['m_e5646054b94b','m_67dc2a20f68e','m_e4e5cd1ba211'] as const;
    el('lb-charts').replaceChildren(...(['requestsPerSecond','meanMs','p95Ms'] as const).map((key,i)=>chart(chartKeys[i]!,key)));
    const expanded = new Set([...el('lb-results').querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.dataset.group));
    el('lb-results').replaceChildren(...next.groups.map(g => {
      const details = document.createElement('details'); details.dataset.group=g.variantId+g.workload; details.open=expanded.has(details.dataset.group);
      const heading = document.createElement('summary'), body = document.createElement('div'); body.className='subtle metric-list'; const s = g.stats;
      bindLocalizedText(heading, () => t('m_5b6b5b20cacd', { p0: g.name, p1: workloadText(g.workload), p2: g.completed, p3: g.expected, p4: fmt(s.requestsPerSecond,3), p5: groupStatusText(g.status) }));
      bindLocalizedText(body, () => [t('m_96c3536f1f3f', { p0: fmt(s.totalDurationMs), p1: s.success, p2: s.total, p3: percent(s.successRate), p4: s.failed, p5: s.timeout, p6: percent(s.timeoutRate), p7: s.cancelled }),
        ...([[t('m_dae5e4a4bd6d'),s.endToEndMs],[t('m_117c113c3b45'),s.queueMs],['Prompt',s.promptMs],['Decode',s.decodeMs]] as const).map(([name,m])=>t('m_8acbdbbca743', { p0: name, p1: fmt(m.meanMs), p2: fmt(m.p50Ms), p3: fmt(m.p95Ms), p4: fmt(m.p99Ms), p5: fmt(m.minMs), p6: fmt(m.maxMs), p7: percent(m.coverage) })),
        t('m_06dce737d87b', { p0: fmt(s.inputTokens.total,0), p1: fmt(s.inputTokens.perSecond), p2: fmt(s.outputTokens.total,0), p3: fmt(s.outputTokens.perSecond) }),
        t('m_7b4549c17e5a', { p0: g.gpuObservation?.completeComputeMs != null ? t('m_6bdd05343c27') : t('m_42f941671bf5'), p1: fmt(g.gpuObservation?.completeComputeMs ?? g.gpuObservation?.sampledComputeMs), p2: percent(g.gpuObservation?.computePassCoverage), p3: fmt(g.gpuObservation?.allocatedBufferBytesAfter == null ? null : g.gpuObservation.allocatedBufferBytesAfter/1048576), p4: fmt(g.gpuObservation?.lifetimePeakAllocatedBufferBytes == null ? null : g.gpuObservation.lifetimePeakAllocatedBufferBytes/1048576) }),
        t('m_cab4d4b19827', { p0: g.nativeAfter?.nativePeakActive ?? t('m_4d8c1c5b4283') }),
        ...(g.error ? [localizeMessage(g.error)] : []),...(g.fallbackReasons ?? []).map(localizeMessage)].join('\n'));
      details.append(heading,body); return details;
    }));
  }
  async function command(control: LocalControl) { const reply = await browser.runtime.sendMessage({type:'local-control',control}) as LocalReply; if (!reply?.ok) throw reply?.error === 'LOCAL_BENCHMARK_BUSY' ? new UiError('m_5eadc2f13988') : reply?.error ? new Error(reply.error) : new UiError('m_6617b63d3f34'); if(reply.state) options.state(reply.state); return reply; }
  function schedule() { clearTimeout(timer); if(active()) timer=setTimeout(()=>void poll(),800); }
  async function poll() { if(polling) return; polling=true; try { render((await command({action:'benchmark-status'})).report ?? null); } catch(e) { bindLocalizedText(el('lb-status'), () => t('m_fb5089735051', { p0: localizeMessage(e) })); el('lb-status').className='status error'; } finally { polling=false; schedule(); } }
  el('lb-start').addEventListener('click',async()=>{ if(blocked || active() || !enabled)return; for(const field of benchmarkPanel.querySelectorAll<HTMLInputElement>('input[id^="lb-"]')) if(!field.reportValidity()) return; actionError=null; pending=true; render(report); try { const parallels=el('lb-parallels').value.split(',').map(v=>Number(v.trim())); const workloads=(['short','normal','long'] as const).filter(w=>el('lb-'+w).checked); const language = options.translationSettings?.(); const benchmarkOptions = { parallels, workloads, count:Number(el('lb-count').value), applicationConcurrency:Number(el('lb-concurrency').value), requestTimeoutMs:Number(el('lb-budget').value), baseConfig:read(), validateCorpus:true, ...(language ?? {}) }; const reply=await command({action:'benchmark-start',modelId:options.modelId(),options:benchmarkOptions}); report=reply.report ?? null; } catch(e) { actionError=e; } finally { pending=false; render(report); schedule(); } });
  el('lb-stop').addEventListener('click',async()=>{ if(!active())return; actionError=null; if(report) report={...report,status:'stopping'}; render(report); schedule(); try { report=(await command({action:'benchmark-stop'})).report ?? report; } catch(e) { actionError=e; } finally { render(report); schedule(); } });
  el('lb-export').addEventListener('click',()=>{ if(!report)return; const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'})); const a=document.createElement('a'); a.href=url;a.download=`danlingo-${report.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); });
  el('lb-apply').addEventListener('click',()=>{ if(!canApply() || !report?.recommendedVariant)return; try { fill(applyLocalRecommendation(read(),report.modelId,report.recommendedVariant.config,report.finishedAt));options.changed();actionError=null;bindLocalizedText(el('lb-status'), () => t('m_efa4a7706c6b')); el('lb-status').className='status'; } catch(e) {bindLocalizedText(el('lb-status'), () => localizeMessage(e));el('lb-status').className='status error';} });
  fill(); void poll();
  let reasoningModel: LocalModelInfo | undefined, reasoningInitialized = false;
  const reasoningField = el('lp-superChatReasoning') as unknown as HTMLSelectElement;
  const reasoningLabel = (value: string): string => {
    const labels: Record<string, string> = {
      auto:t('m_0c9b819dedcc'), off:t('m_3fd47edce45b'), on:t('m_8da97ddda990'), low:t('m_309afd0204dd'),
      medium:t('m_e1d278532eac'), high:t('m_cba5143f64e5'), max:t('m_10bec0878f8c'),
    };
    return labels[value] ?? value;
  };
  function renderReasoningOptions() {
    for (const item of reasoningField.options) item.text = item.dataset.currentUnsupported === 'true'
      ? t('m_f62067038240', { p0: item.value }) : reasoningLabel(item.value);
  }
  function renderReasoningNote(): string {
    if (!reasoningInitialized) return '';
    const capability = modelTemplateCapability(reasoningModel);
    return capability.mode === 'none' ? (reasoningModel?.translationProfile === 'seed-x'
      ? t('m_cd2c63736615')
      : t('m_785fcca5a8a6'))
      : capability.status === 'unknown' ? t('m_936ea71667e4')
      : t('m_a42dd47721d8', { p0: capability.supported.map(reasoningLabel).join(' / '), p1: !capability.supported.includes('off') ? t('m_43baf41fbbd3') : '' });
  }
  bindLocalizedText(reasoningNote, renderReasoningNote);
  const stopLocale = onLocaleChange(renderReasoningOptions);
  window.addEventListener('pagehide', stopLocale, { once: true });
  const setModel = (model?: LocalModelInfo) => {
    const capability = modelTemplateCapability(model), current = reasoningField.value || config.superChatReasoning;
    reasoningModel = model; reasoningInitialized = true;
    reasoningField.replaceChildren(...capability.supported.map(value => new Option('',value)));
    if (!capability.supported.includes(current as LocalPerformanceConfig['superChatReasoning'])) {
      const invalid = new Option('', current); invalid.disabled = true; invalid.dataset.currentUnsupported = 'true'; reasoningField.append(invalid);
    }
    reasoningField.value = current;
    renderReasoningOptions(); bindLocalizedText(reasoningNote, renderReasoningNote);
  };
  return {read,fill,active,setModel,setBlocked:(value:boolean)=>{blocked=value;el('lb-start').disabled=blocked || !enabled || active() || !options.modelId();},refresh:()=>{summary();render(report);},setEnabled:(value:boolean)=>{enabled=value;summary();render(report);}};
}
