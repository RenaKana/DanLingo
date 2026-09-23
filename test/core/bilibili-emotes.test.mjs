import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineEmotes, prepareEmoteText, emoteProse, emoteUrl } from '../../src/platforms/bilibili-live/emotes.ts';
import { ordinaryComment, translatedPacket } from '../../src/platforms/bilibili-live/messages.ts';
import { captureNativeDispatch } from '../../src/platforms/bilibili-live/dispatch.ts';
import { BilibiliNativeQueue } from '../../src/platforms/bilibili-live/queue.ts';
import { BilibiliRepairs } from '../../src/platforms/bilibili-live/repairs.ts';
import { needsTranslation } from '../../src/core/messages.ts';
import { protectText } from '../../src/translation/text.ts';

const metadata = { '[笑]': { url: 'https://i0.hdslb.com/bfs/emote/fixture.png', width: 24, height: 24, emoticon_unique: 'inline-id' } };
const packet = (text, emots = metadata, extra = {}) => {
  const style = [0, 1, 25, 0xffffff]; style[15] = { extra: JSON.stringify({ id_str: 'opaque-A', emots, ...extra }) };
  return { cmd: 'DANMU_MSG', info: [style, text] };
};

test('inline image plus prose is eligible, empty map is harmless, pure pictures and unknown effects remain original', () => {
  assert.equal(ordinaryComment(packet('今日は楽しい[笑]'), 'occ:1').translatable, true);
  assert.equal(ordinaryComment(packet('[笑]今日は楽しい[笑]'), 'occ:1').translatable, true);
  assert.equal(ordinaryComment(packet('[笑][笑]！'), 'occ:1').translatable, false);
  assert.equal(ordinaryComment(packet('今日は楽しい', {}), 'occ:1').translatable, true);
  for (const emots of [[], true, { '[笑]': {} }, { '[笑]': { url: 'javascript:alert(1)' } }, { invalid: { url: metadata['[笑]'].url } }]) {
    assert.equal(ordinaryComment(packet('今日は楽しい[笑]', emots), 'occ:1').translatable, false);
  }
  for (const extra of [{ animation: { type: 1 } }, { mode: 1 }, { dm_type: 1 }, { emoticon_unique: 'large-image' }]) {
    assert.equal(ordinaryComment(packet('今日は楽しい[笑]', metadata, extra), 'occ:1').translatable, false);
  }
  const large = packet('今日は楽しい[笑]'); large.info[0][12] = 1;
  assert.equal(ordinaryComment(large, 'occ:1').translatable, false);
  const mode = packet('今日は楽しい[笑]'); mode.info[0][15].mode = 3012;
  assert.equal(ordinaryComment(mode, 'occ:1').translatable, false);
  for (const extra of ['x'.repeat(16001), { emots: metadata }]) {
    const invalid = packet('今日は楽しい[笑]'); invalid.info[0][15].extra = extra;
    assert.equal(ordinaryComment(invalid, 'occ:1'), null, 'unreadable emote metadata must not fall back to unprotected text translation');
  }
});

test('multiple aliases preserve occurrence order and match HTTPS-upgraded native URLs', () => {
  assert.equal(emoteUrl('http://example.test/smile.png'), 'https://example.test/smile.png');
  assert.equal(emoteUrl('//example.test/smile.png'), 'https://example.test/smile.png');
  assert.equal(emoteUrl('https://user:secret@example.test/smile.png'), null);
  const original = '[笑]今日は[泣]楽しい[笑]', plan = prepareEmoteText(original, ['[笑]', '[泣]']);
  const translated = plan.text.replace('今日は', '今天').replace('楽しい', '很开心');
  assert.equal(plan.restore(translated), '[笑]今天[泣]很开心[笑]');
  assert.equal(plan.restore(translated.replace('bili0_0', 'swap').replace('bili0_1', 'bili0_0').replace('swap', 'bili0_1')), undefined);
});

test('ordinary and timeout retry eligibility inspect prose, not registered alias face markers or letters', () => {
  const map = { '[泣ω]': { url: metadata['[笑]'].url }, '[happy]': { url: metadata['[笑]'].url } };
  const source = ordinaryComment(packet('今日は[泣ω]楽しい', map), 'occ:1'), sent = [];
  const eligible = text => needsTranslation(text, 'zh-Hans', 'auto') && !protectText(text).reason;
  assert.equal(eligible(source.originalText), false);
  assert.equal(eligible(emoteProse(source.originalText, source.inlineEmotes)), true);
  let now = 0;
  const ledger = new BilibiliRepairs({ now: () => now, active: () => true, eligible, timeoutMs: () => 5000, send: value => sent.push(value) });
  ledger.capture(source);
  const queue = new BilibiliNativeQueue({ now: () => now, current: () => true, active: () => true, eligible,
    setTimeout() {}, clearTimeout() {}, source: value => assert.equal(value.translatable, true), decision() {}, removed() {},
    retryPolicy: () => ({ timeoutMs: 1000, hold: true }), retry: (value, deadline) => ledger.requestTimeout(value.sourceId, deadline-now) });
  const shown = []; queue.add(source, 500, value => shown.push(value)); assert.equal(shown.length, 0);
  now = 500; queue.pump(); const request = sent.find(value => value.type === 'repair-request'); assert.equal(request.purpose, 'timeout');
  assert.equal(queue.retryResult(source.sourceId, source.originalText, '丢失图片'), false);
  assert.equal(queue.retryResult(source.sourceId, source.originalText, '今天[泣ω]很开心', true), true);
  assert.equal(shown[0].info[1], '今天[泣ω]很开心');
  now = 2000; assert.equal(queue.retryResult(source.sourceId, source.originalText, '过期[泣ω]结果'), false);
  const chinese = ordinaryComment(packet('中文[happy]留言', map), 'occ:2');
  assert.equal(eligible(emoteProse(chinese.originalText, chinese.inlineEmotes)), false, 'English alias does not make Chinese prose require translation');
});

