// slice-worker.js
// Image Align Tool_50 huge-image worker
// - Tries ImageDecoder + VideoFrame.copyTo first.
// - Falls back to createImageBitmap(blob) + OffscreenCanvas when ImageDecoder cannot decode the frame.
// - Returns RGBA tiles to the main thread.

const sessions = new Map();

function fail(type, reqId, fileId, error) {
  self.postMessage({
    type,
    reqId,
    fileId,
    error: error && error.message ? error.message : String(error || 'Worker error'),
  });
}

function inferMimeType(input) {
  const explicitType = input && input.mimeType ? String(input.mimeType).trim() : '';
  if (explicitType) return explicitType;
  const name = String((input && input.fileName) || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

function getFrameSize(frame) {
  const visible = frame && frame.visibleRect ? frame.visibleRect : null;
  const width = (frame && (frame.displayWidth || frame.codedWidth)) || (visible && visible.width) || 0;
  const height = (frame && (frame.displayHeight || frame.codedHeight)) || (visible && visible.height) || 0;
  return { width, height };
}

async function tryOpenWithImageDecoder(buffer, mimeType) {
  if (!self.ImageDecoder) {
    throw new Error('ImageDecoder is not available in this browser');
  }

  if (typeof ImageDecoder.isTypeSupported === 'function') {
    const support = await ImageDecoder.isTypeSupported(mimeType).catch(() => null);
    if (support && support.supported === false) {
      throw new Error(`Unsupported image type: ${mimeType}`);
    }
  }

  const uint8 = new Uint8Array(buffer);
  const decoder = new ImageDecoder({
    type: mimeType,
    data: uint8,
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });

  let decoded = null;
  try {
    if (decoder.tracks && decoder.tracks.ready) {
      await decoder.tracks.ready.catch(() => {});
    }
    try {
      decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    } catch (_) {
      decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: false });
    }
    const frame = decoded.image;
    const { width, height } = getFrameSize(frame);
    if (!width || !height) {
      try { frame.close(); } catch (_) {}
      try { decoder.close(); } catch (_) {}
      throw new Error('Decoded frame has invalid dimensions');
    }
    return { mode: 'frame', decoder, frame, width, height, backend: 'ImageDecoder' };
  } catch (e) {
    try { if (decoded && decoded.image) decoded.image.close(); } catch (_) {}
    try { decoder.close(); } catch (_) {}
    throw e;
  }
}

async function tryOpenWithBitmap(buffer, mimeType) {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is not available in this browser');
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not available in this browser');
  }

  const blob = new Blob([buffer], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width || 0;
  const height = bitmap.height || 0;
  if (!width || !height) {
    try { bitmap.close(); } catch (_) {}
    throw new Error('Bitmap has invalid dimensions');
  }

  return { mode: 'bitmap', bitmap, width, height, backend: 'createImageBitmap' };
}

async function openFile(reqId, fileId, payload) {
  const mimeType = inferMimeType(payload);
  const buffer = payload && payload.buffer ? payload.buffer : null;
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('Huge worker did not receive image data');
  }

  let session = null;
  let decoderError = null;

  try {
    session = await tryOpenWithImageDecoder(buffer, mimeType);
  } catch (e) {
    decoderError = e;
  }

  if (!session) {
    try {
      session = await tryOpenWithBitmap(buffer, mimeType);
    } catch (bitmapError) {
      const decoderMessage = decoderError && decoderError.message ? decoderError.message : String(decoderError || 'unknown');
      const bitmapMessage = bitmapError && bitmapError.message ? bitmapError.message : String(bitmapError || 'unknown');
      throw new Error(`Huge decode failed: decoder=${decoderMessage}; bitmap=${bitmapMessage}`);
    }
  }

  session.mimeType = mimeType;
  session.canvas = null;
  session.ctx = null;
  sessions.set(fileId, session);
  self.postMessage({
    type: 'open-ok',
    reqId,
    fileId,
    width: session.width,
    height: session.height,
    mimeType,
    backend: session.backend,
    decoderError: decoderError && decoderError.message ? decoderError.message : null,
  });
}

function getBitmapCanvas(session, width, height) {
  if (!session.canvas || session.canvas.width !== width || session.canvas.height !== height) {
    session.canvas = new OffscreenCanvas(width, height);
    session.ctx = session.canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' }) || session.canvas.getContext('2d');
    if (!session.ctx) {
      throw new Error('OffscreenCanvas 2D context is not available');
    }
    session.ctx.imageSmoothingEnabled = false;
  }
  return { canvas: session.canvas, ctx: session.ctx };
}

async function renderTile(reqId, fileId, sx, sy, sw, sh) {
  const session = sessions.get(fileId);
  if (!session) throw new Error('Worker session is not open');

  const x = Math.max(0, Math.min(session.width - 1, sx | 0));
  const y = Math.max(0, Math.min(session.height - 1, sy | 0));
  const width = Math.max(1, Math.min(session.width - x, sw | 0));
  const height = Math.max(1, Math.min(session.height - y, sh | 0));

  if (session.mode === 'frame') {
    const rect = { x, y, width, height };
    const allocationSize = session.frame.allocationSize({ rect, format: 'RGBA', colorSpace: 'srgb' });
    const buffer = new ArrayBuffer(allocationSize);
    await session.frame.copyTo(buffer, { rect, format: 'RGBA', colorSpace: 'srgb' });
    self.postMessage({ type: 'render-ok', reqId, fileId, width, height, buffer, backend: session.backend }, [buffer]);
    return;
  }

  if (session.mode === 'bitmap') {
    const { ctx } = getBitmapCanvas(session, width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(session.bitmap, x, y, width, height, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const buffer = imageData.data.buffer;
    self.postMessage({ type: 'render-ok', reqId, fileId, width, height, buffer, backend: session.backend }, [buffer]);
    return;
  }

  throw new Error('Unknown worker session mode');
}

async function closeFile(reqId, fileId) {
  const session = sessions.get(fileId);
  if (session) {
    try { if (session.frame) session.frame.close(); } catch (_) {}
    try { if (session.decoder) session.decoder.close(); } catch (_) {}
    try { if (session.bitmap) session.bitmap.close(); } catch (_) {}
    sessions.delete(fileId);
  }
  self.postMessage({ type: 'close-ok', reqId, fileId });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'open') {
      await openFile(msg.reqId, msg.fileId, msg);
      return;
    }
    if (msg.type === 'render') {
      await renderTile(msg.reqId, msg.fileId, msg.sx, msg.sy, msg.sw, msg.sh);
      return;
    }
    if (msg.type === 'close') {
      await closeFile(msg.reqId, msg.fileId);
      return;
    }
    fail('worker-error', msg.reqId, msg.fileId, new Error(`Unknown worker message: ${msg.type}`));
  } catch (e) {
    if (msg.type === 'open') fail('open-error', msg.reqId, msg.fileId, e);
    else if (msg.type === 'render') fail('render-error', msg.reqId, msg.fileId, e);
    else if (msg.type === 'close') fail('close-error', msg.reqId, msg.fileId, e);
    else fail('worker-error', msg.reqId, msg.fileId, e);
  }
};
