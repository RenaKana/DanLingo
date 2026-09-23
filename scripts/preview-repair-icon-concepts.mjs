import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';


const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  ...browserLaunchOptions("chromium"),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 1 });
const output = resolve('.artifacts/previews/repair-icon-concepts');
await mkdir(output, { recursive: true });
try {
  await page.goto(pathToFileURL(resolve('docs/previews/repair-icon-concepts.html')).href, { waitUntil: 'load' });
  await page.locator('h1').waitFor();
  assert.equal(await page.locator('.concept').count(), 3);
  assert.equal(await page.locator('button.icon-button').count(), 18);
  assert.equal(await page.locator('.message').first().locator('.copy > .actions').count(), 1);
  assert.equal(await page.locator('.concept-a .message').last().locator('.copy > .actions').count(), 1);
  const original = page.locator('.concept-b .message').last().locator('button[data-action="original"]');
  await original.click();
  assert.equal(await original.getAttribute('aria-label'), '显示原文');
  await original.click();
  assert.equal(await original.getAttribute('aria-label'), '显示译文');
  await original.press('Tab');
  assert.equal(await page.locator(':focus').evaluate(element => element.matches('button.icon-button')), true);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.screenshot({ path: resolve(output, 'repair-icon-concepts.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'PASS', screenshot: resolve(output, 'repair-icon-concepts.png'), concepts: 3, buttons: await page.locator('button.icon-button').count() }, null, 2));
} finally {
  await browser.close();
}
