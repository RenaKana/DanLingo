import { defineContentScript } from 'wxt/utils/define-content-script';
import { startNativeBridge } from '../src/platforms/niconico/native';

export default defineContentScript({
  matches: ['https://www.nicovideo.jp/*'], world: 'MAIN', runAt: 'document_start',
  main() { startNativeBridge(); },
});
