// app.js
// Test 56: fast scan, two preparation workers, streaming uploads and five-pass verification.
const { board } = window.miro;

// ---- color / slice settings ----
const SAT_CODE_MAX = 99;
const SAT_BOOST = 4.0;
const SAT_GROUP_THRESHOLD = 35;
const SLICE_TILE_SIZE = 4096;
const HUGE_SLICE_TILE_SIZE = 2048;
const SLICE_THRESHOLD_WIDTH = 8192;
const SLICE_THRESHOLD_HEIGHT = 4096;
let MAX_SLICE_DIM = 16384;
const MAX_URL_BYTES = window.LosslessUpload.URL_LIMIT;
const CREATE_IMAGE_MAX_RETRIES = 5;
const CREATE_IMAGE_BASE_DELAY_MS = 500;

const UPLOAD_CONCURRENCY = 5; // Source files; split pieces share their source slot.
const PART_CONCURRENCY_PER_SOURCE = 8;
const META_APP_ID = "image-align-tool";
const MAX_NOTIFICATION_MESSAGE_LENGTH = 80;
const LARGE_IMAGE_DIMENSION_WARNING = 16384;
const LARGE_IMAGE_WORKER_MIN_DIM = 24000;
const LARGE_IMAGE_WORKER_MIN_TILES = 36;
const TOO_LARGE_IMPORT_MESSAGE = "Image is too large for this browser";
const HUGE_INIT_FAILURE_MESSAGE = "Huge mode init failed";
const FAILURE_UI_COLOR = "#c62828";
const HUGE_WORKER_PATH = "./slice-worker.js?v=53.1";
const HUGE_TILE_MIME = "image/png";

function detectMaxSliceDim() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      console.warn("Slice: WebGL not available, using fallback 16384.");
      return;
    }
    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    console.log("Slice: MAX_TEXTURE_SIZE =", maxTexSize);
    MAX_SLICE_DIM = Math.min(maxTexSize || 16384, 32767);
  } catch (e) {
    console.warn("Slice: failed to detect MAX_TEXTURE_SIZE, using fallback.", e);
  }
}

function getTitle(item) {
  return (item.title || "").toString();
}

function extractTrailingNumber(str) {
  const match = String(str || "").match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isNaN(num) ? null : num;
}

function sortByGeometry(images) {
  return [...images].sort((a, b) => {
    if (a.y < b.y) return -1;
    if (a.y > b.y) return 1;
    if (a.x < b.x) return -1;
    if (a.x > b.x) return 1;
    return 0;
  });
}

function getCornerFlip(startCorner) {
  let flipX = false;
  let flipY = false;
  switch (startCorner) {
    case "top-right":
      flipX = true;
      break;
    case "bottom-left":
      flipY = true;
      break;
    case "bottom-right":
      flipX = true;
      flipY = true;
      break;
    default:
      break;
  }
  return { flipX, flipY };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function get2dContextSrgb(canvas) {
  try {
    const ctx = canvas.getContext("2d", { colorSpace: "srgb", alpha: false });
    if (ctx) return ctx;
  } catch (_) {}
  return canvas.getContext("2d");
}

function logCanvasColorSpace(prefix) {
  try {
    const c = document.createElement("canvas");
    let supported = false;
    let actual = "unknown";
    try {
      const ctx = c.getContext("2d", { colorSpace: "srgb", alpha: false });
      supported = !!ctx;
      if (ctx && typeof ctx.getContextAttributes === "function") {
        const attrs = ctx.getContextAttributes();
        if (attrs && typeof attrs.colorSpace === "string") actual = attrs.colorSpace;
      }
    } catch (_) {
      supported = false;
    }
    console.log(`${prefix}: 2D colorSpace request=srgb supported=${supported} actual=${actual}`);
  } catch (_) {}
}

class DataUrlTooLargeError extends Error {
  constructor(message, length, limit) {
    super(message);
    this.name = "DataUrlTooLargeError";
    this.length = length;
    this.limit = limit;
  }
}

class FatalHugeFileError extends Error {
  constructor(file, fileName, cause) {
    const message = cause && cause.message ? cause.message : String(cause || "Huge tile failed");
    super(message);
    this.name = "FatalHugeFileError";
    this.file = file;
    this.fileName = fileName || (file && file.name) || "image";
    this.cause = cause;
  }
}

function clampNotificationMessage(message, fallback = "Operation failed") {
  const raw = (message == null ? "" : String(message)).replace(/\s+/g, " ").trim();
  const safe = raw || fallback;
  if (safe.length <= MAX_NOTIFICATION_MESSAGE_LENGTH) return safe;
  return safe.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH - 1).trimEnd() + "…";
}

