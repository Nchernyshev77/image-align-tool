const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');

// Exercise the actual import handler with a fake SDK. This does not prove Miro's server limit.
function setup(files, rejectUpload = false, options = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', value: '', hidden: true });
    return elements.get(id);
  };
  el('stitch-form').stitchImagesPerRow = { value: '2' };
  el('stitch-form').stitchStartCorner = { value: 'top-left' };
  el('stitch-form').stitchSkipMissing = { checked: false };
  el('stitchFolderInput').files = files;
  const calls = [];
  const encodes = [];
  const groups=[],messages=[],staged=new Map();let nextKey=0,disposed=false;
  let sourceCloses = 0;
  const board = {
    viewport: { get: async () => ({ x: 0, y: 0, width: 1000, height: 1000 }), zoomTo: async () => {} },
    notifications: { showError: async x => messages.push(x), showWarning: async x => messages.push(x), showInfo: async x => messages.push(x) },
    group: async ({items}) => { groups.push(items);if(options.groupError)throw Error('Group failed');if(options.onGroup)await options.onGroup(items);return {id:'group-'+groups.length}; },
    createImage: async params => {
      calls.push(params);const number=calls.length;
      if (options.onCreate) await options.onCreate(params, number);
      if (rejectUpload === true || rejectUpload === number) throw Object.assign(new Error('Maximum upload size exceeded'), { code: 'invalidParameters', status: 400 });
      return { id:String(number),setMetadata: async () => {} };
    },
  };
  const context = vm.createContext({
    window: { miro: { board }, addEventListener() {} },
    document: {
      getElementById: el,
      createElement: type => {
        assert.equal(type, 'canvas');
        return {
          getContext: () => ({
            drawImage() {}, getContextAttributes: () => ({ colorSpace: 'srgb' }),
            getImageData: () => ({ data: new Uint8ClampedArray(50 * 50 * 4) }),
          }),
          toDataURL() { throw new Error('Original must never be re-encoded'); },
        };
      },
    },
    Image: class {
      set src(value) {
        if (!value) return;
        this.naturalWidth = value.width;
        this.naturalHeight = value.height;
        queueMicrotask(() => this.onload());
      }
    },
    URL: { createObjectURL: file => file, revokeObjectURL() {} },
    FileReader: class {
      readAsDataURL(file) {
        if (options.onRead) options.onRead(file);
        queueMicrotask(() => {
          if (file.readError) { this.error = new Error('Read failed'); this.onerror(); return; }
          this.result = `data:${file.type};base64,${file.bytes.toString('base64')}`;
          this.onload();
        });
      }
    },
    Uint8Array, DataView, Blob, Response, CompressionStream, DecompressionStream,
    performance, setTimeout: fn => setTimeout(fn, 0),
    console: { log() {}, warn() {}, error() {}, groupCollapsed() {}, groupEnd() {}, table() {} },
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../lossless-upload.js'), 'utf8'), context);
  context.window.JpegLossless={create:()=>({
    async open(file){return {width:file.width,height:file.height,eligible:!!options.jpeg,safeX:true,safeY:true,mcuX:8,mcuY:8,reason:'Test PNG fallback'};},
    async crop(rect){encodes.push({...rect,jpeg:true});const size=options.pngSize?options.pngSize(rect):100;return {size,type:'image/jpeg',bytes:Buffer.alloc(100,0x5a)};},
    async close(){},dispose(){},
  })};
  context.window.UploadStaging={create:async()=>({
    async put(blob){if(options.stageError)throw Error('Storage full');const key=++nextKey;staged.set(key,blob);return key;},
    async get(key){assert.ok(staged.has(key),'Missing staged part');return staged.get(key);},
    async remove(key){staged.delete(key);},async dispose(){staged.clear();disposed=true;},
  })};
  const helpers = context.window.LosslessUpload;
  helpers.openSource = async file => ({
    file,
    image: { width: file.width, height: file.height },
    colors: { description: 'test RGB profile', chunks: [] },
    close: () => sourceCloses++,
  });
  helpers.encodeRegion = async (source, rect) => {
    encodes.push({ ...rect });
    if (options.onEncode) await options.onEncode(source, rect);
    const size = options.pngSize ? options.pngSize(rect) : 100;
    return { size, type: 'image/png', bytes: Buffer.alloc(Math.min(size, 100), 0x7f) };
  };
  vm.runInContext(source, context);
  return { calls, el, encodes, groups,messages,staged,get disposed(){return disposed;}, get sourceCloses() { return sourceCloses; }, run: () => context.handleStitchSubmit({ preventDefault() {} }) };
}

function fixture(size = 20_000_000, name = 'Tile_1.jpg') {
  const bytes = Buffer.alloc(size, 0xa5);
  return { name, type: 'image/jpeg', width: 4096, height: 4096, size, bytes };
}

test('20 MB original is sent once, unchanged, at full size; grid spacing is preserved', async () => {
  const file = fixture();
  const second = fixture(100, 'Tile_2.jpg');
  const app = setup([file, second]);
  await app.run();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[0].width, 4096);
  assert.equal(app.calls[1].x - app.calls[0].x, 4096);
  assert.equal(app.calls[0].y, app.calls[1].y);
  assert.deepEqual(Buffer.from(app.calls[0].url.split(',')[1], 'base64'), file.bytes);
  const report = JSON.parse(app.el('originalUploadReport').value);
  assert.equal(report.uploads[0].fileBytes, 20_000_000);
  assert.ok(report.uploads[0].payloadCharacters > 11_000_000);
  assert.equal(report.uploads[0].status, 'created');
  assert.equal(app.el('stitchButton').disabled, false);
});

