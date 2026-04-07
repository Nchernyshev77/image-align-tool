// slice-worker.js
// Image Align Tool_48 huge-image worker
// - Uses ImageDecoder in a dedicated worker.
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

function inferMimeType(file) {
  const type = file && file.type ? String(file.type).trim() : "";
  if (type) return type;
  const name = String((file && file.name) || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function getFrameSize(frame) {
  const visible = frame && frame.visibleRect ? frame.visibleRect : null;
  const width = frame && (frame.displayWidth || frame.codedWidth || (visible && visible.width)) || 0;
  const height = frame && (frame.displayHeight || frame.codedHeight || (visible && visible.height)) || 0;
  return { width, height };
}

async function openFile(reqId, fileId, file) {
  if (!self.ImageDecoder) {
    throw new Error("ImageDecoder is not available in this browser");
  }
  const mimeType = inferMimeType(file);
  if (typeof ImageDecoder.isTypeSupported === "function") {
    try {
      const support = await ImageDecoder.isTypeSupported(mimeType);
      if (!support || support.supported === false) {
        throw new Error(`Unsupported image type: ${mimeType}`);
      }
    } catch (e) {
      if (/Unsupported image type/.test(String(e && e.message ? e.message : e))) throw e;
    }
  }

  const buffer = await file.arrayBuffer();
  const decoder = new ImageDecoder({
    type: mimeType,
    data: buffer,
    transfer: [buffer],
    premultiplyAlpha: "none",
    colorSpaceConversion: "default",
  });

  const decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
  const frame = decoded.image;
  const { width, height } = getFrameSize(frame);
  if (!width || !height) {
    try { frame.close(); } catch (_) {}
    try { decoder.close(); } catch (_) {}
    throw new Error("Decoded frame has invalid dimensions");
  }

  sessions.set(fileId, { decoder, frame, width, height, mimeType });
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
  const rect = { x, y, width, height };

  const allocationSize = frame.allocationSize({ rect, format: "RGBA", colorSpace: "srgb" });
  const buffer = new ArrayBuffer(allocationSize);
  await frame.copyTo(buffer, { rect, format: "RGBA", colorSpace: "srgb" });
  self.postMessage({ type: "render-ok", reqId, fileId, width, height, buffer }, [buffer]);
}

async function closeFile(reqId, fileId) {
  const session = sessions.get(fileId);
  if (session) {
    try { if (session.frame) session.frame.close(); } catch (_) {}
    try { if (session.decoder) session.decoder.close(); } catch (_) {}
    sessions.delete(fileId);
  }
  self.postMessage({ type: "close-ok", reqId, fileId });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "open") {
      await openFile(msg.reqId, msg.fileId, msg.file);
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
