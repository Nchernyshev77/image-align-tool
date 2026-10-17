// Lossless PNG subdivision. No resize, JPEG re-encoding, or quality fallback.
(function (root) {
  'use strict';
  const URL_LIMIT = 30_000_000;
  const PNG_MIME = 'image/png';
  // https://help.miro.com/hc/en-us/articles/360017731613-Supported-file-formats
  const MAX_IMAGE_WIDTH=8192,MAX_IMAGE_HEIGHT=4096;
  const dimensionsFit=(width,height)=>width<=MAX_IMAGE_WIDTH&&height<=MAX_IMAGE_HEIGHT;
  const COLOR_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI']);
  const ascii = bytes => String.fromCharCode(...bytes);
  const payloadBytes = (size, mime) => 4 * Math.ceil(size / 3) + `data:${mime};base64,`.length + 2;
  const fits = (size, mime) => payloadBytes(size, mime) <= URL_LIMIT;

  function partitions(width, height, count) {
    if (![width, height, count].every(Number.isSafeInteger) || width < 1 || height < 1 || count < 1) {
      throw new Error('Invalid slice dimensions');
    }
    const horizontal = width >= height;
    const length = horizontal ? width : height;
    if (count > length) throw new Error('Too many slices for this image');
    return Array.from({ length: count }, (_, i) => {
      const start = Math.floor(i * length / count);
      const end = Math.floor((i + 1) * length / count);
      return horizontal ? { x: start, y: 0, width: end - start, height }
        : { x: 0, y: start, width, height: end - start };
    });
  }

  function dyadicRegions(width,height,count,{mcuX=1,mcuY=1,safeX=true,safeY=true,maxWidth=Infinity,maxHeight=Infinity,preferredAxis=null}={}) {
    if(![width,height,count,mcuX,mcuY].every(Number.isSafeInteger)||width<1||height<1||count<1||(count&(count-1)))throw Error('Invalid binary partition');
    let rects=[{x:0,y:0,width,height}];
    while(rects.length<count){
      const next=[];
      for(const r of rects){
        const xCut=Math.floor((r.x+r.width/2)/mcuX)*mcuX;
        const yCut=Math.floor((r.y+r.height/2)/mcuY)*mcuY;
        const xOk=safeX&&xCut>r.x&&xCut<r.x+r.width,yOk=safeY&&yCut>r.y&&yCut<r.y+r.height;
        const preferX=r.width>maxWidth?(r.height<=maxHeight||r.width/maxWidth>=r.height/maxHeight):r.height>maxHeight?false:preferredAxis?preferredAxis==='x':r.width>=r.height;
        const axis=xOk&&(!yOk||preferX)?'x':yOk?'y':null;
        if(!axis)throw Error('No further lossless block-aligned split is possible');
        if(axis==='x')next.push({...r,width:xCut-r.x},{...r,x:xCut,width:r.x+r.width-xCut});
        else next.push({...r,height:yCut-r.y},{...r,y:yCut,height:r.y+r.height-yCut});
      }
      rects=next;
    }
    return rects;
  }

  async function planParts(width,height,encode,{firstCount=2,onAttempt=()=>{},mime=PNG_MIME,alignment={},priority=()=>0,maxWidth=Infinity,maxHeight=Infinity}={}) {
    for(let count=firstCount;count<=256;count*=2){
      onAttempt(count);const parts=new Array(count);
      // Probe the most complex area first. A bad candidate can then be rejected
      // sooner, without skipping a valid smaller layout or changing output order.
      const candidates=dyadicRegions(width,height,count,{...alignment,maxWidth,maxHeight}).map((rect,index)=>({rect,index,score:priority(rect)}));
      // Dimension failures are known without encoding even one candidate.
      if(candidates.some(({rect})=>rect.width>maxWidth||rect.height>maxHeight))continue;
      candidates.sort((a,b)=>b.score-a.score||a.index-b.index);
      let complete=true;
      for(const {rect,index} of candidates){
        const blob=await encode(rect);
        if(!blob||blob.type!==mime)throw Error('Image encoding failed');
        if(!fits(blob.size,mime)){complete=false;break;}
        parts[index]={...rect,blob};
      }
      if(complete)return parts;
      parts.length=0;
    }
    throw Error('Image cannot fit the upload limit within 256 parts');
  }

  // One producer, bounded admission: Base64 is made only after a slot opens.
  // A rejected upload releases its slot, and does not stall other sources.
  function createUploadQueue(limit = 4) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid upload concurrency');
    const active = new Set();
    return {
      async enqueue(task) {
        while (active.size >= limit) await Promise.race(active);
        const done = Promise.resolve().then(task);
        const settled = done.then(() => {}, () => {}).finally(() => active.delete(settled));
        active.add(settled);
        return { done };
      },
      async drain() { while (active.size) await Promise.all(active); },
    };
  }

  function pngChunks(bytes) {
    if (bytes.length < 8 || ascii(bytes.subarray(1, 4)) !== 'PNG') throw new Error('Invalid PNG');
    const chunks = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const end = offset + length + 12;
      if (end > bytes.length) throw new Error('Truncated PNG chunk');
      const type = ascii(bytes.subarray(offset + 4, offset + 8));
      chunks.push({ type, data: bytes.subarray(offset + 8, end - 4), raw: bytes.subarray(offset, end) });
      offset = end;
      if (type === 'IEND') return chunks;
    }
    throw new Error('Incomplete PNG');
  }

  function chunk(type, data) {
    const result = new Uint8Array(data.length + 12);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(Array.from(type, c => c.charCodeAt(0)), 4);
    result.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
    return result;
  }

  function jpegProfile(bytes) {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid JPEG');
    const parts = new Map();
    let expected = 0;
    for (let p = 2; p < bytes.length;) {
      if (bytes[p++] !== 255) throw new Error('Invalid JPEG marker');
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (bytes[p] << 8) | bytes[p + 1];
      if (length < 2 || p + length > bytes.length) throw new Error('Truncated JPEG metadata');
      const data = bytes.subarray(p + 2, p + length);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (data[0] !== 8 || ![1, 3].includes(data[5])) {
          throw new Error('Lossless PNG slicing supports 8-bit RGB or grayscale JPEG, not CMYK/HDR');
        }
      }
      if (marker === 0xe2 && ascii(data.subarray(0, 12)) === 'ICC_PROFILE\0') {
        const index = data[12], total = data[13];
        if (!total || index < 1 || index > total || (expected && total !== expected) || parts.has(index)) {
          throw new Error('Invalid JPEG color profile');
        }
        expected = total;
        parts.set(index, data.subarray(14));
      }
      p += length;
    }
    if (!expected) return null;
    if (parts.size !== expected) throw new Error('Incomplete JPEG color profile');
    const profile = new Uint8Array([...parts.values()].reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (let i = 1; i <= expected; i++) { profile.set(parts.get(i), offset); offset += parts.get(i).length; }
    return profile;
  }

  function requireRgbProfile(profile) {
    if (profile.length < 128 || ascii(profile.subarray(16, 20)) !== 'RGB ') {
      throw new Error('This color profile cannot be preserved in an RGB PNG; source was not changed');
    }
  }

  async function colorMetadata(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 255 && bytes[1] === 216) {
      const profile = jpegProfile(bytes);
      if (!profile) return { chunks: [chunk('sRGB', new Uint8Array([0]))], description: 'untagged JPEG treated as sRGB' };
      requireRgbProfile(profile);
      const compressed = new Uint8Array(await new Response(
        new Blob([profile]).stream().pipeThrough(new CompressionStream('deflate'))
      ).arrayBuffer());
      // PNG iCCP: profile name, NUL, compression method 0, zlib data.
      const data = new Uint8Array(5 + compressed.length);
      data.set([73, 67, 67, 0, 0]);
      data.set(compressed, 5);
      return { chunks: [chunk('iCCP', data)], description: 'original JPEG ICC profile preserved' };
    }
    if (ascii(bytes.subarray(1, 4)) === 'PNG') {
      const chunks = pngChunks(bytes);
      const header = chunks.find(c => c.type === 'IHDR');
      if (!header || header.data[8] > 8) throw new Error('16-bit PNG slicing is not supported without reducing precision');
      if (chunks.some(c => c.type === 'acTL')) throw new Error('Animated PNG slicing is not supported');
      const color = chunks.filter(c => COLOR_CHUNKS.has(c.type));
      const icc = color.find(c => c.type === 'iCCP');
      if (icc) {
        const nameEnd = icc.data.indexOf(0);
        if (nameEnd < 1 || icc.data[nameEnd + 1] !== 0) throw new Error('Invalid PNG color profile');
        const profile = new Uint8Array(await new Response(new Blob([icc.data.subarray(nameEnd + 2)]).stream()
          .pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
        requireRgbProfile(profile);
      }
      if (color.some(c => ['cICP', 'mDCV', 'cLLI'].includes(c.type))) throw new Error('HDR PNG slicing is not supported without color conversion');
      return { chunks: color.map(c => c.raw.slice()), description: 'original PNG color metadata preserved' };
    }
    throw new Error('Oversized files must be JPEG or PNG for lossless slicing');
  }

  async function preserveColor(blob, colors) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const output = [bytes.subarray(0, 8)];
    for (const c of pngChunks(bytes)) {
      if (COLOR_CHUNKS.has(c.type)) continue;
      output.push(c.raw);
      if (c.type === 'IHDR') output.push(...colors);
    }
    return new Blob(output, { type: PNG_MIME });
  }

  async function openSource(file) {
    const colors = await colorMetadata(file);
    // Decode once at native resolution. Ignore the source profile here and
    // reattach it to each PNG: do not silently clip wide-gamut JPEGs to sRGB.
    const image = await createImageBitmap(file, {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'from-image',
    });
    return { image, colors, close: () => image.close() };
  }

  async function encodeRegion(source, rect) {
    const canvas = typeof document==='undefined' ? new OffscreenCanvas(rect.width,rect.height) : document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    try {
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb', alpha: true });
      if (!ctx) throw new Error('PNG canvas is not available');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source.image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      const blob = canvas.convertToBlob ? await canvas.convertToBlob({type:PNG_MIME}) : await new Promise((resolve, reject) => canvas.toBlob(
        result => result ? resolve(result) : reject(new Error('PNG encoding failed')), PNG_MIME
      ));
      return await preserveColor(blob, source.colors.chunks);
    } finally {
      canvas.width = canvas.height = 1;
    }
  }

  root.LosslessUpload = { URL_LIMIT, PNG_MIME, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, dimensionsFit, payloadBytes, fits, partitions, dyadicRegions, planParts, createUploadQueue,
    openSource, encodeRegion, colorMetadata, preserveColor, pngChunks, chunk, jpegProfile };
})(typeof window !== 'undefined' ? window : globalThis);