test('SDK rejection stays visible with no retry, slicing, or recompression', async () => {
  const app = setup([fixture()], true);
  await app.run();
  assert.equal(app.calls.length, 1);
  const report = JSON.parse(app.el('originalUploadReport').value);
  assert.equal(report.uploads[0].status, 'failed');
  assert.equal(report.uploads[0].error.code, 'invalidParameters');
  assert.equal(report.uploads[0].error.status, 400);
  assert.equal(app.el('originalUploadReportBox').hidden, false);
  assert.equal(app.el('stitchButton').disabled, false);
});

test('file read failure is reported and the next file can still upload', async () => {
  const bad = { ...fixture(100), readError: true };
  const app = setup([bad, fixture(100, 'Tile_2.jpg')]);
  await app.run();
  assert.equal(app.calls.length, 1);
  const report = JSON.parse(app.el('originalUploadReport').value);
  assert.deepEqual(report.uploads.map(x => x.status), ['failed', 'created']);
});


const oversized=(name='Tile_1.jpg')=>({...fixture(100,name),size:28_000_000});
const sizeFor=n=>r=>r.width*r.height>4096*4096/n?23_000_000:100;
for(const jpeg of [false,true])for(const target of [2,4,8]){
 test(`${jpeg?'JPEG coefficient':'PNG fallback'} uses ${target} parts, prepared first, native pixels and one source group`,async()=>{
  let app;app=setup([oversized(),fixture(100,'Tile_2.jpg')],false,{jpeg,pngSize:sizeFor(target),onEncode:()=>{assert.equal(app.calls.length,0);assert.equal(app.el('stitchProgressStage').textContent,'Stage 1/2');}});
  await app.run();
  const reports=JSON.parse(app.el('originalUploadReport').value).uploads;
  assert.equal(reports[0].mode,jpeg?'lossless-jpeg':'lossless-png');
  assert.deepEqual(reports[0].attempts,Array.from({length:Math.log2(target)},(_,i)=>2**(i+1)));
  assert.equal(reports[0].partCount,target);assert.equal(reports[0].status,'created');
  const parts=app.calls.filter(p=>p.title.includes('Tile_1.jpg')),original=app.calls.find(p=>p.title.endsWith('Tile_2.jpg'));
  assert.equal(parts.length,target);
  const rects=reports[0].parts;
  assert.equal(rects.reduce((sum,p)=>sum+p.width*p.height,0),4096*4096);
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++)assert.ok(rects[i].x+rects[i].width<=rects[j].x||rects[j].x+rects[j].width<=rects[i].x||rects[i].y+rects[i].height<=rects[j].y||rects[j].y+rects[j].height<=rects[i].y,'Parts overlap');
  const left=original.x-2048-4096,top=original.y-2048;
  for(const p of rects){const call=parts[p.part-1];assert.equal(call.x,left+p.x+p.width/2);assert.equal(call.y,top+p.y+p.height/2);assert.equal(call.width,p.width);assert.ok(call.url.startsWith(`data:image/${jpeg?'jpeg':'png'};base64,`));}
  assert.equal(app.groups.length,1);assert.equal(app.groups[0].length,target);assert.equal(reports[0].group.status,'created');
  assert.equal(app.disposed,true);assert.equal(app.staged.size,0);
  assert.equal(app.sourceCloses,jpeg?0:1);
  assert.equal(app.el('stitchProgressMain').textContent,`Uploading to board… ${target+1} / ${target+1}`);
 });
}

test('partial concurrent failure keeps successful parts grouped, drains started requests and continues the next file',async()=>{
 const app=setup([oversized(),fixture(100,'Tile_2.jpg')],2,{pngSize:sizeFor(4)});await app.run();
 const reports=JSON.parse(app.el('originalUploadReport').value).uploads;
 assert.equal(reports[0].status,'partial');assert.equal(reports[0].createdParts,3);
 assert.equal(reports[1].status,'created');assert.equal(app.calls.length,5);
 assert.equal(app.groups[0].length,3);assert.equal(app.el('stitchButton').disabled,false);
});

