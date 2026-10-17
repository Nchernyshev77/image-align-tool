// Streaming import, board reconciliation, and at most five upload passes.
(function(root){
 'use strict';
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function parallel(items,limit,task){let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;await task(items[i],i);}}));}
 function deadline(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]).finally(()=>clearTimeout(timer));}
 function taskQueue(limit){
  const pending=[],idle=[];let active=0;
  function pump(){while(active<limit&&pending.length){const job=pending.shift();active++;
   Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{active--;pump();if(!active&&!pending.length)while(idle.length)idle.pop()();});
  }}
  return {get size(){return active+pending.length;},add(task){const done=new Promise((resolve,reject)=>pending.push({task,resolve,reject}));done.catch(()=>{});pump();return done;},
   drain(){return active||pending.length?new Promise(resolve=>idle.push(resolve)):Promise.resolve();}};
 }
 function preparationWorkers(sources,device=root.navigator||{}){
  const cores=Number(device.hardwareConcurrency)||4,memory=Number(device.deviceMemory)||0;
  const large=sources.some(s=>s.info&&s.info.width*s.info.height*4>256*1024*1024);
  return Math.max(1,Math.min(sources.length||1,large||(memory&&memory<=4)?2:Math.max(2,Math.min(4,Math.floor(cores/2)))));
 }
 function rateGate({enabled=true,now=()=>Date.now(),wait=sleep,onWait=()=>{}}={}){
  const entries=[];let blocked=0,waiting=0,waitingAt=0,waited=0;
  return {
   get waitMs(){return waited+(waiting?now()-waitingAt:0);},
   block(ms){blocked=Math.max(blocked,now()+ms);},
   async take(cost){if(!enabled)return;let held=false;try{while(true){const t=now();while(entries.length&&entries[0].at<=t-3600000)entries.shift();
    let minute=0,hour=0,minuteReset=t,hourReset=t;
    for(const e of entries){hour+=e.cost;if(e.at>t-60000){minute+=e.cost;if(minuteReset===t)minuteReset=e.at+60001;}if(hourReset===t)hourReset=e.at+3600001;}
    const until=Math.max(blocked,minute+cost>95000?minuteReset:0,hour+cost>950000?hourReset:0);
    if(until>t){if(!held){held=true;if(!waiting++)waitingAt=t;}onWait(until-t);await wait(Math.min(1000,until-t));continue;}
    entries.push({at:t,cost});return;
   }}finally{if(held&&!--waiting)waited+=now()-waitingAt;}},
  };
 }
 async function run({files,board,scan,layout,createPreparer,onProgress=()=>{},options={}}){
  const maxPasses=5,sourceLimit=5,partLimit=8;
  const wait=options.wait||sleep,requestMs=options.requestMs||120000,clock=options.clock||(()=>performance.now()),startedAt=clock();
  const timings={scanMs:0,prepareMs:0,toneMs:0,encodeMs:0,probes:0,readMs:0,uploadMs:0,metadataMs:0,groupMs:0,verifyMs:0,admissionWaitMs:0,rateWaitMs:0,totalMs:0};
  const measure=async(key,task)=>{const start=clock();try{return await task();}finally{timings[key]+=clock()-start;}};
  const runId=options.runId||((root.crypto&&root.crypto.randomUUID)?root.crypto.randomUUID().replace(/-/g,''):Date.now().toString(36)+Math.random().toString(36).slice(2));
  const sources=files.map((file,index)=>({file,index,name:file.name||'image',info:null,jobs:[],parts:[],prepared:false,error:null,group:null}));
  const state={scanDone:0,prepareDone:0,totalSources:files.length,totalParts:0,uploaded:0,verified:0,groupedSources:0,workers:0,pass:1,status:'Scanning files',phase:'scan'};
  let active=true;
  const emit=(patch={})=>{Object.assign(state,patch);if(active)onProgress({...state,timings:{...timings,rateWaitMs:gate.waitMs,totalMs:clock()-startedAt}});};
  const gate=rateGate({enabled:options.rateLimit!==false,wait,now:options.now,onWait:()=>emit({status:'Waiting for Miro request limit…'})});
  let preparers=[];
  const metadataQueue=taskQueue(4),groupQueue=taskQueue(5);
  const allParts=()=>sources.flatMap(s=>s.parts);
  const keyMap=new Map(),timedOut=new Set();let boardError=null,duplicates=0;
  const uncertain=()=>[...timedOut].some(p=>p.pending&&!p.found);
  function scheduleMetadata(part,widget){
   if(!active||!widget.setMetadata||part.metadataId===widget.id)return;
   part.metadataId=widget.id;
   metadataQueue.add(async()=>{try{await gate.take(50);await measure('metadataMs',()=>deadline(Promise.resolve().then(()=>widget.setMetadata('image-align-tool',part.metadata)),options.metadataMs||15000,'Image metadata'));}
    catch(error){part.metadataError=error.message||String(error);}});
  }
  function acknowledge(part,widget,groupNow=true){part.id=widget.id;part.widget=widget;part.error=null;
   if(!part.counted){part.counted=true;state.uploaded++;}scheduleMetadata(part,widget);
   if(active&&groupNow)scheduleGroup(part.source);emit();}
  async function scanSource(source){try{const info=await scan(source.file);if(!info.width||!info.height)throw Error('Invalid image dimensions');source.info=info;source.error=null;}catch(error){source.error=error.message||String(error);}}
  async function prepare(source,worker){
   if(!source.info)return false;
   try{
    const output=await measure('prepareMs',()=>worker.prepare(source.file,source.info,source.jobs));
    if(output.timings)for(const key of ['toneMs','encodeMs','probes'])timings[key]+=output.timings[key]||0;
    if(output.regions.length!==source.jobs.length)throw Error('Prepared region count changed');
    const descriptors=[];
    for(let j=0;j<output.regions.length;j++){
     const region=output.regions[j],job=source.jobs[j];
     const regionInfo={mode:region.mode,sourceX:region.sourceX,sourceY:region.sourceY,width:region.width,height:region.height,attempts:region.attempts};
     for(let p=0;p<region.parts.length;p++){
      const part=region.parts[p],key=`${source.index}.${j}.${p}`,marker=`[ia:${runId}:${key}]`;
      const prefix=`C${String(output.satCode||0).padStart(2,'0')}/${String(output.briCode||0).padStart(3,'0')} `;
      const title=prefix+(job.titleName||source.name)+(part.original?'':` [${region.mode==='lossless-jpeg'?'JPEG':'PNG'} ${p+1}/${region.parts.length}]`);
      descriptors.push({...part,key,marker,title,alt:source.name.slice(0,55)+' '+marker,source,job,region:regionInfo,index:p,count:region.parts.length,
       boardX:job.x-region.width/2+part.x+part.width/2,boardY:job.y-region.height/2+part.y+part.height/2,
       metadata:{fileName:source.name,satCode:output.satCode||0,briCode:output.briCode||0,uploadMode:region.mode,
        sourceWidth:source.info.width,sourceHeight:source.info.height,sourceX:region.sourceX+part.x,sourceY:region.sourceY+part.y,
        partIndex:p+1,partCount:region.parts.length,tileIndex:job.tileIndex||1,importRun:runId,importPart:key},attempts:0,id:null,found:false,pending:null});
     }
    }
    if(source.prepared){
     if(descriptors.length!==source.parts.length)throw Error('Prepared layout changed during recovery');
     for(let i=0;i<descriptors.length;i++){const a=descriptors[i],b=source.parts[i];if(['key','x','y','width','height','mime'].some(k=>a[k]!==b[k]))throw Error('Prepared part changed during recovery');b.blob=a.blob;}
    }else{
     source.parts=descriptors;source.prepared=true;state.totalParts+=descriptors.length;
     for(const p of descriptors)keyMap.set(p.key,p);
    }
    source.error=null;return true;
   }catch(error){source.error=error.message||String(error);return false;}
  }
  async function uploadPart(part){
   if(part.found||part.pending||uncertain())return;
   const readingAt=Date.now();
   try{
    const blob=part.original?part.source.file:part.blob;if(!blob)throw Error('Prepared part is unavailable');
    const url=await measure('readMs',()=>options.readDataUrl(blob));part.readMs=Date.now()-readingAt;
    if(url.length+2>root.LosslessUpload.URL_LIMIT)throw Error('Image payload exceeds Miro limit');
    await gate.take(500);part.attempts++;
    const request=measure('uploadMs',()=>Promise.resolve().then(()=>board.createImage({url,title:part.title,alt:part.alt,x:part.boardX,y:part.boardY,width:part.width})));
    part.pending=request;
    request.then(widget=>{if(part.pending===request)part.pending=null;timedOut.delete(part);acknowledge(part,widget);},error=>{if(part.pending===request)part.pending=null;timedOut.delete(part);part.error=error.message||String(error);});
    try{await deadline(request,requestMs,'Image upload');}
    catch(error){if(part.pending&&error.message==='Image upload timed out')timedOut.add(part);if(/429|rate.?limit|credits|too many/i.test(String(error.code||'')+' '+error.message))gate.block(options.rateLimit===false?0:61000);throw error;}
   }catch(error){part.error=error.message||String(error);}
   finally{part.blob=null;emit();}
  }
  async function uploadSource(source){await parallel(source.parts.filter(p=>!p.found),partLimit,uploadPart);for(const part of source.parts)part.blob=null;}
  async function snapshot(){
   try{
    await gate.take(500);const items=await measure('verifyMs',()=>deadline(Promise.resolve().then(()=>board.get({type:'image'})),options.readMs||30000,'Board verification'));
    if(!Array.isArray(items))throw Error('Board returned an invalid image list');
    const byId=new Map(items.map(item=>[item.id,item])),byKey=new Map();duplicates=0;
    for(const item of items){const alt=String(item.alt||''),start=alt.indexOf(`[ia:${runId}:`);if(start<0)continue;
     const end=alt.indexOf(']',start);if(end<0)continue;const key=alt.slice(start+5+runId.length,end);
     if(!keyMap.has(key))continue;if(byKey.has(key)){duplicates++;continue;}byKey.set(key,item);
    }
    state.verified=0;
    for(const part of allParts()){
     const widget=byKey.get(part.key)||(part.id&&byId.get(part.id));part.found=!!widget;
     if(widget){acknowledge(part,widget,false);state.verified++;}
     else part.widget=null;
    }
    boardError=null;emit();return true;
   }catch(error){boardError=error.message||String(error);emit({status:'Cannot verify board; waiting to check again…'});return false;}
  }
  async function groupSource(source,final=false){
    const widgets=source.parts.map(p=>p.widget).filter(Boolean);
    if(widgets.length<2||(!final&&widgets.length!==source.parts.length))return;
    const groups=new Set(widgets.map(w=>w.groupId).filter(Boolean));
    if(groups.size===1&&widgets.every(w=>w.groupId)){source.group={id:widgets[0].groupId,status:'created',itemIds:widgets.map(w=>w.id)};return;}
    if(source.group&&source.group.status==='created'&&source.group.itemIds&&widgets.every(w=>source.group.itemIds.includes(w.id))&&widgets.length===source.group.itemIds.length)return;
    if(groups.size){
     if(groups.size===1&&source.group&&source.group.id&&groups.has(source.group.id)){
      try{await gate.take(50);const previous=await deadline(board.getById(source.group.id),options.groupMs||30000,'Group lookup');await gate.take(50);await deadline(previous.ungroup(),options.groupMs||30000,'Ungrouping');}
      catch(error){source.group={status:'failed',error:error.message};return;}
     }else{source.group={status:'failed',error:'Parts are already assigned to different groups'};return;}
    }
    try{await gate.take(50);const group=await measure('groupMs',()=>deadline(Promise.resolve().then(()=>board.group({items:widgets})),options.groupMs||30000,'Grouping'));source.group={id:group.id,status:'created',itemIds:widgets.map(w=>w.id)};}
    catch(error){source.group={status:'failed',error:error.message||String(error)};}
  }
  function scheduleGroup(source,final=false){
   if(source.groupTask)return source.groupTask;
   const present=source.parts.filter(p=>p.widget).length;
   if(present<2||(!final&&present!==source.parts.length))return;
   source.groupTask=groupQueue.add(async()=>{
    try{await groupSource(source,final);if(source.group&&source.group.status==='created'&&!source.groupCounted){source.groupCounted=true;state.groupedSources++;emit();}}
    catch(error){source.group={status:'failed',error:error.message||String(error)};}
    finally{source.groupTask=null;}
   });return source.groupTask;
  }
  async function groupSources(final=false){
   for(const source of sources)scheduleGroup(source,final);
   await groupQueue.drain();
  }
  async function firstPass(){
   let next=0;const queue=root.LosslessUpload.createUploadQueue(sourceLimit),uploads=[];
   await Promise.all(preparers.map(async worker=>{
    while(next<sources.length&&!uncertain()){const source=sources[next++];
     if(source.info){emit({phase:'prepare',status:'Preparing and uploading tiles…'});if(await prepare(source,worker)){
       state.prepareDone++;emit();const admission=await measure('admissionWaitMs',()=>queue.enqueue(()=>uploadSource(source)));uploads.push(admission.done);
     }else{state.prepareDone++;emit();}}
     else{state.prepareDone++;emit();}
    }
   }));
   await queue.drain();await Promise.all(uploads);
  }
  async function recoveryPass(){
   if(uncertain())return;
   const todo=sources.filter(s=>!s.prepared||s.parts.some(p=>!p.found&&!p.pending));let next=0;
   const queue=root.LosslessUpload.createUploadQueue(sourceLimit),uploads=[];
   await Promise.all(preparers.map(async worker=>{while(next<todo.length){const source=todo[next++];
    if(await prepare(source,worker)){const admission=await queue.enqueue(()=>uploadSource(source));uploads.push(admission.done);}
   }}));await queue.drain();await Promise.all(uploads);
  }
   emit();
  try{
   await measure('scanMs',()=>parallel(sources,4,async source=>{await scanSource(source);state.scanDone++;emit();}));
   // Header failures are recorded and retried; they cannot disappear from totals.
   for(let attempt=2;attempt<=5&&sources.some(s=>!s.info);attempt++){
    emit({status:`Rechecking unreadable files: ${attempt}/5`});await wait(options.retryDelayMs===undefined?500:options.retryDelayMs);
    await parallel(sources.filter(s=>!s.info),4,scanSource);
   }
   await layout(sources);
   const workerCount=options.workers?Math.max(1,Math.min(4,files.length||1,Math.floor(options.workers))):preparationWorkers(sources);
   preparers=Array.from({length:workerCount},()=>createPreparer());state.workers=workerCount;
   emit({phase:'prepare',status:'Preparing and uploading tiles…'});
   await firstPass();
   let success=false;
   for(let pass=1;pass<=maxPasses;pass++){
    await groupQueue.drain();
    emit({pass,phase:'verify',status:`Checking uploaded tiles: ${pass}/5…`});
    const readable=await snapshot();
    if(readable)await groupSources(pass===5);
    const missing=sources.filter(s=>!s.prepared||s.parts.some(p=>!p.found));
    const groupFailed=sources.some(s=>s.group&&s.group.status==='failed');
    if(readable&&!missing.length&&!duplicates&&!groupFailed){success=true;break;}
    if(pass===maxPasses)break;
    await wait(options.retryDelayMs===undefined?Math.min(8000,1000*2**(pass-1)):options.retryDelayMs);
    // A failed board read never triggers a blind retransmission.
    if(readable&&await snapshot()){emit({pass:pass+1,phase:'upload',status:`Restoring missing tiles: ${pass+1}/5…`});await recoveryPass();}
   }
   const failures=sources.filter(s=>!s.prepared||s.parts.some(p=>!p.found)).map(s=>({name:s.name,
    missing:s.prepared?s.parts.filter(p=>!p.found).length:null,total:s.prepared?s.parts.length:null,error:s.error||s.parts.find(p=>!p.found&&p.error)?.error||boardError||'Image not found on board'}));
   if(metadataQueue.size)emit({phase:'details',status:'Finishing image details…'});
   await metadataQueue.drain();
   timings.rateWaitMs=gate.waitMs;timings.totalMs=clock()-startedAt;
   const result={success,sources,failures,verified:state.verified,totalParts:state.totalParts,passes:state.pass,boardError,duplicates,workers:state.workers,timings,
    groupErrors:sources.filter(s=>s.group&&s.group.status==='failed').map(s=>({name:s.name,error:s.group.error}))};
   emit({phase:success?'complete':'error',status:success?'All tiles verified':`Import incomplete after ${maxPasses} passes`});return result;
  }finally{active=false;await groupQueue.drain();await metadataQueue.drain();for(const worker of preparers)worker.dispose();for(const part of allParts())part.blob=null;}
 }
 root.ImportEngine={run,parallel,rateGate,preparationWorkers};
})(typeof window==='undefined'?globalThis:window);
