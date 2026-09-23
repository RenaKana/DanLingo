// Navigate through the actual settings controls; never unhide a panel behind the UI.
export async function settingsSection(page, section) {
  if (await page.locator('#category').isVisible()) await page.locator('#category').selectOption(section);
  else await page.locator(`nav a[href="#${section}"]`).click();
  await page.locator(`[data-section="${section}"]`).waitFor({state:'visible'});
}
export async function settingsDetails(page, selector) {
  const section = await page.locator(selector).evaluate(el => el.closest('[data-section]').dataset.section);
  await settingsSection(page, section);
  const details = page.locator(selector);
  if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
}
