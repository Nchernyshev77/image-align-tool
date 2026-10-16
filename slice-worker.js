// slice-worker.js
// Image Align Tool_53 lossless huge-image worker
// - Uses the same ImageBitmap decoder as regular uploads in a dedicated worker.
// - Accepts ArrayBuffer + file metadata from the main thread.
// - Keeps one decoded frame per huge source.
// - Returns RGBA tiles to the main thread.

const sessions = new Map();

function fail(type, reqId, fileId, error) {
  self.postMessage({
    type,
    reqId,
    fileId,
    error: error && error.message ? error.message : String(error || "Worker error"),
  });
}

function inferMimeType(input) {
  const explicitType = input && input.mimeType ? String(input.mimeType).trim() : "";
  if (explicitType) return explicitType;
  const fileType = input && input.file && input.file.type ? String(input.file.type).trim() : "";
  if (fileType) return fileType;
  const name = String((input && (input.fileName || (input.file && input.file.name))) || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

async function openFile(reqId, fileId, payload) {
  if (!self.createImageBitmap || !self.OffscreenCanvas) {
    throw new Error("Lossless worker decoding is not available in this browser");
  }
  const mimeType = inferMimeType(payload);
  let buffer = payload && payload.buffer ? payload.buffer : null;
  if (!(buffer instanceof ArrayBuffer)) {
    const file = payload && payload.file ? payload.file : null;
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new Error("Huge worker did not receive image data");
    }
    buffer = await file.arrayBuffer();
  }

  // Match the regular upload decoder exactly. VideoFrame.copyTo can round
  // JPEG YUV-to-RGB samples differently and must not be used for these tiles.
  const frame = await createImageBitmap(new Blob([buffer], { type: mimeType }), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
    imageOrientation: "from-image",
  });
  const { width, height } = frame;
  if (!width || !height) {
    frame.close();
    throw new Error("Decoded frame has invalid dimensions");
  }
  sessions.set(fileId, { frame, width, height, mimeType });
  self.postMessage({ type: "open-ok", reqId, fileId, width, height, mimeType });
}

async function renderTile(reqId, fileId, sx, sy, sw, sh) {
  const session = sessions.get(fileId);
  if (!session) throw new Error("Worker session is not open");
  const frame = session.frame;

  const x = Math.max(0, Math.min(session.width - 1, sx | 0));
  const y = Math.max(0, Math.min(session.height - 1, sy | 0));
  const width = Math.max(1, Math.min(session.width - x, sw | 0));
  const height = Math.max(1, Math.min(session.height - y, sh | 0));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: true, colorSpace: "srgb", willReadFrequently: true });
  if (!ctx) throw new Error("Cannot create lossless tile canvas");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, x, y, width, height, 0, 0, width, height);
  const buffer = ctx.getImageData(0, 0, width, height).data.buffer;
  canvas.width = canvas.height = 1;
  self.postMessage({ type: "render-ok", reqId, fileId, width, height, buffer }, [buffer]);
}

async function closeFile(reqId, fileId) {
  const session = sessions.get(fileId);
  if (session) {
    try { if (session.frame) session.frame.close(); } catch (_) {}
    sessions.delete(fileId);
  }
  self.postMessage({ type: "close-ok", reqId, fileId });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "open") {
      await openFile(msg.reqId, msg.fileId, msg);
      return;
    }
    if (msg.type === "render") {
      await renderTile(msg.reqId, msg.fileId, msg.sx, msg.sy, msg.sw, msg.sh);
      return;
    }
    if (msg.type === "close") {
      await closeFile(msg.reqId, msg.fileId);
      return;
    }
    fail("worker-error", msg.reqId, msg.fileId, new Error(`Unknown worker message: ${msg.type}`));
  } catch (e) {
    if (msg.type === "open") fail("open-error", msg.reqId, msg.fileId, e);
    else if (msg.type === "render") fail("render-error", msg.reqId, msg.fileId, e);
    else if (msg.type === "close") fail("close-error", msg.reqId, msg.fileId, e);
    else fail("worker-error", msg.reqId, msg.fileId, e);
  }
};

