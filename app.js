// app.js
// Image Align Tool_49: Sorting + Stitch/Slice
// Base: Image Align Tool_41
// Changes in _49:
// - Fix huge worker init by sending ArrayBuffer to the worker instead of trying to transfer File.
// - Add a clearer huge-mode init failure message instead of misreporting it as image-too-large.
// - Keep the _48 huge-mode path: 2048 tiles, concurrency 1, PNG tiles, and object URLs.
// - panel.html is unchanged.

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
const MAX_URL_BYTES = 11000000;
const CREATE_IMAGE_MAX_RETRIES = 5;
const CREATE_IMAGE_BASE_DELAY_MS = 500;

const UPLOAD_CONCURRENCY_NORMAL = 4;
const UPLOAD_CONCURRENCY_HUGE = 1;
const META_APP_ID = "image-align-tool";
const MAX_NOTIFICATION_MESSAGE_LENGTH = 80;
const LARGE_IMAGE_DIMENSION_WARNING = 16384;
const LARGE_IMAGE_WORKER_MIN_DIM = 24000;
const LARGE_IMAGE_WORKER_MIN_TILES = 36;
const TOO_LARGE_IMPORT_MESSAGE = "Image is too large for this browser";
const HUGE_INIT_FAILURE_MESSAGE = "Huge mode init failed";
const FAILURE_UI_COLOR = "#c62828";
const HUGE_WORKER_PATH = "./slice-worker.js";
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

function canvasToDataUrlUnderLimit(canvas) {
  const q = 0.8;
  const dataUrl = canvas.toDataURL("image/jpeg", q);
  if (dataUrl.length > MAX_URL_BYTES) {
    throw new DataUrlTooLargeError(
      `dataURL too large at q=${q} (len=${dataUrl.length}, cap=${MAX_URL_BYTES})`,
      dataUrl.length,
      MAX_URL_BYTES
    );
  }
  return dataUrl;
}

