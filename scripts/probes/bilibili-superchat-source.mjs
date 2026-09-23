// Read-only official static source evidence. Never execute a downloaded bundle,
// inspect account state, or fetch paid-message history. Keep only code anchors.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base='https://s1.hdslb.com/bfs/static/blive/blfe-live-room/static/js/';
const resources=[
  {file:'9203.fe32bf54b47974091866.js',anchors:[
    'danmaku-item superChat-card-detail','u.setAttribute("data-danmaku",e.message)',
    'u.querySelector(".input-contain > .text").textContent=e.message','queueChatHistoryRender=function',
    't.time<=0?e.removeSuperChatItem(t)',
  ]},
  {file:'988.80f82bc0df18f384486b.js',anchors:['staticClass:"super-chat-bubble-main"','key:"currentSuperChat"','staticClass:"content-message"']},
];
const report={capturedAt:new Date().toISOString(),evidence:'OFFICIAL_STATIC_SOURCE_NOT_NATURAL_PAID_MESSAGE',resources:[],
  limitations:['No natural 20-battery message was observed. Amount tiers and a particular user message are not verified.','Only reviewed DOM/body and lifecycle anchors are recorded; no server-history or account requests.']};
for(const {file,anchors} of resources){
  const response=await fetch(base+file,{signal:AbortSignal.timeout(25000)});assert.equal(response.status,200);
  const source=await response.text();assert.ok(source.length<5000000);
  const evidence=anchors.map(anchor=>{const offset=source.indexOf(anchor);assert.ok(offset>=0,`Missing native anchor: ${anchor}`);
    return{anchor,offset,excerpt:source.slice(Math.max(0,offset-50),offset+anchor.length+100)};});
  report.resources.push({url:base+file,sha256:createHash('sha256').update(source).digest('hex'),evidence});
}
const output=resolve('.artifacts/bilibili/superchat-source');await mkdir(output,{recursive:true});
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log('PASS official SC source anchors; '+resolve(output,'report.json'));