async function notify(kind, message, details) {
  const safeMessage = clampNotificationMessage(message);
  try {
    if (details !== undefined) {
      const logger = kind === "showError" ? console.error : kind === "showWarning" ? console.warn : console.log;
      logger("[Image Align Tool] notification:", safeMessage, details);
    }
    await board.notifications[kind](safeMessage);
  } catch (e) {
    console.error("[Image Align Tool] notification failed", { kind, safeMessage, details, error: e });
  }
}

const notifyInfo = (message, details) => notify("showInfo", message, details);
const notifyWarning = (message, details) => notify("showWarning", message, details);
const notifyError = (message, details) => notify("showError", message, details);

async function decodeImageFromFile(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await loadImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function getBrightnessAndSaturationFromImageElement(
  img,
  smallSize = 50,
  blurPx = 3,
  cropTopRatio = 0.3,
  cropSideRatio = 0.2
) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const width = smallSize;
  const height = smallSize;
  canvas.width = width;
  canvas.height = height;

  const prevFilter = ctx.filter || "none";
  try {
    ctx.filter = `blur(${blurPx}px)`;
  } catch (_) {}
  ctx.drawImage(img, 0, 0, width, height);
  ctx.filter = prevFilter;

  const cropY = Math.floor(height * cropTopRatio);
  const cropH = height - cropY;
  const cropX = Math.floor(width * cropSideRatio);
  const cropW = width - 2 * cropX;
  if (cropH <= 0 || cropW <= 0) return null;

  let imageData;
  try {
    imageData = ctx.getImageData(cropX, cropY, cropW, cropH);
  } catch (e) {
    console.error("getImageData failed (CORS?):", e);
    return null;
  }

  const data = imageData.data;
  const totalPixels = cropW * cropH;
  let sumY = 0;
  let sumDiff = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumY += y;
    const maxv = Math.max(r, g, b);
    const minv = Math.min(r, g, b);
    sumDiff += maxv - minv;
  }

  const brightness = (sumY / totalPixels) / 255;
  const saturation = (sumDiff / totalPixels) / 255;
  return { brightness, saturation };
}

async function alignImagesInGivenOrder(images, config) {
  const { imagesPerRow, horizontalGap, verticalGap, sizeMode, startCorner } = config;
  if (!images.length) return;

  if (sizeMode === "width") {
    const targetWidth = Math.min(...images.map((img) => img.width));
    for (const img of images) img.width = targetWidth;
    await Promise.all(images.map((img) => img.sync()));
  } else if (sizeMode === "height") {
    const targetHeight = Math.min(...images.map((img) => img.height));
    for (const img of images) img.height = targetHeight;
    await Promise.all(images.map((img) => img.sync()));
  }

  const total = images.length;
  const cols = Math.max(1, imagesPerRow);
  const rows = Math.ceil(total / cols);
  const rowHeights = new Array(rows).fill(0);
  const rowWidths = new Array(rows).fill(0);

  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const img = images[i];
    if (img.height > rowHeights[r]) rowHeights[r] = img.height;
    if (rowWidths[r] > 0) rowWidths[r] += horizontalGap;
    rowWidths[r] += img.width;
  }

  const gridWidth = rowWidths.length ? Math.max(...rowWidths) : 0;
  const gridHeight = rowHeights.reduce((sum, h) => sum + h, 0) + verticalGap * Math.max(0, rows - 1);
  const rowTop = new Array(rows).fill(0);
  for (let r = 1; r < rows; r++) rowTop[r] = rowTop[r - 1] + rowHeights[r - 1] + verticalGap;

  const baseX = new Array(total).fill(0);
  const baseY = new Array(total).fill(0);
  const rowCursorX = new Array(rows).fill(0);

  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const img = images[i];
    baseY[i] = rowTop[r] + rowHeights[r] / 2;
    baseX[i] = rowCursorX[r] + img.width / 2;
    rowCursorX[r] += img.width + horizontalGap;
  }

  const bounds = images.map((img) => ({
    left: img.x - img.width / 2,
    top: img.y - img.height / 2,
    right: img.x + img.width / 2,
    bottom: img.y + img.height / 2,
  }));
  const minLeft = Math.min(...bounds.map((b) => b.left));
  const minTop = Math.min(...bounds.map((b) => b.top));
  const maxRight = Math.max(...bounds.map((b) => b.right));
  const maxBottom = Math.max(...bounds.map((b) => b.bottom));

  const { flipX, flipY } = getCornerFlip(startCorner);
  const originLeft = flipX ? (maxRight - gridWidth) : minLeft;
  const originTop = flipY ? (maxBottom - gridHeight) : minTop;

  for (let i = 0; i < total; i++) {
    let x0 = baseX[i];
    let y0 = baseY[i];
    if (flipX) x0 = gridWidth - x0;
    if (flipY) y0 = gridHeight - y0;
    images[i].x = originLeft + x0;
    images[i].y = originTop + y0;
  }

  await Promise.all(images.map((img) => img.sync()));
}

