import { defineContentScript } from 'wxt/utils/define-content-script';
import { startYoutubeLiveBridge } from '../src/platforms/youtube/native';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'], world: 'MAIN', runAt: 'document_start',
  main() { startYoutubeLiveBridge(); },
});
