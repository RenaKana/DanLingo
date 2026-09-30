import { t } from '../../src/i18n';
import { bindLocalizedText } from '../../src/ui/localized-text';

const get = (id: string) => document.getElementById(id)!;
const box = (className: string) => { const node = document.createElement('div'); node.className = className; return node; };

/** Both backends share the sample input and translation result layout. */
function modelTest(buttonId: string, optionsId: string, resultId: string) {
  const test = box('service-test'), action = box('service-test-action');
  const options = get(optionsId), fields = options.querySelector('.grid')!;
  const sample = fields.querySelector('label')!;
  action.append(get(buttonId));
  for (const field of [...fields.children]) if (field !== sample) action.append(field);
  options.replaceChildren(sample, action, ...options.querySelectorAll('[data-help]'));
  const feedback = box('model-test-feedback'), output = box('model-test-output');
  output.id = resultId + '-output'; output.hidden = true;
  feedback.append(get(resultId), output); test.append(options, feedback);
  return test;
}

export function mountLocalService(local: HTMLElement) {
  local.classList.add('local-service');
  const source = local.querySelector('.local-folder-heading')!, sourceActions = box('service-source-actions');
  sourceActions.append(...source.querySelectorAll('button')); source.append(sourceActions);
  const button = get('test-local-model'), row = button.parentElement!;
  const test = modelTest('test-local-model', 'local-model-test-options', 'local-test-result');
  test.classList.add('span'); row.replaceWith(test);
  get('local-preload-entry').closest('label')!.classList.add('service-runtime-start');
  get('local-idle-unload-minutes').closest('label')!.classList.add('service-field', 'span');
}

/** Move the existing controls; their IDs, input state and event handlers stay intact. */
export function mountCompactService(service: HTMLElement, info: HTMLDetailsElement) {
  const group = (name: string, title: string) => {
    const section = document.createElement('section'); section.className = `service-group service-${name}`;
    const heading = box('service-group-heading'), h2 = document.createElement('h2');
    h2.id = `service-${name}-heading`; section.setAttribute('aria-labelledby', h2.id);
    bindLocalizedText(h2, () => t(title));
    heading.append(h2); const body = box('service-group-body'); section.append(heading, body);
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
  const catalog = get('model-catalog-row');
  const budget = get('online-budget-status'), budgetNote = budget.nextElementSibling!;
  const privacy = info.querySelector(':scope > p');
  const connection = group('connection', 'settings.serviceConnectionTitle');
  const endpoint = field('endpoint'), key = field('api-key');
  endpoint.control.append(http);
  const credentials = box('service-credentials'); credentials.append(remember, get('key-state')); key.control.append(credentials);
  connection.body.append(endpoint.row, key.row);

  const model = group('model', 'performance.model');
  const modelField = field('model', 'service-model-field'), thinking = field('thinking-effort', 'service-thinking-field');
  modelField.row.querySelector('label')!.classList.add('sr-only');
  const modelInput = box('service-model-input'); modelInput.append(modelField.control.firstElementChild!, get('get-models'));
  modelField.control.append(modelInput, get('models-cache'), get('models-result'));
  // Retain the original action-row ID/backend contract while placing the action by its input.
  catalog.replaceChildren(modelField.row); catalog.className = 'service-catalog';
  const test = modelTest('test-model', 'model-test-options', 'test-result');
  modelInput.append(test.querySelector('#test-model')!);
  test.querySelector('.service-test-action')!.remove();
  model.body.append(catalog, thinking.row, test);

  const quota = box('service-group service-quota');
  const limit = field('online-request-limit'), quotaLine = box('service-quota-line');
  quotaLine.append(limit.control.firstElementChild!, budget); limit.control.append(quotaLine, budgetNote); quota.append(limit.row);

  const notes = box('service-notes'); info.classList.remove('span'); notes.append(info); if (privacy) notes.append(privacy);
  service.classList.add('compact-service');
  service.dataset.backend = 'online';
  service.replaceChildren(connection.section, model.section, quota, notes);
}