test('only registered aliases become collision-safe ordered placeholders; image URLs never enter request text', () => {
  const original = '[[DL:bili0_0]][笑]今日は[普通の文章]楽しい[笑]';
  const plan = prepareEmoteText(original, ['[笑]']);
  assert.equal(plan.hasProse, true); assert.equal(plan.text.includes('[笑]'), false);
  assert.equal(plan.text.includes('https:'), false); assert.equal(plan.text.includes('[普通の文章]'), true);
  const translated = plan.text.replace('今日は', '今天').replace('[普通の文章]楽しい', '很开心');
  assert.equal(plan.restore(translated), '[[DL:bili0_0]][笑]今天很开心[笑]');
  assert.equal(plan.restore(translated.replace('[[DL:bili1_0]]', '')), undefined);
  assert.equal(plan.restore(translated.replace('[[DL:bili1_0]]', '[[DL:bili1_1]]')), undefined);
  assert.equal(plan.restore(translated + '[笑]'), undefined);
  assert.equal(prepareEmoteText('hello', ['[笑]']), null);
  assert.equal(prepareEmoteText('[笑][笑]', ['[笑]']).hasProse, false);
});

test('native dispatch runs original filtering once and keeps emote data in both native output copies', () => {
  const input = packet('今日は楽しい[笑]'), source = ordinaryComment(input, 'occ:1'), seen = [], map = metadata;
  let filters = 0;
  const engine = { danmaku: { add(value) { seen.push({ screen: value }); } } };
  const context = { isBlocked(value) { filters++; assert.equal(value.text, input.info[1]); return false; }, emitDanmaku(value) { seen.push({ chat: value }); } };
  const original = function (wire, ctx) { const decoded = { text: wire.info[1], emoticons: map }; if (!ctx.isBlocked(decoded)) { this.danmaku.add(decoded); ctx.emitDanmaku(wire); } };
  const captured = captureNativeDispatch(engine, context, original, [input, context], source);
  assert.equal(captured.translatable, true); assert.equal(filters, 1); assert.equal(seen.length, 0);
  captured.submit(translatedPacket(source, '今天真开心[笑]'));
  assert.equal(seen[0].screen.text, '今天真开心[笑]'); assert.equal(seen[0].screen.emoticons, map);
  assert.equal(seen[1].chat.info[1], '今天真开心[笑]'); assert.equal(seen[1].chat.info[0], input.info[0]);
  assert.equal(input.info[1], '今日は楽しい[笑]'); assert.equal(filters, 1);
});

test('queue and forced repairs reject lost emotes while retaining saved original, metadata and distinct translation versions', () => {
  const source = ordinaryComment(packet('今日は楽しい[笑]'), 'occ:1'), shown = [], sent = [];
  const queue = new BilibiliNativeQueue({ now: () => 0, current: () => true, active: () => true, eligible: () => true,
    setTimeout() {}, clearTimeout() {}, source() {}, decision() {}, removed() {} });
  queue.add(source, 2000, value => shown.push(value));
  assert.equal(queue.prepare(source.sourceId, source.originalText, '漏掉表情'), false);
  assert.equal(queue.prepare(source.sourceId, source.originalText, '今天开心[笑]'), true);
  assert.equal(shown[0].info[1], '今天开心[笑]');
  const ledger = new BilibiliRepairs({ now: () => 0, active: () => true, eligible: () => true, timeoutMs: () => 15000, send: value => sent.push(value) });
  ledger.capture(source); ledger.normal(source.sourceId, '今天开心[笑]'); ledger.confirm(source.sourceId, '今天开心[笑]');
  const force = ledger.request(source.sourceId, true, true);
  ledger.result({ sourceId: source.sourceId, requestId: force, status: 'translated', text: '又漏表情' });
  assert.equal(ledger.get(source.sourceId).text, '今天开心[笑]');
  const next = ledger.request(source.sourceId, true, true);
  ledger.result({ sourceId: source.sourceId, requestId: next, status: 'translated', text: '第二份译文[笑]' });
  assert.equal(ledger.get(source.sourceId).displayedText, '今天开心[笑]');
  assert.equal(ledger.get(source.sourceId).text, '第二份译文[笑]');
  assert.equal(ledger.get(source.sourceId).originalText, source.originalText);
  assert.deepEqual(ledger.get(source.sourceId).inlineEmotes, inlineEmotes(metadata));
  assert.deepEqual(sent.find(value => value.type === 'repair-record').emoteTokens, ['[笑]']);
});
