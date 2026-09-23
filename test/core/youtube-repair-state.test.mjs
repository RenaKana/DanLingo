import test from 'node:test';
import assert from 'node:assert/strict';
import { comparableChatText, latestChatRecords, unchangedChatTranslation } from '../../src/platforms/youtube/repair-state.ts';

test('YouTube unchanged eligible prose is suspicious, not a successful display', () => {
  assert.equal(unchangedChatTranslation({simpleText:'こんにちは'}, {simpleText:'こんにちは'}, true), true);
  assert.equal(unchangedChatTranslation({runs:[{text:'こんばんは '},{emoji:{emojiId:'⭐'}}]}, {runs:[{text:'こんばんは '},{emoji:{emojiId:'⭐'}}]}, true), true);
  assert.equal(unchangedChatTranslation({simpleText:'こんにちは'}, {simpleText:'你好'}, true), false);
  assert.equal(unchangedChatTranslation({simpleText:'你好'}, {simpleText:'你好'}, false), false);
  assert.equal(comparableChatText('\u200b 你好\n 世界 '), '你好 世界');
});
test('latest uses message time, breaks ties by capture order and does not mutate inputs', () => {
  const rows = [{id:'pin-old',time:1,order:100},{id:'new',time:3,order:2},{id:'middle',time:2,order:1},{id:'newer',time:3,order:3}];
  assert.deepEqual(latestChatRecords(rows,3).map(r=>r.id), ['newer','new','middle']);
  assert.equal(rows[0].id, 'pin-old');
  for(const count of [0,-1,1.5,2001,NaN]) assert.deepEqual(latestChatRecords(rows,count), []);
  assert.equal(latestChatRecords(rows,2000).length, 4);
});
