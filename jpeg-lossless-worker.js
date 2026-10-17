'use strict';
importScripts('./lossless-upload.js?v=63','./jpeg-lossless.js?v=63');
let runtime,inputPtr=0,opened=false,sourceInfo,profile;
function load(){
  if(runtime)return runtime;
  runtime=new Promise((resolve,reject)=>{
    self.Module={locateFile:p=>new URL('./vendor/jpegcropscale/'+p+'?v=63',self.location.href).href,
      onRuntimeInitialized:()=>resolve(self.Module),onAbort:reason=>reject(Error(String(reason))),print:()=>{},printErr:()=>{}};
    importScripts('./vendor/jpegcropscale/jpeg_worker.js?v=63');
  });return runtime;
}
async function close(){if(opened||inputPtr){const m=await load();if(opened)m._close_jpeg();if(inputPtr)m._free(inputPtr);}inputPtr=0;opened=false;profile=null;sourceInfo=null;}
self.onmessage=async e=>{
 const msg=e.data;
 try{
  if(msg.type==='open'){
    await close();const bytes=new Uint8Array(msg.buffer);sourceInfo=JpegLossless.info(bytes);
    if(!sourceInfo.eligible)throw Error(sourceInfo.reason);
    JpegLossless.assertWorkspace(sourceInfo,bytes.length);
    profile=LosslessUpload.jpegProfile(bytes);const m=await load();
    if(!m._open_jpeg||!m._crop_jpeg)throw Error('JPEG codec version mismatch; reopen the application');
    inputPtr=m._malloc(bytes.length)>>>0;
    if(!inputPtr)throw Error('Not enough memory for JPEG source');
    try{
      m.HEAPU8.set(bytes,inputPtr);
      if(m._open_jpeg(inputPtr,bytes.length)!==0)throw Error('Reading JPEG coefficients failed: '+m.UTF8ToString(m._jpeg_error()>>>0));
      opened=true;
    }finally{m._free(inputPtr);inputPtr=0;}
    self.postMessage({req:msg.req,heapBytes:m.HEAPU8.length});return;
  }
  if(msg.type==='close'){await close();self.postMessage({req:msg.req});return;}
  if(msg.type!=='crop'||!opened)throw Error('JPEG source is not open');
  const r=msg.rect,m=await load();
  if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>sourceInfo.width||r.y+r.height>sourceInfo.height||r.x%sourceInfo.mcuX||r.y%sourceInfo.mcuY)throw Error('JPEG crop must match native MCU boundaries');
  const sizePtr=m._malloc(4)>>>0;if(!sizePtr)throw Error('Not enough memory for JPEG crop');let out=0;
  try{
    m.HEAPU32[sizePtr>>>2]=0;
    // Unsigned pointers are required above 2 GiB. Reuse the native coefficients.
    out=m._crop_jpeg(r.x,r.y,r.width,r.height,sizePtr)>>>0;
    const size=m.HEAPU32[sizePtr>>>2];
    if(!out||!size||out+size>m.HEAPU8.length){
      const reason=m._jpeg_error?m.UTF8ToString(m._jpeg_error()>>>0):'';
      throw Error('Lossless JPEG crop failed'+(reason?': '+reason:''));
    }
    const bytes=m.HEAPU8.slice(out,out+size),meta=JpegLossless.info(bytes),icc=LosslessUpload.jpegProfile(bytes);
    if(meta.width!==r.width||meta.height!==r.height||meta.orientation!==1)throw Error('JPEG crop dimensions changed');
    if((profile===null)!==(icc===null)||(profile&&(!icc||profile.length!==icc.length||profile.some((v,i)=>v!==icc[i]))))throw Error('JPEG color profile changed');
    self.postMessage({req:msg.req,buffer:bytes.buffer,heapBytes:m.HEAPU8.length},[bytes.buffer]);
  }finally{if(out)m._free_buffer(out);m._free(sizePtr);}
 }catch(error){self.postMessage({req:msg.req,error:error.message||String(error)});}
};
