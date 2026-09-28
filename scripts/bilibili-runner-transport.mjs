// Authenticated, fixed-extension loopback transport shared by Bilibili runners.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { browserExecutablePath } from './browser-runtime.mjs';

export const BILIBILI_RUNNER_EXTENSION_ID = 'oibgpmpodmpojgengjhdeadfnkplhigo';
const COMMANDS = new Set(['rpc', 'reload', 'openTarget', 'audit', 'close-owned', 'close-render-preview-owned',
  'close-live-preview-owned', 'close-native-supply-owned', 'userFilters', 'displayPlan', 'renderPreview',
  'livePreview', 'nativeSupply', 'ownedSupplyStatus']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function consumeCommandResult(data, pending, late, now = Date.now()) {
  const item = pending.get(data.id);
  if (!item) {
    const expiresAt = late.get(data.id);
    assert.ok(expiresAt && expiresAt >= now, 'unknown-command');
    late.delete(data.id);
    return 'late';
  }
  pending.delete(data.id);
  clearTimeout(item.timer);
  data.ok ? item.resolve(data.result) : item.reject(Error(data.error ?? 'command-failed'));
  return 'active';
}

export function createBilibiliRunnerTransport({ extensionId = BILIBILI_RUNNER_EXTENSION_ID } = {}) {
  const token = randomBytes(32).toString('hex');
  const queue = [], pending = new Map(), late = new Map();
  let server, poll, hello, serial = 0, shuttingDown = false;

  function reply(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': `chrome-extension://${extensionId}`,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    res.end(JSON.stringify(value));
  }
  function deliver() {
    if (poll && queue.length) {
      const current = poll;
      poll = null;
      clearTimeout(current.timer);
      reply(current.res, 200, queue.shift());
    }
  }
  function openPage() {
    assert.ok(server?.listening, 'Runner transport is not connected');
    hello = null;
    const url = `chrome-extension://${extensionId}/dispatch-runner.html#port=${server.address().port}&token=${token}`;
    spawn(browserExecutablePath('chrome'), [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  function control(command, payload = {}, timeout = 45000) {
    assert.ok(COMMANDS.has(command), 'Unknown runner command');
    const id = String(++serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const queued = queue.findIndex(item => item.id === id);
        if (queued >= 0) queue.splice(queued, 1);
        else late.set(id, Date.now() + 120000);
        reject(Error(`Command timed out: ${command}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      queue.push({ id, command, payload });
      deliver();
    });
  }
  async function waitHello(timeout = 60000) {
    const end = Date.now() + timeout;
    do {
      if (hello) return hello;
      await delay(200);
    } while (Date.now() < end);
    throw Error('Timed out: extension connection; complete the one-time Connect permission on its page');
  }
  async function connect() {
    assert.ok(!server, 'Runner transport already started');
    server = createServer(async (req, res) => {
      if (req.headers.origin !== `chrome-extension://${extensionId}` || req.socket.remoteAddress !== '127.0.0.1')
        return reply(res, 403, {});
      if (req.method === 'OPTIONS') return reply(res, 200, {});
      const got = Buffer.from(req.headers.authorization ?? ''), want = Buffer.from(`Bearer ${token}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply(res, 403, {});
      if (req.method === 'POST' && req.url === '/command') {
        if (shuttingDown) return reply(res, 200, { idle: true, closing: true });
        if (poll) return reply(res, 409, { error: 'controller-already-connected' });
        const timer = setTimeout(() => { if (poll?.res === res) poll = null; reply(res, 200, { idle: true }); }, 20000);
        poll = { res, timer };
        res.on('close', () => { if (poll?.res === res) { clearTimeout(timer); poll = null; } });
        deliver();
        return;
      }
      if (req.method !== 'POST' || !['/hello', '/result'].includes(req.url)) return reply(res, 404, {});
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 * 1024 * 1024) throw Error('response-too-large');
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (req.url === '/hello') { assert.equal(data.extensionId, extensionId); hello = data; }
        else consumeCommandResult(data, pending, late);
        reply(res, 200, { ok: true });
      } catch (error) { reply(res, 400, { error: error.message }); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    openPage();
    return waitHello();
  }
  async function close() {
    shuttingDown = true;
    queue.length = 0;
    for (const item of pending.values()) clearTimeout(item.timer);
    if (poll) { clearTimeout(poll.timer); reply(poll.res, 200, { idle: true, closing: true }); }
    if (hello) await delay(250);
    server?.closeAllConnections();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
  }
  return { connect, control, openPage, waitHello, close, get hello() { return hello; },
    redact(message) { return String(message).replaceAll(token, '[session]'); } };
}
