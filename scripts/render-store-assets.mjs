// Render the existing vector brand without downloading images or fonts.
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

const iconsOnly = process.argv.includes('--icons-only');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, ...browserLaunchOptions('edge') });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route(/^https?:/, route => route.abort());
  await mkdir(resolve('public/icon'), { recursive: true });
  const mark = await readFile(resolve('docs/store-assets/mark.svg'), 'utf8');
  const render = async (svg, width, height, path) => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(path), omitBackground: true });
  };
  for (const size of [16, 32, 48, 128]) await render(mark, size, size, `public/icon/${size}.png`);
  if (!iconsOnly) {
    await render(mark, 300, 300, 'docs/store-assets/icon-300.png');
    await render(await readFile(resolve('docs/store-assets/tile.svg'), 'utf8'), 440, 280, 'docs/store-assets/tile-440x280.png');
  }
  console.log(iconsOnly ? 'Rendered 4 extension icons.' : 'Rendered 4 extension icons, Edge logo and promotional tile.');
} finally { await browser.close(); }
