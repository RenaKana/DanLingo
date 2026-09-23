import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceFromUrl, matchesResourceUrl, sameSession, validSession, cacheResource } from '../../src/core/resource.ts';
import { parseSources, sourceEventId } from '../../src/core/messages.ts';
const url='https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
const resource={platform:'bilibili',scenario:'video',resourceId:'av2:cid62132',urlResourceId:'BV1xx411c7mD:p2',sessionId:'document-a',generation:1};
test('URL candidate cannot impersonate native CID; part/CID/session transitions stay separate',()=>{
  assert.equal(resourceFromUrl(url).resourceId,'BV1xx411c7mD:p2'); assert.ok(matchesResourceUrl(resource,url));
  assert.equal(matchesResourceUrl(resource,url.replace('p=2','p=1')),false); assert.equal(validSession({...resource,resourceId:'BV1xx411c7mD:p2'}),false);
  assert.equal(sameSession(resource,{...resource,resourceId:'av2:cid62133'}),false);
  assert.equal(sameSession(resource,{...resource,generation:2}),false); assert.equal(sameSession(resource,{...resource,urlResourceId:'av2:p2'}),false);
  assert.ok(matchesResourceUrl({platform:'bilibili',scenario:'live',resourceId:'room:22900497',urlResourceId:'777'},'https://live.bilibili.com/777'));
  for(const u of ['https://www.bilibili.com/bangumi/play/ep1','https://www.bilibili.com/cheese/play/ep1','https://live.bilibili.com/blanc/0','http://www.bilibili.com/video/av2','https://www.bilibili.com.evil.test/video/av2','https://www.bilibili.com/video/av2?p=0']) assert.equal(resourceFromUrl(u),null,u);
});

test('all room IDs share normal and blanc aliases without weakening native session identity', () => {
  for (const id of ['1', '7777', '5236391', '98765432109876543210']) {
    const native = { platform: 'bilibili', scenario: 'live', resourceId: 'room:545068', urlResourceId: id };
    for (const path of [`/${id}`, `/blanc/${id}`]) for (const suffix of ['', '/', '?liteVersion=true', '/?liteVersion=false&from=share#chat']) {
      const url = 'https://live.bilibili.com' + path + suffix;
      assert.deepEqual(resourceFromUrl(url), { platform: 'bilibili', scenario: 'live', resourceId: id });
      assert.ok(matchesResourceUrl(native, url));
      assert.equal(matchesResourceUrl({ ...native, urlResourceId: '42' }, url), false);
      assert.equal(matchesResourceUrl({ ...native, resourceId: id }, url), false);
    }
  }
  for (const path of ['/blanc/', '/blanc/0', '/blanc/-1', '/blanc/123/other', '/foo/123', '/blanc/123456789012345678901'])
    assert.equal(resourceFromUrl('https://live.bilibili.com' + path), null);
  for (const prefix of ['http://live.bilibili.com', 'https://live.bilibili.com.evil.test', 'https://key@live.bilibili.com', 'https://live.bilibili.com:444'])
    assert.equal(resourceFromUrl(prefix + '/blanc/123'), null);
});
test('Bilibili parser validates CID/modes while preserving exact old Niconico identifiers/cache',()=>{
  const row={platform:'bilibili',threadId:'62132',fork:'main',sourceId:'12345678901234567890',originalText:'こんにちは',mediaTimeMs:5000,renderAtMs:5000,translatable:true,style:{position:'1'}};
  assert.equal(parseSources([row],resource.resourceId,'bilibili').length,1);
  assert.equal(parseSources([{...row,threadId:'62133'}],resource.resourceId,'bilibili').length,0);
  assert.equal(parseSources([{...row,style:{position:'7'}}],resource.resourceId,'bilibili')[0].translatable,false);
  assert.equal(parseSources([{...row,platform:'niconico'}],resource.resourceId,'bilibili').length,0);
  assert.equal(sourceEventId('sm9','10','main','12'),'["sm9","10","main","12"]');
  assert.equal(cacheResource({platform:'niconico',scenario:'video',resourceId:'sm9'}),'sm9');
  assert.notEqual(cacheResource(resource),cacheResource({...resource,resourceId:'av2:cid62133'}));
});
