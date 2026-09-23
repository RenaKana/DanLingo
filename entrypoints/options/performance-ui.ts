import { browser } from 'wxt/browser';
import { endpointOrigin } from '../../src/core/config';
import type { Settings } from '../../src/core/types';
import type { PerformanceReport } from '../../src/translation/performance-test';
import { translationLanguageMessage } from '../../src/local/translation-profile';

export function mountPerformanceUI(options: { container: HTMLElement; activity(active: boolean): void; readSettings(): Settings; readKey(): string }) {
  const panel = document.createElement('section'); panel.className = 'card performance-panel';
  panel.innerHTML = `<style>.performance-panel [hidden]{display:none!important}</style><h2>翻译性能测试</h2>
    <div class="grid">
      <label>测试次数<select id="performance-count"><option value="10">10 次</option><option value="100">100 次</option><option value="custom">自定义</option></select></label>
      <label id="performance-custom-field" hidden>自定义次数<input id="performance-custom" type="number" min="1" max="1000" value="10"></label>
      <label>测试模式<select id="performance-mode"><option value="latency">基础延迟</option><option value="load">实际负载回放</option></select></label>
      <label>测试并发<input id="performance-concurrency" type="number" min="1" max="64" value="1"></label>
      <label>翻译策略<select id="performance-strategy"><option value="normal">普通弹幕</option><option value="superchat">Super Chat</option></select></label>
      <label data-load-only hidden>每个回放任务的消息数<input id="performance-batch-size" type="number" min="1" max="200" value="2"></label>
      <label data-load-only hidden>任务到达间隔（毫秒）<input id="performance-arrival" type="number" min="0" max="5000" value="100"></label>
    </div>
    <div class="row" style="margin-top:16px"><button id="performance-start" type="button">开始测试</button><button id="performance-stop" type="button" disabled>停止</button><button id="performance-copy" type="button" disabled>复制结果</button></div>
    <div id="performance-progress" class="status" role="status" aria-live="polite"></div>
    <details><summary>完整测试结果</summary><div id="performance-result" class="status" style="white-space:pre-line" role="status"></div></details>
    <div id="performance-copy-status" class="status" role="status" aria-live="polite"></div>
    <label id="performance-copy-fallback" hidden>手动复制测试结果<textarea id="performance-copy-text" readonly rows="6" spellcheck="false" style="width:100%;box-sizing:border-box"></textarea></label>
    <p class="subtle">会发送所选次数，可能产生服务用量。测试期间暂停观看页翻译，结束后恢复，不改翻译开关。</p>`;
  options.container.append(panel);
  for (const control of panel.querySelectorAll('input,select')) control.setAttribute('form', 'performance-controls');
  const field = (id: string) => panel.querySelector<HTMLInputElement>('#performance-' + id)!;
  const button = (id: string) => panel.querySelector<HTMLButtonElement>('#performance-' + id)!;
  const progress = field('progress'), result = field('result');
  const copyStatus = field('copy-status'), copyFallback = field('copy-fallback');
  const copyText = panel.querySelector<HTMLTextAreaElement>('#performance-copy-text')!;
  let copyVersion = 0;
  function clearCopy() { copyVersion++; copyStatus.textContent = ''; copyFallback.hidden = true; copyText.value = ''; }
  function legacyCopy(text: string): boolean {
    const previous = document.activeElement;
    const input = document.createElement('textarea'); input.value = text; input.readOnly = true;
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; panel.append(input);
    try { input.focus({ preventScroll: true }); input.select(); return document.execCommand('copy'); }
    catch { return false; }
    finally { input.remove(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }
  }
  let report: PerformanceReport | null = null, polling = false, starting = false, timer: ReturnType<typeof setTimeout> | undefined;
  const ms = (value: number | null) => value === null ? '无有效统计' : `${value.toFixed(1)} ms`;
  const rate = (value: number | null) => value === null ? '无有效统计' : `${(value * 100).toFixed(1)}%`;
  const setStatus = (text: string, error = false) => { progress.textContent = text; progress.className = error ? 'status error' : 'status'; };
  function render(next: PerformanceReport | null) {
    if (next?.id !== report?.id) clearCopy();
    report = next;
    const active = starting || next?.state === 'running';
    options.activity(!!active);
    button('start').disabled = !!active; button('stop').disabled = !active; button('copy').disabled = !next;
    if (!next) return;
    const rejected = next.samples.filter(sample => sample.sentAt === null && sample.status === 'failed' && sample.reason);
    const reasons = [...new Set(rejected.map(sample => sample.reason!))];
    const noRequests = next.state === 'completed' && next.actualRequests === 0;
    setStatus(`${next.state === 'running' ? '测试中' : next.state === 'stopped' ? '已停止' : noRequests ? '测试未能发出请求' : '已完成'} · ${next.completed}/${next.planned} 个任务 · 实际发出 ${next.actualRequests} 次请求${next.stopReason ? ' · ' + next.stopReason : ''}${reasons.length ? ' · ' + reasons.map(reason => translationLanguageMessage(reason) ?? reason).join('；') : ''}`, noRequests || rejected.length > 0);
    const lines = [
      ...(next.backend === 'local' ? [`本地实际推理 ${next.localInferenceCalls ?? '尚未确认'}；请求数为 IPC 调用数。`] : []),
      `${next.model} · ${next.backend === 'local' ? '本地 GPU · WebGPU' : '在线服务'} · ${next.config.strategy === 'superchat' ? 'Super Chat' : '普通弹幕'}`,
      `平均完整译文 ${ms(next.meanMs)}（成功请求 n=${next.successRequests}） · P50 ${ms(next.p50Ms)} · P95 ${ms(next.p95Ms)}`,
      `成功率 ${rate(next.successRate)} · 失败 ${next.failed} · 超时 ${next.timeout} · 已发送后取消 ${next.cancelled} · 尚未发送任务 ${next.unsent}`,
      ...(rejected.length ? [`发送前失败 ${rejected.length} 次：${reasons.map(reason => translationLanguageMessage(reason) ?? reason).join('；')}`] : []),
      `成功请求吞吐 ${next.throughput.toFixed(2)} 次/秒 · 首次请求 ${ms(next.firstRequestMs)} · 后续均值 ${ms(next.stableMeanMs)}`,
      ...(next.config.mode === 'load' ? [`平均排队/合批 ${ms(next.meanQueueMs)} · 译文就绪总延迟 ${ms(next.meanReadyMs)} · 已到达消息预算内完成 ${rate(next.withinBudgetRate)}`] : []),
      next.usage ? `服务 usage：${JSON.stringify(next.usage)}（${next.usageReports}/${next.actualRequests} 次请求提供；缺失不计为零）` : '服务未报告用量；不代表零用量。',
      ...(next.config.count <= 10 ? ['P50/P95 为小样本结果。'] : []),
      '未预热；已绕过插件缓存和在途合并。服务端缓存及屏幕延迟未测。',
      '成功数按请求、格式与语言检查统计。',
    ];
    result.textContent = lines.join('\n');
  }
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try { const response = await browser.runtime.sendMessage({ type: 'performance-status' }); if (response?.ok) render(response.report); }
    catch { setStatus('后台暂时不可用；已发送请求可能仍产生用量', true); }
    finally { polling = false; clearTimeout(timer); if (report?.state === 'running') timer = setTimeout(() => { void poll(); }, 350); }
  }
  field('count').addEventListener('change', () => { panel.querySelector<HTMLElement>('#performance-custom-field')!.hidden = field('count').value !== 'custom'; });
  field('mode').addEventListener('change', () => { for (const el of panel.querySelectorAll<HTMLElement>('[data-load-only]')) el.hidden = field('mode').value !== 'load'; });
  button('start').addEventListener('click', async () => {
    if (starting || report?.state === 'running') return;
    for (const input of panel.querySelectorAll<HTMLInputElement>('input')) if (!input.closest('[hidden]') && !input.reportValidity()) return;
    starting = true; clearCopy(); options.activity(true); button('start').disabled = true; result.textContent = ''; setStatus('正在准备测试…');
    try {
      const settings = options.readSettings();
      const config = { count: Number(field('count').value === 'custom' ? field('custom').value : field('count').value),
        mode: field('mode').value, concurrency: Number(field('concurrency').value), batchSize: Number(field('batch-size').value),
        arrivalIntervalMs: Number(field('arrival').value), strategy: field('strategy').value };
      if (settings.backend !== 'local' && !await browser.permissions.request({ origins: [endpointOrigin(settings.endpoint, settings.allowLocalHttp) + '/*'] })) throw new Error('未授权服务地址');
      const response = await browser.runtime.sendMessage({ type: 'performance-start', settings, apiKey: options.readKey(), config });
      if (!response?.ok) throw new Error(response?.error || '无法开始测试');
      starting = false; render(response.report); await poll();
    } catch (error) { const code = error instanceof Error ? error.message : '测试启动失败'; setStatus(translationLanguageMessage(code) ?? code, true); }
    finally { starting = false; button('start').disabled = (report as PerformanceReport | null)?.state === 'running'; options.activity(button('start').disabled); }
  });
  button('stop').addEventListener('click', async () => {
    try { await browser.runtime.sendMessage({ type: 'performance-stop' }); await poll(); }
    catch { setStatus('未能确认停止；已发送请求可能仍产生用量', true); }
  });
  button('copy').addEventListener('click', async () => {
    if (!report) return;
    clearCopy();
    const version = copyVersion, text = JSON.stringify(report, null, 2);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Try selection-based copying below. */ }
    if (version !== copyVersion) return;
    if (!copied) copied = legacyCopy(text);
    copyStatus.className = copied ? 'status' : 'status error';
    copyStatus.textContent = copied ? '已复制当前测试结果' : '浏览器未允许自动复制，结果已选中，请按 Ctrl+C 复制';
    if (!copied) { copyFallback.hidden = false; copyText.value = text; copyText.focus({ preventScroll: true }); copyText.select(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  void poll();
}
