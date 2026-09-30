import { t } from '../../src/i18n';
import { bindLocalizedText } from '../../src/ui/localized-text';

/** Relocate marked instructions once, after the settings panels have mounted. */
export function mountSettingsHelp() {
  const help = document.querySelector<HTMLElement>('[data-section="help"]')!;
  help.classList.add('settings-help');
  const topics = new Map<string, HTMLElement>();
  const messages = new Set<string>();
  for (const note of document.querySelectorAll<HTMLElement>('[data-help]')) {
    const key = note.dataset.i18n;
    if (key && messages.has(key)) { note.remove(); continue; }
    if (key) messages.add(key);
    const title = note.dataset.help!;
    let topic = topics.get(title);
    if (!topic) {
      topic = document.createElement('section'); topic.className = 'help-topic';
      const heading = document.createElement('h2'); bindLocalizedText(heading, () => t(title));
      topic.append(heading); help.append(topic); topics.set(title, topic);
    }
    note.classList.remove('span', 'subtle', 'hint', 'notice');
    note.classList.add('help-copy'); topic.append(note);
  }
}
