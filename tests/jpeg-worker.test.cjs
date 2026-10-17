const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
require('../lossless-upload');require('../jpeg-lossless');
const L=globalThis.LosslessUpload,J=globalThis.JpegLossless;
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'jpeg-fixtures.json'),'utf8'));
function quantizationTables(bytes){
 const tables={};
 for(let p=2;p+4<=bytes.length;){
  if(bytes[p++]!==255)throw Error('Invalid JPEG marker');while(bytes[p]===255)p++;
  const marker=bytes[p++];if(marker===0xda||marker===0xd9)break;
  if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
  const length=(bytes[p]<<8)|bytes[p+1];
  if(marker===0xdb)for(let q=p+2;q<p+length;){const spec=bytes[q++],size=64*((spec>>4)+1);tables[spec&15]=Array.from(bytes.subarray(q,q+size));q+=size;}
  p+=length;
 }
 return tables;
}
function workerHarness({memory64Supported=true,reserveAbove4GiB=false}={}){
 const root=path.resolve(__dirname,'..');let req=0,waiting,reservation=0;
 const context=vm.createContext({require,process,__dirname:path.join(root,'vendor/jpegcropscale'),console,
   Uint8Array,Uint32Array,ArrayBuffer,WebAssembly:memory64Supported?WebAssembly:{validate:()=>false},URL,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,
   location:{href:'file://'+path.join(root,'jpeg-lossless-worker.js')},
   postMessage:message=>{if(message.error)waiting.reject(Error(message.error));else waiting.resolve(message);},
 });
 vm.runInContext('self=globalThis',context);
 context.importScripts=(...files)=>{for(const f of files){
  if(reserveAbove4GiB&&f.includes('jpeg_worker64.js')){
   const ready=context.Module.onRuntimeInitialized;
   context.Module.onRuntimeInitialized=()=>{reservation=context.Module._malloc(4n*1024n**3n);assert(reservation,'64-bit address reservation failed');ready();};
  }
  vm.runInContext(fs.readFileSync(path.resolve(root,f.split('?')[0]),'utf8'),context);
 }};
 vm.runInContext(fs.readFileSync(path.join(root,'jpeg-lossless-worker.js'),'utf8'),context);
 return {call:message=>new Promise((resolve,reject)=>{waiting={resolve,reject};context.onmessage({data:{...message,req:++req}}).catch(reject);}),dispose(){if(reservation)context.Module._free(BigInt(reservation));reservation=0;}};
}

test('JPEG header permits coefficient cropping for 4:2:0 and records chroma seam axes and EXIF rotation',()=>{
 const a=J.info(Buffer.from(fixtures['444'],'base64')),b=J.info(Buffer.from(fixtures['422'],'base64'));
 assert.equal(a.eligible,true);assert.equal(a.safeX,true);assert.equal(a.safeY,true);
 assert.equal(b.eligible,true);assert.equal(b.safeX,false);assert.equal(b.safeY,true);
 const c=J.info(Buffer.from(fixtures['420'],'base64'));assert.equal(c.eligible,true);assert.equal(c.safeX,false);assert.equal(c.safeY,false);
 assert.equal(J.info(Buffer.from(fixtures.orientation6,'base64')).eligible,false);
});