async function orderImagesForSorting(images, { sortMode, sizeMode, sizeOrder }) {
  if (!images.length) return [];

  if (sortMode === "number") {
    const hasAnyEmptyTitle = images.some((img) => !getTitle(img));
    if (hasAnyEmptyTitle) {
      const geoOrder = sortByGeometry(images);
      let counter = 1;
      for (const img of geoOrder) img.title = String(counter++);
      await Promise.all(geoOrder.map((img) => img.sync()));
      images = geoOrder;
    }

    const meta = images.map((img, index) => {
      const title = getTitle(img);
      const lower = title.toLowerCase();
      const num = extractTrailingNumber(title);
      return { img, index, lower, num, hasNumber: num !== null };
    });

    meta.sort((a, b) => {
      if (a.hasNumber && !b.hasNumber) return -1;
      if (!a.hasNumber && b.hasNumber) return 1;
      if (a.hasNumber && b.hasNumber) {
        if (a.num !== b.num) return a.num - b.num;
        if (a.lower < b.lower) return -1;
        if (a.lower > b.lower) return 1;
        return a.index - b.index;
      }
      if (a.lower < b.lower) return -1;
      if (a.lower > b.lower) return 1;
      return a.index - b.index;
    });
    return meta.map((m) => m.img);
  }

  if (sortMode === "color") {
    const meta = images.map((img, index) => {
      const title = getTitle(img);
      const match = title.match(/^C(\d{2})\/(\d{3})\s+/);
      if (!match) return { img, index, hasCode: false, group: 1, satCode: null, briCode: null };
      const satCode = Number.parseInt(match[1], 10);
      const briCode = Number.parseInt(match[2], 10);
      const group = satCode <= SAT_GROUP_THRESHOLD ? 0 : 1;
      return { img, index, hasCode: true, satCode, briCode, group };
    });

    if (!meta.some((m) => m.hasCode)) return sortByGeometry(images);

    meta.sort((a, b) => {
      if (a.hasCode && b.hasCode) {
        if (a.group !== b.group) return a.group - b.group;
        if (a.briCode !== b.briCode) return a.briCode - b.briCode;
        if (a.satCode !== b.satCode) return a.satCode - b.satCode;
        return a.index - b.index;
      }
      if (a.hasCode) return -1;
      if (b.hasCode) return 1;
      return a.index - b.index;
    });
    return meta.map((m) => m.img);
  }

  if (sortMode === "size") {
    const order = sizeOrder === "asc" ? 1 : -1;
    let targetWidth = null;
    let targetHeight = null;
    if (sizeMode === "width") targetWidth = Math.min(...images.map((img) => img.width));
    else if (sizeMode === "height") targetHeight = Math.min(...images.map((img) => img.height));

    const withKeys = images.map((img, index) => {
      const w0 = img.width || 0;
      const h0 = img.height || 0;
      let w = w0;
      let h = h0;
      if (targetWidth && w0 > 0) {
        const scale = targetWidth / w0;
        w = targetWidth;
        h = h0 * scale;
      } else if (targetHeight && h0 > 0) {
        const scale = targetHeight / h0;
        h = targetHeight;
        w = w0 * scale;
      }
      return { img, index, area: w * h, w0, h0 };
    });

    withKeys.sort((a, b) => {
      if (a.area !== b.area) return (a.area - b.area) * order;
      if (a.w0 !== b.w0) return (a.w0 - b.w0) * order;
      if (a.h0 !== b.h0) return (a.h0 - b.h0) * order;
      return a.index - b.index;
    });

    return withKeys.map((x) => x.img);
  }

  return images;
}

