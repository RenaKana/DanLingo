import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

export const onlineSettings = (overrides = {}) => ({
  ...DEFAULT_SETTINGS,
  backend: 'online',
  endpoint: 'https://api.minimax.cn/v1/chat/completions',
  model: 'MiniMax-M3',
  profile: 'minimax',
  protocol: 'chat-completions',
  thinkingEffort: 'off',
  reasoningProfileOverride: undefined,
  ...overrides,
});
