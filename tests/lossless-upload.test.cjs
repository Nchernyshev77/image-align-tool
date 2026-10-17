const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inflateSync } = require('node:zlib');
require('../lossless-upload.js');
const L = globalThis.LosslessUpload;

test('Base64 payload includes prefix and JSON quotes at the measured 30,000,000-byte boundary', () => {
  assert.equal(L.fits(22_499_979, 'image/jpeg'), true);
  assert.equal(L.fits(22_499_980, 'image/jpeg'), false);
  assert.equal(L.payloadBytes(25_927_152, 'image/jpeg'), 34_569_561);
  assert.equal(L.payloadBytes(31_897_125, 'image/jpeg'), 42_529_525);
});

test('integer strips cover every pixel exactly once, including odd dimensions and vertical strips', () => {
  for (const [width, height] of [[4096,4096], [4097,2049], [5,11]]) {
    for (const count of [2,3,4]) {
      const rects = L.partitions(width,height,count);
      assert.equal(rects.reduce((a,r)=>a+r.width*r.height,0),width*height);
      const horizontal=width>=height;
      let end=0;
      for(const r of rects) {
        assert.equal(horizontal?r.x:r.y,end);
        end += horizontal?r.width:r.height;
        assert.equal(horizontal?r.height:r.width,horizontal?height:width);
      }
      assert.equal(end,Math.max(width,height));
    }
  }
});

test('all candidate PNGs are checked; a later oversized part rejects the whole layout', async () => {
  const attempts=[];
  const parts=await L.planParts(4096,4096,async r=>({type:'image/png',size:r.width===2048&&r.height===4096&&r.x>0?23_000_000:100}),{onAttempt:n=>attempts.push(n)});
  assert.deepEqual(attempts,[2,4]);
  assert.equal(parts.length,4);
});

test('complexity hints reject a bad layout earlier while retaining the smallest valid binary layout and part order',async()=>{
 const calls=[],attempts=[];
 const parts=await L.planParts(4096,4096,async r=>{calls.push(r);return {type:'image/png',size:r.width===2048&&r.height===4096&&r.x>0?23000000:100};},
  {priority:r=>r.x,onAttempt:n=>attempts.push(n)});
 assert.deepEqual(attempts,[2,4]);assert.equal(calls[0].x,2048);assert.equal(calls.length,5);
 assert.deepEqual(parts.map(({blob,...r})=>r),L.dyadicRegions(4096,4096,4));
 const whole=await L.planParts(4096,4096,async()=>({type:'image/png',size:100}),{priority:r=>r.x});
 assert.equal(whole.length,2);assert.equal(whole[0].x,0);
});

const marker=(type,data)=>Buffer.concat([Buffer.from([255,type,(data.length+2)>>8,(data.length+2)&255]),data]);
const fakeJpeg=profile=> {
  const first=profile.subarray(0,75),last=profile.subarray(75);
  const app=(num,data)=>marker(0xe2,Buffer.concat([Buffer.from('ICC_PROFILE\0'),Buffer.from([num,2]),data]));
  // Deliberately reversed ICC segments: sequence numbers, not physical order, matter.
  return new Blob([Buffer.from([255,216]),app(2,last),app(1,first),Buffer.from([255,218])],{type:'image/jpeg'});
};

test('JPEG ICC segments survive PNG iCCP compression byte-for-byte, without conflicting color tags',async()=> {
  const profile=Buffer.alloc(128,0);
  profile.write('RGB ',16);profile.write('acsp',36);
  const colors=await L.colorMetadata(fakeJpeg(profile));
  const signature=Buffer.from([137,80,78,71,13,10,26,10]);
  const png=new Blob([signature,L.chunk('IHDR',new Uint8Array(13)),L.chunk('sRGB',new Uint8Array([0])),L.chunk('gAMA',new Uint8Array(4)),L.chunk('IDAT',new Uint8Array([1,2,3])),L.chunk('IEND',new Uint8Array())],{type:'image/png'});
  const result=new Uint8Array(await(await L.preserveColor(png,colors.chunks)).arrayBuffer());
  const chunks=L.pngChunks(result);
  assert.deepEqual(chunks.map(c=>c.type),['IHDR','iCCP','IDAT','IEND']);
  assert.deepEqual(inflateSync(chunks[1].data.subarray(5)),profile);
  assert.deepEqual([...chunks[2].data],[1,2,3]);
  assert.equal(Buffer.from(L.chunk('IEND',new Uint8Array())).toString('hex'),'0000000049454e44ae426082');
});

test('unsupported CMYK profiles fail instead of being silently relabelled as RGB',async()=> {
  const profile=Buffer.alloc(128);profile.write('CMYK',16);
  await assert.rejects(()=>L.colorMetadata(fakeJpeg(profile)),/cannot be preserved/);
});


test('binary partitions cover odd dimensions exactly and obey MCU boundaries and safe axes',()=>{
 for(const n of [2,4,8])for(const [w,h] of [[4096,4096],[4097,2051]]){
  const rects=L.dyadicRegions(w,h,n,{mcuX:8,mcuY:8});assert.equal(rects.length,n);
  assert.equal(rects.reduce((s,r)=>s+r.width*r.height,0),w*h);
  for(const r of rects){assert.equal(r.x%8,0);assert.equal(r.y%8,0);}
 }
 const rects=L.dyadicRegions(4096,4096,8,{mcuX:16,mcuY:8,safeX:false,safeY:true});
 assert.ok(rects.every(r=>r.x===0&&r.width===4096));
 assert.throws(()=>L.dyadicRegions(4096,4096,3),/binary/);
});