test('group failure is reported without retrying successful image uploads',async()=>{
 const app=setup([oversized()],false,{groupError:true});await app.run();
 const report=JSON.parse(app.el('originalUploadReport').value).uploads[0];
 assert.equal(report.status,'created');assert.equal(report.group.status,'failed');assert.equal(app.calls.length,2);
 assert.ok(app.messages.some(x=>String(x).includes('groups')));assert.equal(app.disposed,true);
});

test('storage quota failure creates no partial source and lets a small original upload',async()=>{
 const app=setup([oversized(),fixture(100,'Tile_2.jpg')],false,{stageError:true});await app.run();
 const reports=JSON.parse(app.el('originalUploadReport').value).uploads;
 assert.equal(reports[0].status,'failed');assert.equal(reports[1].status,'created');assert.equal(app.calls.length,1);assert.equal(app.disposed,true);
});

test('bottom-right corner reverses source slots, never reverses pixels within a tile',async()=>{
 const app=setup([oversized(),fixture(100,'Tile_2.jpg')]);app.el('stitch-form').stitchStartCorner.value='bottom-right';await app.run();
 const parts=app.calls.filter(p=>p.title.includes('Tile_1.jpg')),other=app.calls.find(p=>p.title.endsWith('Tile_2.jpg'));
 assert.ok(parts[0].x<parts[1].x);assert.equal(parts[0].x-1024,other.x+2048);
});

test('missing tile numbers preserve whole source slots',async()=>{
 const app=setup([fixture(100),oversized('Tile_3.jpg')]);app.el('stitch-form').stitchSkipMissing.checked=true;app.el('stitch-form').stitchImagesPerRow.value='4';await app.run();
 assert.equal(app.calls[1].x-1024-(app.calls[0].x-2048),8192);
});

test('all large-image regions are prepared before any upload and grouped as one original source',async()=>{
 let app;app=setup([{...fixture(100),width:9000,height:4096}],false,{onEncode:()=>assert.equal(app.calls.length,0)});await app.run();
 assert.deepEqual(app.calls.map(p=>p.width),[4096,4096,808]);assert.deepEqual(app.encodes.map(p=>p.x),[0,4096,8192]);
 assert.equal(app.groups.length,1);assert.equal(app.groups[0].length,3);assert.equal(app.sourceCloses,1);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<deadline,'Expected queue state not reached');await new Promise(r=>setImmediate(r));}}

test('five source slots permit one four-part tile plus four originals: eight parallel uploads, sixth source waits',async()=>{
 const gates=Array.from({length:6},deferred);let active=0,maximum=0,reads=0;
 const files=[oversized(),...Array.from({length:5},(_,i)=>fixture(100,`Tile_${i+2}.jpg`))];
 const app=setup(files,false,{pngSize:sizeFor(4),onRead:()=>reads++,onCreate:async p=>{const i=Number(p.title.match(/Tile_(\d+)/)[1])-1;active++;maximum=Math.max(maximum,active);await gates[i].promise;active--;}});
 const running=app.run();await until(()=>app.calls.length===8);
 assert.equal(reads,8);assert.ok(app.calls.every(p=>!p.title.includes('Tile_6.jpg')));assert.equal(app.el('stitchButton').disabled,true);
 gates[1].resolve();await until(()=>app.calls.length===9);assert.ok(app.calls.some(p=>p.title.includes('Tile_6.jpg')));
 for(const g of gates)g.resolve();await running;
 assert.equal(maximum,8);assert.equal(app.groups.length,1);assert.equal(app.groups[0].length,4);assert.equal(app.el('stitchButton').disabled,false);
});

test('five four-part sources run twenty uploads and wait for grouping before releasing source slots',async()=>{
 const uploadGate=deferred(),groupGate=deferred();let reads=0;
 const app=setup(Array.from({length:6},(_,i)=>oversized(`Tile_${i+1}.jpg`)),false,{pngSize:sizeFor(4),onRead:()=>reads++,onCreate:()=>uploadGate.promise,onGroup:()=>groupGate.promise});
 const running=app.run();await until(()=>app.calls.length===20);assert.equal(reads,20);assert.equal(app.groups.length,0);assert.equal(app.sourceCloses,6);
 uploadGate.resolve();await until(()=>app.groups.length===5);assert.equal(app.calls.length,20);assert.equal(app.el('stitchButton').disabled,true);
 groupGate.resolve();await running;assert.equal(app.calls.length,24);assert.equal(app.groups.length,6);assert.equal(app.disposed,true);
});