async function handleSortingSubmit(event) {
  event.preventDefault();
  try {
    const form = document.getElementById("sorting-form");
    if (!form) return;

    const imagesPerRow = Number(form.sortingImagesPerRow.value) || 1;
    const horizontalGap = Number(form.sortingHorizontalGap.value) || 0;
    const verticalGap = Number(form.sortingVerticalGap.value) || 0;
    const sizeMode = form.sortingSizeMode.value;
    const startCorner = form.sortingStartCorner.value;
    const sortModeEl = document.getElementById("sortingSortMode");
    const sortMode = sortModeEl ? sortModeEl.value : "number";
    const sizeOrder = form.sortingSizeOrder ? form.sortingSizeOrder.value : "desc";

    const selection = await board.getSelection();
    const images = selection.filter((i) => i.type === "image");
    if (!images.length) {
      await notifyInfo("Select at least one image");
      return;
    }
    if (imagesPerRow < 1) {
      await notifyError("Rows must be greater than 0");
      return;
    }

    const orderedImages = await orderImagesForSorting(images, { sortMode, sizeMode, sizeOrder });
    await alignImagesInGivenOrder(orderedImages, { imagesPerRow, horizontalGap, verticalGap, sizeMode, startCorner });
    await notifyInfo(`Aligned ${orderedImages.length} image${orderedImages.length === 1 ? "" : "s"}`);
  } catch (err) {
    console.error(err);
    await notifyError("Align images failed", err);
  }
}

function sortFilesByNameWithNumber(files) {
  const arr = Array.from(files).map((file, index) => {
    const name = file.name || "";
    const lower = name.toLowerCase();
    const num = extractTrailingNumber(name);
    return { file, index, lower, num, hasNumber: num !== null };
  });

  const anyHasNumber = arr.some((m) => m.hasNumber);
  if (!anyHasNumber) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  } else {
    arr.sort((a, b) => {
      if (a.hasNumber && !b.hasNumber) return -1;
      if (!a.hasNumber && b.hasNumber) return 1;
      if (a.hasNumber && b.hasNumber) {
        if (a.num !== b.num) return a.num - b.num;
        if (a.lower < b.lower) return -1;
        if (a.lower > b.lower) return 1;
        return a.index - b.index;
      }
      if (a.lower < b.lower) return -1;
      if (a.lower > b.lower) return 1;
      return a.index - b.index;
    });
  }
  return arr.map((m) => m.file);
}

function readOriginalDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.startsWith("data:")) {
        reject(new Error("Cannot read original image"));
        return;
      }
      // Preserve the original bytes; callers check the measured Miro URL limit.
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error || new Error("Cannot read original image"));
    reader.onabort = () => reject(new Error("Reading original image was cancelled"));
    reader.readAsDataURL(file);
  });
}

function getUploadErrorDetails(error) {
  const details = {};
  for (const key of ["name", "message", "code", "status", "statusCode"]) {
    if (error && ["string", "number"].includes(typeof error[key])) details[key] = error[key];
  }
  if (!details.message) details.message = String(error || "Unknown upload error");
  // Never include image data or request bodies in the diagnostics.
  for (const key of Object.keys(details)) {
    if (typeof details[key] === "string") {
      details[key] = details[key].replace(/data:[^\s"']+/g, "[image data omitted]").slice(0, 3000);
    }
  }
  return details;
}

function rgbaBufferToPngBlob(buffer, width, height) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { colorSpace: "srgb", alpha: true });
      ctx.imageSmoothingEnabled = false;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("PNG tile encode failed"));
          return;
        }
        resolve(blob);
      }, HUGE_TILE_MIME);
    } catch (e) {
      reject(e);
    }
  });
}

