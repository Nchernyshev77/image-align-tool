const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
require('../jpeg-lossless');require('../fast-image-scan');
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'jpeg-fixtures.json'),'utf8'));

test('JPEG scanning reads a header, never decodes pixels or reads the whole large file',async()=>{
 const bytes=Buffer.from(fixtures['444'],'base64');let read=0;
 const file={size:28000000,slice(start,end){read+=Math.min(end,bytes.length);return new Blob([bytes.subarray(start,end)]);},arrayBuffer(){throw Error('Full-file read must not happen');}};
 const meta=await FastImageScan.scan(file);assert.equal(meta.width,128);assert.equal(meta.height,96);assert.ok(read<65537);
});
test('EXIF orientation is reflected in scanned board dimensions',async()=>{
 const meta=await FastImageScan.scan(new Blob([Buffer.from(fixtures.orientation6,'base64')]));assert.equal(meta.width,96);assert.equal(meta.height,128);
});
test('PNG scan only needs its header',async()=>{
 const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);new DataView(bytes.buffer).setUint32(16,4096);new DataView(bytes.buffer).setUint32(20,4096);
 const meta=await FastImageScan.scan(new Blob([bytes]));assert.equal(meta.width,4096);assert.equal(meta.height,4096);
});