for(const wide of [false,true])test(`production ${wide?'memory64':'wasm32'} JPEG worker keeps dimensions/ICC and rejects invalid crop boundaries`,async()=>{
 const worker=workerHarness({reserveAbove4GiB:wide});
 for(const type of ['444','422','420']){
  const bytes=Buffer.from(fixtures[type],'base64'),meta=J.info(bytes),profile=L.jpegProfile(bytes);
  const opened=await worker.call({type:'open',wide,buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});if(wide)assert(opened.heapBytes>4*1024**3);
  for(const count of [2,4,8])for(const rect of L.dyadicRegions(meta.width,meta.height,count,J.cropAlignment(meta))){
   const result=await worker.call({type:'crop',rect}),out=new Uint8Array(result.buffer),outputMeta=J.info(out);
   assert.equal(outputMeta.width,rect.width);assert.equal(outputMeta.height,rect.height);
   assert.equal(outputMeta.mcuX,meta.mcuX);assert.equal(outputMeta.mcuY,meta.mcuY);
   assert.deepEqual(quantizationTables(out),quantizationTables(bytes));
   assert.deepEqual(L.jpegProfile(out),profile);
  }
  await assert.rejects(worker.call({type:'crop',rect:{x:1,y:0,width:32,height:32}}),/MCU/);
  const rect={x:0,y:0,width:32,height:32};
  const before=await worker.call({type:'crop',rect});
  await worker.call({type:'crop',rect:{x:32,y:32,width:32,height:32}});
  const after=await worker.call({type:'crop',rect});
  assert.deepEqual(new Uint8Array(after.buffer),new Uint8Array(before.buffer),'Cached coefficients must survive other crops and rejected boundaries');
  await worker.call({type:'close'});
 }
 await assert.rejects(worker.call({type:'crop',rect:{x:0,y:0,width:32,height:32}}),/not open/);worker.dispose();
});

test('EXIF thumbnail offsets address the original bytes and malformed optional thumbnails are ignored',()=>{
 const original=Buffer.from(fixtures['444'],'base64'),preview=Buffer.from(fixtures['420'],'base64');
 for(const le of [true,false]){
  const tiff=new Uint8Array(44+preview.length),view=new DataView(tiff.buffer);
  tiff.set(le?[73,73]:[77,77]);view.setUint16(2,42,le);view.setUint32(4,8,le);
  view.setUint16(8,0,le);view.setUint32(10,14,le);view.setUint16(14,2,le);
  for(const [at,tag,value] of [[16,0x201,44],[28,0x202,preview.length]]){
   view.setUint16(at,tag,le);view.setUint16(at+2,4,le);view.setUint32(at+4,1,le);view.setUint32(at+8,value,le);
  }
  tiff.set(preview,44);
  const segment=Buffer.concat([Buffer.from([255,225,0,0]),Buffer.from('Exif\0\0'),tiff]);segment.writeUInt16BE(segment.length-2,2);
  const bytes=Buffer.concat([original.subarray(0,2),segment,original.subarray(2)]),thumb=J.info(bytes).thumbnail;
  assert.equal(thumb.offset,56);assert.deepEqual(bytes.subarray(thumb.offset,thumb.offset+thumb.length),preview);
  bytes.fill(255,2+10+28+8,2+10+28+12);
  assert.equal(J.info(bytes).thumbnail,undefined);
 }
});

test('preparation progress does not resolve the operation before its final result',async()=>{
 let instance;
 class Worker{constructor(){instance=this;}postMessage(message){this.request=message;}terminate(){}}
 const context=vm.createContext({Worker,setTimeout,clearTimeout,Error});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../tile-preparation.js'),'utf8'),context);
 const client=context.TilePreparation.create(),stages=[];let finished=false;
 const result=client.prepare({size:10},{width:32,height:32},[],p=>stages.push(p.stage)).then(r=>{finished=true;return r;});
 instance.onmessage({data:{req:instance.request.req,progress:{stage:'Reading JPEG coefficients once…'}}});
 await Promise.resolve();assert.equal(finished,false);assert.deepEqual(stages,['Reading JPEG coefficients once…']);
 instance.onmessage({data:{req:instance.request.req,regions:[]}});
 assert.deepEqual((await result).regions,[]);client.dispose();
});

test('4:2:2 prefers exact horizontal seams but can cut across chroma when pixel limits require it',()=>{
 const meta=J.info(Buffer.from(fixtures['422'],'base64')),alignment=J.cropAlignment(meta);
 const strips=L.dyadicRegions(4096,4096,8,alignment);assert.ok(strips.every(r=>r.width===4096&&r.x===0));
 const forced=L.dyadicRegions(16384,4096,2,{...alignment,maxWidth:8192,maxHeight:4096});
 assert.ok(forced.every(r=>r.width===8192&&r.height===4096));
});

