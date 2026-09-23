import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTranslationShortcut,
  registerTranslationShortcutHandler,
  TRANSLATION_SHORTCUT_COMMAND,
  TRANSLATION_SHORTCUT_DEFAULT,
  TRANSLATION_SHORTCUT_DESCRIPTION,
  translationShortcutManagementUrl,
} from '../../src/core/translation-shortcut.ts';

test('shortcut metadata remains stable and reads the browser-assigned value', async () => {
  assert.equal(TRANSLATION_SHORTCUT_COMMAND, 'toggle-translation');
  assert.equal(TRANSLATION_SHORTCUT_DEFAULT, 'Alt+Shift+T');
  assert.equal(TRANSLATION_SHORTCUT_DESCRIPTION, '快速切换翻译');
  assert.equal(await getTranslationShortcut({ getAll: async () => [
    { name: 'other-command', shortcut: 'Ctrl+Shift+X' },
    { name: TRANSLATION_SHORTCUT_COMMAND, shortcut: 'Ctrl+Alt+T' },
  ] }), 'Ctrl+Alt+T');
});

test('unassigned or missing shortcuts remain an empty state', async () => {
  assert.equal(await getTranslationShortcut({ getAll: async () => [{ name: TRANSLATION_SHORTCUT_COMMAND, shortcut: '' }] }), '');
  assert.equal(await getTranslationShortcut({ getAll: async () => [] }), '');
  assert.equal(await getTranslationShortcut({ getAll: async () => [{ name: TRANSLATION_SHORTCUT_COMMAND }] }), '');
});

test('management URLs identify the native browser page without navigating', () => {
  assert.equal(translationShortcutManagementUrl('chrome'), 'chrome://extensions/shortcuts');
  assert.equal(translationShortcutManagementUrl('edge'), 'edge://extensions/shortcuts');
});

test('handler filters commands, forwards the tab, and unregisters cleanly', async () => {
  const listeners = new Set();
  const calls = [];
  const commands = { onCommand: {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
  } };
  const dispose = registerTranslationShortcutHandler(commands, tab => { calls.push(tab); });
  const listener = [...listeners][0];
  listener('other-command', { id: 1 });
  listener(TRANSLATION_SHORTCUT_COMMAND, { id: 7 });
  await Promise.resolve();
  assert.deepEqual(calls, [{ id: 7 }]);
  dispose();
  assert.equal(listeners.size, 0);
});