function computeVariableSlotCenters(orderedInfos, imagesPerRow, startCorner, viewCenterX, viewCenterY) {
  const totalSlots = orderedInfos.length;
  if (!totalSlots) return [];
  const cols = Math.max(1, imagesPerRow);
  const rows = Math.ceil(totalSlots / cols);
  const rowHeights = new Array(rows).fill(0);
  const rowWidths = new Array(rows).fill(0);

  for (let i = 0; i < totalSlots; i++) {
    const r = Math.floor(i / cols);
    const info = orderedInfos[i];
    if (info.height > rowHeights[r]) rowHeights[r] = info.height;
    if (rowWidths[r] > 0) rowWidths[r] += 0;
    rowWidths[r] += info.width;
  }

  const gridWidth = rowWidths.length ? Math.max(...rowWidths) : 0;
  const gridHeight = rowHeights.reduce((sum, h) => sum + h, 0);
  const rowTop = new Array(rows).fill(0);
  for (let r = 1; r < rows; r++) rowTop[r] = rowTop[r - 1] + rowHeights[r - 1];

  const baseX = new Array(totalSlots).fill(0);
  const baseY = new Array(totalSlots).fill(0);
  const rowCursorX = new Array(rows).fill(0);

  for (let i = 0; i < totalSlots; i++) {
    const r = Math.floor(i / cols);
    const info = orderedInfos[i];
    baseY[i] = rowTop[r] + rowHeights[r] / 2;
    baseX[i] = rowCursorX[r] + info.width / 2;
    rowCursorX[r] += info.width;
  }

  const { flipX, flipY } = getCornerFlip(startCorner);
  const centers = [];
  for (let i = 0; i < totalSlots; i++) {
    let x0 = baseX[i] - gridWidth / 2;
    let y0 = baseY[i] - gridHeight / 2;
    if (flipX) x0 = -x0;
    if (flipY) y0 = -y0;
    centers.push({ x: viewCenterX + x0, y: viewCenterY + y0 });
  }
  return centers;
}

function computeSkipMissingSlotCenters(tileInfos, imagesPerRow, startCorner, viewCenterX, viewCenterY) {
  if (!tileInfos.length) return [];
  const cols = Math.max(1, imagesPerRow);
  const cellWidth = tileInfos[0].info.width;
  const cellHeight = tileInfos[0].info.height;
  let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;

  for (const { num } of tileInfos) {
    const row = Math.floor(num / cols);
    const col = num % cols;
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
  }

  const normCols = Math.max(1, maxCol - minCol + 1);
  const normRows = Math.max(1, maxRow - minRow + 1);
  const gridWidth = normCols * cellWidth;
  const gridHeight = normRows * cellHeight;
  let flipX = false;
  let flipY = false;
  switch (startCorner) {
    case "top-right": flipX = true; break;
    case "bottom-left": flipY = true; break;
    case "bottom-right": flipX = true; flipY = true; break;
    default: break;
  }

  const centersByFileId = new Map();
  for (const { info, num } of tileInfos) {
    let row = Math.floor(num / cols) - minRow;
    let col = (num % cols) - minCol;
    if (flipX) col = normCols - 1 - col;
    if (flipY) row = normRows - 1 - row;
    const left = viewCenterX - gridWidth / 2 + col * cellWidth;
    const top = viewCenterY - gridHeight / 2 + row * cellHeight;
    centersByFileId.set(info.file, { x: left + cellWidth / 2, y: top + cellHeight / 2 });
  }
  return centersByFileId;
}

