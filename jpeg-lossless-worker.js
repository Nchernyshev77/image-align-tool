'use strict';
importScripts('./lossless-upload.js?v=55','./jpeg-lossless.js?v=55');
let runtime,inputPtr=0,inputSize=0,sourceInfo,profile;
function load(){
  if(runtime)return runtime;
  runtime=new Promise((resolve,reject)=>{
    self.Module={locateFile:p=>new URL('./vendor/jpegcropscale/'+p,self.location.href).href,
      onRuntimeInitialized:()=>resolve(self.Module),onAbort:reason=>reject(Error(String(reason))),print:()=>{},printErr:()=>{}};
    importScripts('./vendor/jpegcropscale/jpeg_worker.js');
  });return runtime;
}
async function close(){if(inputPtr){const m=await load();m._free(inputPtr);}inputPtr=0;inputSize=0;profile=null;sourceInfo=null;}
self.onmessage=async e=>{
 const msg=e.data;
 try{
  if(msg.type==='open'){
    await close();const bytes=new Uint8Array(msg.buffer);sourceInfo=JpegLossless.info(bytes);
    if(!sourceInfo.eligible)throw Error(sourceInfo.reason);
    profile=LosslessUpload.jpegProfile(bytes);const m=await load();inputSize=bytes.length;inputPtr=m._malloc(inputSize);
    if(!inputPtr)throw Error('Not enough memory for JPEG source');m.HEAPU8.set(bytes,inputPtr);
    self.postMessage({req:msg.req});return;
  }
  if(msg.type==='close'){await close();self.postMessage({req:msg.req});return;}
  if(msg.type!=='crop'||!inputPtr)throw Error('JPEG source is not open');
  const r=msg.rect,m=await load();
  if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>sourceInfo.width||r.y+r.height>sourceInfo.height||r.x%sourceInfo.mcuX||r.y%sourceInfo.mcuY)throw Error('JPEG crop must match native MCU boundaries');
  const sizePtr=m._malloc(4);let out=0;
  try{
    m.HEAPU32[sizePtr>>2]=0;
    // Scale is hardcoded to 1: the lossy downscale/recompression branch is never used.
    out=m._process_jpeg(inputPtr,inputSize,1,r.x,r.y,r.width,r.height,sizePtr);
    const size=m.HEAPU32[sizePtr>>2];if(!out||!size||out+size>m.HEAPU8.length)throw Error('Lossless JPEG crop failed');
    const bytes=m.HEAPU8.slice(out,out+size),meta=JpegLossless.info(bytes),icc=LosslessUpload.jpegProfile(bytes);
    if(meta.width!==r.width||meta.height!==r.height||meta.orientation!==1)throw Error('JPEG crop dimensions changed');
    if((profile===null)!==(icc===null)||(profile&&(!icc||profile.length!==icc.length||profile.some((v,i)=>v!==icc[i]))))throw Error('JPEG color profile changed');
    self.postMessage({req:msg.req,buffer:bytes.buffer},[bytes.buffer]);
  }finally{if(out)m._free_buffer(out);m._free(sizePtr);}
 }catch(error){self.postMessage({req:msg.req,error:error.message||String(error)});}
};
