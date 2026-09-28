import { defineConfig } from 'wxt';
// @ts-ignore Build-only JavaScript plugin, pinned dependency source checks included.
import { localWllamaAssets } from './scripts/local-wllama-assets.mjs';
// @ts-ignore Build-only source identity helpers.
import { buildIdentityAsset, createBuildIdentity } from './scripts/build-identity.mjs';
import { TRANSLATION_SHORTCUT_COMMAND, TRANSLATION_SHORTCUT_DEFAULT } from './src/core/translation-shortcut.ts';

const buildIdentity = createBuildIdentity(import.meta.url);

export default defineConfig({
  vite: () => ({
    define: { __DANLINGO_BUILD_ID__: JSON.stringify(buildIdentity.buildId) },
    plugins: [localWllamaAssets(), buildIdentityAsset(buildIdentity)], worker: { plugins: () => [localWllamaAssets()] },
  }),
  manifest: {
    name: '__MSG_extensionName__',
    default_locale: 'en',
    description: '__MSG_extensionDescription__',
    version: '0.5.1',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' } },
    minimum_chrome_version: '120',
    commands: {
      [TRANSLATION_SHORTCUT_COMMAND]: {
        suggested_key: { default: TRANSLATION_SHORTCUT_DEFAULT },
        description: '__MSG_extensionShortcut__',
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
