import { browser } from 'wxt/browser';
import { normalizeLocalConfig, resolveLocalConfig, applyLocalRecommendation } from '../../src/local/config';
import type { LocalPerformanceConfig, LocalControl, LocalReply, LocalState, LocalModelInfo } from '../../src/local/types';
import { modelTemplateCapability } from '../../src/local/reasoning';
import type { LocalBenchmarkReport } from '../../src/local/benchmark-runner';

export function mountLocalPerformanceUI(options: { container: HTMLElement; benchmarkContainer: HTMLElement; superchatContainer: HTMLElement; activity(active: boolean): void; modelId(): string; changed(): void; state(state?: LocalState): void; busyChanged(): void; translationSettings?: () => { sourceLanguage: string; targetLanguage: string } | undefined }) {
  const panel = document.createElement('div'); panel.className = 'span local-performance';
  const pick = (key: string, label: string, values: Array<string | [string, string]>) => `<label>${label}<select id="lp-${key}">${values.map(v => { const [value, text] = typeof v === 'string' ? [v, v] : v; return `<option value="${value}">${text}</option>`; }).join('')}</select></label>`;
  const number = (key: string, label: string, min: number, step = '1') => `<label>${label}<input id="lp-${key}" type="number" min="${min}" step="${step}" required></label>`;
  const numberOrAuto = (key: string, label: string, min: number, step = '1') => `<label>${label}<span class="inline-field"><select id="lp-${key}-mode"><option value="auto">Auto</option><option value="custom">自定义</option></select><input id="lp-${key}-value" type="number" min="${min}" step="${step}" required></span></label>`;
  const tri: Array<[string, string]> = [['auto', 'Auto'], ['off', 'Off'], ['on', 'On']];
  panel.innerHTML = `<style>.local-performance [hidden]{display:none!important}.local-performance{min-width:0}.local-performance details{margin-top:14px}.local-performance .row{margin-top:12px}.local-performance svg{width:100%;height:auto;display:block}.local-performance pre{max-height:340px}.local-performance .chart-grid{display:grid;gap:12px}.local-performance .metric-list{white-space:pre-line}.local-performance input[type=number]{width:100%}</style>
    <div class="grid">${pick('mode', '本地性能模式', [['auto','Auto · 实测建议优先'],['low-memory','低显存'],['balanced','平衡'],['high-performance','高性能'],['custom','自定义']])}<div id="lp-summary" class="subtle" role="status"></div></div>
    <details id="lp-capacity"><summary>容量与 GPU 参数</summary><div class="grid">
      ${number('parallel','原生并行序列',1)}${numberOrAuto('contextTokens','统一上下文（tokens）',1)}
      ${number('estimatedTokensPerRequest','每请求预估 tokens（Auto 上下文）',1)}${pick('batchPreset','Prompt batch', [['compatibility','兼容 128 / 128'],['balanced','平衡 512 / 256'],['throughput','吞吐 512 / 512'],['custom','自定义']])}
      ${number('batch','Batch',1)}${number('microBatch','Micro batch',1)}
      ${pick('flashAttention','Flash Attention',tri)}${numberOrAuto('cpuThreads','CPU 线程',1)}
      <label class="check"><input id="lp-warmup" type="checkbox">加载后预热</label><label class="check"><input id="lp-measureGpu" type="checkbox">采样 GPU 时间（有测量开销）</label><label class="check"><input id="lp-allowAutoFallback" type="checkbox">允许 Auto 自动回退</label>
    </div><p class="subtle">修改后需重新加载模型。Flash Attention 需模型和设备支持。</p></details>
    <details><summary>本地生成策略</summary><div class="grid">
      ${number('temperature','Temperature',0,'any')}${pick('superChatReasoning','Super Chat 思考',tri)}
      ${number('normalMaxTokens','普通弹幕输出上限',1)}${number('superChatMaxTokens','Super Chat 输出上限',1)}${number('manualMaxTokens','手动测试输出上限',1)}
      ${pick('promptMode','提示词模式',[['auto','Auto'],['hy-mt','HY-MT'],['json','JSON']])}${pick('languageValidation','语言校验',[['strict','检测明显错语言或未翻译'],['off','关闭']])}
      <label class="check"><input id="lp-reusePromptCache" type="checkbox">原生提示词 KV 复用（实验性）</label>
    </div><p class="subtle">生成参数需重载模型；提示词模式和语言校验保存即生效。</p></details>
    <details id="lb-panel"><summary>本地并发 Benchmark</summary><div class="grid">
      <label>原生并行序列（逗号分隔）<input id="lb-parallels" value="1,2,4,8,16" required></label>
      <label>每组请求数<input id="lb-count" type="number" min="1" max="256" value="32" required></label>
      <label>每请求预算（含排队，毫秒）<input id="lb-budget" type="number" min="1000" max="600000" value="60000" required></label>
      <label>应用请求并发<input id="lb-concurrency" type="number" min="1" max="2147483647" value="32" required></label>
      <div class="row span"><label class="check"><input id="lb-short" type="checkbox" checked>短弹幕</label><label class="check"><input id="lb-normal" type="checkbox" checked>普通句子</label><label class="check"><input id="lb-long" type="checkbox" checked>长 Super Chat</label></div>
    </div><div class="row"><button id="lb-start" type="button">开始 Benchmark</button><button id="lb-stop" type="button" disabled>停止</button><button id="lb-export" type="button" disabled>导出 JSON</button><button id="lb-apply" type="button" disabled>采用建议</button></div>
    <p id="lb-status" class="status" role="status" aria-live="polite">未运行</p><div id="lb-charts" class="chart-grid"></div><div id="lb-results"></div>
    <p class="subtle">测试时暂停观看页翻译，结束后自动恢复。每组至少完成两轮并行请求，才会生成建议。</p>
    </details>`;
  options.container.append(panel);
  const benchmarkPanel = panel.querySelector<HTMLDetailsElement>('#lb-panel')!;
  benchmarkPanel.open = true; options.benchmarkContainer.classList.add('local-benchmark'); options.benchmarkContainer.append(benchmarkPanel);
  const sc = document.createElement('div'); sc.className = 'grid';
  sc.append(panel.querySelector('#lp-superChatReasoning')!.closest('label')!, panel.querySelector('#lp-superChatMaxTokens')!.closest('label')!);
  options.superchatContainer.append(sc);
  const reasoningNote = document.createElement('p'); reasoningNote.className = 'subtle'; sc.after(reasoningNote);
  // These controls belong to the benchmark action, never to settings submission.
  for (const field of benchmarkPanel.querySelectorAll<HTMLInputElement>('input')) field.setAttribute('form', 'local-benchmark-controls');
  const el = (id: string) => document.getElementById(id) as HTMLInputElement;
  let config = normalizeLocalConfig(), report: LocalBenchmarkReport | null = null;
  let pending = false, timer: ReturnType<typeof setTimeout> | undefined, polling = false, enabled = false, actionError = '';
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
    try { const value = read(), r = resolveLocalConfig(value, options.modelId()); el('lp-summary').textContent = `计划 ${r.parallel} 序列 · 上下文 ${r.contextTokens} · Batch ${r.batch}/${r.microBatch} · FA ${r.flashAttention} · CPU ${r.cpuThreads}${value.mode === 'auto' ? value.autoRecommendation?.modelId === options.modelId() ? ' · 此模型实测建议（FA / CPU 跟随建议）' : ' · 保守基线' : ''}`; }
    catch { el('lp-summary').textContent = '参数无效：检查有限正整数、Micro batch ≤ Batch 和上下文容量。'; }
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
  const fmt = (n: number | null | undefined, digits = 1) => n == null ? '未知' : n.toFixed(digits);
  const percent = (n: number | null | undefined) => n == null ? '未知' : `${(n * 100).toFixed(1)}%`;
  function chart(label: string, key: 'requestsPerSecond' | 'meanMs' | 'p95Ms') {
    const box = document.createElement('div'), title = document.createElement('div'); title.className = 'subtle'; title.textContent = label; box.append(title);
    box.tabIndex = 0; box.setAttribute('role', 'region'); box.setAttribute('aria-label', label + '图表，可横向滚动；完整数值见下方明细');
    const groups = report!.groups.filter(g => g.status === 'completed');
    const value = (g: typeof groups[number]) => key === 'requestsPerSecond' ? g.stats.requestsPerSecond : g.stats.endToEndMs[key];
    const points = groups.map(value).filter((n): n is number => n != null); if (!points.length) return box;
    const max = Math.max(...points, .001), parallels = [...new Set(groups.map(g => g.runtime?.parallel ?? g.config.parallel))].sort((a,b) => a-b);
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 580 160'); svg.setAttribute('role','img'); svg.setAttribute('aria-label', label + '；完整数值见各组详情');
    const add = (tag: string, attrs: Record<string,string>, text?: string) => { const node = document.createElementNS(svg.namespaceURI,tag); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); if(text) node.textContent=text; svg.append(node); };
    add('path',{d:'M48 12V130H558',fill:'none',stroke:'var(--border)'});
    add('text',{x:'0',y:'18','font-size':'11',fill:'var(--muted)'},fmt(max)); add('text',{x:'24',y:'132','font-size':'11',fill:'var(--muted)'},'0');
    const x = (p: number) => 60 + (parallels.length === 1 ? 0 : parallels.indexOf(p) / (parallels.length - 1) * 480);
    parallels.forEach(p => add('text',{x:String(x(p)),y:'149','font-size':'11',fill:'var(--muted)'},String(p)));
    ['short','normal','long'].forEach((workload,index) => { const rows = groups.filter(g => g.workload === workload && value(g) != null).sort((a,b) => (a.runtime?.parallel ?? a.config.parallel)-(b.runtime?.parallel ?? b.config.parallel)); const color = ['var(--accent)','#5c91d5','#bb873c'][index]!;
      add('polyline',{points:rows.map(g => `${x(g.runtime?.parallel ?? g.config.parallel)},${130-value(g)!/max*112}`).join(' '),fill:'none',stroke:color,'stroke-width':'2'});
      rows.forEach(g => { add('circle',{cx:String(x(g.runtime?.parallel ?? g.config.parallel)),cy:String(130-value(g)!/max*112),r:'3',fill:color}); });
      add('text',{x:String(160+index*110),y:'12','font-size':'11',fill:color},['短弹幕','普通句子','长 SC'][index]);
    }); box.append(svg); return box;
  }
  function render(next: LocalBenchmarkReport | null) {
    report = next; el('lb-start').disabled = !enabled || active() || !options.modelId(); el('lb-stop').disabled = !active(); el('lb-export').disabled = !enabled || !next;
    el('lb-apply').disabled = !enabled || !canApply();
    options.activity(active()); options.busyChanged(); if (!next) { if(actionError) {el('lb-status').textContent=actionError;el('lb-status').className='status error';} return; }
    const phase = {loading:'加载',preflight:'检查语料',warmup:'预热',measuring:'测量',restoring:'恢复原配置',done:'结束'}[next.phase];
    el('lb-status').textContent = `${({running:'运行中',stopping:'停止中',completed:'已完成',cancelled:'已停止',failed:'失败'})[next.status]} · ${phase} · ${next.groups.reduce((n,g)=>n+g.completed,0)} 个请求已结束${next.error ? ' · '+next.error : ''}${next.restoreError ? ' · 恢复失败：'+next.restoreError : ''}${next.status === 'completed' ? next.recommendedVariant ? ' · 建议 '+next.recommendedVariant.name : ' · 无符合条件的建议' : ''}`;
    el('lb-status').className = next.error || next.restoreError ? 'status error' : 'status';
    if (actionError) {el('lb-status').textContent=actionError;el('lb-status').className='status error';}
    el('lb-charts').replaceChildren(...(['requestsPerSecond','meanMs','p95Ms'] as const).map((key,i)=>chart(['吞吐（请求/秒）· 横轴：原生序列','平均端到端延迟（ms）','P95 端到端延迟（ms）'][i]!,key)));
    const expanded = new Set([...el('lb-results').querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.dataset.group));
    el('lb-results').replaceChildren(...next.groups.map(g => {
      const details = document.createElement('details'); details.dataset.group=g.variantId+g.workload; details.open=expanded.has(details.dataset.group);
      const heading = document.createElement('summary'), body = document.createElement('div'); body.className='subtle metric-list'; const s = g.stats;
      heading.textContent = `${g.name} · ${{short:'短弹幕',normal:'普通句子',long:'长 SC'}[g.workload]} · ${g.completed}/${g.expected} · ${fmt(s.requestsPerSecond,3)} 请求/秒 · ${g.status}`;
      body.textContent = [`总耗时 ${fmt(s.totalDurationMs)} ms · 成功 ${s.success}/${s.total} (${percent(s.successRate)}) · 失败 ${s.failed} · 超时 ${s.timeout} (${percent(s.timeoutRate)}) · 取消 ${s.cancelled}`,
        ...([['端到端',s.endToEndMs],['排队',s.queueMs],['Prompt',s.promptMs],['Decode',s.decodeMs]] as const).map(([name,m])=>`${name} ms：均值 ${fmt(m.meanMs)} · P50 ${fmt(m.p50Ms)} · P95 ${fmt(m.p95Ms)} · P99 ${fmt(m.p99Ms)} · 最小 ${fmt(m.minMs)} · 最大 ${fmt(m.maxMs)} · 覆盖 ${percent(m.coverage)}`),
        `输入 ${fmt(s.inputTokens.total,0)} tokens · ${fmt(s.inputTokens.perSecond)} tokens/s；输出 ${fmt(s.outputTokens.total,0)} tokens · ${fmt(s.outputTokens.perSecond)} tokens/s`,
        `GPU ${g.gpuObservation?.completeComputeMs != null ? '本组完整计算' : '采样计算'} ${fmt(g.gpuObservation?.completeComputeMs ?? g.gpuObservation?.sampledComputeMs)} ms · pass 覆盖 ${percent(g.gpuObservation?.computePassCoverage)} · 已跟踪缓冲 ${fmt(g.gpuObservation?.allocatedBufferBytesAfter == null ? null : g.gpuObservation.allocatedBufferBytesAfter/1048576)} MiB · 生命周期峰值 ${fmt(g.gpuObservation?.lifetimePeakAllocatedBufferBytes == null ? null : g.gpuObservation.lifetimePeakAllocatedBufferBytes/1048576)} MiB`,
        `GPU 计算时间不含数据传输，不能分摊成并行请求耗时；缓冲分配不是物理显存。原生峰值 ${g.nativeAfter?.nativePeakActive ?? '未知'}（包括此前负载／预热）。`,
        ...(g.error ? [g.error] : []),...(g.fallbackReasons ?? [])].join('\n');
      details.append(heading,body); return details;
    }));
  }
  async function command(control: LocalControl) { const reply = await browser.runtime.sendMessage({type:'local-control',control}) as LocalReply; if (!reply?.ok) throw new Error(reply?.error || '本地测试操作失败'); if(reply.state) options.state(reply.state); return reply; }
  function schedule() { clearTimeout(timer); if(active()) timer=setTimeout(()=>void poll(),800); }
  async function poll() { if(polling) return; polling=true; try { render((await command({action:'benchmark-status'})).report ?? null); } catch(e) { el('lb-status').textContent=`状态读取失败：${e instanceof Error ? e.message : String(e)}；正在重试`; } finally { polling=false; schedule(); } }
  el('lb-start').addEventListener('click',async()=>{ if(active() || !enabled)return; for(const field of benchmarkPanel.querySelectorAll<HTMLInputElement>('input[id^="lb-"]')) if(!field.reportValidity()) return; actionError=''; pending=true; render(report); try { const parallels=el('lb-parallels').value.split(',').map(v=>Number(v.trim())); const workloads=(['short','normal','long'] as const).filter(w=>el('lb-'+w).checked); const language = options.translationSettings?.(); const benchmarkOptions = { parallels, workloads, count:Number(el('lb-count').value), applicationConcurrency:Number(el('lb-concurrency').value), requestTimeoutMs:Number(el('lb-budget').value), baseConfig:read(), validateCorpus:true, ...(language ?? {}) }; const reply=await command({action:'benchmark-start',modelId:options.modelId(),options:benchmarkOptions}); report=reply.report ?? null; } catch(e) { actionError=e instanceof Error ? e.message : String(e); } finally { pending=false; render(report); schedule(); } });
  el('lb-stop').addEventListener('click',async()=>{ if(!active())return; actionError=''; if(report) report={...report,status:'stopping'}; render(report); schedule(); try { report=(await command({action:'benchmark-stop'})).report ?? report; } catch(e) { actionError=e instanceof Error ? e.message : String(e); } finally { render(report); schedule(); } });
  el('lb-export').addEventListener('click',()=>{ if(!report)return; const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'})); const a=document.createElement('a'); a.href=url;a.download=`danlingo-${report.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); });
  el('lb-apply').addEventListener('click',()=>{ if(!canApply() || !report?.recommendedVariant)return; try { fill(applyLocalRecommendation(read(),report.modelId,report.recommendedVariant.config,report.finishedAt));options.changed();el('lb-status').textContent='已填入此模型的 Auto 建议；点击页面“保存本地后端”保存。'; } catch(e) {el('lb-status').textContent=e instanceof Error ? e.message : String(e);} });
  document.getElementById('local-model')!.addEventListener('change',()=>{summary();render(report);});
  fill(); void poll();
  const setModel = (model?: LocalModelInfo) => {
    const capability = modelTemplateCapability(model), field = el('lp-superChatReasoning') as unknown as HTMLSelectElement;
    const current = field.value || config.superChatReasoning;
    const names: Record<string,string> = {auto:'Auto · 模板默认',off:'关闭',on:'开启',low:'低（low）',medium:'中（medium）',high:'高（high）',max:'最高（max）'};
    field.replaceChildren(...capability.supported.map(value => new Option(names[value],value)));
    if (!capability.supported.includes(current as LocalPerformanceConfig['superChatReasoning'])) {
      const invalid = new Option(`${current} · 当前模型不支持`, current); invalid.disabled = true; field.append(invalid);
    }
    field.value = current;
    reasoningNote.textContent = capability.mode === 'none' ? (model?.translationProfile === 'seed-x'
      ? 'Seed-X 可能错译或输出额外推理，暂不支持调整思考设置。'
      : '使用 TranslateGemma 时，请明确选择源语言和直播源语言。')
      : capability.status === 'unknown' ? '此模型暂不可手动设置思考强度。'
      : `支持的思考设置：${capability.supported.join(' / ')}。${!capability.supported.includes('off') ? '此模型无法关闭思考，普通弹幕使用默认设置。' : ''}`;
  };
  return {read,fill,active,setModel,refresh:()=>{summary();render(report);},setEnabled:(value:boolean)=>{enabled=value;summary();render(report);}};
}
