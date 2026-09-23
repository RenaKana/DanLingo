import { defineConfig } from 'wxt';
// @ts-ignore Build-only JavaScript plugin, pinned dependency source checks included.
import { localWllamaAssets } from './scripts/local-wllama-assets.mjs';
import { TRANSLATION_SHORTCUT_COMMAND, TRANSLATION_SHORTCUT_DEFAULT, TRANSLATION_SHORTCUT_DESCRIPTION } from './src/core/translation-shortcut.ts';

export default defineConfig({
  vite: () => ({ plugins: [localWllamaAssets()], worker: { plugins: () => [localWllamaAssets()] } }),
  manifest: {
    name: 'DanLingo · 弹幕翻译',
    description: '在 Niconico、YouTube 与 Bilibili 原生页面翻译弹幕和直播聊天。',
    version: '0.3.0',
    minimum_chrome_version: '120',
    commands: {
      [TRANSLATION_SHORTCUT_COMMAND]: {
        suggested_key: { default: TRANSLATION_SHORTCUT_DEFAULT },
        description: TRANSLATION_SHORTCUT_DESCRIPTION,
      },
    },
    permissions: ['storage', 'offscreen'],
    web_accessible_resources: [{ resources: ['options.html'], matches: ['https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/*', 'https://www.youtube.com/*', 'https://www.bilibili.com/*', 'https://live.bilibili.com/*'] }],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" },
    host_permissions: ['https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/watch/*', 'https://www.youtube.com/*', 'https://www.bilibili.com/*', 'https://live.bilibili.com/*'],
    // Match patterns cannot express RFC1918 ranges. HTTP is validated in the background;
    // the settings gesture requests only the configured host, never this wildcard.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
});
