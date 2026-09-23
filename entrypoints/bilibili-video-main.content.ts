import { defineContentScript } from 'wxt/utils/define-content-script';
import { startBilibiliNativeBridge } from '../src/platforms/bilibili/video';

export default defineContentScript({
  matches: ['https://www.bilibili.com/*'], world: 'MAIN', runAt: 'document_start',
  main() { startBilibiliNativeBridge(); },
});