test('workspace routing keeps small files on wasm32, accepts 32K with reserve and rejects oversized working sets',async()=>{
 const {jpeg}=require('./large-jpeg-fixture');
 for(const sampling of ['420','444']){
  const bytes=jpeg(16384,16384,sampling),meta=J.info(bytes);
  assert.equal(meta.coefficientBytes,16384*16384*(sampling==='420'?3:6));
  assert.ok(J.assertWorkspace(meta,bytes.length)<=J.HEAP_BYTES);
  assert.ok(J.assertWorkspace(meta,600*1024**2)<J.HEAP_BYTES);
 }
 const strip=jpeg(32768,4096),stripMeta=J.info(strip);assert.ok(J.assertWorkspace(stripMeta,strip.length)<J.HEAP_BYTES);
 const square=jpeg(32768,32768,'444'),squareMeta=J.info(square);assert.equal(squareMeta.coefficientBytes,6*1024**3);
 assert(J.needsMemory64(squareMeta,square.length));assert(J.assertWorkspace(squareMeta,2*1024**3)<J.HEAP_BYTES);
 const reserve=J.info(jpeg(36864,36864,'444'));assert(J.assertWorkspace(reserve,3*1024**3)<J.HEAP_BYTES);
 assert(!J.needsMemory64(J.info(jpeg(4096,4096,'444')),18000000));
 const enormous=jpeg(65500,65500,'444'),enormousMeta=J.info(enormous);assert.throws(()=>J.assertWorkspace(enormousMeta,enormous.length),/16 GiB/);
 const worker=workerHarness();await assert.rejects(worker.call({type:'open',buffer:enormous.buffer}),/16 GiB/);
 const unsupported=workerHarness({memory64Supported:false});await assert.rejects(unsupported.call({type:'open',buffer:square.buffer}),/does not support 64-bit/);
});

test('large JPEG close terminates the native worker to release its grown WASM heap',async()=>{
 const instances=[];
 class Worker{
  constructor(){this.messages=[];instances.push(this);}
  postMessage(message){this.messages.push(message.type);queueMicrotask(()=>this.onmessage({data:{req:message.req}}));}
  terminate(){this.terminated=true;}
 }
 const context=vm.createContext({Worker,Blob,Uint8Array,DataView,Map,Math,Number,Error,String});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../jpeg-lossless.js'),'utf8'),context);
 const client=context.JpegLossless.create(),small=new Blob([Buffer.from(fixtures['444'],'base64')]);
 await client.open(small);await client.close();assert.equal(instances.length,1);assert.equal(instances[0].terminated,undefined);
 const large=new Blob([require('./large-jpeg-fixture').jpeg(16384,16384,'444')]);
 await client.open(large);await client.close();assert.equal(instances[0].terminated,true);
 await client.open(small);assert.equal(instances.length,2);client.dispose();assert.equal(instances[1].terminated,true);
});

test('large preparation gets ten minutes while ordinary tiles keep the two-minute deadline',()=>{
 require('../tile-preparation');
 assert.equal(globalThis.TilePreparation.timeoutFor({size:28000000},{width:4096,height:4096,jpeg:{coefficientBytes:96*1024**2}}),120000);
 assert.equal(globalThis.TilePreparation.timeoutFor({size:300000000},{width:16384,height:16384,jpeg:{coefficientBytes:1536*1024**2}}),600000);
});


test('local JPEG loading uses bounded File slices without a complete outside-WASM read',async()=>{
 const bytes=Buffer.from(fixtures['444'],'base64'),blob=new Blob([bytes,new Uint8Array(17*1024**2)]),reads=[];
 const file={size:blob.size,arrayBuffer(){throw Error('Full source read is forbidden');},slice(start,end){reads.push(end-start);return blob.slice(start,end);}};
 const worker=workerHarness();await worker.call({type:'open',file});
 const result=await worker.call({type:'crop',rect:{x:0,y:0,width:32,height:32}});
 assert.equal(J.info(new Uint8Array(result.buffer)).width,32);assert(reads.length>=3);assert(Math.max(...reads)<=16*1024**2);await worker.call({type:'close'});
});
