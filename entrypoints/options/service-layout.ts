import { t } from '../../src/i18n';
import { bindLocalizedText } from '../../src/ui/localized-text';

const get = (id: string) => document.getElementById(id)!;
const box = (className: string) => { const node = document.createElement('div'); node.className = className; return node; };

/** Move the existing controls; their IDs, input state and event handlers stay intact. */
export function mountCompactService(service: HTMLElement, info: HTMLDetailsElement) {
  const group = (name: string, title: string, hint: string, online = false) => {
    const section = document.createElement('section'); section.className = `service-group service-${name}`;
    if (online) section.dataset.backend = 'online';
    const heading = box('service-group-heading'), h2 = document.createElement('h2'), p = document.createElement('p');
    h2.id = `service-${name}-heading`; section.setAttribute('aria-labelledby', h2.id);
    bindLocalizedText(h2, () => t(title)); bindLocalizedText(p, () => t(hint));
    heading.append(h2, p); const body = box('service-group-body'); section.append(heading, body);
    return { section, body };
  };
  const field = (id: string, className = '') => {
    const input = get(id), old = id === 'model' ? input.closest('.model-control')! : input.closest('label')!;
    const label = id === 'model' ? old.querySelector('label')! : old as HTMLLabelElement;
    const row = box(`service-field ${className}`), control = box('service-control');
    label.htmlFor = id; label.classList.remove('span');
    control.append(input); row.append(label, control); return { row, control };
  };
  const http = get('local-http').closest('label')!, remember = get('remember').closest('label')!;
  const catalog = get('model-catalog-row'), testRow = get('test-model').parentElement!;
  const testOptions = get('model-test-options'), testNote = testOptions.querySelector(':scope > p')!;
  const budget = get('online-budget-status'), budgetNote = budget.nextElementSibling!;
  const privacy = info.querySelector(':scope > p');
  const connection = group('connection', 'settings.serviceConnectionTitle', 'settings.serviceConnectionHint', true);
  const endpoint = field('endpoint'), key = field('api-key');
  endpoint.control.append(http);
  const credentials = box('service-credentials'); credentials.append(remember, get('key-state')); key.control.append(credentials);
  connection.body.append(endpoint.row, key.row);

  const model = group('model', 'settings.modelTestTitle', 'settings.modelTestHint');
  const modelField = field('model', 'service-model-field'), thinking = field('thinking-effort', 'service-thinking-field');
  modelField.row.dataset.backend = thinking.row.dataset.backend = 'online';
  const modelInput = box('service-model-input'); modelInput.append(modelField.control.firstElementChild!, get('get-models'));
  modelField.control.append(modelInput, get('models-cache'), get('models-result'));
  // Retain the original action-row ID/backend contract while placing the action by its input.
  catalog.replaceChildren(modelField.row); catalog.className = 'service-catalog';
  const test = box('service-test'); testRow.classList.add('service-test-action');
  testRow.insertBefore(testNote, get('test-result')); test.append(testRow, testOptions);
  model.body.append(catalog, thinking.row, test);

  const quota = group('quota', 'settings.requestQuotaTitle', 'settings.requestQuotaHint');
  const limit = field('online-request-limit'), quotaLine = box('service-quota-line');
  quotaLine.append(limit.control.firstElementChild!, budget); limit.control.append(quotaLine, budgetNote); quota.body.append(limit.row);

  const notes = box('service-notes'); info.classList.remove('span'); notes.append(info); if (privacy) notes.append(privacy);
  service.classList.add('compact-service');
  service.replaceChildren(connection.section, model.section, quota.section, notes);
}
