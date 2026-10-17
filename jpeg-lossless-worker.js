'use strict';
importScripts('./lossless-upload.js?v=64','./jpeg-lossless.js?v=64');
let runtime,runtimeWide=false,inputPtr=0,opened=false,sourceInfo,profile;
const ptr=n=>runtimeWide?BigInt(n):n;
const offset=n=>runtimeWide?Number(n):n>>>0;
function load(wide=false){
  if(runtime){if(runtimeWide!==wide)throw Error('JPEG memory mode changed; reopen the worker');return runtime;}
  if(wide&&!WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,4,0])))throw Error('This browser does not support 64-bit JPEG processing; use an updated 64-bit Chrome or Firefox');
  runtimeWide=wide;
  runtime=new Promise((resolve,reject)=>{
    self.Module={locateFile:p=>new URL('./vendor/jpegcropscale/'+p+'?v=64',self.location.href).href,
      onRuntimeInitialized:()=>resolve(self.Module),onAbort:reason=>reject(Error(String(reason))),print:()=>{},printErr:()=>{}};
    try{importScripts('./vendor/jpegcropscale/jpeg_worker'+(wide?'64':'')+'.js?v=64');}catch(error){reject(error);}
  });return runtime;
}
async function close(){if(opened||inputPtr){const m=await runtime;if(opened)m._close_jpeg();if(inputPtr)m._free(ptr(inputPtr));}inputPtr=0;opened=false;profile=null;sourceInfo=null;}
self.onmessage=async e=>{
 const msg=e.data;
 try{
  if(msg.type==='open'){
    await close();
    const header=msg.file?await JpegLossless.readHeader(msg.file):{bytes:new Uint8Array(msg.buffer)};
    sourceInfo=header.meta||JpegLossless.info(header.bytes);
    if(!sourceInfo.eligible)throw Error(sourceInfo.reason);
    const size=msg.file?msg.file.size:header.bytes.length;
    JpegLossless.assertWorkspace(sourceInfo,size);
    const wide=JpegLossless.needsMemory64(sourceInfo,size)||!!msg.wide;
    profile=LosslessUpload.jpegProfile(header.bytes);const m=await load(wide);
    if(!m._open_jpeg||!m._crop_jpeg)throw Error('JPEG codec version mismatch; reopen the application');
    inputPtr=offset(m._malloc(ptr(size)));
    if(!inputPtr)throw Error('Not enough memory for JPEG source');
    try{
      if(msg.file){
        // Only a small read buffer exists outside WASM, even for gigabyte files.
        const chunkBytes=16*1024**2;
        for(let at=0;at<size;at+=chunkBytes){
          const bytes=new Uint8Array(await msg.file.slice(at,Math.min(size,at+chunkBytes)).arrayBuffer());
          if(bytes.length!==Math.min(chunkBytes,size-at))throw Error('Incomplete local JPEG read');
          m.HEAPU8.set(bytes,inputPtr+at);
        }
      }else m.HEAPU8.set(header.bytes,inputPtr);
      if(m._open_jpeg(ptr(inputPtr),ptr(size))!==0)throw Error('Reading JPEG coefficients failed: '+m.UTF8ToString(offset(m._jpeg_error())));
      opened=true;
    }finally{m._free(ptr(inputPtr));inputPtr=0;}
    self.postMessage({req:msg.req,heapBytes:m.HEAPU8.length,memory64:wide});return;
  }
  if(msg.type==='close'){await close();self.postMessage({req:msg.req});return;}
  if(msg.type!=='crop'||!opened)throw Error('JPEG source is not open');
  const r=msg.rect,m=await runtime;
  if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>sourceInfo.width||r.y+r.height>sourceInfo.height||r.x%sourceInfo.mcuX||r.y%sourceInfo.mcuY)throw Error('JPEG crop must match native MCU boundaries');
  const sizePtr=offset(m._malloc(ptr(runtimeWide?8:4)));if(!sizePtr)throw Error('Not enough memory for JPEG crop');let out=0;
  try{
    m.HEAPU8.fill(0,sizePtr,sizePtr+(runtimeWide?8:4));
    out=offset(m._crop_jpeg(r.x,r.y,r.width,r.height,ptr(sizePtr)));
    const view=new DataView(m.HEAPU8.buffer),size=runtimeWide?Number(view.getBigUint64(sizePtr,true)):view.getUint32(sizePtr,true);
    if(!out||!size||!Number.isSafeInteger(size)||out+size>m.HEAPU8.length){
      const reason=m._jpeg_error?m.UTF8ToString(offset(m._jpeg_error())):'';
      throw Error('Lossless JPEG crop failed'+(reason?': '+reason:''));
    }
    const bytes=m.HEAPU8.slice(out,out+size),meta=JpegLossless.info(bytes),icc=LosslessUpload.jpegProfile(bytes);
    if(meta.width!==r.width||meta.height!==r.height||meta.orientation!==1)throw Error('JPEG crop dimensions changed');
    if((profile===null)!==(icc===null)||(profile&&(!icc||profile.length!==icc.length||profile.some((v,i)=>v!==icc[i]))))throw Error('JPEG color profile changed');
    self.postMessage({req:msg.req,buffer:bytes.buffer,heapBytes:m.HEAPU8.length},[bytes.buffer]);
  }finally{if(out)m._free_buffer(ptr(out));m._free(ptr(sizePtr));}
 }catch(error){self.postMessage({req:msg.req,error:error.message||String(error)});}
};