function createHugeSliceManager() {
  let worker = null;
  let requestId = 1;
  let fileId = 1;
  const pending = new Map();
  const sessions = new WeakMap();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(HUGE_WORKER_PATH);
    worker.onmessage = (event) => {
      const msg = event.data || {};
      const pendingReq = pending.get(msg.reqId);
      if (!pendingReq) return;
      pending.delete(msg.reqId);
      if (msg.type && msg.type.endsWith("-error")) {
        pendingReq.reject(new Error(msg.error || "Worker request failed"));
        return;
      }
      pendingReq.resolve(msg);
    };
    worker.onerror = (event) => {
      console.error("[Image Align Tool] huge worker crashed", event);
      for (const [id, req] of pending.entries()) {
        pending.delete(id);
        req.reject(new Error("Huge slice worker crashed"));
      }
    };
    return worker;
  }

  function callWorker(message, transfer = []) {
    const id = requestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ensureWorker().postMessage({ ...message, reqId: id }, transfer);
    });
  }

  async function openFile(file) {
    let session = sessions.get(file);
    if (session && session.openPromise) return session.openPromise;
    const currentFileId = `huge-${fileId++}`;
    session = { fileId: currentFileId, openPromise: null };
    sessions.set(file, session);
    session.openPromise = Promise.resolve()
      .then(async () => {
        session.colors = await window.LosslessUpload.colorMetadata(file);
        const buffer = await file.arrayBuffer();
        return callWorker({
          type: "open",
          fileId: currentFileId,
          fileName: file && file.name ? file.name : "",
          mimeType: file && file.type ? file.type : "",
          buffer,
        }, [buffer]);
      })
      .then((msg) => ({ fileId: currentFileId, width: msg.width, height: msg.height, colors: session.colors }))
      .catch((err) => {
        sessions.delete(file);
        throw err;
      });
    return session.openPromise;
  }

  async function renderTile(file, sx, sy, sw, sh) {
    const session = sessions.get(file);
    if (!session || !session.openPromise) throw new Error("Huge file session is not open");
    await session.openPromise;
    const msg = await callWorker({ type: "render", fileId: session.fileId, sx, sy, sw, sh });
    return { width: msg.width, height: msg.height, buffer: msg.buffer, colors: session.colors };
  }

  async function closeFile(file) {
    const session = sessions.get(file);
    if (!session) return;
    try {
      await callWorker({ type: "close", fileId: session.fileId });
    } catch (e) {
      console.warn("[Image Align Tool] huge worker close failed", e);
    }
    sessions.delete(file);
  }

  async function disposeAll() {
    if (worker) {
      try {
        worker.terminate();
      } catch (_) {}
      worker = null;
    }
    pending.clear();
  }

  return { openFile, renderTile, closeFile, disposeAll };
}

