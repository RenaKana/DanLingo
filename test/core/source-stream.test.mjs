import test from 'node:test';
import assert from 'node:assert/strict';
import { SourcePublisher, SOURCE_CHUNK_BYTES } from '../../src/core/source-stream.ts';
const row=(n,text='コメント')=>({id:String(n),sourceId:String(n),resourceId:'sm9',threadId:'1',fork:'main',platform:'niconico',originalText:text,mediaTimeMs:n*1000,renderAtMs:n*1000-2000,translatable:true,style:{commands:[]}});
test('full pool over5000 is acknowledged in bounded chunks, retransmission is idempotent',()=>{
  const sent=[];const p=new SourcePublisher(c=>sent.push(structuredClone(c)));const rows=Array.from({length:6001},(_,i)=>row(i));
  p.update(rows,0);assert.equal(sent.length,1);assert.equal(sent[0].reset,true);assert.equal(sent[0].upserts.length,500);
  p.pump(999);assert.equal(sent.length,1);p.pump(1000);assert.deepEqual(sent[1],sent[0]);
  const seen=new Set();let now=1001;
  while(p.busy){const c=sent.at(-1);for(const r of c.upserts)seen.add(r.id);assert.ok(c.upserts.length+c.removes.length<=500);assert.ok(new TextEncoder().encode(JSON.stringify(c)).length<=SOURCE_CHUNK_BYTES);p.acknowledge(c.revision,c.index,now++);}
  assert.equal(seen.size,6001);assert.equal(p.complete,true);const count=sent.length;p.update(rows,now);assert.equal(sent.length,count);
  p.update([row(0,'変更'),...rows.slice(2),row(7000)],now+1);assert.deepEqual(sent.at(-1).removes,['1']);assert.deepEqual(sent.at(-1).upserts.map(r=>r.id),['0','7000']);
});
test('UTF8 byte limit splits long comments before count limit and reset starts a fresh full snapshot',()=>{
  const sent=[];const p=new SourcePublisher(c=>sent.push(c));const rows=Array.from({length:600},(_,i)=>row(i,'語'.repeat(1000)));
  p.update(rows,0);assert.ok(sent[0].upserts.length<500);let total=0;
  while(p.busy){const c=sent.at(-1);assert.ok(new TextEncoder().encode(JSON.stringify(c)).length<SOURCE_CHUNK_BYTES);total+=c.upserts.length;p.acknowledge(c.revision,c.index,1);}
  assert.equal(total,600);p.reset();p.update([],2);assert.equal(sent.at(-1).reset,true);assert.equal(sent.at(-1).complete,true);
});
