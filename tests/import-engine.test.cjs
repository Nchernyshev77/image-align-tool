const {test}=require('node:test'),assert=require('node:assert/strict');
require('../lossless-upload');require('../import-engine');
const L=globalThis.LosslessUpload,E=globalThis.ImportEngine;
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn){const end=Date.now()+3000;while(!fn()){assert.ok(Date.now()<end,'Timed out waiting for pipeline');await new Promise(r=>setImmediate(r));}}
function setup(count=1,options={}){
 const files=Array.from({length:count},(_,i)=>({name:`Tile_${i+1}.jpg`,index:i,type:'image/jpeg',size:28000000}));
 const images=new Map(),groups=[],calls=[],progress=[],metadata=[],scans=new Map(),preps=new Map();let next=0,prepareActive=0,maxPrepare=0,activeUploads=0,maxUploads=0,disposed=0;
 const board={
  async createImage(params){
   calls.push(params);const call=calls.length;activeUploads++;maxUploads=Math.max(maxUploads,activeUploads);
   try{
    if(options.onCreate)await options.onCreate(params,call);
    if(options.failBefore&&options.failBefore(params,call))throw Error('Network rejected request');
    const widget={...params,id:String(++next),type:'image',async setMetadata(key,value){if(options.onMetadata)await options.onMetadata(this);metadata.push({key,value});}};
    if(!options.drop||!options.drop(params,call))images.set(widget.id,widget);
    if(options.lostReply&&options.lostReply(params,call))throw Error('Connection lost after server accepted image');
    return widget;
   }finally{activeUploads--;}
  },
  async get(){if(options.readError)throw Error('Cannot read board');if(options.onRead)await options.onRead(images);return [...images.values()];},
  async group({items}){
   if(options.groupGate)await options.groupGate.promise;
   if(items.some(item=>!images.has(item.id)))throw Error('Cannot group an image missing from the board');
   const id='g'+groups.length;groups.push(items.map(i=>i.id));for(const item of items){item.groupId=id;}
   if(options.lostGroupReply&&groups.length===1)throw Error('Group response lost');
   if(options.groupError)throw Error('Cannot group');return {id};
  },
  async getById(id){return {async ungroup(){for(const item of images.values())if(item.groupId===id)item.groupId=undefined;}};},
 };
 const createPreparer=()=>({
  async prepare(file,info,jobs){
   preps.set(file.index,(preps.get(file.index)||0)+1);prepareActive++;maxPrepare=Math.max(maxPrepare,prepareActive);
   try{
    if(options.prepare)await options.prepare(file);
    if(options.prepareError&&options.prepareError(file,preps.get(file.index)))throw Error('Preparation failed');
    const rects=L.dyadicRegions(info.width,info.height,options.parts||4);
    return {satCode:12,briCode:100,regions:jobs.map(()=>({mode:'lossless-jpeg',sourceX:0,sourceY:0,width:info.width,height:info.height,
      parts:rects.map(r=>({...r,blob:{size:100,type:'image/jpeg',bytes:'image'},size:100,mime:'image/jpeg'}))}))};
   }finally{prepareActive--;}
  },dispose(){disposed++;},
 });
 const input={files,board,scan:async file=>{
  scans.set(file.index,(scans.get(file.index)||0)+1);
  if(options.scanError&&options.scanError(file,scans.get(file.index)))throw Error('File unreadable');return {width:4096,height:4096};
 },layout:async sources=>{for(const s of sources)s.jobs=s.info?[{kind:'full',width:4096,height:4096,x:s.index*4096,y:0}]:[];},
 createPreparer,onProgress:s=>{progress.push({...s});if(options.progress)options.progress(s);},
 options:{readDataUrl:async blob=>'data:'+blob.type+';base64,AAAA',rateLimit:false,retryDelayMs:0,requestMs:1000,workers:2,...options.engine}};
 return {input,files,images,groups,calls,progress,metadata,scans,preps,get maxPrepare(){return maxPrepare;},get maxUploads(){return maxUploads;},get disposed(){return disposed;},run:()=>E.run(input)};
}

