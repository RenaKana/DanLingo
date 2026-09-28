import { defineContentScript } from 'wxt/utils/define-content-script';
import { BUILD_ID } from '../src/core/build-identity';
// @ts-ignore Task-scoped diagnostic module; no production behavior changes.
import { startAuditMain } from '../src/diagnostics/bilibili-audit-main.mjs';

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/BV1yvhW6sEzi*', 'https://www.bilibili.com/video/BV1RHaw6mEDR*'], world: 'MAIN', runAt: 'document_idle',
  main() { startAuditMain(BUILD_ID); },
});
