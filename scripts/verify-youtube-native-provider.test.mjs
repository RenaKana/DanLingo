import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installProviderTransport } from './youtube-provider-transport.mjs';
import { parseProviderWindowArgs } from './verify-youtube-native-provider.mjs';

test('real chat CLI accepts only fixed supported windows without reading the supplied config', () => {
  const args = ['--config-file', 'nonexistent', '--url', 'https://www.youtube.com/watch?v=abcdefghijk'];
  for (const buffer of [500, 1000, 2000, 3000]) assert.equal(parseProviderWindowArgs([...args, '--buffer', String(buffer), '--check-args']).bufferMs, buffer);
  for (const extra of [['--buffer', '4000'], ['--model', 'other'], ['--browser', 'personal'], ['--seconds', '1']])
    assert.throws(() => parseProviderWindowArgs([...args, ...extra]));
  assert.throws(() => parseProviderWindowArgs(['--config-file', 'nonexistent', '--url', 'https://example.com/watch?v=abcdefghijk']));
});


class Context extends EventEmitter {
  async route(endpoint, handler) { this.endpoint = endpoint; this.handler = handler; }
  async unroute() {}
  async post(model = 'deepseek-flash', status = 200) {
    const request = {url:()=>this.endpoint,method:()=> 'POST',postDataJSON:()=>({model,stream:false,messages:['SYNTHETIC_SECRET']})};
    let sent = false, blocked = false;
    await this.handler({request:()=>request, abort:async()=>{blocked=true;},continue:async()=>{
      sent=true;this.emit('response',{request:()=>request,status:()=>status});this.emit('requestfinished',request);
    }}); return {sent,blocked};
  }
}
test('browser transport caps actual dispatch, preserves aggregate privacy and accounts completion',async()=>{
  const context=new Context(), guard=await installProviderTransport(context,{endpoint:'https://fixture.invalid',maxPosts:2});
  assert.equal((await context.post('other')).blocked,true);
  assert.equal((await context.post()).sent,true);assert.equal((await context.post()).sent,true);
  assert.equal((await context.post()).blocked,true);
  const stats=guard.snapshot();assert.equal(stats.posts,2);assert.equal(stats.blocked,2);assert.equal(stats.active,0);
  assert.equal(stats.bodyMs.length,2);assert.ok(!JSON.stringify(stats).includes('SYNTHETIC_SECRET'));
  await guard.close();assert.equal(context.listenerCount('response'),0);
});
test('401/403/429 stop later dispatch before transport',async()=>{
  for(const status of [401,403,429]){
    const context=new Context(),guard=await installProviderTransport(context,{endpoint:'https://fixture.invalid'});
    assert.equal((await context.post('deepseek-flash',status)).sent,true);assert.equal((await context.post()).blocked,true);
    assert.equal(guard.snapshot().posts,1);await guard.close();
  }
});
