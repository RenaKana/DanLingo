import { t } from '../../src/i18n';
import { bindLocalizedText } from '../../src/ui/localized-text';
import type { testModel } from '../../src/translation/model-test';

export function renderModelTestOutput(target: HTMLElement, result: Awaited<ReturnType<typeof testModel>>) {
  const header = document.createElement('div'); header.className = 'model-test-summary';
  const name = document.createElement('strong'); name.textContent = result.model;
  const elapsed = document.createElement('span');
  bindLocalizedText(elapsed, () => t('modelTest.elapsed', { seconds: Number((result.elapsedMs / 1000).toFixed(2)) }));
  header.append(name, elapsed);
  const comparison = document.createElement('div'); comparison.className = 'model-test-comparison';
  for (const [key, value] of [['m_354b28c85333', result.sourceText], ['modelTest.translation', result.text]] as const) {
    const column = document.createElement('div'), label = document.createElement('div'), text = document.createElement('p');
    label.className = 'model-test-label'; bindLocalizedText(label, () => t(key));
    text.textContent = value; text.dir = 'auto'; column.append(label, text); comparison.append(column);
  }
  const metadata = document.createElement('div'); metadata.className = 'model-test-metadata';
  bindLocalizedText(metadata, () => [
    `${t('performance.targetLanguage')}: ${result.targetLanguage}`,
    t(result.promptMode === 'hy-mt' ? 'm_f9042fe0fe55' : 'm_8e1dfd9d2eff'),
    ...(result.local ? [t('m_03ac907910fc', { p0: Math.round(result.local.queueMs), p1: Math.round(result.local.inferenceMs) })] : []),
  ].join(' · '));
  target.replaceChildren(header, comparison, metadata); target.hidden = false;
}
