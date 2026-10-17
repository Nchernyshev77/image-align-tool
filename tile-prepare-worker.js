'use strict';
importScripts('./lossless-upload.js?v=63','./jpeg-lossless.js?v=63');
const jpeg=JpegLossless.create();
async function tone(file,info){
 let image;
 const thumbnail=info.jpeg?.thumbnail;
 if(thumbnail)try{image=await createImageBitmap(file.slice(thumbnail.offset,thumbnail.offset+thumbnail.length,'image/jpeg'),{resizeWidth:50,resizeHeight:50});}catch{}
 if(!image)image=await createImageBitmap(file,{resizeWidth:50,resizeHeight:50});
 try{
  const canvas=new OffscreenCanvas(50,50),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,50,50);
  const sample=ctx.getImageData(0,0,50,50).data,complexity=new Float32Array(2500);
  for(let y=0;y<50;y++)for(let x=0;x<50;x++){
   const i=(y*50+x)*4;let score=0;
   for(let c=0;c<3;c++){if(x)score+=Math.abs(sample[i+c]-sample[i-4+c]);if(y)score+=Math.abs(sample[i+c]-sample[i-200+c]);}
   complexity[y*50+x]=score;
  }
  ctx.clearRect(0,0,50,50);ctx.filter='blur(3px)';ctx.drawImage(image,0,0,50,50);
  const data=ctx.getImageData(10,15,30,35).data;let y=0,diff=0;
  for(let i=0;i<data.length;i+=4){y+=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];diff+=Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2]);}
  canvas.width=canvas.height=1;
  return {briCode:Math.round((1-y/(data.length/4)/255)*999),satCode:Math.min(99,Math.round(diff/(data.length/4)/255*4*99)),complexity};
 }finally{image.close();}
}
self.onmessage=async e=>{
 const {req,file,info,jobs}=e.data;let source,meta,jpegOpened=false;const regions=[];let response;
 const timings={toneMs:0,encodeMs:0,probes:0};
 const progress=stage=>self.postMessage({req,progress:{stage}});
 try{
  const needsTransform=jobs.some(j=>j.kind!=='full'||!LosslessUpload.fits(file.size,file.type||'application/octet-stream')||!LosslessUpload.dimensionsFit(j.width,j.height));
  const isJpeg=!!info.jpeg||/image\/jpe?g/i.test(file.type)||(!file.type&&/\.(jpe?g|jfif)$/i.test(file.name||''));
  if(needsTransform&&isJpeg){
   meta=info.jpeg;if(!meta){meta=await jpeg.open(file);jpegOpened=meta.eligible;}
   if(!meta.eligible)throw Error(meta.reason||'Unsupported JPEG slicing; no PNG conversion is used');
   if(meta.width!==info.width||meta.height!==info.height)throw Error('JPEG dimensions differ; refusing to resize or convert');
   JpegLossless.assertWorkspace(meta,file.size);
  }
  progress(info.jpeg?.thumbnail?'Reading embedded preview…':'Reading image preview…');
  const toneStarted=performance.now(),colors=await tone(file,info);
  timings.toneMs=performance.now()-toneStarted;
  for(const job of jobs){
   const full=job.kind==='full',width=full?job.width:job.sw,height=full?job.height:job.sh;
   const sourceX=full?0:job.sx,sourceY=full?0:job.sy;
   const priority=r=>{
    const x0=Math.floor((sourceX+r.x)/info.width*50),y0=Math.floor((sourceY+r.y)/info.height*50);
    const x1=Math.min(50,Math.ceil((sourceX+r.x+r.width)/info.width*50)),y1=Math.min(50,Math.ceil((sourceY+r.y+r.height)/info.height*50));
    let score=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)score+=colors.complexity[y*50+x];
    return score/Math.max(1,(x1-x0)*(y1-y0))*r.width*r.height;
   };
   let planCount=0,planDone=0;
   const measured=encode=>async r=>{const start=performance.now();timings.probes++;try{return await encode(r);}finally{timings.encodeMs+=performance.now()-start;progress(`Preparing ${++planDone} / ${planCount} parts…`);}};
   const limits={maxWidth:LosslessUpload.MAX_IMAGE_WIDTH,maxHeight:LosslessUpload.MAX_IMAGE_HEIGHT};
   let mode='original',parts,reason,attempts=[];
   const attempt=n=>{attempts.push(n);planCount=n;planDone=0;};
   if(full&&LosslessUpload.fits(file.size,file.type||'application/octet-stream')&&LosslessUpload.dimensionsFit(width,height))parts=[{x:0,y:0,width,height,original:true,size:file.size,mime:file.type}];
   else{
    if(isJpeg){if(!jpegOpened){progress('Reading JPEG coefficients once…');meta=await jpeg.open(file,meta);jpegOpened=true;}mode='lossless-jpeg';parts=await LosslessUpload.planParts(width,height,measured(r=>jpeg.crop({...r,x:r.x+sourceX,y:r.y+sourceY})),
     {...limits,mime:'image/jpeg',alignment:JpegLossless.cropAlignment(meta),priority,firstCount:full?2:1,onAttempt:attempt});}
    else{
     mode='lossless-png';
     if(!source){source=await LosslessUpload.openSource(file);if(source.image.width!==info.width||source.image.height!==info.height)throw Error('Decoded dimensions differ; refusing to resize');}
     parts=await LosslessUpload.planParts(width,height,measured(r=>LosslessUpload.encodeRegion(source,{...r,x:r.x+sourceX,y:r.y+sourceY})),
      {...limits,priority,firstCount:full?2:1,onAttempt:attempt});
    }
   }
   regions.push({mode,attempts,reason,sourceX,sourceY,width,height,parts:parts.map(p=>({...p,size:p.blob?p.blob.size:p.size,mime:p.blob?p.blob.type:p.mime}))});
  }
  timings.jpegPeakHeapBytes=jpegOpened?jpeg.peakHeapBytes:0;
  response={req,regions,satCode:colors.satCode,briCode:colors.briCode,timings};
 }catch(error){response={req,error:error.message||String(error)};}
 finally{if(source)source.close();await jpeg.close();}
 self.postMessage(response);
};
