// Temporary, device-local disk staging. No image data is sent to an app server.
(function(root){
 'use strict';
 async function create(){
  if(!root.indexedDB)throw Error('Browser local storage is unavailable for upload preparation');
  const name='image-align-prepared-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('parts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const transaction=(mode,action)=>new Promise((resolve,reject)=>{
    const tx=db.transaction('parts',mode),request=action(tx.objectStore('parts'));let value;
    if(request)request.onsuccess=()=>{value=request.result;};
    tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error||Error('Cannot store prepared parts'));tx.onabort=()=>reject(tx.error||Error('Cannot store prepared parts'));
  });let next=0;
  return {
   async put(blob){const key=++next;await transaction('readwrite',s=>s.put(blob,key));return key;},
   async get(key){const value=await transaction('readonly',s=>s.get(key));if(!value)throw Error('Prepared image is missing');return value;},
   async remove(key){await transaction('readwrite',s=>s.delete(key));},
   async dispose(){db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve;});},
  };
 }
 root.UploadStaging={create};
})(typeof window==='undefined'?globalThis:window);
