async function squareMemory64Test(sizes=[32768]){
 for(const size of sizes){
  const file=new File([LargeJpegFixture.jpeg(size,size,'444')],`Square_${size}.jpg`,{type:'image/jpeg'}),info=await FastImageScan.scan(file);
  const client=TilePreparation.create({workerUrl:'../tile-prepare-worker.js?v=64'}),started=performance.now(),stages=[];
  log(`Checking ${size}×${size} 4:4:4 in memory64, without an embedded thumbnail…`);
  try{
   const prepared=await client.prepare(file,info,[{kind:'full',width:size,height:size}],p=>stages.push(p.stage)),region=prepared.regions[0];
   assert(prepared.timings.jpegPeakHeapBytes>4*1024**3,'Memory64 test did not cross 4 GiB');
   assert(stages.includes('Preparing a small JPEG preview…'),'Large JPEG tried a whole-source browser preview');
   let area=0;
   for(let i=0;i<region.parts.length;i++){
    const p=region.parts[i];assert(p.blob.type==='image/jpeg'&&L.fits(p.blob.size,'image/jpeg')&&L.dimensionsFit(p.width,p.height),'Invalid memory64 JPEG part');area+=p.width*p.height;
    // Decode first, central, and last parts; native worker validates every output.
    if(i===0||i===Math.floor(region.parts.length/2)||i===region.parts.length-1){
     const image=await createImageBitmap(p.blob,{resizeWidth:1,resizeHeight:1}),canvas=new OffscreenCanvas(1,1),ctx=canvas.getContext('2d');
     try{assert(image.width===1&&image.height===1,'Preview decode failed');ctx.drawImage(image,0,0);const pixel=ctx.getImageData(0,0,1,1).data;assert(pixel[0]===128&&pixel[1]===128&&pixel[2]===128&&pixel[3]===255,'Memory64 pixels changed');}finally{image.close();}
    }
   }
   assert(area===size*size,'Memory64 source lost image area');
   log(`PASS ${size}×${size} memory64: ${region.parts.length} JPEG parts, full resolution; heap ${Math.round(prepared.timings.jpegPeakHeapBytes/1024**2)} MiB; ${Math.round(performance.now()-started)} ms`);
  }finally{client.dispose();}
 }
}
