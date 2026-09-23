import { defineContentScript } from 'wxt/utils/define-content-script';
import { startNiconicoLiveBridge } from '../src/platforms/niconico-live/native';

export default defineContentScript({
  matches: ['https://live.nicovideo.jp/watch/*'], world: 'MAIN', runAt: 'document_start',
  main() { startNiconicoLiveBridge(); },
});
