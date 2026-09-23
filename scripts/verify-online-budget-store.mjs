import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';

function argumentsFrom(argv) {
  const options = {
    playwrightModule: process.env.DANLINGO_PLAYWRIGHT_MODULE || process.env.PLAYWRIGHT_MODULE,
    chromiumPath: process.env.DANLINGO_TEST_BROWSER || process.env.DANLINGO_E2E_EXECUTABLE || process.env.CHROMIUM_EXECUTABLE_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') {
      console.log('node scripts/verify-online-budget-store.mjs [--playwright-module PATH] [--chromium PATH]\nRuns isolated offline Chromium checks against real IndexedDB. Uses browser-runtime.mjs and DANLINGO_* environment settings; legacy PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE_PATH are also accepted.');
      process.exit(0);
    }
    if (key !== '--playwright-module' && key !== '--chromium') throw new Error(`Unsupported argument: ${key}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    options[key === '--playwright-module' ? 'playwrightModule' : 'chromiumPath'] = value;
    index += 1;
  }
  return options;
}

const options = argumentsFrom(process.argv.slice(2));
const { chromium } = options.playwrightModule
  ? await import(pathToFileURL(resolve(options.playwrightModule)).href) : await loadPlaywright();
const source = await readFile(new URL('../src/core/online-budget.ts', import.meta.url), 'utf8');
const browserModule = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  fileName: 'src/core/online-budget.ts',
}).outputText;

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end('<!doctype html><meta charset="utf-8"><title>Online budget IndexedDB checks</title>');
});
await new Promise((resolvePromise, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolvePromise);
});

let browser;
try {
  browser = await chromium.launch({
    ...browserLaunchOptions('chromium', { executablePath: options.chromiumPath }),
    headless: true,
    args: ['--disable-background-networking', '--disable-sync', '--no-first-run'],
  });
  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}/`;
  const pages = await Promise.all(Array.from({ length: 3 }, () => context.newPage()));

  for (const page of pages) {
    await page.goto(origin);
    await page.evaluate(async moduleText => {
      const moduleUrl = URL.createObjectURL(new Blob([moduleText], { type: 'text/javascript' }));
      try {
        globalThis.__onlineBudgetModule = await import(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
    }, browserModule);
  }
  await context.setOffline(true);

  const databaseName = `online-budget-harness-${randomUUID()}`;
  const dayA = '2026-02-02';
  const beforeMidnight = '2026-02-02T15:59:59.000Z';
  const afterMidnight = '2026-02-02T16:00:00.000Z';
  const makeBudget = (page, name, instant) => page.evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).read(100);
  }, { name, instant });
  await Promise.all(pages.map(page => makeBudget(page, databaseName, beforeMidnight)));

  const reserveMany = (page, count, limit, instant) => page.evaluate(async ({ count: amount, limit: cap, instant: clock, name: dbName }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    const attempts = Array.from({ length: amount }, () => new OnlineRequestBudget({
      databaseName: dbName,
      now: () => new Date(clock),
    }).reserve(cap));
    const results = await Promise.allSettled(attempts);
    return results.map(result => result.status === 'fulfilled'
      ? { status: 'fulfilled', state: result.value }
      : { status: 'rejected', code: result.reason?.code ?? null });
  }, { count, limit, instant, name: databaseName });

  const [left, right] = await Promise.all([
    reserveMany(pages[0], 12, 7, beforeMidnight),
    reserveMany(pages[1], 12, 7, beforeMidnight),
  ]);
  const concurrent = [...left, ...right];
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 7, 'concurrent instances must grant exactly the limit');
  assert.equal(concurrent.filter(result => result.code === 'online-daily-limit-reached').length, 17, 'all remaining reservations must report exhaustion');
  assert.ok(concurrent.filter(result => result.status === 'fulfilled').every(result => result.state.day === dayA));

  const rebuilt = await pages[2].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    const budget = new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) });
    return Promise.all([budget.read(6), budget.read(10), budget.reserve(10)]);
  }, { name: databaseName, instant: beforeMidnight });
  assert.deepEqual(rebuilt.map(state => [state.used, state.status]), [[7, 'exhausted'], [7, 'available'], [8, 'available']]);

  const dayB = await pages[1].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).reserve(4);
  }, { name: databaseName, instant: afterMidnight });
  assert.equal(dayB.day, '2026-02-03');
  assert.equal(dayB.used, 1);
  const oldDay = await pages[2].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).read(10);
  }, { name: databaseName, instant: beforeMidnight });
  assert.equal(oldDay.used, 8, 'returning to a prior date must retain its independent record');
  const dayBAgain = await pages[0].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).read(4);
  }, { name: databaseName, instant: afterMidnight });
  assert.equal(dayBAgain.used, 1, 'raising or lowering another day’s limit must not change this day');

  const midnightDatabase = `${databaseName}-queued-midnight`;
  await pages[1].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    globalThis.__onlineBudgetClock = clock;
    globalThis.__onlineBudgetForMidnight = new OnlineRequestBudget({
      databaseName: dbName,
      now: () => new Date(globalThis.__onlineBudgetClock),
    });
    return globalThis.__onlineBudgetForMidnight.read(5);
  }, { name: midnightDatabase, instant: beforeMidnight });
  await pages[0].evaluate(({ name: dbName, storeName, day }) => new Promise((resolvePromise, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(storeName, 'readwrite');
      const objectStore = transaction.objectStore(storeName);
      let requests = 0;
      let stopped = false;
      const pump = () => {
        if (stopped || requests >= 50000) return;
        requests += 1;
        const request = objectStore.get(day);
        request.onsuccess = pump;
        request.onerror = () => reject(request.error);
      };
      transaction.onabort = () => { database.close(); resolvePromise(); };
      transaction.oncomplete = () => { database.close(); resolvePromise(); };
      globalThis.__onlineBudgetLock = {
        stop: () => {
          stopped = true;
          try { transaction.abort(); } catch { /* It may already have completed. */ }
        },
      };
      pump();
      resolvePromise();
    };
  }), { name: midnightDatabase, storeName: 'daily-usage', day: dayA });
  await pages[1].evaluate(() => {
    globalThis.__onlineBudgetMidnightResults = Promise.all([
      globalThis.__onlineBudgetForMidnight.read(5),
      globalThis.__onlineBudgetForMidnight.reserve(5),
    ]);
  });
  await pages[1].waitForTimeout(40);
  await pages[1].evaluate(clock => { globalThis.__onlineBudgetClock = clock; }, afterMidnight);
  await pages[0].evaluate(() => globalThis.__onlineBudgetLock.stop());
  const midnightResults = await pages[1].evaluate(() => globalThis.__onlineBudgetMidnightResults);
  assert.deepEqual(midnightResults.map(state => [state.day, state.used]), [['2026-02-03', 0], ['2026-02-03', 1]]);
  const priorDayAfterQueue = await pages[2].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).read(5);
  }, { name: midnightDatabase, instant: beforeMidnight });
  assert.equal(priorDayAfterQueue.used, 0, 'a request queued across midnight must not charge the prior day');

  const corruptDatabase = `${databaseName}-corrupt`;
  await makeBudget(pages[0], corruptDatabase, beforeMidnight);
  await pages[0].evaluate(({ name: dbName, storeName }) => new Promise((resolvePromise, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put({ day: '2026-02-02', used: 'not-a-count' });
      transaction.oncomplete = () => { database.close(); resolvePromise(); };
      transaction.onabort = () => reject(transaction.error);
    };
  }), { name: corruptDatabase, storeName: 'daily-usage' });
  const corruptRead = await pages[0].evaluate(({ name: dbName }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date('2026-02-02T15:59:59.000Z') }).read(5);
  }, { name: corruptDatabase });
  assert.deepEqual([corruptRead.status, corruptRead.used, corruptRead.remaining, corruptRead.reason], ['unavailable', null, null, 'online-budget-storage-unavailable']);
  const corruptReserveCode = await pages[0].evaluate(async ({ name: dbName }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    try {
      await new OnlineRequestBudget({ databaseName: dbName, now: () => new Date('2026-02-02T15:59:59.000Z') }).reserve(5);
      return null;
    } catch (error) { return error.code; }
  }, { name: corruptDatabase });
  assert.equal(corruptReserveCode, 'online-budget-storage-unavailable');

  const cancellationDatabase = `${databaseName}-cancel`;
  await makeBudget(pages[1], cancellationDatabase, beforeMidnight);
  await pages[0].evaluate(({ name: dbName, storeName, day }) => new Promise((resolvePromise, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(storeName, 'readwrite');
      const objectStore = transaction.objectStore(storeName);
      let requests = 0;
      let stopped = false;
      const pump = () => {
        if (stopped || requests >= 50000) return;
        requests += 1;
        const request = objectStore.get(day);
        request.onsuccess = pump;
        request.onerror = () => reject(request.error);
      };
      transaction.onabort = () => { database.close(); resolvePromise(); };
      transaction.oncomplete = () => { database.close(); resolvePromise(); };
      globalThis.__onlineBudgetLock = {
        stop: () => {
          stopped = true;
          try { transaction.abort(); } catch { /* It may already have completed. */ }
        },
      };
      pump();
      resolvePromise();
    };
  }), { name: cancellationDatabase, storeName: 'daily-usage', day: dayA });
  await pages[1].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    const controller = new AbortController();
    const budget = new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) });
    globalThis.__onlineBudgetController = controller;
    globalThis.__onlineBudgetPending = budget.reserve(1, controller.signal).then(
      () => ({ code: null }),
      error => ({ code: error.code ?? null }),
    );
  }, { name: cancellationDatabase, instant: beforeMidnight });
  await pages[1].waitForTimeout(40);
  await pages[1].evaluate(() => globalThis.__onlineBudgetController.abort());
  await pages[0].evaluate(() => globalThis.__onlineBudgetLock.stop());
  const cancellation = await pages[1].evaluate(() => globalThis.__onlineBudgetPending);
  assert.equal(cancellation.code, 'cancelled');
  const afterCancellation = await pages[2].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).read(5);
  }, { name: cancellationDatabase, instant: beforeMidnight });
  assert.equal(afterCancellation.used, 0, 'cancelled reservations must not consume a slot');

  const failedRead = await pages[0].evaluate(() => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    const budget = new OnlineRequestBudget({ indexedDB: { open() { throw new Error('open failed'); } } });
    return budget.read(3);
  });
  assert.deepEqual([failedRead.status, failedRead.used, failedRead.remaining], ['unavailable', null, null]);
  const failedReserve = await pages[0].evaluate(async () => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    const budget = new OnlineRequestBudget({ indexedDB: { open() { throw new Error('open failed'); } } });
    try { await budget.reserve(3); return null; }
    catch (error) { return error.code; }
  });
  assert.equal(failedReserve, 'online-budget-storage-unavailable');

  const schemaDatabase = `${databaseName}-schema`;
  await pages[0].evaluate(({ name: dbName }) => new Promise((resolvePromise, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('daily-usage', { keyPath: 'used' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolvePromise(); };
  }), { name: schemaDatabase });
  const incompatibleSchema = await pages[0].evaluate(({ name: dbName }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date('2026-02-02T15:59:59.000Z') }).read(3);
  }, { name: schemaDatabase });
  assert.deepEqual([incompatibleSchema.status, incompatibleSchema.used], ['unavailable', null]);

  const versionDatabase = `${databaseName}-version`;
  const versionBudget = await pages[2].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    const budget = new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) });
    return budget.read(3);
  }, { name: versionDatabase, instant: beforeMidnight });
  assert.equal(versionBudget.used, 0);
  const upgraded = await pages[0].evaluate(({ name: dbName }) => new Promise((resolvePromise, reject) => {
    const open = indexedDB.open(dbName, 2);
    const timer = setTimeout(() => reject(new Error('Version upgrade timed out')), 2000);
    open.onblocked = () => { clearTimeout(timer); reject(new Error('Budget connection blocked a version upgrade')); };
    open.onerror = () => { clearTimeout(timer); reject(open.error); };
    open.onsuccess = () => { clearTimeout(timer); open.result.close(); resolvePromise(true); };
  }), { name: versionDatabase });
  assert.equal(upgraded, true);
  const oldVersionRead = await pages[2].evaluate(({ name: dbName, instant: clock }) => {
    const { OnlineRequestBudget } = globalThis.__onlineBudgetModule;
    return new OnlineRequestBudget({ databaseName: dbName, now: () => new Date(clock) }).read(3);
  }, { name: versionDatabase, instant: beforeMidnight });
  assert.deepEqual([oldVersionRead.status, oldVersionRead.used], ['unavailable', null]);

  await context.close();
  console.log('PASS: real IndexedDB concurrency, persistence, limit changes, local-day partitioning and queued-midnight rollover, corruption, cancellation, open failure, schema validation, and versionchange handling.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolvePromise => server.close(resolvePromise));
}