function rgbaBufferToPngBlob(buffer, width, height) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = get2dContextSrgb(canvas);
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
        const buffer = await file.arrayBuffer();
        return callWorker({
          type: "open",
          fileId: currentFileId,
          fileName: file && file.name ? file.name : "",
          mimeType: file && file.type ? file.type : "",
          buffer,
        }, [buffer]);
      })
      .then((msg) => ({ fileId: currentFileId, width: msg.width, height: msg.height }))
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
    return { width: msg.width, height: msg.height, buffer: msg.buffer };
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
  logCanvasColorSpace("Stitch/Slice");

  const hugeManager = createHugeSliceManager();
  let uploadedBytesDone = 0;
  let uploadRetryEvents = 0;
  const createImageWallTimesMs = [];
  let createImageWallTimeSumMs = 0;
  let createImageWallTimeCount = 0;

  const stitchButton = document.getElementById("stitchButton");
  const progressBarEl = document.getElementById("stitchProgressBar");
  const progressMainEl = document.getElementById("stitchProgressMain");
  const progressEtaEl = document.getElementById("stitchProgressEta");

  let progressStageEl = document.getElementById("stitchProgressStage");
  if (!progressStageEl && progressMainEl && progressMainEl.parentNode) {
    progressStageEl = document.createElement("div");
    progressStageEl.id = "stitchProgressStage";
    progressStageEl.style.textAlign = "center";
    progressStageEl.style.fontWeight = "600";
    progressStageEl.style.margin = "6px 0 2px";
    progressStageEl.style.fontSize = "12px";
    progressStageEl.style.userSelect = "none";
    progressMainEl.parentNode.insertBefore(progressStageEl, progressMainEl);
  }

  const STAGES_TOTAL = 2;
  let stageIndex = 1;

  const resetProgressUiState = () => {
    if (progressBarEl) {
      progressBarEl.style.width = "0%";
      progressBarEl.style.display = "";
      if (progressBarEl.parentElement) progressBarEl.parentElement.style.display = "";
    }
    if (progressStageEl) {
      progressStageEl.style.display = "";
      progressStageEl.style.color = "";
      progressStageEl.style.fontWeight = "600";
      progressStageEl.textContent = "";
    }
    if (progressMainEl) {
      progressMainEl.style.color = "";
      progressMainEl.style.fontWeight = "";
      progressMainEl.textContent = "";
    }
    if (progressEtaEl) {
      progressEtaEl.style.color = "";
      progressEtaEl.textContent = "";
    }
  };

  const showFailedProgressState = (message) => {
    if (progressBarEl) {
      progressBarEl.style.width = "0%";
      progressBarEl.style.display = "none";
      if (progressBarEl.parentElement) progressBarEl.parentElement.style.display = "none";
    }
    if (progressStageEl) {
      progressStageEl.style.display = "";
      progressStageEl.style.color = FAILURE_UI_COLOR;
      progressStageEl.style.fontWeight = "700";
      progressStageEl.textContent = "Fail";
    }
    if (progressMainEl) {
      progressMainEl.style.color = FAILURE_UI_COLOR;
      progressMainEl.style.fontWeight = "700";
      progressMainEl.textContent = message || "Fail";
    }
    if (progressEtaEl) {
      progressEtaEl.style.color = FAILURE_UI_COLOR;
      progressEtaEl.textContent = "";
    }
  };

  const setStage = (idx) => {
    stageIndex = Math.max(1, Math.min(STAGES_TOTAL, idx));
    if (progressStageEl) progressStageEl.textContent = `Stage ${stageIndex}/${STAGES_TOTAL}`;
  };

  const setProgress = (done, total, labelOverride, displayDone, displayTotal) => {
    if (total > 0 && progressBarEl) {
      const frac = done / total;
      progressBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
    }
    if (!progressMainEl) return;
    const label = labelOverride !== undefined ? String(labelOverride) : "Creating";
    const showDisplayCounts = Number.isFinite(displayTotal) && displayTotal > 0 && Number.isFinite(displayDone);
    if (total > 0) {
      const shownDone = showDisplayCounts ? displayDone : done;
      const shownTotal = showDisplayCounts ? displayTotal : total;
      progressMainEl.textContent = `${label} ${shownDone} / ${shownTotal}`;
      return;
    }
    progressMainEl.textContent = labelOverride !== undefined ? label : "";
  };

  const setEtaText = (ms) => {
    if (!progressEtaEl) return;
    if (ms == null || !Number.isFinite(ms) || ms < 0) {
      progressEtaEl.textContent = "";
      return;
    }
    const totalSeconds = Math.round(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    const secsStr = secs.toString().padStart(2, "0");
    progressEtaEl.textContent = mins ? `${mins}m ${secsStr}s left` : `${secsStr}s left`;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const form = document.getElementById("stitch-form");
    if (!form) return;

    const imagesPerRow = Number(form.stitchImagesPerRow.value) || 1;
    const startCorner = form.stitchStartCorner.value;
    const skipMissingTiles = form.stitchSkipMissing.checked;
    const input = document.getElementById("stitchFolderInput");
    const files = input ? input.files : null;

    if (!files || !files.length) {
      await notifyError("Select one or more image files");
      return;
    }
    if (imagesPerRow < 1) {
      await notifyError("Rows must be greater than 0");
      return;
    }

    if (stitchButton) stitchButton.disabled = true;
    resetProgressUiState();
    setProgress(0, 0, "");
    setEtaText(null);

    const filesArray = Array.from(files);
    setStage(1);
    const PREP_EXTRA_STEPS = 4;
    const prepTotalSteps = filesArray.length + PREP_EXTRA_STEPS;

    let viewCenterX = 0;
    let viewCenterY = 0;
    try {
      const viewport = await board.viewport.get();
      viewCenterX = viewport.x + viewport.width / 2;
      viewCenterY = viewport.y + viewport.height / 2;
    } catch (e) {
      console.warn("Stitch/Slice: could not get viewport, fallback to 0,0", e);
    }

    const fileInfos = [];
    let anySliced = false;
    const hugeInitFailures = [];

    setProgress(0, prepTotalSteps, "Preparing files…", 0, filesArray.length);

    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];
      setProgress(i + 1, prepTotalSteps, "Preparing files…", i + 1, filesArray.length);
      await sleep(0);

      let imgEl;
      try {
        imgEl = await decodeImageFromFile(file);
      } catch (e) {
        console.error("Stitch/Slice: browser failed to decode image", file.name, e);
        await notifyError("Cannot decode image", { fileName: file.name, error: e });
        continue;
      }

      const width = imgEl.naturalWidth || imgEl.width;
      const height = imgEl.naturalHeight || imgEl.height;
      if (!width || !height) {
        await notifyError("Invalid image size", { fileName: file.name, width, height });
        try { imgEl.src = ""; } catch (_) {}
        continue;
      }

      if (width > MAX_SLICE_DIM || height > MAX_SLICE_DIM) {
        console.warn("Stitch/Slice: image exceeds MAX_TEXTURE_SIZE hint", {
          fileName: file.name,
          width,
          height,
          maxTextureSize: MAX_SLICE_DIM,
        });
      }

      let brightness = 0.5;
      let saturation = 0.0;
      try {
        const res = getBrightnessAndSaturationFromImageElement(imgEl);
        if (res) {
          brightness = res.brightness;
          saturation = res.saturation;
        }
      } catch (e) {
        console.warn("Stitch/Slice: brightness/saturation calc failed for", file.name, e);
      }

      const briCode = Math.max(0, Math.min(999, Math.round((1 - brightness) * 999)));
      const satCode = Math.max(0, Math.min(SAT_CODE_MAX, Math.round(Math.min(1, saturation * SAT_BOOST) * SAT_CODE_MAX)));
      const needsSlice = width > SLICE_THRESHOLD_WIDTH || height > SLICE_THRESHOLD_HEIGHT;
      if (needsSlice) anySliced = true;

      let previewTilesX = 1;
      let previewTilesY = 1;
      let previewNumTiles = 1;
      if (needsSlice) {
        previewTilesX = Math.ceil(width / SLICE_TILE_SIZE);
        previewTilesY = Math.ceil(height / SLICE_TILE_SIZE);
        previewNumTiles = previewTilesX * previewTilesY;
      }

      const useHugeWorker = needsSlice && (
        width > LARGE_IMAGE_WORKER_MIN_DIM ||
        height > LARGE_IMAGE_WORKER_MIN_DIM ||
        previewNumTiles >= LARGE_IMAGE_WORKER_MIN_TILES
      );
      const sliceTileSize = useHugeWorker ? HUGE_SLICE_TILE_SIZE : SLICE_TILE_SIZE;
      const tilesX = needsSlice ? Math.ceil(width / sliceTileSize) : 1;
      const tilesY = needsSlice ? Math.ceil(height / sliceTileSize) : 1;
      const numTiles = tilesX * tilesY;

      if (useHugeWorker) {
        try {
          const sessionMeta = await hugeManager.openFile(file);
          console.log("[Image Align Tool] huge mode init", {
            fileName: file.name,
            width,
            height,
            workerWidth: sessionMeta.width,
            workerHeight: sessionMeta.height,
            tilesX,
            tilesY,
            sliceTileSize,
          });
        } catch (e) {
          hugeInitFailures.push({ fileName: file.name, width, height, error: e && e.message ? e.message : String(e) });
          console.error("[Image Align Tool] huge mode init failed", { fileName: file.name, error: e });
          try { imgEl.src = ""; } catch (_) {}
          continue;
        }
      }

      try { imgEl.src = ""; } catch (_) {}
      fileInfos.push({
        file,
        width,
        height,
        briCode,
        satCode,
        needsSlice,
        useHugeWorker,
        tilesX,
        tilesY,
        numTiles,
        sliceTileSize,
      });
    }

    let prepDone = filesArray.length;

    if (!fileInfos.length) {
      if (hugeInitFailures.length > 0) {
        showFailedProgressState("Huge mode init failed");
        await notifyWarning(HUGE_INIT_FAILURE_MESSAGE, { failedFiles: hugeInitFailures });
        return;
      }
      setProgress(0, 0, "Nothing to import.");
      setEtaText(null);
      return;
    }

    if (hugeInitFailures.length > 0) {
      await notifyWarning(
        hugeInitFailures.length === 1 ? HUGE_INIT_FAILURE_MESSAGE : "Some huge files failed",
        { failedFiles: hugeInitFailures }
      );
    }

    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (sorting)", filesArray.length, filesArray.length);
    await sleep(0);

    const orderedFiles = sortFilesByNameWithNumber(filesArray);
    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (indexing)", filesArray.length, filesArray.length);
    await sleep(0);

    const infoByFile = new Map();
    fileInfos.forEach((info) => infoByFile.set(info.file, info));
    const orderedInfos = orderedFiles.map((f) => infoByFile.get(f)).filter(Boolean);

    if (!orderedInfos.length) {
      setProgress(0, 0, "Nothing to import.");
      return;
    }

    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (counting tiles)", filesArray.length, filesArray.length);
    await sleep(0);

    let totalTiles = orderedInfos.reduce((sum, info) => sum + (info.needsSlice ? info.numTiles : 1), 0);
    if (anySliced && skipMissingTiles) {
      await notifyInfo("Skip missing tiles ignored");
    }

    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (layout)", filesArray.length, filesArray.length);
    await sleep(0);

    let slotCentersByFile = null;
    let slotCentersArray = null;
    const hasAnyNumber = orderedInfos.some((info) => extractTrailingNumber(info.file.name || "") !== null);
    if (!anySliced && skipMissingTiles && hasAnyNumber) {
      const tileInfos = [];
      let maxNum = -Infinity;
      for (const info of orderedInfos) {
        const num = extractTrailingNumber(info.file.name || "");
        if (num === null) continue;
        tileInfos.push({ info, num });
        if (num > maxNum) maxNum = num;
      }
      if (!tileInfos.length) {
        slotCentersArray = computeVariableSlotCenters(orderedInfos, imagesPerRow, startCorner, viewCenterX, viewCenterY);
      } else {
        let current = maxNum;
        for (const info of orderedInfos) {
          const already = tileInfos.find((t) => t.info.file === info.file);
          if (!already) tileInfos.push({ info, num: ++current });
        }
        slotCentersByFile = computeSkipMissingSlotCenters(tileInfos, imagesPerRow, startCorner, viewCenterX, viewCenterY);
      }
    } else {
      slotCentersArray = computeVariableSlotCenters(orderedInfos, imagesPerRow, startCorner, viewCenterX, viewCenterY);
    }

    const allCreatedTiles = [];
    let createdTiles = 0;
    let settledTiles = 0;
    let skippedTiles = 0;
    const failedHugeFiles = new Map();
    const failedSourceFiles = new Map();

    const recordFailedSourceFile = (fileName, reason, details) => {
      const key = fileName || "image";
      if (!failedSourceFiles.has(key)) {
        failedSourceFiles.set(key, { fileName: key, reason: reason || "import-failed", details: details || null });
      }
      console.warn("[Image Align Tool] source file failed", { fileName: key, reason, details });
    };

    const markJobSettled = (job, status, details) => {
      if (job && job.__settled) return;
      if (job) job.__settled = true;
      settledTiles += 1;
      if (status === "skipped") skippedTiles += 1;
      if (details) {
        console.log("[Image Align Tool] job settled", {
          status,
          title: job && job.title ? job.title : null,
          fileName: job && job.file ? job.file.name : null,
          details,
        });
      }
      setProgress(settledTiles, totalTiles, "Uploading to board…");
    };

    const markHugeFileFailed = async (file, error, job) => {
      if (!file || failedHugeFiles.has(file)) return;
      const failedFileName = (job && job.file && job.file.name) || (file && file.name) || "image";
      const failedMessage = error && error.message ? error.message : String(error || "huge file failed");
      failedHugeFiles.set(file, { fileName: failedFileName, message: failedMessage });
      recordFailedSourceFile(failedFileName, "huge-file-failed", failedMessage);
      console.warn("[Image Align Tool] huge file failed; skipping remaining tiles", { fileName: failedFileName, error });
      await hugeManager.closeFile(file);
    };

    setStage(2);
    setProgress(0, totalTiles, "Uploading to board…");

    const createImageWithRetry = async (params, maxRetries = CREATE_IMAGE_MAX_RETRIES) => {
      let attempt = 0;
      let lastErr = null;
      const tStart = performance.now();
      while (attempt <= maxRetries) {
        try {
          const res = await board.createImage(params);
          const dt = performance.now() - tStart;
          createImageWallTimesMs.push(dt);
          createImageWallTimeSumMs += dt;
          createImageWallTimeCount += 1;
          return res;
        } catch (e) {
          lastErr = e;
          attempt += 1;
          uploadRetryEvents += 1;
          if (attempt > maxRetries) break;
          const base = CREATE_IMAGE_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 250;
          await sleep(base + jitter);
        }
      }
      throw lastErr;
    };

    const runWithConcurrency = async (items, workerFn, concurrency) => {
      let cursor = 0;
      const runners = new Array(concurrency).fill(0).map(async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) break;
          await workerFn(items[i], i);
        }
      });
      await Promise.all(runners);
    };

    const tileJobs = [];
    const remainingJobsByFile = new Map();
    const originalNameByFile = new Map();

    const registerJobForFile = (file) => {
      remainingJobsByFile.set(file, (remainingJobsByFile.get(file) || 0) + 1);
    };

    const getFileCenter = (info, fileIndex) => {
      if (slotCentersByFile) return slotCentersByFile.get(info.file) || { x: viewCenterX, y: viewCenterY };
      if (slotCentersArray) return slotCentersArray[fileIndex] || { x: viewCenterX, y: viewCenterY };
      return { x: viewCenterX, y: viewCenterY };
    };

    for (let i = 0; i < orderedInfos.length; i++) {
      const info = orderedInfos[i];
      const { file, needsSlice, width, height, tilesX, tilesY, sliceTileSize } = info;
      const center = getFileCenter(info, i);
      const originalName = file.name || "image";
      originalNameByFile.set(file, originalName);

      if (!needsSlice) {
        registerJobForFile(file);
        tileJobs.push({ kind: "full", file, info, x: center.x, y: center.y, width, height });
        continue;
      }

      const nameMatch = originalName.match(/^(.*?)(\.[^.]*$|$)/);
      const baseName = nameMatch ? nameMatch[1] : originalName;
      const originalExt = nameMatch && nameMatch[2] ? nameMatch[2] : "";
      const colWidths = [];
      const rowHeights = [];
      for (let tx = 0; tx < tilesX; tx++) colWidths.push(Math.min(sliceTileSize, width - tx * sliceTileSize));
      for (let ty = 0; ty < tilesY; ty++) rowHeights.push(Math.min(sliceTileSize, height - ty * sliceTileSize));

      const mosaicW = colWidths.reduce((sum, w) => sum + w, 0);
      const mosaicH = rowHeights.reduce((sum, h) => sum + h, 0);
      const mosaicLeft = center.x - mosaicW / 2;
      const mosaicTop = center.y - mosaicH / 2;

      const colPrefix = [0];
      for (let tx = 1; tx < tilesX; tx++) colPrefix[tx] = colPrefix[tx - 1] + colWidths[tx - 1];
      const rowPrefix = [0];
      for (let ty = 1; ty < tilesY; ty++) rowPrefix[ty] = rowPrefix[ty - 1] + rowHeights[ty - 1];

      let tileIndex = 0;
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          tileIndex += 1;
          const sw = colWidths[tx];
          const sh = rowHeights[ty];
          const sx = tx * sliceTileSize;
          const sy = ty * sliceTileSize;
          const tileLeft = mosaicLeft + colPrefix[tx];
          const tileTop = mosaicTop + rowPrefix[ty];
          const centerX = tileLeft + sw / 2;
          const centerY = tileTop + sh / 2;
          const tileSuffix = String(tileIndex).padStart(2, "0");
          const tileBaseName = `${baseName}_${tileSuffix}`;
          const tileFullName = originalExt ? `${tileBaseName}${originalExt}` : tileBaseName;
          const title = `C${String(info.satCode).padStart(2, "0")}/${String(info.briCode).padStart(3, "0")} ${tileFullName}`;
          registerJobForFile(file);
          tileJobs.push({
            kind: "tile",
            file,
            info,
            x: centerX,
            y: centerY,
            sx,
            sy,
            sw,
            sh,
            tileIndex,
            tilesX,
            tilesY,
            title,
          });
        }
      }
    }

    const imageCache = new Map();
    const getDecodedImage = async (file) => {
      const cached = imageCache.get(file);
      if (cached) return cached;
      const imgPromise = decodeImageFromFile(file);
      imageCache.set(file, imgPromise);
      return imgPromise;
    };

    const releaseImageIfDone = async (file, useHugeWorker) => {
      const left = (remainingJobsByFile.get(file) || 0) - 1;
      if (left <= 0) {
        remainingJobsByFile.delete(file);
        if (useHugeWorker) {
          await hugeManager.closeFile(file);
        }
        const cached = imageCache.get(file);
        if (cached) {
          cached.then((imgEl) => { try { imgEl.src = ""; } catch (_) {} }).catch(() => {});
          imageCache.delete(file);
        }
        return;
      }
      remainingJobsByFile.set(file, left);
    };

    const uploadRegularRegionWithSubslice = async (job, imgEl, region, uploadOne) => {
      const canvas = document.createElement("canvas");
      canvas.width = region.w;
      canvas.height = region.h;
      const ctx = get2dContextSrgb(canvas);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, region.w, region.h);
      ctx.drawImage(imgEl, region.sx, region.sy, region.sw, region.sh, 0, 0, region.w, region.h);
      try {
        const url = canvasToDataUrlUnderLimit(canvas);
        await uploadOne(url, region.left + region.w / 2, region.top + region.h / 2, region.titleBase, region.metaBase, url.length);
      } catch (e) {
        if (!(e && e.name === "DataUrlTooLargeError")) throw e;
        const minSub = 512;
        if (region.w <= minSub || region.h <= minSub) throw e;
        const w2 = Math.ceil(region.w / 2);
        const h2 = Math.ceil(region.h / 2);
        const wR = region.w - w2;
        const hB = region.h - h2;
        const sw2 = Math.ceil(region.sw / 2);
        const sh2 = Math.ceil(region.sh / 2);
        const swR = region.sw - sw2;
        const shB = region.sh - sh2;
        totalTiles += 3;
        setProgress(settledTiles, totalTiles, "Uploading to board…");
        const nextDepth = (region.depth || 0) + 1;
        const base = region.titleBase;
        const mkMeta = (subRow, subCol) => ({
          ...region.metaBase,
          subSlice: true,
          subDepth: nextDepth,
          subRow,
          subCol,
          subW: region.w,
          subH: region.h,
        });
        const parts = [
          { sx: region.sx, sy: region.sy, sw: sw2, sh: sh2, left: region.left, top: region.top, w: w2, h: h2, titleBase: `${base} s${nextDepth}a`, metaBase: mkMeta(0, 0), depth: nextDepth },
          { sx: region.sx + sw2, sy: region.sy, sw: swR, sh: sh2, left: region.left + w2, top: region.top, w: wR, h: h2, titleBase: `${base} s${nextDepth}b`, metaBase: mkMeta(0, 1), depth: nextDepth },
          { sx: region.sx, sy: region.sy + sh2, sw: sw2, sh: shB, left: region.left, top: region.top + h2, w: w2, h: hB, titleBase: `${base} s${nextDepth}c`, metaBase: mkMeta(1, 0), depth: nextDepth },
          { sx: region.sx + sw2, sy: region.sy + sh2, sw: swR, sh: shB, left: region.left + w2, top: region.top + h2, w: wR, h: hB, titleBase: `${base} s${nextDepth}d`, metaBase: mkMeta(1, 1), depth: nextDepth },
        ];
        for (const part of parts) {
          await uploadRegularRegionWithSubslice(job, imgEl, part, uploadOne);
        }
      }
    };

    const processOneJob = async (job) => {
      if (job.__settled) return;
      const { file, info } = job;
      const fileName = originalNameByFile.get(file) || "image";
      const useHugeWorker = !!(info && info.useHugeWorker);
      if (useHugeWorker && failedHugeFiles.has(file)) {
        markJobSettled(job, "skipped", { reason: "file-already-failed" });
        await releaseImageIfDone(file, useHugeWorker);
        return;
      }

      const uploadOne = async (url, x, y, title, meta, byteCount, maxRetries) => {
        const imgWidget = await createImageWithRetry({ url, x, y, title }, maxRetries);
        try {
          await imgWidget.setMetadata(META_APP_ID, meta);
        } catch (e) {
          console.warn("setMetadata failed:", e);
        }
        allCreatedTiles.push(imgWidget);
        uploadedBytesDone += byteCount || 0;
        createdTiles += 1;
        markJobSettled(job, "created");
      };

      try {
        if (useHugeWorker) {
          const { width, height, buffer } = await hugeManager.renderTile(file, job.sx, job.sy, job.sw, job.sh);
          const blob = await rgbaBufferToPngBlob(buffer, width, height);
          const url = URL.createObjectURL(blob);
          try {
            await uploadOne(
              url,
              job.x,
              job.y,
              job.title,
              {
                fileName,
                satCode: info.satCode,
                briCode: info.briCode,
                tileIndex: job.tileIndex,
                tilesX: job.tilesX,
                tilesY: job.tilesY,
                hugeMode: true,
                tileMime: HUGE_TILE_MIME,
              },
              blob.size,
              1
            );
          } finally {
            URL.revokeObjectURL(url);
          }
          return;
        }

        const imgEl = await getDecodedImage(file);
        if (job.kind === "full") {
          const titleBase = `C${String(info.satCode).padStart(2, "0")}/${String(info.briCode).padStart(3, "0")} ${fileName}`;
          const left = job.x - job.width / 2;
          const top = job.y - job.height / 2;
          await uploadRegularRegionWithSubslice(job, imgEl, {
            sx: 0,
            sy: 0,
            sw: job.width,
            sh: job.height,
            left,
            top,
            w: job.width,
            h: job.height,
            titleBase,
            metaBase: { fileName, satCode: info.satCode, briCode: info.briCode },
            depth: 0,
          }, uploadOne);
        } else {
          const left = job.x - job.sw / 2;
          const top = job.y - job.sh / 2;
          await uploadRegularRegionWithSubslice(job, imgEl, {
            sx: job.sx,
            sy: job.sy,
            sw: job.sw,
            sh: job.sh,
            left,
            top,
            w: job.sw,
            h: job.sh,
            titleBase: job.title,
            metaBase: {
              fileName,
              satCode: info.satCode,
              briCode: info.briCode,
              tileIndex: job.tileIndex,
              tilesX: job.tilesX,
              tilesY: job.tilesY,
            },
            depth: 0,
          }, uploadOne);
        }
      } catch (e) {
        if (useHugeWorker) {
          await markHugeFileFailed(file, new FatalHugeFileError(file, fileName, e), job);
          markJobSettled(job, "skipped", { reason: "huge-file-failed" });
          return;
        }
        throw e;
      } finally {
        if (job.__settled || failedHugeFiles.has(file)) {
          await releaseImageIfDone(file, useHugeWorker);
        }
      }
    };

    const regularTileJobs = tileJobs.filter((job) => !(job.info && job.info.useHugeWorker));
    const hugeTileJobs = tileJobs.filter((job) => !!(job.info && job.info.useHugeWorker));

    if (regularTileJobs.length) {
      await runWithConcurrency(regularTileJobs, async (job) => processOneJob(job), UPLOAD_CONCURRENCY_NORMAL);
    }
    if (hugeTileJobs.length) {
      await runWithConcurrency(hugeTileJobs, async (job) => processOneJob(job), UPLOAD_CONCURRENCY_HUGE);
    }

    setProgress(totalTiles, totalTiles, "Uploading to board…");
    setEtaText(null);

    if (allCreatedTiles.length) {
      try {
        await board.viewport.zoomTo(allCreatedTiles);
      } catch (e) {
        console.warn("zoomTo failed in Stitch/Slice:", e);
      }
    }

    const totalMB = uploadedBytesDone / 1_000_000;
    const avgMBPerTile = createdTiles ? totalMB / createdTiles : 0;
    const avgCreateMs = createImageWallTimeCount ? Math.round(createImageWallTimeSumMs / createImageWallTimeCount) : null;
    console.groupCollapsed("[Image Align Tool] Import stats");
    console.log("Files (sources):", fileInfos.length);
    console.log("Tiles:", { total: totalTiles, created: createdTiles, settled: settledTiles, skipped: skippedTiles });
    console.log("Upload:", { totalMB: Math.round(totalMB * 10) / 10, avgMBPerTile: Math.round(avgMBPerTile * 100) / 100, retries: uploadRetryEvents, avgCreateMs });
    if (failedSourceFiles.size) console.table(Array.from(failedSourceFiles.values()));
    console.groupEnd();

    const failedFileCount = failedSourceFiles.size;
    const skippedCount = skippedTiles;
    if (createdTiles <= 0 && failedFileCount > 0) {
      await notifyError(`Failed to import ${failedFileCount} file${failedFileCount === 1 ? "" : "s"}`, {
        failedFiles: Array.from(failedSourceFiles.values()),
        totalTiles,
        skippedCount,
      });
    } else if (failedFileCount > 0) {
      await notifyWarning(`Failed to import ${failedFileCount} file${failedFileCount === 1 ? "" : "s"}`, {
        failedFiles: Array.from(failedSourceFiles.values()),
        totalTiles,
        skippedCount,
      });
    } else if (skippedCount > 0) {
      await notifyWarning("Import completed with skipped tiles", { importedSources: fileInfos.length, totalTiles, skippedCount });
    } else {
      await notifyInfo(`Imported ${fileInfos.length} image${fileInfos.length === 1 ? "" : "s"}`, { importedSources: fileInfos.length, totalTiles });
    }
  } catch (err) {
    console.error(err);
    showFailedProgressState("Import failed");
    await notifyError("Image import failed", err);
  } finally {
    try {
      await hugeManager.disposeAll();
    } catch (_) {}
    if (stitchButton) stitchButton.disabled = false;
  }
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
