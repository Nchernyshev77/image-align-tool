const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
require('../lossless-upload');require('../jpeg-lossless');
const L=globalThis.LosslessUpload,J=globalThis.JpegLossless;
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'jpeg-fixtures.json'),'utf8'));
function workerHarness(){
 const root=path.resolve(__dirname,'..');let req=0,waiting;
 const context=vm.createContext({require,process,__dirname:path.join(root,'vendor/jpegcropscale'),console,
   Uint8Array,Uint32Array,ArrayBuffer,WebAssembly,URL,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,
   location:{href:'file://'+path.join(root,'jpeg-lossless-worker.js')},
   postMessage:message=>{if(message.error)waiting.reject(Error(message.error));else waiting.resolve(message);},
 });
 vm.runInContext('self=globalThis',context);
 context.importScripts=(...files)=>{for(const f of files)vm.runInContext(fs.readFileSync(path.resolve(root,f.split('?')[0]),'utf8'),context);};
 vm.runInContext(fs.readFileSync(path.join(root,'jpeg-lossless-worker.js'),'utf8'),context);
 return {call:message=>new Promise((resolve,reject)=>{waiting={resolve,reject};context.onmessage({data:{...message,req:++req}}).catch(reject);})};
}

test('JPEG header guards chroma seam axes and EXIF rotation',()=>{
 const a=J.info(Buffer.from(fixtures['444'],'base64')),b=J.info(Buffer.from(fixtures['422'],'base64'));
 assert.equal(a.eligible,true);assert.equal(a.safeX,true);assert.equal(a.safeY,true);
 assert.equal(b.eligible,true);assert.equal(b.safeX,false);assert.equal(b.safeY,true);
 assert.equal(J.info(Buffer.from(fixtures['420'],'base64')).eligible,false);
 assert.equal(J.info(Buffer.from(fixtures.orientation6,'base64')).eligible,false);
});

test('production JPEG worker runs vendored WASM, keeps dimensions/ICC, and rejects invalid crop boundaries',async()=>{
 const worker=workerHarness();
 for(const type of ['444','422']){
  const bytes=Buffer.from(fixtures[type],'base64'),meta=J.info(bytes),profile=L.jpegProfile(bytes);
  await worker.call({type:'open',buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
  for(const count of [2,4,8])for(const rect of L.dyadicRegions(meta.width,meta.height,count,meta)){
   const result=await worker.call({type:'crop',rect}),out=new Uint8Array(result.buffer),outputMeta=J.info(out);
   assert.equal(outputMeta.width,rect.width);assert.equal(outputMeta.height,rect.height);
   assert.deepEqual(L.jpegProfile(out),profile);
  }
  await assert.rejects(worker.call({type:'crop',rect:{x:1,y:0,width:32,height:32}}),/MCU/);
  await worker.call({type:'close'});
 }
 await assert.rejects(worker.call({type:'crop',rect:{x:0,y:0,width:32,height:32}}),/not open/);
});