async function handleStitchSubmit(event) {
  event.preventDefault();
  const form=document.getElementById('stitch-form'),button=document.getElementById('stitchButton');
  const input=document.getElementById('stitchFolderInput');
  const files=sortFilesByNameWithNumber(Array.from(input&&input.files||[]));
  if(!files.length){await notifyError('Select one or more image files');return;}
  const imagesPerRow=Number(form.stitchImagesPerRow.value)||1,startCorner=form.stitchStartCorner.value,skipMissing=form.stitchSkipMissing.checked;
  if(imagesPerRow<1){await notifyError('Rows must be greater than 0');return;}
  const bar=document.getElementById('stitchProgressBar'),status=document.getElementById('stitchProgressMain');
  const scanEl=document.getElementById('stitchScanProgress'),prepareEl=document.getElementById('stitchPrepareProgress'),uploadEl=document.getElementById('stitchUploadProgress');
  const resultEl=document.getElementById('stitchResult'),elapsedEl=document.getElementById('stitchElapsed');
  const startedAt=performance.now();
  const showElapsed=()=>{
    const elapsedMs=performance.now()-startedAt,seconds=Math.round(elapsedMs/1000);
    const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
    if(elapsedEl){
      elapsedEl.textContent=`Total time: ${hours?`${hours}h `:''}${hours||minutes?`${minutes}m `:''}${seconds%60}s`;
      elapsedEl.hidden=false;
    }
    return elapsedMs;
  };
  if(button)button.disabled=true;
  if(resultEl){resultEl.hidden=true;resultEl.textContent='';}
  if(elapsedEl){elapsedEl.hidden=true;elapsedEl.textContent='';}
  if(status){status.style.color='';status.textContent='Scanning files…';}
  if(bar){bar.style.width='0%';bar.style.background='';}
  let viewCenterX=0,viewCenterY=0;
  try {
    try{const viewport=await board.viewport.get();viewCenterX=viewport.x+viewport.width/2;viewCenterY=viewport.y+viewport.height/2;}catch(error){console.warn('Viewport unavailable',error);}
    const layout=async sources=>{
      const fallback=sources.find(s=>s.info)?.info||{width:4096,height:4096};
      const infos=sources.map(source=>{
        const info=source.info||fallback,width=info.width,height=info.height;
        const needsSlice=width>SLICE_THRESHOLD_WIDTH||height>SLICE_THRESHOLD_HEIGHT;
        const baseTiles=Math.ceil(width/SLICE_TILE_SIZE)*Math.ceil(height/SLICE_TILE_SIZE);
        const huge=width>LARGE_IMAGE_WORKER_MIN_DIM||height>LARGE_IMAGE_WORKER_MIN_DIM||baseTiles>=LARGE_IMAGE_WORKER_MIN_TILES;
        return {...info,file:source.file,width,height,needsSlice,sliceTileSize:huge?HUGE_SLICE_TILE_SIZE:SLICE_TILE_SIZE};
      });
      let centers,centerMap;
      if(skipMissing&&!infos.some(info=>info.needsSlice)&&infos.some(info=>extractTrailingNumber(info.file.name||'')!==null)){
        let next=Math.max(...infos.map(info=>extractTrailingNumber(info.file.name||'')||0));
        const numbered=infos.map(info=>({info,num:extractTrailingNumber(info.file.name||'')??++next}));
        centerMap=computeSkipMissingSlotCenters(numbered,imagesPerRow,startCorner,viewCenterX,viewCenterY);
      }else centers=computeVariableSlotCenters(infos,imagesPerRow,startCorner,viewCenterX,viewCenterY);
      for(let i=0;i<sources.length;i++){
        const source=sources[i],info=infos[i],center=centerMap?centerMap.get(source.file):centers[i];
        if(!source.info){source.jobs=[];continue;}
        if(!info.needsSlice){source.jobs=[{kind:'full',width:info.width,height:info.height,x:center.x,y:center.y}];continue;}
        const jobs=[],size=info.sliceTileSize,left=center.x-info.width/2,top=center.y-info.height/2;
        let index=0;const match=source.name.match(/^(.*?)(\.[^.]*$|$)/),base=match?match[1]:source.name,ext=match?match[2]:'';
        for(let sy=0;sy<info.height;sy+=size)for(let sx=0;sx<info.width;sx+=size){
          const sw=Math.min(size,info.width-sx),sh=Math.min(size,info.height-sy);index++;
          jobs.push({kind:'tile',sx,sy,sw,sh,x:left+sx+sw/2,y:top+sy+sh/2,tileIndex:index,titleName:`${base}_${String(index).padStart(2,'0')}${ext}`});
        }
        source.jobs=jobs;
      }
    };
    const onProgress=state=>{
      if(scanEl)scanEl.textContent=`1. Scanning: ${state.scanDone} / ${state.totalSources}`;
      if(prepareEl)prepareEl.textContent=`2. Preparing: ${state.prepareDone} / ${state.totalSources}`;
      if(uploadEl)uploadEl.textContent=`3. Uploading: ${state.uploaded} / ${state.totalParts||'…'}`;
      if(status)status.textContent=state.status;
      if(bar){const scan=state.scanDone/state.totalSources,prepared=state.prepareDone/state.totalSources;
        const upload=state.totalParts?Math.min(1,state.uploaded/state.totalParts):0;
        bar.style.width=`${state.phase==='complete'?100:Math.min(97,10*scan+35*prepared+45*upload)}%`;}
    };
    const result=await window.ImportEngine.run({files,board,scan:window.FastImageScan.scan,layout,
      createPreparer:()=>window.TilePreparation.create(),onProgress,options:{readDataUrl:readOriginalDataUrl}});
    const elapsedMs=showElapsed();
    window.ImageAlignLastImport={version:57,elapsedMs,success:result.success,verified:result.verified,totalParts:result.totalParts,passes:result.passes,
      failures:result.failures,groupErrors:result.groupErrors,boardError:result.boardError,duplicates:result.duplicates};
    if(resultEl){
      resultEl.hidden=false;
      if(result.success)resultEl.textContent=`Verified ${result.verified} parts from ${files.length} files.`;
      else{
        const failures=result.failures.map(f=>`${f.name}: ${f.total===null?'could not prepare':`${f.missing} of ${f.total} parts missing`} — ${f.error}`);
        failures.push(...result.groupErrors.map(f=>`${f.name}: grouping failed — ${f.error}`));
        if(result.boardError)failures.push(`Could not verify board: ${result.boardError}`);
        if(result.duplicates)failures.push(`Duplicate image references found: ${result.duplicates}`);
        resultEl.textContent='Import incomplete after 5 passes.\n'+failures.join('\n');
      }
      resultEl.style.color=result.success?'':FAILURE_UI_COLOR;
      resultEl.style.textAlign=result.success?'center':'left';
    }
    if(result.success){
      if(status)status.textContent='All tiles uploaded and verified';
      await notifyInfo(`Verified ${result.verified} image parts`);
      const widgets=result.sources.flatMap(s=>s.parts.map(p=>p.widget).filter(Boolean));
      if(widgets.length)try{await board.viewport.zoomTo(widgets);}catch(error){console.warn('zoomTo failed',error);}
    }else{
      if(status){status.textContent='Import incomplete after 5 passes';status.style.color=FAILURE_UI_COLOR;}
      if(bar)bar.style.background=FAILURE_UI_COLOR;
      await notifyError(`Import incomplete: ${result.failures.length} files; see the list below`);
    }
  }catch(error){
    showElapsed();
    console.error('Image import failed',error);
    if(status){status.textContent='Import failed';status.style.color=FAILURE_UI_COLOR;}
    if(resultEl){resultEl.hidden=false;resultEl.textContent=error.message||String(error);resultEl.style.color=FAILURE_UI_COLOR;resultEl.style.textAlign='left';}
    await notifyError('Image import failed',error);
  }finally{if(button)button.disabled=false;}
}

