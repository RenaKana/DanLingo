export const TRANSLATION_SHORTCUT_COMMAND = 'toggle-translation';
export const TRANSLATION_SHORTCUT_DEFAULT = 'Alt+Shift+T';
export const TRANSLATION_SHORTCUT_DESCRIPTION = '快速切换翻译';

export type ShortcutBrowser = 'chrome' | 'edge';

export interface TranslationShortcutCommand {
  name?: string;
  shortcut?: string;
}

export interface TranslationShortcutApi<Tab = unknown> {
  getAll(): Promise<readonly TranslationShortcutCommand[]>;
  onCommand: {
    addListener(listener: (command: string, tab?: Tab) => void): void;
    removeListener?(listener: (command: string, tab?: Tab) => void): void;
  };
}

/** Return the browser-assigned shortcut, or an empty string when unassigned/unknown. */
export async function getTranslationShortcut(
  commands: Pick<TranslationShortcutApi, 'getAll'>,
): Promise<string> {
  const registered = await commands.getAll();
  const command = registered.find(entry => entry.name === TRANSLATION_SHORTCUT_COMMAND);
  return typeof command?.shortcut === 'string' ? command.shortcut : '';
}

/** Native browser page where the user can assign or change extension shortcuts. */
export function translationShortcutManagementUrl(browser: ShortcutBrowser): string {
  return `${browser}://extensions/shortcuts`;
}

/** Register only the translation command; the callback owns the atomic settings update. */
export function registerTranslationShortcutHandler<Tab>(
  commands: Pick<TranslationShortcutApi<Tab>, 'onCommand'>,
  toggle: (tab?: Tab) => void | Promise<void>,
): () => void {
  const listener = (command: string, tab?: Tab) => {
    if (command === TRANSLATION_SHORTCUT_COMMAND) void toggle(tab);
  };
  commands.onCommand.addListener(listener);
  return () => commands.onCommand.removeListener?.(listener);
}
