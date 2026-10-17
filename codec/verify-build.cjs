// Opt-in integration check: actual allocation and a native 16K 4:4:4 crop
// beyond 2 GiB. Padding stresses the input allocation; it is not image detail.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
require('../jpeg-lossless');
const {jpeg}=require('../tests/large-jpeg-fixture');
const directory=path.resolve(__dirname,'../vendor/jpegcropscale');
let ready;
const initialized=new Promise(resolve=>ready=resolve);
const context=vm.createContext({require,process,__dirname:directory,console,Uint8Array,Uint32Array,ArrayBuffer,
 WebAssembly,URL,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,
 Module:{locateFile:p=>path.join(directory,p),onRuntimeInitialized:()=>ready(),print:()=>{},printErr:()=>{}}});
vm.runInContext(fs.readFileSync(path.join(directory,'jpeg_worker.js'),'utf8'),context);
(async()=>{
 await initialized;
 const m=context.Module,source=jpeg(16384,16384,'444');
 const padded=new Uint8Array(source.length+512*1024**2);padded.set(source);
 const input=m._malloc(padded.length)>>>0,sizePtr=m._malloc(4)>>>0;
 assert(input&&sizePtr,'Input allocation failed');m.HEAPU8.set(padded,input);
 let output=0;
 try{
  output=m._process_jpeg(input,padded.length,1,8192,12288,8192,4096,sizePtr)>>>0;
  const size=m.HEAPU32[sizePtr>>>2];
  assert(output&&size,m.UTF8ToString(m._jpeg_error()>>>0));
  const meta=JpegLossless.info(m.HEAPU8.subarray(output,output+size));
  assert.equal(meta.width,8192);assert.equal(meta.height,4096);
  assert(m.HEAPU8.length>2*1024**3,'Check did not exercise more than 2 GiB');
  console.log(JSON.stringify({check:'native 16K 4:4:4 crop above 2 GiB',sourceBytes:padded.length,
   heapBytes:m.HEAPU8.length,outputPointer:output,outputBytes:size,width:meta.width,height:meta.height}));
 }finally{if(output)m._free_buffer(output);m._free(sizePtr);m._free(input);}
})().catch(error=>{console.error(error);process.exitCode=1;});
