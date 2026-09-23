import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production identity/ledger/DOM modules in an isolated local browser; no provider or real website.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const uri = source => 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const compile = async file => ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const protectedText=uri(await compile('src/translation/text.ts'));
const emotes=uri((await compile('src/platforms/bilibili-live/emotes.ts')).replace("'../../translation/text.ts'",JSON.stringify(protectedText)));
const inline=source=>source.replace("'./emotes.ts'",JSON.stringify(emotes));
const messages=uri(inline(await compile('src/platforms/bilibili-live/messages.ts')));
const repairs=uri(inline(await compile('src/platforms/bilibili-live/repairs.ts')));
const nativeBody=uri(inline(await compile('src/platforms/bilibili-live/body.ts')));
const dom=uri((await compile('src/platforms/bilibili-live/repairs-dom.ts')).replace("'./messages.ts'",JSON.stringify(messages)).replace("'./repairs.ts'",JSON.stringify(repairs)).replace("'./body.ts'",JSON.stringify(nativeBody)));
const {chromium}=await loadPlaywright();
const browser=await chromium.launch({...browserLaunchOptions("chromium"),headless:true});
const page=await browser.newPage();const output=resolve('.artifacts/bilibili/repair-dom');await mkdir(output,{recursive:true});
try {
  await page.route('**/*',route=>route.request().resourceType()==='document'
    ?route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><div id="chat-items"></div><div id="cards"></div>'})
    :route.abort());
  await page.goto('https://fixture.invalid/');
  const result=await page.evaluate(async({repairs,dom,nativeBody})=>{
    const {BilibiliRepairs}=await import(repairs),{BilibiliRepairDom}=await import(dom),{readNativeBody}=await import(nativeBody);
    const sent=[];let now=0,active=true;
    const ledger=new BilibiliRepairs({now:()=>now,active:()=>active,eligible:()=>true,timeoutMs:()=>5000,send:d=>sent.push(d)});
    const manager=new BilibiliRepairDom({ledger,active:()=>active});
    const add=(id,bodyText)=>{const row=document.createElement('div');row.className='chat-item danmaku-item';row.setAttribute('data-id_str',id);
      row.innerHTML='<b>Author ◆</b><span class="danmaku-item-right"></span>';row.querySelector('span').textContent=bodyText;document.querySelector('#chat-items').append(row);return row;};
    const id='ab0123456789abcdef0123456789abcdefABC',sourceId='dm:'+id,original='原始文字';
    ledger.capture({sourceId,nativeId:id,originalText:original});ledger.normal(sourceId,'automatic A');
    const a=add(id,'automatic A'),body=a.querySelector('span');manager.scan();
    const initialBaseline=ledger.get(sourceId).displayedText;
    const retryButton=a.querySelector('[data-danlingo-bili-retry]'), originalButton=a.querySelector('[data-danlingo-bili-original]');
    const iconOnly=!!(retryButton?.textContent?.trim()===''&&originalButton?.textContent?.trim()===''&&retryButton?.querySelector('svg[data-danlingo-icon="retry"]')&&originalButton?.querySelector('svg[data-danlingo-icon="original"]'));
    retryButton.click();const request=sent.filter(d=>d.type==='repair-request').at(-1);
    a.querySelector('button').click();const coalesced=sent.filter(d=>d.type==='repair-request').length===1;
    ledger.result({...request,status:'translated',text:'forced B'});manager.scan();const afterForce=body.textContent;
    const originalRequestCount=sent.filter(d=>d.type==='repair-request').length; a.querySelector('[data-danlingo-bili-original]').click();
    const afterShowOriginal=body.textContent, originalButtonLabel=a.querySelector('[data-danlingo-bili-original]').getAttribute('aria-label');
    a.querySelector('[data-danlingo-bili-original]').click(); const afterShowTranslation=body.textContent;
    const pendingOriginal=ledger.request(sourceId,true,true); const pendingRequestCount=sent.filter(d=>d.type==='repair-request').length; manager.scan(); a.querySelector('[data-danlingo-bili-original]').click();
    ledger.result({sourceId,requestId:pendingOriginal,status:'translated',text:'stale C'}); manager.scan(); const afterPendingOriginal=body.textContent;
    a.querySelector('[data-danlingo-bili-original]').click(); const afterPendingTranslation=body.textContent;
    const b=add(id,'automatic A');manager.scan();const afterRebuild=b.querySelector('span').textContent;
    const receipts=sent.filter(d=>d.type==='repair-applied'&&d.resultVersion===2&&d.application==='native-updated').length;
    a.remove();b.remove();manager.scan();const absentReceipt=sent.at(-1).application;
    const noId=add('bad id',original);ledger.capture({sourceId:'occ:1',originalText:original});manager.scan();
    const unknownUnbound=noId.querySelector('button')===null;
    const special=add('special','原始文字');special.querySelector('span').innerHTML='<img alt="表情">原始文字';ledger.capture({sourceId:'dm:special',originalText:original});manager.scan();
    const specialUnchanged=special.querySelector('img')!==null&&special.querySelector('button')===null;
    const emotes={'[笑]':'https://fixture.invalid/smile.png','[泣]':'https://fixture.invalid/cry.png'};
    const mixedId='dm:mixed',mixedOriginal='[笑]原始[泣]文字[笑]';
    ledger.capture({sourceId:mixedId,nativeId:'mixed',originalText:mixedOriginal,inlineEmotes:emotes});ledger.normal(mixedId,'[笑]automatic A[泣]text[笑]');
    const mixed=add('mixed',''),mixedBody=mixed.querySelector('.danmaku-item-right');
    mixedBody.innerHTML='<span><img src="http://fixture.invalid/smile.png"></span><span>automatic A</span><img src="https://fixture.invalid/cry.png">text<span><img src="//fixture.invalid/smile.png"></span>';
    const originalImages=[...mixedBody.querySelectorAll('img')];let imageClicks=0;originalImages[0].addEventListener('click',()=>imageClicks++);
    manager.scan();const mixedBaseline=ledger.get(mixedId).displayedText;
    mixed.querySelector('button').click();const mixedRequest=sent.filter(d=>d.type==='repair-request').at(-1);
    ledger.result({...mixedRequest,status:'translated',text:'before[笑]forced B[泣]long text[笑]after'});manager.scan();
    const mixedAfterForce=readNativeBody(mixedBody,mixedOriginal,emotes).text;
    const imageNodesPreserved=originalImages.every((img,i)=>img===mixedBody.querySelectorAll('img')[i]);originalImages[0].click();
    const secondMixedRequest=ledger.request(mixedId,true,true);ledger.result({sourceId:mixedId,requestId:secondMixedRequest,status:'translated',text:'[笑]third C[泣]still intact[笑]'});manager.scan();
    const mixedSecondForce=readNativeBody(mixedBody,mixedOriginal,emotes).text;
    const unknown=add('unregistered-image','');unknown.querySelector('span').innerHTML='<img src="https://fixture.invalid/other.png">原始[泣]文字[笑]';
    ledger.capture({sourceId:'dm:unregistered-image',nativeId:'unregistered-image',originalText:mixedOriginal,inlineEmotes:emotes});manager.scan();
    const unknownImageUnbound=unknown.querySelector('button')===null;
    const scSource={sourceId:'sc:9',nativeId:'9',originalText:'支持消息',expiresAt:1000};ledger.capture(scSource,scSource);
    const sc=document.createElement('div');sc.className='super-chat-bubble-main';sc.__vue__={currentSuperChat:{id:9,message:'支持消息'}};
    sc.innerHTML='<b>¥30 Author ◆</b><span class="content-message"><i class="content-message-icon">★</i>支持消息</span>';document.querySelector('#cards').append(sc);manager.scan();
    const scRequest=ledger.request('sc:9',false);ledger.result({sourceId:'sc:9',requestId:scRequest,status:'translated',text:'SC translation'});manager.scan();
    const scBody=sc.querySelector('.content-message').textContent,metadata=sc.querySelector('b').textContent;
    ledger.remove(['sc:9']);sc.remove();manager.scan();ledger.result({sourceId:'sc:9',requestId:scRequest,status:'translated',text:'stale'});manager.scan();
    const scNotRestored=document.querySelectorAll('.super-chat-bubble-main').length===0;
    const visualStyle=document.createElement('style');visualStyle.dataset.repairVisualStyle='';visualStyle.textContent=`
      #repair-visual-sample{display:grid;grid-template-columns:max-content max-content;gap:12px;box-sizing:border-box;width:max-content;padding:12px;font-family:Arial,sans-serif}
      #repair-visual-sample .repair-visual-panel{display:flex;gap:12px;box-sizing:border-box;width:max-content;padding:12px;border:1px solid currentColor;border-radius:8px}
      #repair-visual-sample .repair-visual-panel[data-theme="light"]{color:#17212b;background:#f7f9fb}
      #repair-visual-sample .repair-visual-panel[data-theme="dark"]{color:#eef4ff;background:#17202c}
      #repair-visual-sample .repair-visual-viewport{box-sizing:border-box;flex:0 0 auto;padding:8px;border:1px dashed currentColor;border-radius:6px}
      #repair-visual-sample .repair-visual-viewport[data-width="280"]{width:280px}
      #repair-visual-sample .repair-visual-viewport[data-width="360"]{width:360px}
      #repair-visual-sample .repair-visual-row{display:block;box-sizing:border-box;width:100%;margin:0 0 8px;padding:7px 8px;border:1px solid color-mix(in srgb,currentColor 34%,transparent);border-radius:5px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
      #repair-visual-sample .repair-visual-row:last-child{margin-bottom:0}
      #repair-visual-sample .repair-visual-row>b{font-size:12px;line-height:18px;vertical-align:middle;white-space:nowrap}
      #repair-visual-sample .repair-visual-row>.danmaku-item-right{display:inline;font-size:12px;line-height:20px;vertical-align:middle}
    `;document.head.append(visualStyle);
    const visualSample=document.createElement('section');visualSample.id='repair-visual-sample';visualSample.setAttribute('aria-label','Bilibili repair control visual regression');
    const visualRows={};let visualIndex=0;
    const addVisual=(panel,width,variant,originalText,displayedText,viewport)=>{
      const id=`visual${++visualIndex}a0123456789abcdef0123456789abcdefABC`,sourceId=`dm:${id}`,caseName=`${panel}-${width}-${variant}`;
      ledger.capture({sourceId,nativeId:id,originalText});ledger.normal(sourceId,displayedText);
      const row=document.createElement('div');row.className='chat-item danmaku-item repair-visual-row';row.dataset.visualCase=caseName;row.dataset.visualTheme=panel;row.dataset.visualWidth=String(width);row.dataset.visualExpectedText=displayedText;row.setAttribute('data-id_str',id);
      row.innerHTML='<b>Author ◆</b><span class="danmaku-item-right"></span>';row.dataset.visualOriginalText=originalText;row.querySelector('.danmaku-item-right').textContent=displayedText;viewport.append(row);
      visualRows[caseName]={row,body:row.querySelector('.danmaku-item-right'),originalText,displayedText};
    };
    for(const theme of ['light','dark']){
      const panel=document.createElement('div');panel.className='repair-visual-panel';panel.dataset.visualPanel=theme;panel.dataset.theme=theme;
      for(const width of [280,360]){
        const viewport=document.createElement('div');viewport.className='repair-visual-viewport';viewport.dataset.width=String(width);
        addVisual(theme,width,'short','原始短消息','短消息',viewport);
        addVisual(theme,width,'wrapped','原始消息需要在较窄宽度下换行显示，以便验证最后一行的操作控件定位','自动翻译后的一段较长消息需要在较窄宽度下换行显示，以便验证最后一行的操作控件定位',viewport);
        panel.append(viewport);
      }
      visualSample.append(panel);
    }
    document.querySelector('#chat-items').append(visualSample);manager.scan();
    const frame=document.createElement('iframe');frame.style.cssText='width:640px;height:220px;border:0';frame.src='https://fixture.invalid/embedded';
    const frameLoaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));document.body.append(frame);await frameLoaded;
    const frameDocument=frame.contentDocument;if(!frameDocument)throw new Error('same-origin iframe document unavailable');
    const frameSent=[],frameLedger=new BilibiliRepairs({now:()=>now,active:()=>active,eligible:()=>true,timeoutMs:()=>5000,send:d=>frameSent.push(d)});
    const frameManager=new BilibiliRepairDom({ledger:frameLedger,active:()=>active,document:frameDocument});
    const frameId='cd0123456789abcdef0123456789abcdefABC',frameSourceId='dm:'+frameId,frameOriginal='[笑]原始[泣]文字[笑]';
    frameLedger.capture({sourceId:frameSourceId,nativeId:frameId,originalText:frameOriginal,inlineEmotes:emotes});frameLedger.normal(frameSourceId,'[笑]frame A[泣]text[笑]');
    const frameRow=frameDocument.createElement('div');frameRow.className='chat-item danmaku-item';frameRow.setAttribute('data-id_str',frameId);frameRow.innerHTML='<span class="danmaku-item-right"></span>';
    const frameBody=frameRow.querySelector('.danmaku-item-right');frameBody.innerHTML='<span><img src="https://fixture.invalid/smile.png"></span><span>frame A</span><img src="https://fixture.invalid/cry.png">text<span><img src="//fixture.invalid/smile.png"></span>';
    frameDocument.querySelector('#chat-items').append(frameRow);frameManager.scan();
    const frameBaseline=frameLedger.get(frameSourceId).displayedText,frameRetry=frameRow.querySelector('[data-danlingo-bili-retry]');
    frameRetry.click();const frameRequest=frameSent.filter(d=>d.type==='repair-request').at(-1);
    frameLedger.result({...frameRequest,status:'translated',text:'before[笑]frame B[泣]frame text[笑]after'});frameManager.scan();
    const frameText=()=>readNativeBody(frameBody,frameOriginal,emotes)?.text,frameAfterForce=frameText(),frameOriginalButton=frameRow.querySelector('[data-danlingo-bili-original]');
    frameOriginalButton.click();const frameAfterOriginal=frameText();frameOriginalButton.click();const frameAfterTranslation=frameText();
    frame.hidden=true;const hiddenFrameVisible=frameManager.visibleIds().size>0;frame.hidden=false;frameManager.scan();
    frameManager.dispose();frame.remove();
    window.__repairManager=manager;window.__repairMixed={body:mixedBody,original:mixedOriginal,emotes};window.__repairVisual={sample:visualSample,rows:visualRows,sent};
    return{initialBaseline,coalesced,afterForce,afterShowOriginal,originalButtonLabel,afterShowTranslation,afterPendingOriginal,afterPendingTranslation,originalRequestCount,pendingRequestCount,afterRebuild,receipts,absentReceipt,unknownUnbound,specialUnchanged,scBody,metadata,scNotRestored,frameBaseline,frameAfterForce,frameAfterOriginal,frameAfterTranslation,hiddenFrameVisible,mixedBaseline,mixedAfterForce,mixedSecondForce,mixedRestored:null,imageNodesPreserved,imageClicks,unknownImageUnbound,rowForce:request.force,iconOnly};
  },{repairs,dom,nativeBody});
  const visualMeasure=()=>page.evaluate(()=>{
    const rect=r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height});
    const center=r=>({x:(r.left+r.right)/2,y:(r.top+r.bottom)/2});
    return [...document.querySelectorAll('[data-visual-case]')].map(row=>{
      const body=row.querySelector('.danmaku-item-right'),actions=row.querySelector('[data-danlingo-bili-actions]'),buttons=[...row.querySelectorAll('[data-danlingo-bili-actions]>button')],svgs=buttons.map(button=>button.querySelector('svg'));
      const bodyLines=[...(body?.getClientRects()??[])].map(rect),lastLine=bodyLines.at(-1),actionRect=actions?.getBoundingClientRect(),buttonRects=buttons.map(button=>button.getBoundingClientRect()),glyphRects=svgs.map(svg=>svg?.getBoundingClientRect()).filter(Boolean);
      const rowRect=row.getBoundingClientRect(),marginLeft=actions?Number.parseFloat(getComputedStyle(actions).marginLeft)||0:0,availableOnLastLine=lastLine?rowRect.right-lastLine.right:0,requiredForPair=actionRect?actionRect.width+marginLeft:0,pairMoved=!!(lastLine&&actionRect&&actionRect.top>lastLine.bottom+0.5);
      const bodyCenter=lastLine?center(lastLine):null,actionCenter=actionRect?center(actionRect):null;
      const expectedTexts=[row.dataset.visualExpectedText,row.dataset.visualOriginalText];
      return{caseName:row.dataset.visualCase,theme:row.dataset.visualTheme,width:Number(row.dataset.visualWidth),expectedText:row.dataset.visualExpectedText,bodyText:body?.textContent??'',bodyChildElements:body?.children.length??-1,bodyLines,actions:actionRect?rect(actionRect):null,actionLineCount:actions?.getClientRects().length??-1,buttons:buttonRects.map(rect),glyphs:glyphRects.map(rect),bodyCenter,actionCenter,centerDelta:bodyCenter&&actionCenter?Math.abs(bodyCenter.y-actionCenter.y):null,glyphCenterDeltas:glyphRects.map(glyph=>bodyCenter?Math.abs(center(glyph).y-bodyCenter.y):null),sameButtonLine:buttonRects.length===2&&Math.abs(buttonRects[0].top-buttonRects[1].top)<=0.5,groupContainsPair:!!(actions&&buttonRects.length===2&&buttonRects.every(button=>button.left>=actionRect.left-0.5&&button.right<=actionRect.right+0.5)),movedWhole:!!(pairMoved&&buttonRects.length===2&&Math.abs(buttonRects[0].top-buttonRects[1].top)<=0.5),moveNecessary:!!(pairMoved&&lastLine&&Math.abs(actionRect.left-(lastLine.left+marginLeft))<=1.5),alignedToLastLine:!!(lastLine&&actionRect&&!pairMoved&&Math.abs(actionCenter.y-bodyCenter.y)<=2.5),noExtraBodyText:!!(body&&expectedTexts.includes(body.textContent)&&body.children.length===0&&body.nextElementSibling===actions),rowClientWidth:row.clientWidth,rowScrollWidth:row.scrollWidth,viewportClientWidth:row.parentElement?.clientWidth??-1,viewportScrollWidth:row.parentElement?.scrollWidth??-1,rowOverflow:row.scrollWidth<=row.clientWidth+0.5,viewportOverflow:!!row.parentElement&&row.parentElement.scrollWidth<=row.parentElement.clientWidth+0.5};
    });
  });
  const visualBaseline=await visualMeasure();
  await page.screenshot({path:resolve(output,'repair-dom.png')});
  for(const theme of ['light','dark']) await page.locator(`[data-visual-panel="${theme}"]`).screenshot({path:resolve(output,`repair-dom-visual-${theme}-baseline.png`)});
  const keyboardVisual={};
  for(const theme of ['light','dark']){
    const target=page.locator(`[data-visual-case="${theme}-280-wrapped"] [data-danlingo-bili-original]`);await target.focus();const before=await page.evaluate(()=>window.__repairVisual.sent.filter(d=>d.type==='repair-request').length);await target.press('Enter');
    keyboardVisual[theme]=await page.evaluate(({theme,before})=>{const row=document.querySelector(`[data-visual-case="${theme}-280-wrapped"]`),body=row.querySelector('.danmaku-item-right'),button=row.querySelector('[data-danlingo-bili-original]');return{bodyText:body.textContent,requestCount:window.__repairVisual.sent.filter(d=>d.type==='repair-request').length,before,requestUnchanged:window.__repairVisual.sent.filter(d=>d.type==='repair-request').length===before,showingOriginal:button.getAttribute('aria-pressed')==='true',focusVisible:document.activeElement===button&&getComputedStyle(button).outlineStyle!=='none'}},{theme,before});
    await page.locator(`[data-visual-panel="${theme}"]`).screenshot({path:resolve(output,`repair-dom-visual-${theme}.png`)});
  }
  const visualStates=await visualMeasure();
  result.mixedRestored=await page.evaluate(async({nativeBody})=>{const {readNativeBody}=await import(nativeBody);const mixed=window.__repairMixed;window.__repairManager.dispose();const text=readNativeBody(mixed.body,mixed.original,mixed.emotes).text;const visualControls=document.querySelectorAll('[data-visual-case] [data-danlingo-bili-actions]').length,managerStyle=[...document.querySelectorAll('style')].some(style=>style.textContent?.includes('[data-danlingo-bili-actions]'));return{text,visualControls,managerStyle};},{nativeBody});
  result.visualBaseline=visualBaseline;result.visualStates=visualStates;result.keyboardVisual=keyboardVisual;result.visualDisposed=result.mixedRestored;
  const visualRows=result.visualBaseline;
  assert.equal(visualRows.length,8);
  assert.ok(visualRows.every(row=>row.actionLineCount===1&&row.sameButtonLine&&row.groupContainsPair&&row.noExtraBodyText&&row.alignedToLastLine&&row.glyphCenterDeltas.every(delta=>delta<=2.5)&&row.rowOverflow&&row.viewportOverflow), 'baseline visual controls must align without overflow');
  assert.ok(visualRows.some(row=>row.bodyLines.length>1), 'baseline visual sample must include wrapped messages');
  assert.ok(result.visualStates.every(row=>row.actionLineCount===1&&row.sameButtonLine&&row.groupContainsPair&&row.noExtraBodyText&&row.rowOverflow&&row.viewportOverflow), 'visual states must keep paired controls grouped without overflow');
  assert.ok(result.visualStates.some(row=>row.movedWhole&&row.moveNecessary), 'a tight message must move the paired controls as one group');
  assert.ok(result.visualStates.some(row=>row.caseName==='light-280-wrapped'&&row.movedWhole)&&result.visualStates.some(row=>row.caseName==='light-360-wrapped'&&!row.movedWhole&&row.alignedToLastLine), 'the paired group must move only at the narrower width when needed');
  assert.ok(Object.values(result.keyboardVisual).every(state=>state.requestUnchanged&&state.showingOriginal&&state.focusVisible), 'keyboard original toggle must avoid a new request and show focus');
  assert.deepEqual(result.mixedRestored,{text:'[笑]automatic A[泣]text[笑]',visualControls:0,managerStyle:false});
  const coreResult={...result};delete coreResult.visualBaseline;delete coreResult.visualStates;delete coreResult.keyboardVisual;delete coreResult.visualDisposed;coreResult.mixedRestored=coreResult.mixedRestored.text;
  assert.deepEqual(coreResult,{initialBaseline:'automatic A',coalesced:true,afterForce:'forced B',afterShowOriginal:'原始文字',originalButtonLabel:'显示译文',afterShowTranslation:'forced B',afterPendingOriginal:'原始文字',afterPendingTranslation:'stale C',originalRequestCount:1,pendingRequestCount:2,afterRebuild:'stale C',receipts:1,absentReceipt:'recent-only',unknownUnbound:true,specialUnchanged:true,scBody:'★SC translation',metadata:'¥30 Author ◆',scNotRestored:true,
    frameBaseline:'[笑]frame A[泣]text[笑]',frameAfterForce:'before[笑]frame B[泣]frame text[笑]after',frameAfterOriginal:'[笑]原始[泣]文字[笑]',frameAfterTranslation:'before[笑]frame B[泣]frame text[笑]after',hiddenFrameVisible:false,
    mixedBaseline:'[笑]automatic A[泣]text[笑]',mixedAfterForce:'before[笑]forced B[泣]long text[笑]after',mixedSecondForce:'[笑]third C[泣]still intact[笑]',mixedRestored:'[笑]automatic A[泣]text[笑]',imageNodesPreserved:true,imageClicks:1,unknownImageUnbound:true,rowForce:true,iconOnly:true});
  await writeFile(resolve(output,'report.json'),JSON.stringify({status:'PASS',evidence:'isolated production DOM modules, no provider',checks:result},null,2));
  console.log('PASS Bilibili native repair DOM; '+resolve(output,'report.json'));
}finally{await browser.close();}
