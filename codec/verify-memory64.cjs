// Verify real 64-bit addresses with a sparse 4 GiB allocation, without
// touching/committing that gap. Then crop a small public fixture above it.
const {spawnSync}=require('node:child_process');
if(Number(process.versions.node.split('.')[0])<24&&!process.env.JPEG_MEMORY64_NODE_READY){
 const result=spawnSync(process.execPath,['--experimental-wasm-memory64',__filename],{stdio:'inherit',env:{...process.env,JPEG_MEMORY64_NODE_READY:'1'}});process.exit(result.status??1);
}
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
require('../jpeg-lossless');require('../lossless-upload');
const fixtures=require('../tests/jpeg-fixtures.json');
const directory=path.resolve(__dirname,'../vendor/jpegcropscale');let ready;
const initialized=new Promise(resolve=>ready=resolve);
const context=vm.createContext({require,process,__dirname:directory,console,Uint8Array,Uint32Array,BigUint64Array,ArrayBuffer,WebAssembly,URL,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,
 Module:{locateFile:p=>path.join(directory,p),onRuntimeInitialized:()=>ready(),print:()=>{},printErr:()=>{}}});
vm.runInContext(fs.readFileSync(path.join(directory,'jpeg_worker64.js'),'utf8'),context);
(async()=>{
 await initialized;const m=context.Module,gap=m._malloc(4n*1024n**3n);assert(gap,'Sparse address reservation failed');
 let input,sizePtr,output;
 try{
  const source=Buffer.from(fixtures['444'],'base64');input=m._malloc(BigInt(source.length));sizePtr=m._malloc(8n);
  assert(Number(input)>2**32,'Input did not cross 4 GiB');m.HEAPU8.set(source,Number(input));
  assert.equal(m._open_jpeg(BigInt(input),BigInt(source.length)),0,m.UTF8ToString(Number(m._jpeg_error())));
  output=m._crop_jpeg(0,0,32,32,BigInt(sizePtr));
  const size=Number(new DataView(m.HEAPU8.buffer).getBigUint64(Number(sizePtr),true));assert(output&&size,m.UTF8ToString(Number(m._jpeg_error())));
  assert(Number(output)>2**32,'Output did not cross 4 GiB');
  const bytes=m.HEAPU8.slice(Number(output),Number(output)+size),meta=JpegLossless.info(bytes);
  assert.equal(meta.width,32);assert.equal(meta.height,32);assert.deepEqual(LosslessUpload.jpegProfile(bytes),LosslessUpload.jpegProfile(source));
  console.log(JSON.stringify({check:'memory64 JPEG crop at real addresses above 4 GiB',input:Number(input),output:Number(output),heapBytes:m.HEAPU8.length,outputBytes:size}));
 }finally{if(output)m._free_buffer(BigInt(output));m._close_jpeg();if(sizePtr)m._free(BigInt(sizePtr));if(input)m._free(BigInt(input));m._free(BigInt(gap));}
})().catch(error=>{console.error(error);process.exitCode=1;});
