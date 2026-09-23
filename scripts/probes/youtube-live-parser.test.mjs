import assert from 'node:assert/strict';
import test from 'node:test';
import { YoutubeChatLedger, chatSelection, continuationFrom } from '../../src/platforms/youtube/chat.ts';
import { protectText, restoreText } from '../../src/translation/text.ts';
const item = (id, text, author = 'author-a') => ({ liveChatTextMessageRenderer: { id, message: { runs: [{ text }] }, authorExternalChannelId: author, timestampUsec: '1789204939787234' } });
const add = value => ({ addChatItemAction: { item: value } });
test('initial and recovered snapshots seed IDs without backfill; new IDs preserve receipt clock', () => {
  const ledger = new YoutubeChatLedger();
  assert.equal(ledger.read({ actions: [add(item('old', 'history'))] }, 1000, true).events.length, 0);
  const next = ledger.read({ actions: [add(item('old', 'history')), add(item('new', 'hello'))] }, 1500, false);
  assert.deepEqual(next.events.map(x => [x.sourceId, x.originalText, x.receivedAt]), [['new', 'hello', 1500]]);
  ledger.clear();
  assert.equal(ledger.read({ actions: [add(item('new', 'hello'))] }, 2000, true).events.length, 0);
});
test('same-batch delete suppresses add and leaves a tombstone against duplicate delivery', () => {
  const ledger = new YoutubeChatLedger();
  const deleted = ledger.read({ actions: [add(item('x', 'removed')), { removeChatItemAction: { targetItemId: 'x' } }] }, 1000, false);
  assert.deepEqual(deleted.removes, ['x']); assert.deepEqual(deleted.events, []);
  assert.deepEqual(ledger.read({ actions: [add(item('x', 'removed'))] }, 2000, false).events, []);
});
test('author deletion invalidates existing items but does not ban future messages', () => {
  const ledger = new YoutubeChatLedger();
  ledger.read({ actions: [add(item('x', 'one')), add(item('y', 'other', 'author-b'))] }, 1000, false);
  const removed = ledger.read({ actions: [{ markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'author-a' } }] }, 1200, false);
  assert.deepEqual(removed.removes, ['x']); assert.deepEqual(removed.removeAuthors, ['author-a']);
  assert.equal(ledger.read({ actions: [add(item('z', 'later'))] }, 1300, false).events.length, 1);
});
test('author deletion preserves messages added later in the same ordered response', () => {
  const ledger = new YoutubeChatLedger();
  ledger.read({ actions: [add(item('existing', 'earlier'))] }, 1000, false);
  const batch = ledger.read({ actions: [
    add(item('before', 'before deletion')),
    { markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'author-a' } },
    add(item('after', 'after deletion')),
    add(item('other', 'unaffected', 'author-b')),
  ] }, 2000, false);
  assert.deepEqual(batch.removes, ['existing', 'before']);
  assert.deepEqual(batch.removeAuthors, ['author-a']);
  assert.deepEqual(batch.events.map(event => event.sourceId), ['after', 'other']);
  assert.deepEqual(ledger.read({ actions: [add(item('before', 'replay')), add(item('after', 'duplicate'))] }, 3000, false).events, []);
});

test('replacement clears old item; same source ID is never displayed twice', () => {
  const ledger = new YoutubeChatLedger(); ledger.read({ actions: [add(item('x', 'old'))] }, 1000, false);
  const replacement = ledger.read({ actions: [{ replaceChatItemAction: { targetItemId: 'x', replacementItem: item('x', 'changed') } }] }, 1100, false);
  assert.deepEqual(replacement.removes, ['x']); assert.deepEqual(replacement.events, []);
  const unseen = ledger.read({ actions: [{ replaceChatItemAction: { targetItemId: 'historical', replacementItem: item('new-id', 'old changed') } }] }, 1200, false);
  assert.deepEqual(unseen.events, []);
});
test('ordinary mixed emoji retains protectable shortcuts; paid messages are excluded', () => {
  const value = item('x', 'Hi '); value.liveChatTextMessageRenderer.message.runs.push({ emoji: { shortcuts: [':face-purple-wide-eyes:'] } });
  const ledger = new YoutubeChatLedger();
  const result = ledger.read({ actions: [add(value), add({ liveChatPaidMessageRenderer: { id: 'paid', message: { simpleText: 'paid' } } })] }, 1000, false);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].originalText, 'Hi :face-purple-wide-eyes:'); assert.equal(result.events[0].translatable, true);
});
test('unknown emoji preserves accessible original text and skips translation', () => {
  const value = item('x', 'Hello '); value.liveChatTextMessageRenderer.message.runs.push({ emoji: { image: { accessibility: { accessibilityData: { label: 'custom wave' } } } } });
  const result = new YoutubeChatLedger().read({ actions: [add(value)] }, 1000, false);
  assert.equal(result.events[0].originalText, 'Hello custom wave'); assert.equal(result.events[0].translatable, false);
});
test('Unicode emoji wins over its alias and survives translation protection unchanged', () => {
  for (const glyph of ['😂', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣', '❤️']) {
    const value = item('unicode', 'Hello ');
    value.liveChatTextMessageRenderer.message.runs.push({ emoji: { emojiId: glyph, shortcuts: [':display-name:'] } });
    const event = new YoutubeChatLedger().read({ actions: [add(value)] }, 1000, false).events[0];
    assert.equal(event.originalText, 'Hello ' + glyph);
    assert.equal(event.translatable, true);
    const protectedText = protectText(event.originalText);
    assert.equal(restoreText(protectedText, protectedText.text.replace('Hello', '你好')), '你好 ' + glyph);
    assert.equal(restoreText(protectedText, '你好'), undefined, 'missing glyph token must fall back to original');
  }
});
test('Unicode shortcut remains intact when custom emoji ID is not a glyph', () => {
  const value = item('unicode-shortcut', 'Great ');
  value.liveChatTextMessageRenderer.message.runs.push({ emoji: { emojiId: 'opaque-custom-id', shortcuts: [':thumbs-up:', '👍🏽'] } });
  const event = new YoutubeChatLedger().read({ actions: [add(value)] }, 1000, false).events[0];
  assert.equal(event.originalText, 'Great 👍🏽');
});
test('server continuation interval and explicit two-option filter are preserved', () => {
  assert.equal(continuationFrom({ continuations: [{ invalidationContinuationData: { continuation: 'opaque', timeoutMs: 10000 } }] }).timeoutMs, 10000);
  const subMenuItems = [false, true].map(selected => ({ selected, continuation: { reloadContinuationData: { continuation: 'opaque' } } }));
  assert.equal(chatSelection({ header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems } } } } }).coverage, 'all');
  assert.equal(chatSelection({ header: {} }).coverage, 'unknown');
});