test('256 sources / 1024 parts stream through two workers; uploads start before batch preparation finishes',async()=>{
 const app=setup(256,{prepare:()=>new Promise(r=>setImmediate(r))});const result=await app.run();
 assert.equal(result.success,true);assert.equal(result.totalParts,1024);assert.equal(result.verified,1024);assert.equal(app.calls.length,1024);assert.equal(app.groups.length,256);assert.equal(app.maxPrepare,2);
 assert.ok(app.progress.some(s=>s.uploaded>0&&s.prepareDone<256));assert.equal(app.disposed,2);
 assert.ok(result.sources.every(s=>s.parts.every(p=>p.blob===null&&!('parts' in p.region))),'No prepared-batch blob references remain');
});

test('only missing pieces are re-uploaded, already present pieces are retained',async()=>{
 const app=setup(2,{failBefore:(_,n)=>n===2});const result=await app.run();
 assert.equal(result.success,true);assert.equal(result.passes,2);assert.equal(app.calls.length,9);assert.equal(app.images.size,8);
 assert.equal(app.calls.filter(p=>p.alt===app.calls[1].alt).length,2);assert.equal(app.groups.length,2);
});

test('a lost create reply is recovered from the unique board marker without creating a duplicate',async()=>{
 const app=setup(1,{lostReply:(_,n)=>n===2});const result=await app.run();
 assert.equal(result.success,true);assert.equal(app.calls.length,4);assert.equal(app.images.size,4);assert.equal(result.verified,4);
});

test('an acknowledged image missing from the board is actually reuploaded',async()=>{
 const app=setup(1,{drop:(_,n)=>n===3});const result=await app.run();
 assert.equal(result.success,true);assert.equal(app.calls.length,5);assert.equal(app.images.size,4);
});

test('permanent missing piece stops after exactly five upload passes and is listed by filename',async()=>{
 const app=setup(1,{failBefore:p=>p.alt.includes(':0.0.1]')});const result=await app.run();
 assert.equal(result.success,false);assert.equal(result.passes,5);assert.equal(app.calls.length,8);assert.equal(result.failures[0].name,'Tile_1.jpg');
 assert.equal(result.failures[0].missing,1);assert.equal(result.verified,3);assert.equal(app.groups[0].length,3);
});

test('a failed board read never causes blind reuploads or false success',async()=>{
 const app=setup(1,{readError:true});const result=await app.run();
 assert.equal(result.success,false);assert.equal(result.passes,5);assert.equal(app.calls.length,4);assert.match(result.boardError,/Cannot read/);
});

test('a pending timed-out request is checked but never sent twice',async()=>{
 const blocked=gate();const app=setup(1,{parts:1,onCreate:()=>blocked.promise,engine:{requestMs:5}});const result=await app.run();
 assert.equal(result.success,false);assert.equal(app.calls.length,1);assert.equal(result.passes,5);blocked.resolve();
});

test('unreadable input remains in final totals after five header checks',async()=>{
 const app=setup(2,{scanError:file=>file.index===0});const result=await app.run();
 assert.equal(result.success,false);assert.equal(app.scans.get(0),5);assert.equal(result.failures[0].name,'Tile_1.jpg');assert.equal(result.failures[0].total,null);assert.equal(result.verified,4);
});

test('failed preparation is retried, and no pieces from a failed preparation are uploaded',async()=>{
 const app=setup(1,{prepareError:(_,attempt)=>attempt<3});const result=await app.run();
 assert.equal(result.success,true);assert.equal(result.passes,3);assert.equal(app.calls.length,4);assert.equal(app.preps.get(0),3);
});

test('permanently failed preparation errors after five passes',async()=>{
 const app=setup(1,{prepareError:()=>true});const result=await app.run();
 assert.equal(result.success,false);assert.equal(result.passes,5);assert.equal(app.preps.get(0),5);assert.equal(app.calls.length,0);
});

test('lost grouping reply is reconciled from groupId instead of grouping the same images again',async()=>{
 const app=setup(1,{lostGroupReply:true});const result=await app.run();
 assert.equal(result.success,true);assert.equal(app.groups.length,1);assert.equal(app.calls.length,4);
});

test('source admission remains bounded while twenty part requests are waiting',async()=>{
 const blocked=gate(),preparing=[];const app=setup(12,{onCreate:()=>blocked.promise,prepare:file=>{preparing.push(file.index);}});
 const running=app.run();await until(()=>app.calls.length===20);assert.ok(preparing.length<=7);assert.equal(app.maxUploads,20);
 blocked.resolve();const result=await running;assert.equal(result.success,true);
});

