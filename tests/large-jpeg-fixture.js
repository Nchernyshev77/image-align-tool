// Constant-color JPEGs with real native dimensions, without a giant canvas.
(function(root){
 'use strict';
 function jpeg(width,height,sampling='420'){
  if(!['420','444'].includes(sampling)||width<1||height<1||width>65500||height>65500)throw Error('Invalid JPEG fixture');
  const chunks=[new Uint8Array([255,216])];
  const marker=(id,data)=>chunks.push(new Uint8Array([255,id,(data.length+2)>>8,(data.length+2)&255,...data]));
  marker(0xdb,[0,...Array(64).fill(1)]);
  marker(0xc0,[8,height>>8,height&255,width>>8,width&255,3,1,sampling==='420'?0x22:0x11,0,2,0x11,0,3,0x11,0]);
  // A one-bit code for DC category zero and a one-bit AC end-of-block code.
  marker(0xc4,[0,1,...Array(15).fill(0),0,0x10,1,...Array(15).fill(0),0]);
  marker(0xda,[3,1,0,2,0,3,0,0,63,0]);
  const mcu=sampling==='420'?16:8,blocksPerMcu=sampling==='420'?6:3;
  const bits=Math.ceil(width/mcu)*Math.ceil(height/mcu)*blocksPerMcu*2,entropy=new Uint8Array(Math.ceil(bits/8));
  if(bits%8)entropy[entropy.length-1]=(1<<(8-bits%8))-1;
  chunks.push(entropy,new Uint8Array([255,217]));
  const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
 }
 root.LargeJpegFixture={jpeg};
 if(typeof module!=='undefined')module.exports=root.LargeJpegFixture;
})(typeof window==='undefined'?globalThis:window);