window.addEventListener("DOMContentLoaded", () => {
  detectMaxSliceDim();
  logCanvasColorSpace("Canvas");

  const sortingForm = document.getElementById("sorting-form");
  if (sortingForm) sortingForm.addEventListener("submit", handleSortingSubmit);

  const sortModeSelect = document.getElementById("sortingSortMode");
  const sizeOrderField = document.getElementById("sortingSizeOrderField");
  const updateSizeOrderVisibility = () => {
    if (!sortModeSelect || !sizeOrderField) return;
    sizeOrderField.style.display = sortModeSelect.value === "size" ? "" : "none";
  };
  if (sortModeSelect) sortModeSelect.addEventListener("change", updateSizeOrderVisibility);
  updateSizeOrderVisibility();

  const stitchForm = document.getElementById("stitch-form");
  if (stitchForm) stitchForm.addEventListener("submit", handleStitchSubmit);

  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = {
    sorting: document.getElementById("tab-sorting"),
    stitch: document.getElementById("tab-stitch"),
  };

  function activateTab(name) {
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
    Object.entries(tabContents).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle("active", key === name);
    });
  }

  if (tabButtons.length) {
    tabButtons.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));
    activateTab("stitch");
  }

  const fileButton = document.getElementById("stitchFileButton");
  const fileInput = document.getElementById("stitchFolderInput");
  const fileLabel = document.getElementById("stitchFileLabel");
  if (fileButton && fileInput && fileLabel) {
    fileButton.addEventListener("click", () => fileInput.click());
    const updateLabel = () => {
      const files = fileInput.files;
      if (!files || files.length === 0) fileLabel.textContent = "No files selected";
      else if (files.length === 1) fileLabel.textContent = files[0].name;
      else fileLabel.textContent = `${files.length} files selected`;
    };
    fileInput.addEventListener("change", updateLabel);
    updateLabel();
  }
});