test('rate gate waits for minute credits instead of creating rate-limit errors',async()=>{
 let now=0,waited=0;const g=E.rateGate({now:()=>now,wait:async ms=>{now+=ms;waited+=ms;}});
 for(let i=0;i<191;i++)await g.take(500);assert.ok(waited>=60000);
});

test('a late server-created image appearing during retry delay is found before retransmission',async()=>{
 let app,inserted=false;
 app=setup(1,{parts:1,failBefore:(_,n)=>n===1,engine:{wait:async()=>{
  if(!inserted&&app.calls.length){inserted=true;app.images.set('late',{...app.calls[0],id:'late',type:'image'});}
 }}});
 const result=await app.run();assert.equal(result.success,true);assert.equal(app.calls.length,1);assert.equal(app.images.size,1);
});

test('timed-out active source requests do not allow an unbounded stream of new requests',async()=>{
 const blocked=gate();const app=setup(12,{parts:1,onCreate:()=>blocked.promise,engine:{requestMs:5}});
 const result=await app.run();assert.equal(result.success,false);assert.ok(app.calls.length<=5);blocked.resolve();
});

test('a complete source is grouped before remaining uploads and metadata finish',async()=>{
 const uploads=gate(),metadata=gate();
 const app=setup(12,{onCreate:p=>p.alt.includes(':0.')?undefined:uploads.promise,onMetadata:()=>metadata.promise,engine:{workers:4}});
 const running=app.run();await until(()=>app.groups.length===1);
 assert.equal(app.groups[0].length,4);assert.equal(app.images.size,4);assert.equal(app.metadata.length,0);
 assert.ok(app.calls.length>4);uploads.resolve();metadata.resolve();const result=await running;
 assert.equal(result.success,true);assert.equal(app.groups.length,12);
});

test('slow metadata never holds the five source upload slots; its own concurrency stays bounded',async()=>{
 const blocked=gate();let active=0,max=0;
 const app=setup(16,{parts:1,onMetadata:async()=>{active++;max=Math.max(max,active);await blocked.promise;active--;}});
 const running=app.run();await until(()=>app.images.size===16);assert.equal(app.metadata.length,0);assert.equal(max,4);
 blocked.resolve();const result=await running;assert.equal(result.success,true);assert.equal(app.metadata.length,16);
});

test('four preparation lanes still bound lookahead to five uploading plus four preparing sources',async()=>{
 const blocked=gate(),preparing=[];const app=setup(16,{onCreate:()=>blocked.promise,prepare:file=>preparing.push(file.index),engine:{workers:4}});
 const running=app.run();await until(()=>app.calls.length===20);assert.ok(preparing.length<=9);blocked.resolve();
 const result=await running;assert.equal(result.success,true);assert.equal(result.workers,4);assert.equal(app.disposed,4);
});

test('worker selection respects CPU, low memory, large images and batch size',()=>{
 const sources=Array.from({length:20},()=>({info:{width:4096,height:4096}}));
 assert.equal(E.preparationWorkers(sources,{hardwareConcurrency:16,deviceMemory:8}),4);
 assert.equal(E.preparationWorkers(sources,{hardwareConcurrency:16,deviceMemory:4}),2);
 assert.equal(E.preparationWorkers(sources,{hardwareConcurrency:4}),2);
 assert.equal(E.preparationWorkers(sources.slice(0,1),{hardwareConcurrency:16,deviceMemory:8}),1);
 assert.equal(E.preparationWorkers([{info:{width:20000,height:20000}},...sources],{hardwareConcurrency:16,deviceMemory:8}),1);
 assert.equal(E.preparationWorkers([{info:{width:16384,height:16384,jpeg:{coefficientBytes:805306368}}},...sources],{hardwareConcurrency:16,deviceMemory:8}),1);
});

test('summary includes per-stage timings without storing image data',async()=>{
 const app=setup(2),result=await app.run();assert.equal(result.success,true);
 for(const key of ['scanMs','prepareMs','readMs','uploadMs','metadataMs','groupMs','verifyMs','admissionWaitMs','rateWaitMs','totalMs'])assert.ok(Number.isFinite(result.timings[key])&&result.timings[key]>=0,key);
 assert.ok(result.timings.totalMs>0);assert.equal(result.workers,2);
});
