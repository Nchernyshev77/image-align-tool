'use strict';
importScripts('../lossless-upload.js?v=62','../jpeg-lossless.js?v=62');
self.onmessage=async e=>{
 const {type,file,info}=e.data;let client;
 const progress=stage=>self.postMessage({stage});
 try{
  if(type==='thumbnail'){
   progress('createImageBitmap(original, 50×50)');
   const bitmap=await createImageBitmap(file,{resizeWidth:50,resizeHeight:50});
   const dimensions={width:bitmap.width,height:bitmap.height};bitmap.close();self.postMessage({done:true,...dimensions});return;
  }
  JpegLossless.assertWorkspace(info.jpeg,file.size);
  client=JpegLossless.create({workerUrl:'../jpeg-lossless-worker.js?v=62'});
  progress('Read original and initialize native JPEG worker');await client.open(file,info.jpeg);
  let regions,count=2;
  for(;count<=256;count*=2){regions=LosslessUpload.dyadicRegions(info.width,info.height,count,{...JpegLossless.cropAlignment(info.jpeg),maxWidth:8192,maxHeight:4096});
   if(regions.every(r=>LosslessUpload.dimensionsFit(r.width,r.height)))break;}
  progress('Native JPEG coefficient crop');
  const rect=regions[0],blob=await client.crop(rect),output=JpegLossless.info(new Uint8Array(await blob.arrayBuffer()));
  self.postMessage({done:true,layoutParts:count,rect,bytes:blob.size,mime:blob.type,outputWidth:output.width,outputHeight:output.height,
   fitsPayload:LosslessUpload.fits(blob.size,'image/jpeg'),peakHeapBytes:client.peakHeapBytes});
 }catch(error){self.postMessage({error:error.message||String(error)});}
 finally{if(client)client.dispose();}
};
