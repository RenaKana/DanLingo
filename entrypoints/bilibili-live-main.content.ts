import { defineContentScript } from 'wxt/utils/define-content-script';
import { startBilibiliLiveBridge } from '../src/platforms/bilibili-live/native';

export default defineContentScript({
  matches: ['https://live.bilibili.com/*'], world: 'MAIN', runAt: 'document_start',
  main() { startBilibiliLiveBridge(); },
});
