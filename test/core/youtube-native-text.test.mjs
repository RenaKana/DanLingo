import assert from 'node:assert/strict';
import test from 'node:test';
import { placeholderTokens } from '../../src/translation/text.ts';
import { prepareNativeChatText } from '../../src/platforms/youtube/native-text.ts';

const customEmoji = () => ({ emoji: { image: { accessibility: { accessibilityData: { label: 'custom wave' } } } } });

function richMessage() {
  return {
    accessibility: { accessibilityData: { label: 'original chat' } },
    runs: [
      { text: '你好' },
      { text: '\r\n' },
      customEmoji(),
      { text: ' 世界 ' },
      { text: '链接', navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=abc' } } } },
      { text: '重点', bold: true, italics: true },
      { text: '尾' },
    ],
  };
}

function translatedRich(prepared) {
  return prepared.text.replace('你好', 'Hello').replace(' 世界 ', ' world ').replace('尾', 'tail');
}

test('simpleText translation preserves metadata and does not mutate the source', () => {
  const source = { simpleText: 'こんにちは world', accessibilityData: { label: 'keep me' }, timestampUsec: '123' };
  const before = structuredClone(source);
  const prepared = prepareNativeChatText(source);
  assert.ok(prepared);
  assert.equal(prepared.text, source.simpleText);
  assert.equal(prepared.translatable, true);
  assert.deepEqual(prepared.restore('Hello world'), { ...source, simpleText: 'Hello world' });
  assert.deepEqual(source, before);
});

test('simpleText protects and restores each original line break exactly', () => {
  const source = { simpleText: '上\r\n中\n下', metadata: { keep: true } };
  const before = structuredClone(source);
  const prepared = prepareNativeChatText(source);
  assert.ok(prepared);
  const tokens = placeholderTokens(prepared.text).filter(token => token.startsWith('[[DL:ytchat_v1_'));
  assert.equal(tokens.length, 2);
  const translated = prepared.text.replace('上', 'top').replace('中', 'middle').replace('下', 'bottom');
  const restored = prepared.restore(translated);
  assert.ok(restored);
  assert.equal(restored.simpleText, 'top\r\nmiddle\nbottom');
  assert.deepEqual(restored.metadata, source.metadata);
  assert.equal(Object.hasOwn(restored, 'runs'), false);
  assert.equal(prepared.restore(translated.replace(tokens[1], '')), null);
  assert.deepEqual(source, before);
});

test('rich runs translate prose while preserving emoji, links, styles, and line breaks', () => {
  const source = richMessage();
  const before = structuredClone(source);
  const prepared = prepareNativeChatText(source);
  assert.ok(prepared);
  assert.equal(prepared.translatable, true);
  const tokens = placeholderTokens(prepared.text).filter(token => token.startsWith('[[DL:ytchat_v1_'));
  assert.equal(tokens.length, 4);
  const restored = prepared.restore(translatedRich(prepared));
  assert.ok(restored);
  assert.deepEqual(restored.runs, [
    { text: 'Hello' },
    { text: '\r\n' },
    source.runs[2],
    { text: ' world ' },
    source.runs[4],
    source.runs[5],
    { text: 'tail' },
  ]);
  assert.deepEqual(restored.accessibility, source.accessibility);
  assert.deepEqual(source, before);
});

test('pre-existing placeholder literals survive and generated tokens remain deterministic and separate', () => {
  const literal = '[[DL:ytchat_v1_literal_0]]';
  const source = { runs: [{ text: `前 ${literal} 后` }, customEmoji()] };
  const prepared = prepareNativeChatText(source);
  assert.ok(prepared);
  assert.equal(prepared.text, prepareNativeChatText(structuredClone(source)).text);
  assert.ok(prepared.text.includes(literal));
  const generated = placeholderTokens(prepared.text).filter(token => token !== literal);
  assert.equal(generated.length, 1);
  assert.notEqual(generated[0], literal);
  const restored = prepared.restore(prepared.text.replace(`前 ${literal} 后`, `Before ${literal} after`));
  assert.deepEqual(restored?.runs, [{ text: `Before ${literal} after` }, source.runs[1]]);
});

test('restoration rejects invented, removed, and reordered placeholders', () => {
  const prepared = prepareNativeChatText(richMessage());
  assert.ok(prepared);
  const tokens = placeholderTokens(prepared.text).filter(token => token.startsWith('[[DL:ytchat_v1_'));
  const translated = translatedRich(prepared);
  const marker = '\u0000TOKEN\u0000';
  const reordered = translated.replace(tokens[0], marker).replace(tokens[1], tokens[0]).replace(marker, tokens[1]);
  assert.equal(prepared.restore(reordered), null);
  assert.equal(prepared.restore(translated.replace(tokens[0], '[[DL:ytchat_v1_invented_0]]')), null);
  assert.equal(prepared.restore(translated.replace(tokens[0], '')), null);
  assert.equal(prepared.restore(`${translated} [[DL:invented]]`), null);
});

test('size and shape limits are enforced, while pure fragments retain the original clone', () => {
  assert.equal(prepareNativeChatText({ simpleText: 'a'.repeat(1001) }), null);
  assert.equal(prepareNativeChatText({ runs: [{ text: 'a'.repeat(1001) }] }), null);
  assert.equal(prepareNativeChatText({ runs: Array.from({ length: 201 }, () => ({ text: 'a' })) }), null);
  assert.equal(prepareNativeChatText({ simpleText: '' }), null);

  const plain = prepareNativeChatText({ simpleText: 'hello' });
  assert.ok(plain);
  assert.equal(plain.restore(''), null);
  assert.equal(plain.restore('x'.repeat(2001)), null);

  const source = { metadata: { keep: true }, runs: [customEmoji()] };
  const before = structuredClone(source);
  const prepared = prepareNativeChatText(source);
  assert.ok(prepared);
  assert.equal(prepared.translatable, false);
  assert.match(prepared.text, /^\[\[DL:ytchat_v1_[^\]]+\]\]$/u);
  const restored = prepared.restore('forged prose [[DL:evil]]');
  assert.deepEqual(restored, source);
  assert.notEqual(restored, source);
  assert.deepEqual(source, before);
});
