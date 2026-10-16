(function(root){
 'use strict';
 async function scan(file){
  let size=Math.min(file.size,65536);
  while(true){
   const b=new Uint8Array(await file.slice(0,size).arrayBuffer());
   if(b[0]===255&&b[1]===216){
    let p=2,complete=false;
    while(p+4<=b.length){
     if(b[p++]!==255)throw Error('Invalid JPEG header');while(b[p]===255)p++;
     const marker=b[p++];if(marker===0xda||marker===0xd9){complete=true;break;}
     if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
     const length=(b[p]<<8)|b[p+1];if(length<2)throw Error('Invalid JPEG marker');
     if(p+length>b.length)break;p+=length;
    }
    if(complete||size>=file.size){
     try{const meta=root.JpegLossless.info(b);const rotated=meta.orientation>=5&&meta.orientation<=8;
      return {width:rotated?meta.height:meta.width,height:rotated?meta.width:meta.height,jpeg:meta};
     }catch(error){if(!/Unsupported JPEG/.test(error.message))throw error;
      const bitmap=await createImageBitmap(file);try{return {width:bitmap.width,height:bitmap.height};}finally{bitmap.close();}}
    }
    size=Math.min(file.size,size*4);continue;
   }
   if(b.length>=24&&b[0]===137&&String.fromCharCode(...b.subarray(1,4))==='PNG'){
    const view=new DataView(b.buffer,b.byteOffset,b.byteLength);return {width:view.getUint32(16),height:view.getUint32(20)};
   }
   const bitmap=await createImageBitmap(file);try{return {width:bitmap.width,height:bitmap.height};}finally{bitmap.close();}
  }
 }
 root.FastImageScan={scan};
})(typeof window==='undefined'?globalThis:window);
