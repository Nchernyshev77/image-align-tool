(function(root){
 'use strict';
 function timeoutFor(file,info){return (info.jpeg?.coefficientBytes??info.width*info.height*4)+file.size>=512*1024*1024?600000:120000;}
 function create({workerUrl='./tile-prepare-worker.js?v=62'}={}){
  let worker,req=0,pending,timer;
  return {
   prepare(file,info,jobs){
    if(pending)throw Error('Preparation worker is already busy');
    if(!worker){worker=new Worker(workerUrl);
     worker.onmessage=e=>{if(!pending||e.data.req!==pending.req)return;const p=pending;pending=null;clearTimeout(timer);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data);};
     worker.onerror=e=>{clearTimeout(timer);if(pending)pending.reject(Error(e.message||'Preparation worker failed'));pending=null;worker.terminate();worker=null;};}
    return new Promise((resolve,reject)=>{pending={resolve,reject,req:++req};timer=setTimeout(()=>{worker.terminate();worker=null;pending=null;reject(Error('Tile preparation timed out'));},timeoutFor(file,info));worker.postMessage({req,file,info,jobs});});
   },
   dispose(){clearTimeout(timer);if(worker)worker.terminate();worker=null;if(pending)pending.reject(Error('Preparation stopped'));pending=null;},
  };
 }
 root.TilePreparation={create,timeoutFor};
})(typeof window==='undefined'?globalThis:window);
