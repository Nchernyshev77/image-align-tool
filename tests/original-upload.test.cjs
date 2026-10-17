const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
function setup(files,{parts=2,scanError=false}={}){
 const elements=new Map(),calls=[],groups=[],images=[],notes=[];
 const el=id=>{if(!elements.has(id))elements.set(id,{style:{},value:'',textContent:'',hidden:true});return elements.get(id);};
 const form=el('stitch-form');form.stitchImagesPerRow={value:'2'};form.stitchStartCorner={value:'top-left'};form.stitchSkipMissing={checked:false};el('stitchFolderInput').files=files;
 const board={viewport:{get:async()=>({x:0,y:0,width:1000,height:1000}),zoomTo:async()=>{}},
  notifications:{showInfo:async text=>notes.push(text),showError:async text=>notes.push(text),showWarning:async()=>{}},
  createImage:async p=>{calls.push(p);const image={id:String(calls.length),alt:p.alt,width:p.width,title:p.title,type:'image',setMetadata:async()=>{}};images.push(image);return image;},
  get:async()=>images,group:async({items})=>{const id='g'+groups.length;groups.push(items);for(const image of items)image.groupId=id;return {id};},
 };
 const context=vm.createContext({window:{miro:{board},addEventListener(){}},document:{getElementById:el},
  performance,Blob,Response,CompressionStream,DecompressionStream,Uint8Array,DataView,setTimeout,clearTimeout,
  FileReader:class{readAsDataURL(file){queueMicrotask(()=>{this.result=`data:${file.type};base64,${file.bytes.toString('base64')}`;this.onload();});}},
  console:{log(){},warn(){},error(){}},
 });
 for(const file of ['lossless-upload.js','import-engine.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
 const L=context.window.LosslessUpload;
 context.window.FastImageScan={scan:async file=>{if(scanError&&file.name==='Tile_1.jpg')throw Error('Unreadable file');return {width:file.width,height:file.height};}};
 context.window.TilePreparation={create:()=>({dispose(){},async prepare(file,info,jobs){return {satCode:20,briCode:250,regions:jobs.map(job=>{
  const full=job.kind==='full',width=full?job.width:job.sw,height=full?job.height:job.sh;
  const pass=full&&L.fits(file.size,file.type);
  return {mode:pass?'original':'lossless-png',width,height,sourceX:full?0:job.sx,sourceY:full?0:job.sy,
   parts:pass?[{x:0,y:0,width,height,original:true,size:file.size,mime:file.type}]:L.dyadicRegions(width,height,full?parts:1).map(r=>({...r,blob:{size:100,type:'image/png',bytes:Buffer.alloc(100,7)},size:100,mime:'image/png'}))};
 })};}})};
 const run=context.window.ImportEngine.run;
 context.window.ImportEngine.run=input=>run({...input,options:{...input.options,rateLimit:false,retryDelayMs:0}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),context);
 return {calls,groups,notes,el,get result(){return context.window.ImageAlignLastImport;},run:()=>context.handleStitchSubmit({preventDefault(){}})};
}
const fixture=(name='Tile_1.jpg',size=100)=>({name,type:'image/jpeg',width:4096,height:4096,size,bytes:Buffer.alloc(Math.min(size,20000000),0xa5)});

test('handler uploads 20MB original byte-for-byte and reports verified completion without a diagnostics panel',async()=>{
 const file=fixture('Tile_1.jpg',20000000),app=setup([file]);await app.run();
 assert.deepEqual(Buffer.from(app.calls[0].url.split(',')[1],'base64'),file.bytes);assert.equal(app.calls.length,1);
 assert.equal(app.result.success,true);assert.equal(app.el('stitchProgressMain').textContent,'All tiles uploaded and verified');assert.equal(app.el('stitchButton').disabled,false);
 assert.match(app.el('stitchScanProgress').textContent,/1 \/ 1/);
});
for(const parts of [2,4,8])test(`handler positions ${parts} parts exactly in the original source slot`,async()=>{
 const app=setup([fixture('Tile_1.jpg',28000000),fixture('Tile_2.jpg')],{parts});await app.run();
 const slices=app.calls.filter(p=>p.title.includes('Tile_1.jpg')),original=app.calls.find(p=>p.title.endsWith('Tile_2.jpg'));
 assert.equal(slices.length,parts);const rects=globalThisRects(parts);
 for(let i=0;i<parts;i++){const r=rects[i];assert.equal(slices[i].x,original.x-2048-4096+r.x+r.width/2);assert.equal(slices[i].y,original.y-2048+r.y+r.height/2);}
 assert.equal(app.groups[0].length,parts);assert.equal(app.result.verified,parts+1);
});
function globalThisRects(parts){require('../lossless-upload');return globalThis.LosslessUpload.dyadicRegions(4096,4096,parts);}

test('bottom-right layout keeps piece orientation and reverses source slots',async()=>{
 const app=setup([fixture('Tile_1.jpg',28000000),fixture('Tile_2.jpg')]);app.el('stitch-form').stitchStartCorner.value='bottom-right';await app.run();
 const a=app.calls.filter(p=>p.title.includes('Tile_1.jpg')),b=app.calls.find(p=>p.title.endsWith('Tile_2.jpg'));assert.ok(a[0].x<a[1].x);assert.equal(a[0].x-1024,b.x+2048);
});
test('missing numbered tiles retain their full slot',async()=>{
 const app=setup([fixture(),fixture('Tile_3.jpg',28000000)]);app.el('stitch-form').stitchSkipMissing.checked=true;app.el('stitch-form').stitchImagesPerRow.value='4';await app.run();
 const a=app.calls.find(p=>p.title.endsWith('Tile_1.jpg')),b=app.calls.find(p=>p.title.includes('Tile_3.jpg'));assert.equal(b.x-1024-(a.x-2048),8192);
});
test('a scan failure remains visible in the final ordinary error list',async()=>{
 const app=setup([fixture(),fixture('Tile_2.jpg')],{scanError:true});await app.run();
 assert.equal(app.result.success,false);assert.match(app.el('stitchResult').textContent,/Tile_1.jpg/);assert.equal(app.el('stitchResult').hidden,false);assert.equal(app.el('stitchButton').disabled,false);
 assert.notEqual(app.el('stitchProgressBar').style.width,'100%');
});
test('large source regions keep native widths and one group',async()=>{
 const app=setup([{...fixture('Tile_1.jpg',28000000),width:9000,height:4096}]);await app.run();assert.deepEqual(app.calls.map(p=>p.width),[4096,4096,808]);assert.equal(app.groups.length,1);assert.equal(app.groups[0].length,3);
});

test('18MB originals stay byte-for-byte whole even above old pixel slicing thresholds',async()=>{
 const files=[[4096,4096],[8192,8192],[9000,4096]].map(([width,height],i)=>({...fixture(`Tile_${i+1}.jpg`,18000000),width,height}));
 const app=setup(files);await app.run();assert.equal(app.result.success,true);assert.equal(app.calls.length,3);assert.equal(app.groups.length,0);
 for(let i=0;i<files.length;i++){const call=app.calls.find(p=>p.title.endsWith(files[i].name));assert.equal(call.width,files[i].width);assert.deepEqual(Buffer.from(call.url.split(',')[1],'base64'),files[i].bytes);}
});
