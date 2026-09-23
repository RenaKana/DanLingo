import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Bounded synthetic Playwright DOM regression for the production Niconico
// comment sidebar. It never visits or fetches the real Niconico site.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { liveHtml, liveUrl } from '../test/fixtures/niconico-live-sidebar.mjs';

const compile = async file => ts.transpileModule(await readFile(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

const outputBase = resolve('.artifacts/live/niconico-sidebar');
await mkdir(outputBase, { recursive: true });
const output = await mkdtemp(resolve(outputBase, 'run-'));
const report = {
  status: 'INCOMPLETE',
  evidence: 'SYNTHETIC_LOCAL_PLAYWRIGHT_PRODUCTION_DOM_ONLY',
  output,
  screenshots: {},
  checks: {},
  limitations: [
    'The page is a synthetic local fixture; it does not prove real Niconico rendering or site compatibility.',
    'The test imports the current TypeScript module through a data URL and does not exercise the extension bundle.',
    'No provider, credential, account, chat send, or real Niconico request is made.',
  ],
};

let browser;
try {
  const sidebarModule = uri(await compile('src/platforms/niconico-live/sidebar.ts'));

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({
    ...browserLaunchOptions("chromium"),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 700, height: 620 }, deviceScaleFactor: 1 });
  await page.route('**/*', route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.resourceType() === 'document' && request.url() === liveUrl) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: liveHtml });
    }
    return route.abort();
  });
  await page.goto(liveUrl, { waitUntil: 'domcontentloaded' });

  const setup = await page.evaluate(async moduleUrl => {
    const { NiconicoCommentSidebar } = await import(moduleUrl);
    const light = document.querySelector('[data-sidebar="light"]');
    const dark = document.querySelector('[data-sidebar="dark"]');
    if (!(light instanceof HTMLElement) || !(dark instanceof HTMLElement)) throw new Error('fixture sidebars missing');

    const resourceOf = ({ id, text, type = 'normal', isNg = false, isDeleted = false }) => ({
      id: () => id,
      text: () => text,
      type: () => type,
      isNg: () => isNg,
      isDeleted: () => isDeleted,
    });
    const attachFiber = (body, resource, rowIndex = 0, withFiber = true, ownerKey = resource.id(rowIndex)) => {
      if (!withFiber) return;
      const rowOwner = { key: ownerKey, return: null };
      const cellFiber = { memoizedProps: { resource, rowIndex }, return: rowOwner, alternate: null };
      Object.defineProperty(body, '__reactFiber$fixture', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cellFiber,
      });
      return { cellFiber, rowOwner };
    };
    const addRow = (parent, {
      id,
      text,
      name = 'Fixture user',
      number,
      type = 'normal',
      isNg = false,
      isDeleted = false,
      withFiber = true,
      rich = false,
    }) => {
      const row = document.createElement('div');
      row.className = 'fixture-comment-row';
      row.dataset.fixtureId = id || '';
      row.dataset.fixtureType = type;
      row.setAttribute('data-comment-type', type === 'normal' ? 'normal' : type);
      if (number !== undefined) {
        const numberNode = document.createElement('span');
        numberNode.className = 'comment-number';
        numberNode.textContent = String(number);
        row.append(numberNode);
      } else {
        const numberNode = document.createElement('span');
        numberNode.className = 'comment-number';
        numberNode.hidden = true;
        row.append(numberNode);
      }
      const content = document.createElement('span');
      content.className = 'content-area';
      const body = document.createElement('span');
      body.className = 'comment-text';
      if (rich) {
        const emphasis = document.createElement('em');
        emphasis.textContent = text;
        body.append(emphasis, document.createTextNode(' rich-tail'));
      } else {
        body.append(document.createTextNode(text));
      }
      content.append(body);
      const nameNode = document.createElement('span');
      nameNode.className = 'user-summary-area';
      nameNode.textContent = name;
      const menuWrap = document.createElement('span');
      menuWrap.className = 'menu-button-wrapper';
      const menu = document.createElement('button');
      menu.type = 'button';
      menu.setAttribute('aria-label', 'row menu');
      menu.textContent = '⋯';
      menu.addEventListener('click', () => { row.dataset.menuClicked = 'true'; });
      menuWrap.append(menu);
      row.append(nameNode, content, menuWrap);
      const resource = resourceOf({ id, text, type, isNg, isDeleted });
      const fiber = attachFiber(body, resource, 0, withFiber, id);
      const textNode = body.firstChild;
      if (textNode?.nodeType === Node.TEXT_NODE) {
        textNode.addEventListener('fixture-text-event', () => { row.dataset.textEvent = 'true'; });
      }
      parent.append(row);
      return { row, body, menu, resource, textNode, fiber };
    };

    const visual = new NiconicoCommentSidebar();
    const sidebar = new NiconicoCommentSidebar();
    const visualLight = addRow(light, { id: 'visual-light', text: '代表性的普通评论，保持侧栏宽度。', name: 'Light user' });
    const visualDark = addRow(dark, { id: 'visual-dark', text: '暗色侧栏中的代表性普通评论。', name: 'Dark user' });
    visual.capture('visual-light', '代表性的普通评论，保持侧栏宽度。');
    visual.capture('visual-dark', '暗色侧栏中的代表性普通评论。');
    window.__niconicoSidebarFixture = { sidebar, visual, light, dark, addRow, resourceOf, visualLight, visualDark };
    return {
      lightRows: light.querySelectorAll('[data-comment-type="normal"]').length,
      darkRows: dark.querySelectorAll('[data-comment-type="normal"]').length,
    };
  }, sidebarModule);
  assert.deepEqual(setup, { lightRows: 1, darkRows: 1 });

  report.screenshots.beforeLight = resolve(output, 'sidebar-light-before.png');
  report.screenshots.beforeDark = resolve(output, 'sidebar-dark-before.png');
  await page.locator('[data-sidebar="light"]').screenshot({ path: report.screenshots.beforeLight });
  await page.locator('[data-sidebar="dark"]').screenshot({ path: report.screenshots.beforeDark });

  const checks = await page.evaluate(() => {
    const fixture = window.__niconicoSidebarFixture;
    if (!fixture) throw new Error('fixture state missing');
    const { sidebar, visual, light, dark, addRow, resourceOf } = fixture;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const textOf = row => row.body.textContent;
    const onlyTextNode = row => row.body.childNodes.length === 1 && row.body.firstChild?.nodeType === Node.TEXT_NODE;
    const translated = (id, original, text) => { sidebar.capture(id, original); sidebar.translated(id, original, text); };

    // A result updates only the existing body text node and leaves row chrome
    // and its event listeners intact.
    const basic = addRow(light, { id: 'basic', text: '基本コメント', name: 'Alice', number: 1 });
    const basicNode = basic.body.firstChild;
    translated('basic', '基本コメント', 'basic translation');
    sidebar.scan();
    basic.menu.click();
    basicNode?.dispatchEvent(new Event('fixture-text-event'));
    check(textOf(basic) === 'basic translation', 'basic translation missing');
    check(basic.body.firstChild === basicNode && onlyTextNode(basic), 'body text node was replaced');
    check(basic.row.querySelector('.comment-number')?.textContent === '1', 'comment number changed');
    check(basic.row.querySelector('.user-summary-area')?.textContent === 'Alice', 'user name changed');
    check(basic.row.querySelector('.menu-button-wrapper button') === basic.menu && basic.row.dataset.menuClicked === 'true', 'menu/listener was not preserved');
    check(basic.row.dataset.textEvent === 'true', 'original text node listener was lost');

    // The wire resource ID remains sufficient when the displayed number is
    // hidden, and duplicate originals remain independent.
    const hidden = addRow(light, { id: 'hidden-wire-id', text: '同じ原文', name: 'Hidden ID' });
    hidden.row.querySelector('.comment-number').hidden = true;
    translated('hidden-wire-id', '同じ原文', 'hidden translation');
    const duplicateA = addRow(light, { id: 'duplicate-a', text: '重复原文', name: 'Duplicate A' });
    const duplicateB = addRow(light, { id: 'duplicate-b', text: '重复原文', name: 'Duplicate B' });
    translated('duplicate-a', '重复原文', '译文 A');
    translated('duplicate-b', '重复原文', '译文 B');
    sidebar.scan();
    check(textOf(hidden) === 'hidden translation', 'hidden-number stable ID did not bind');
    check(textOf(duplicateA) === '译文 A' && textOf(duplicateB) === '译文 B', 'duplicate originals were conflated');

    // React virtualization can leave an attached cell fiber with an old
    // resource/rowIndex. The keyed row owner is the stable identity guard;
    // this must not select the other source with the same original text.
    const staleIndex = addRow(light, { id: 'keyed-current', text: '相同原文', name: 'Stale rowIndex' });
    const staleResource = resourceOf({ id: 'stale-row-index', text: '相同原文' });
    if (!staleIndex.fiber) throw new Error('stale rowIndex fixture fiber missing');
    staleIndex.fiber.cellFiber.memoizedProps = { resource: staleResource, rowIndex: 0 };
    staleIndex.fiber.rowOwner.key = 'keyed-current';
    translated('stale-row-index', '相同原文', '错误的旧行译文');
    translated('keyed-current', '相同原文', '正确的行译文');
    sidebar.scan();
    check(textOf(staleIndex) === '相同原文', 'stale rowIndex/resource crossed to another source');

    // An alternate fiber may legitimately contain the current keyed props.
    // The verifier models both paths so the production identity check can
    // recover the correct result without trusting the stale attached props.
    const alternate = addRow(light, { id: 'keyed-alternate', text: '备用相同原文', name: 'Alternate props' });
    const alternateStaleResource = resourceOf({ id: 'stale-alternate', text: '备用相同原文' });
    if (!alternate.fiber) throw new Error('alternate fixture fiber missing');
    const staleCellFiber = { memoizedProps: { resource: alternateStaleResource, rowIndex: 0 }, return: alternate.fiber.rowOwner, alternate: null };
    const currentCellFiber = { memoizedProps: { resource: alternate.resource, rowIndex: 0 }, return: alternate.fiber.rowOwner, alternate: staleCellFiber };
    staleCellFiber.alternate = currentCellFiber;
    Object.defineProperty(alternate.body, '__reactFiber$fixture', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: staleCellFiber,
    });
    alternate.fiber.rowOwner.key = 'keyed-alternate';
    translated('stale-alternate', '备用相同原文', '错误的备用旧译文');
    translated('keyed-alternate', '备用相同原文', '正确的备用译文');
    sidebar.scan();
    check(textOf(alternate) === '正确的备用译文', 'current alternate fiber did not restore keyed identity');

    // A result may arrive before the corresponding row, and a recreated row
    // must bind again from the same stable resource ID.
    translated('late-row', '稍后到达', 'late translation');
    const late = addRow(light, { id: 'late-row', text: '稍后到达', name: 'Late row' });
    sidebar.scan();
    check(textOf(late) === 'late translation', 'late row did not bind');
    const lateAfterInitialScan = textOf(late);
    late.row.remove();
    sidebar.scan();
    const recreated = addRow(light, { id: 'late-row', text: '稍后到达', name: 'Recreated row' });
    sidebar.scan();
    check(textOf(recreated) === 'late translation', 'recreated row did not rebind');

    // Recycle one body for a new identity with the same original text. The
    // node is site-reset to the new original before the new result is applied.
    const recycled = addRow(light, { id: 'recycle-old', text: '同一原文', name: 'Recycled row' });
    translated('recycle-old', '同一原文', '旧译文');
    sidebar.scan();
    const recycledNode = recycled.body.firstChild;
    const recycledResource = recycled.resource;
    Object.assign(recycledResource, {
      id: () => 'recycle-new',
      text: () => '同一原文',
    });
    recycled.fiber?.rowOwner && (recycled.fiber.rowOwner.key = 'recycle-new');
    recycledNode.data = '同一原文';
    translated('recycle-new', '同一原文', '新译文');
    sidebar.scan();
    check(textOf(recycled) === '新译文' && recycled.body.firstChild === recycledNode, 'same-original recycled row did not rebind safely');

    // Wrong originals and invalid result values must never write.
    const wrong = addRow(light, { id: 'wrong-original', text: '站点原文', name: 'Wrong original' });
    sidebar.capture('wrong-original', '期望原文');
    sidebar.translated('wrong-original', '错误原文', '不应写入');
    sidebar.translated('wrong-original', '期望原文', '');
    sidebar.translated('wrong-original', '期望原文', '换行\n结果');
    sidebar.translated('wrong-original', '期望原文', 'x'.repeat(1001));
    sidebar.scan();
    check(textOf(wrong) === '站点原文', 'wrong/invalid result wrote to the row');

    // HTML-like output remains a text node, never markup.
    const htmlLike = addRow(light, { id: 'html-like', text: '纯文本', name: 'Text only' });
    translated('html-like', '纯文本', '<b>literal output</b>');
    sidebar.scan();
    check(textOf(htmlLike) === '<b>literal output</b>' && htmlLike.body.children.length === 0 && onlyTextNode(htmlLike), 'HTML-like output was parsed as markup');

    // NG/deleted/operator/gift and rich/unknown structures fail open.
    const ng = addRow(light, { id: 'ng-row', text: 'NG comment', type: 'normal', isNg: true });
    const deleted = addRow(light, { id: 'deleted-row', text: 'Deleted marker', type: 'normal', isDeleted: true });
    const operator = addRow(light, { id: 'operator-row', text: 'Operator message', type: 'operator' });
    const gift = addRow(light, { id: 'gift-row', text: 'Gift message', type: 'gift' });
    const rich = addRow(light, { id: 'rich-row', text: 'Rich message', rich: true });
    const unknown = addRow(light, { id: 'unknown-row', text: 'Unknown structure', withFiber: false, number: 99 });
    for (const row of [ng, deleted, operator, gift, rich, unknown]) translated(row.row.dataset.fixtureId, row.body.textContent, 'should not appear');
    sidebar.scan();
    check(textOf(ng) === 'NG comment' && textOf(deleted) === 'Deleted marker', 'NG/deleted row was changed');
    check(textOf(operator) === 'Operator message' && textOf(gift) === 'Gift message', 'operator/gift row was changed');
    check(textOf(rich) === 'Rich message rich-tail' && rich.body.children.length === 1, 'rich row was changed');
    check(textOf(unknown) === 'Unknown structure' && onlyTextNode(unknown), 'unknown React structure guessed an identity');

    // A source map remains bounded at the production limit. The first source
    // is evicted while the last remains usable.
    const bounded = new sidebar.constructor();
    const boundedHolder = document.createElement('div');
    boundedHolder.hidden = true;
    document.body.append(boundedHolder);
    for (let index = 0; index < 1201; index++) bounded.capture(`bounded-${index}`, `bounded-${index}`);
    bounded.translated('bounded-0', 'bounded-0', 'evicted');
    bounded.translated('bounded-1200', 'bounded-1200', 'retained');
    const evicted = addRow(boundedHolder, { id: 'bounded-0', text: 'bounded-0' });
    const retained = addRow(boundedHolder, { id: 'bounded-1200', text: 'bounded-1200' });
    bounded.scan();
    check(textOf(evicted) === 'bounded-0' && textOf(retained) === 'retained', 'source map bound was not enforced');
    boundedHolder.remove();

    const observedBeforeClear = {
      basic: textOf(basic),
      hidden: textOf(hidden),
      duplicateA: textOf(duplicateA),
      duplicateB: textOf(duplicateB),
      late: lateAfterInitialScan,
      recreated: textOf(recreated),
      recycled: textOf(recycled),
      wrong: textOf(wrong),
      htmlLike: textOf(htmlLike),
      ng: textOf(ng),
      deleted: textOf(deleted),
      operator: textOf(operator),
      gift: textOf(gift),
      rich: textOf(rich),
      unknown: textOf(unknown),
      staleRowIndex: textOf(staleIndex),
      alternate: textOf(alternate),
      evicted: textOf(evicted),
      retained: textOf(retained),
    };

    // Clear restores only rows whose current identity still matches the owned
    // binding. Site-owned changes and recycled rows are left untouched.
    const clearNormal = addRow(dark, { id: 'clear-normal', text: '清理原文', name: 'Clear normal' });
    const clearChanged = addRow(dark, { id: 'clear-changed', text: '站点原文', name: 'Site update' });
    const clearRecycled = addRow(dark, { id: 'clear-recycled-old', text: '旧身份原文', name: 'Recycled clear' });
    translated('clear-normal', '清理原文', '清理译文');
    translated('clear-changed', '站点原文', '站点译文');
    translated('clear-recycled-old', '旧身份原文', '旧译文');
    sidebar.scan();
    clearChanged.body.firstChild.data = '站点自主更新';
    const clearRecycledNode = clearRecycled.body.firstChild;
    const clearRecycledResource = clearRecycled.resource;
    Object.assign(clearRecycledResource, {
      id: () => 'clear-recycled-new',
      text: () => '旧译文',
    });
    clearRecycled.fiber?.rowOwner && (clearRecycled.fiber.rowOwner.key = 'clear-recycled-new');
    sidebar.capture('clear-recycled-new', '旧译文');
    const clearBefore = {
      normal: textOf(clearNormal),
      siteChanged: textOf(clearChanged),
      recycledSameAsOldOutput: textOf(clearRecycled),
    };
    sidebar.clear();
    check(textOf(clearNormal) === '清理原文', 'clear did not restore owned translation');
    check(textOf(clearChanged) === '站点自主更新', 'clear overwrote a site-owned text update');
    check(textOf(clearRecycled) === '旧译文' && clearRecycled.body.firstChild === clearRecycledNode, 'clear overwrote a recycled row whose new original matched old output');
    sidebar.scan();
    check(textOf(clearNormal) === '清理原文' && textOf(clearRecycled) === '旧译文', 'cleared sources rewrote rows on a later scan');

    visual.translated('visual-light', '代表性的普通评论，保持侧栏宽度。', '代表性翻译文本');
    visual.translated('visual-dark', '暗色侧栏中的代表性普通评论。', '暗色翻译文本');
    visual.scan();
    check(fixture.visualLight.body.textContent === '代表性翻译文本' && fixture.visualDark.body.textContent === '暗色翻译文本', 'visual after-state was not translated');

    return {
      basic: { text: observedBeforeClear.basic, sameTextNode: basic.body.firstChild === basicNode, menuPreserved: basic.row.dataset.menuClicked === 'true', listenerPreserved: basic.row.dataset.textEvent === 'true' },
      stableIds: { hidden: observedBeforeClear.hidden, duplicateA: observedBeforeClear.duplicateA, duplicateB: observedBeforeClear.duplicateB, staleRowIndex: observedBeforeClear.staleRowIndex, alternate: observedBeforeClear.alternate },
      lifecycle: { late: observedBeforeClear.late, recreated: observedBeforeClear.recreated, recycled: observedBeforeClear.recycled },
      rejection: { wrong: observedBeforeClear.wrong, htmlLike: observedBeforeClear.htmlLike, htmlChildElements: htmlLike.body.children.length, ng: observedBeforeClear.ng, deleted: observedBeforeClear.deleted, operator: observedBeforeClear.operator, gift: observedBeforeClear.gift, rich: observedBeforeClear.rich, unknown: observedBeforeClear.unknown },
      bounded: { evicted: observedBeforeClear.evicted, retained: observedBeforeClear.retained, limit: 1200 },
      clear: { before: clearBefore, after: { normal: textOf(clearNormal), siteChanged: textOf(clearChanged), recycledSameAsOldOutput: textOf(clearRecycled) } },
      visual: { light: fixture.visualLight.body.textContent, dark: fixture.visualDark.body.textContent },
    };
  });
  report.checks = checks;

  report.screenshots.afterLight = resolve(output, 'sidebar-light-after.png');
  report.screenshots.afterDark = resolve(output, 'sidebar-dark-after.png');
  await page.locator('[data-sidebar="light"]').screenshot({ path: report.screenshots.afterLight });
  await page.locator('[data-sidebar="dark"]').screenshot({ path: report.screenshots.afterDark });
  report.status = 'PASS';
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS Niconico sidebar DOM regression; ${resolve(output, 'report.json')}`);
} catch (error) {
  report.status = 'FAIL';
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(`FAIL Niconico sidebar DOM regression; ${resolve(output, 'report.json')}`);
  throw error;
} finally {
  await browser?.close();
}
