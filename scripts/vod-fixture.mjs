// Browser-only synthetic native player. This is not evidence of Niconico internals.
export const fixtureUrl = 'https://www.nicovideo.jp/watch/sm999999991';
export const fixtureHtml = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>DanLingo VOD synthetic native fixture</title>
<style>body{margin:0;background:#15191d;color:#edf4f8;font:16px system-ui}main{max-width:1120px;margin:32px auto}h1{font-size:19px;font-weight:500}#fixture-stage{position:relative;isolation:isolate;background:linear-gradient(135deg,#14334b,#192332);width:100%;aspect-ratio:16/9;overflow:hidden}#fixture-stage:fullscreen{width:100vw;height:100vh}video{width:100%;height:100%;object-fit:cover}.fixture-label{position:absolute;left:24px;top:18px;color:#a7c1d5;font-size:13px}.fixture-comment{position:absolute;top:30%;left:12%;font-size:30px;color:white;text-shadow:1px 1px 3px #000}.controls{display:flex;gap:12px;margin-top:14px}button{padding:8px 15px;cursor:pointer}</style>
<main><h1>VOD browser acceptance · synthetic native fixture</h1><div id="fixture-stage"><video></video><div class="fixture-label">SYNTHETIC PLAYER · LOCAL MOCK PROVIDER</div><div class="fixture-comment">初めから準備するコメント</div></div><div class="controls"><button id="fixture-play">Play</button><button id="fixture-pause">Pause</button><button id="fixture-fullscreen">Fullscreen</button></div></main></html>`;

export function installBridgeObserver() {
  const state = window.__DL_VOD__ = {
    snapshot: null, sources: new Map(), revisions: [], chunks: [], prepared: new Map(), preparedHistory: [],
    messages: [], sourceRevision: -1, sourceGeneration:undefined, sourceComplete: false, scope: '',
  };
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.bridge !== 'danlingo.native.v1') return;
    const scope = `${d.resourceId}:${d.session}`;
    if (d.from === 'native' && ['snapshot', 'sources'].includes(d.type) && state.scope !== scope) {
      state.scope = scope; state.sources.clear(); state.prepared.clear(); state.sourceComplete = false; state.sourceRevision = -1;
    }
    if (d.from === 'native' && d.type === 'snapshot') state.snapshot = d;
    if (d.from === 'native' && d.type === 'sources') {
      state.chunks.push({ sourceGeneration:d.sourceGeneration, revision:d.revision, index:d.index, reset:d.reset, complete:d.complete, count:d.upserts?.length ?? 0, removes:d.removes ?? [], bytes:JSON.stringify(d).length });
      if (d.sourceGeneration !== state.sourceGeneration || d.revision !== state.sourceRevision) {
        state.sourceGeneration=d.sourceGeneration;
        state.sourceRevision = d.revision; state.revisions.push(d.revision); state.sourceComplete = false;
        if (d.reset) state.sources.clear();
      }
      for (const id of d.removes ?? []) state.sources.delete(id);
      for (const row of d.upserts ?? []) state.sources.set(row.id, row);
      if (d.complete) state.sourceComplete = true;
    }
    if (d.from === 'content' && d.type === 'prepared') {
      for (const row of d.items ?? []) {
        const item = { ...row, at:performance.now(), generation:d.generation, epoch:d.epoch, scope };
        state.prepared.set(row.id, item); state.preparedHistory.push(item);
      }
    }
    if (d.type !== 'snapshot' && d.type !== 'prepared' && d.type !== 'sources') {
      state.messages.push({ from:d.from, type:d.type, at:performance.now(), revision:d.revision, index:d.index, generation:d.generation });
      if (state.messages.length > 500) state.messages.shift();
    }
  });
}

export function installPlaybackObserver() {
  const events=window.__DL_PLAYBACK__=[];
  for(const name of ['play','pause']) {
    const original=HTMLMediaElement.prototype[name];
    HTMLMediaElement.prototype[name]=function(...args) {
      const stack=String(new Error().stack ?? '').split('\n').slice(2,8).map(line=>line.replace(/\?[^ ):]+/g,'?…')).join('\n');
      events.push({name,at:performance.now(),paused:this.paused,time:this.currentTime,stack,extensionCaller:stack.includes('chrome-extension://')});
      return original.apply(this,args);
    };
  }
}

export function installNativeFixture() {
  const install = () => {
    const stage = document.getElementById('fixture-stage');
    if (!stage) return;
    const video = stage.querySelector('video');
    const duration = 720;
    const state = { time:0, rate:1, paused:true, seeking:false, playCalls:0, pauseCalls:0, refreshCalls:0, refreshSnapshots:[], drawn:{}, staged:[], tickAt:performance.now() };
    Object.defineProperties(video, {
      paused:{get:()=>state.paused}, seeking:{get:()=>state.seeking}, currentTime:{get:()=>state.time, set:value=>seek(value)},
      duration:{get:()=>duration}, readyState:{get:()=>4}, playbackRate:{get:()=>state.rate, set:value=>{state.rate=value;}},
      buffered:{get:()=>({length:1,start:()=>175,end:()=>205})},
      played:{get:()=>({length:state.playCalls>0?1:0,start:()=>0,end:()=>state.time})},
    });
    video.play = async () => { state.playCalls++; state.paused=false; state.tickAt=performance.now(); video.dispatchEvent(new Event('play')); video.dispatchEvent(new Event('playing')); };
    video.pause = () => { state.pauseCalls++; state.paused=true; video.dispatchEvent(new Event('pause')); };
    function chat(id, vposMs, body) {
      return { id, thread:'fixture-thread', fork:'main', vposMs, position:'naka', size:'medium', color:'#ffffff', font:'defont',
        comment:{body,commands:['184','naka','white'],postedAt:'2026-09-01T00:00:00Z'} };
    }
    const rows = [chat('zero',0,'初めから準備するコメント'),chat('negative-render',1000,'開始より前に流れるコメント'),chat('near',8000,'もうすぐ見えるコメント')];
    for (let n=0;n<12;n++) rows.push(chat(`buffered-${n}`,180000+n*1000,`バッファ範囲のコメント番号${n}`));
    // Keep every event ID distinct, while repeated text exercises dedup/cache without
    // turning a browser contract test into several minutes of quota-budget waiting.
    for (let n=0;n<5105;n++) rows.push(chat(`far-${n}`,300000+(n%350)*1000,`未来のコメント番号${n%320}`));
    const filters = new Map();
    const layer = {
      stagingChatManager:{chatList:rows}, processor:{contentLengthMs:duration*1000},
      addStagingFilter:(name,fn)=>filters.set(name,fn), removeStagingFilter:name=>filters.delete(name), getStagingFilterNameList:()=>[...filters.keys()],
    };
    function render(id) {
      const row = rows.find(row=>row.id===id);
      if (!row) throw new Error('Fixture source absent: '+id);
      let settings = { visible:true, content:row.comment.body };
      for (const fn of filters.values()) settings=fn(row,settings);
      const result = {id,original:row.comment.body,text:settings.content,mediaTimeMs:state.time*1000,at:performance.now()};
      state.staged.push(result);
      state.drawn[id]=result;
      stage.querySelector('.fixture-comment').textContent=result.text;
      return result;
    }
    function seek(time) {
      state.seeking=true; state.time=Number(time); state.tickAt=performance.now();
      video.dispatchEvent(new Event('seeking'));
      state.seeking=false; video.dispatchEvent(new Event('seeked')); video.dispatchEvent(new Event('timeupdate'));
    }
    const player = {
      watch:{video:{id:location.pathname.split('/')[2],duration}}, context:{}, isDisposed:false, _isInterrupting:false, stage,
      getCurrentTime:()=>state.time, setCurrentTime:seek, getPlaybackRate:()=>state.rate, setPlaybackRate:rate=>{state.rate=rate;video.dispatchEvent(new Event('ratechange'));},
      getVideoElement:()=>video, isPlaying:()=>!state.paused, isSeeking:()=>state.seeking, isReady:()=>true, isDummyVideo:()=>false,
      commentRenderer:{parentElement:stage,layerProcessorList:[layer],refreshComments:()=>{
        state.refreshCalls++;
        const results=['zero','negative-render'].map(render);
        state.refreshSnapshots.push({at:performance.now(),filters:[...filters.keys()],results});
      }},
    };
    video.__reactFiber$danlingoFixture = {memoizedProps:{player},return:null};
    window.__DL_FIXTURE__ = {
      player,state,rows,render,seek,chat,
      add:(id,time,text)=>rows.push(chat(id,time,text)),
      change:(id,text)=>{const row=rows.find(row=>row.id===id);if(!row)throw new Error(id);row.comment.body=text;},
      remove:id=>{const index=rows.findIndex(row=>row.id===id);if(index<0)throw new Error(id);rows.splice(index,1);},
    };
    // Native renderers can stage the opening comments before the extension is ready.
    // Only the production bridge's paused refresh may redraw these in this fixture.
    render('zero'); render('negative-render');
    document.getElementById('fixture-play').onclick=()=>video.play();
    document.getElementById('fixture-pause').onclick=()=>video.pause();
    document.getElementById('fixture-fullscreen').onclick=()=>stage.requestFullscreen();
    setInterval(()=>{const now=performance.now();if(!state.paused){state.time=Math.min(duration,state.time+(now-state.tickAt)*state.rate/1000);}state.tickAt=now;},50);
  };
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',install,{once:true}); else install();
}
