// JPEG coefficient cropping client. All image processing stays on this device.
(function(root){
  'use strict';
  const HEAP_BYTES=2147483648,WORKSPACE_HEADROOM=256*1024*1024;
  function info(bytes){
    if(bytes[0]!==255||bytes[1]!==216)throw Error('Invalid JPEG');
    let result,orientation=1;
    for(let p=2;p+4<=bytes.length;){
      if(bytes[p++]!==255)throw Error('Invalid JPEG marker');
      while(bytes[p]===255)p++;
      const marker=bytes[p++];if(marker===0xda||marker===0xd9)break;
      if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
      const len=(bytes[p]<<8)|bytes[p+1];if(len<2||p+len>bytes.length)throw Error('Truncated JPEG');
      const d=bytes.subarray(p+2,p+len);
      if([0xc0,0xc1,0xc2].includes(marker)){
        const count=d[5];if(d[0]!==8||![1,3].includes(count)||d.length<6+3*count)throw Error('Unsupported JPEG precision/components');
        const h=[],v=[];for(let i=0;i<count;i++){h.push(d[7+3*i]>>4);v.push(d[7+3*i]&15);}
        if([...h,...v].some(x=>x<1||x>4))throw Error('Invalid JPEG sampling');
        const width=(d[3]<<8)|d[4],height=(d[1]<<8)|d[2],maxH=Math.max(...h),maxV=Math.max(...v);
        const coefficientBytes=h.reduce((sum,value,i)=>sum+Math.ceil(width*value/(maxH*8))*Math.ceil(height*v[i]/(maxV*8))*128,0);
        result={width,height,coefficientBytes,mcuX:8*maxH,mcuY:8*maxV,
          safeX:h.every(x=>x===h[0]),safeY:v.every(x=>x===v[0])};
      }
      if(marker===0xe1&&d.length>=14&&String.fromCharCode(...d.subarray(0,6))==='Exif\0\0'){
        const t=new DataView(d.buffer,d.byteOffset+6,d.length-6),le=t.getUint16(0)===0x4949;
        if(t.getUint16(2,le)!==42)throw Error('Invalid EXIF');
        const offset=t.getUint32(4,le);if(offset+2>t.byteLength)throw Error('Invalid EXIF offset');
        const n=t.getUint16(offset,le);
        for(let i=0;i<n;i++){const e=offset+2+i*12;if(e+12>t.byteLength)throw Error('Truncated EXIF');
          if(t.getUint16(e,le)===0x112){if(t.getUint16(e+2,le)!==3||t.getUint32(e+4,le)!==1)throw Error('Invalid EXIF orientation');orientation=t.getUint16(e+8,le);}}
      }
      p+=len;
    }
    if(!result)throw Error('JPEG dimensions missing');
    result.orientation=orientation;
    // All supported sampling modes can be cropped in the coefficient domain.
    // safeX/safeY describe exact RGB seam rendering, not transform eligibility.
    result.eligible=orientation===1;
    result.reason=orientation!==1?'JPEG slicing with EXIF rotation is not supported; no PNG conversion is used':null;
    return result;
  }
  function cropAlignment(meta){
    return {mcuX:meta.mcuX,mcuY:meta.mcuY,safeX:true,safeY:true,
      preferredAxis:!meta.safeX&&meta.safeY?'y':meta.safeX&&!meta.safeY?'x':null};
  }
  function workspaceBytes(meta,fileBytes=0){return (meta.coefficientBytes??meta.width*meta.height*6)+fileBytes+WORKSPACE_HEADROOM;}
  function assertWorkspace(meta,fileBytes=0){
    const bytes=workspaceBytes(meta,fileBytes);
    if(bytes>HEAP_BYTES)throw Error(`Estimated workspace for JPEG ${meta.width}×${meta.height} exceeds the current 2 GiB processing limit; resolution was not reduced`);
    return bytes;
  }
  function create({workerUrl='./jpeg-lossless-worker.js?v=61'}={}){
    let worker,req=0;const pending=new Map();
    function call(message,transfer=[]){
      if(!worker){worker=new Worker(workerUrl);
        worker.onmessage=e=>{const waiter=pending.get(e.data.req);if(!waiter)return;pending.delete(e.data.req);e.data.error?waiter.reject(Error(e.data.error)):waiter.resolve(e.data);};
        worker.onerror=e=>{for(const p of pending.values())p.reject(Error(e.message||'JPEG worker failed'));pending.clear();worker.terminate();worker=null;};}
      return new Promise((resolve,reject)=>{const id=++req;pending.set(id,{resolve,reject});worker.postMessage({...message,req:id},transfer);});
    }
    return {
      async open(file){const buffer=await file.arrayBuffer();const meta=info(new Uint8Array(buffer));
        assertWorkspace(meta,buffer.byteLength);
        if(meta.eligible)await call({type:'open',buffer},[buffer]);return meta;},
      async crop(rect){const result=await call({type:'crop',rect});return new Blob([result.buffer],{type:'image/jpeg'});},
      async close(){if(worker)await call({type:'close'});},
      dispose(){if(worker)worker.terminate();worker=null;for(const p of pending.values())p.reject(Error('JPEG worker disposed'));pending.clear();},
    };
  }
  root.JpegLossless={info,create,cropAlignment,workspaceBytes,assertWorkspace,HEAP_BYTES};
})(typeof window==='undefined'?globalThis:window);
