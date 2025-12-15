// app.js
// Image Align Tool_16: Sorting + Stitch/Slice
// Based on Image Align Tool_14: start concurrency always 4 (removed 128-tile threshold).

const { board } = window.miro;

// ---- color / slice settings ----
const SAT_CODE_MAX = 99;
const SAT_BOOST = 4.0;
const SAT_GROUP_THRESHOLD = 35;      // <= серые, > цветные
const SLICE_TILE_SIZE = 4096;
const SLICE_THRESHOLD_WIDTH = 8192;
const SLICE_THRESHOLD_HEIGHT = 4096;
let   MAX_SLICE_DIM = 16384;         // уточняем через WebGL
const MAX_URL_BYTES = 29000000;      // лимит размера dataURL (~29 МБ, есть запас до 30 МБ)
const TARGET_URL_BYTES = 4500000;   // целевой размер dataURL (~4.5 МБ на тайл/изображение)
const CREATE_IMAGE_MAX_RETRIES = 5;
const CREATE_IMAGE_BASE_DELAY_MS = 500;
const UPLOAD_CONCURRENCY_SMALL = 3;
const UPLOAD_CONCURRENCY_LARGE = 4;

const UPLOAD_CONCURRENCY_MIN = 2;
const UPLOAD_CONCURRENCY_MAX = 5;
const UPLOAD_CONCURRENCY_INITIAL_LARGE = 4;
const META_APP_ID = "image-align-tool";

// ---------- авто-детект лимита по стороне через WebGL ----------

function detectMaxSliceDim() {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");

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

// ---------- helpers: titles & numbers ----------

function getTitle(item) {
  return (item.title || "").toString();
}

function extractTrailingNumber(str) {
  const match = str.match(/(\d+)(?!.*\d)/);
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

// ---------- helpers: image loading & brightness ----------

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Возвращает яркость и "сырую" сатурацию по ROI:
 *   - уменьшаем до smallSize
 *   - блюрим (blurPx)
 *   - обрезаем верх и боковые поля
 */
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

  const avgY = sumY / totalPixels;
  const avgDiff = sumDiff / totalPixels;

  const brightness = avgY / 255;
  const saturationApprox = avgDiff / 255;

  return { brightness, saturation: saturationApprox };
}

// ---------- alignment (Sorting) ----------

async function alignImagesInGivenOrder(images, config) {
  const {
    imagesPerRow,
    horizontalGap,
    verticalGap,
    sizeMode,
    startCorner,
  } = config;

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
  const gridHeight =
    rowHeights.reduce((sum, h) => sum + h, 0) +
    verticalGap * Math.max(0, rows - 1);

  const rowTop = new Array(rows).fill(0);
  for (let r = 1; r < rows; r++) {
    rowTop[r] = rowTop[r - 1] + rowHeights[r - 1] + verticalGap;
  }

  const baseX = new Array(total).fill(0);
  const baseY = new Array(total).fill(0);
  const rowCursorX = new Array(rows).fill(0);

  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const img = images[i];

    const centerY = rowTop[r] + rowHeights[r] / 2;
    const centerX = rowCursorX[r] + img.width / 2;

    baseX[i] = centerX;
    baseY[i] = centerY;

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

  let originLeft;
  let originTop;
  let flipX = false;
  let flipY = false;

  switch (startCorner) {
    case "top-left":
      originLeft = minLeft;
      originTop = minTop;
      break;
    case "top-right":
      originLeft = maxRight - gridWidth;
      originTop = minTop;
      flipX = true;
      break;
    case "bottom-left":
      originLeft = minLeft;
      originTop = maxBottom - gridHeight;
      flipY = true;
      break;
    case "bottom-right":
      originLeft = maxRight - gridWidth;
      originTop = maxBottom - gridHeight;
      flipX = true;
      flipY = true;
      break;
    default:
      originLeft = minLeft;
      originTop = minTop;
  }

  for (let i = 0; i < total; i++) {
    let x0 = baseX[i];
    let y0 = baseY[i];

    if (flipX) x0 = gridWidth - x0;
    if (flipY) y0 = gridHeight - y0;

    const img = images[i];
    img.x = originLeft + x0;
    img.y = originTop + y0;
  }

  await Promise.all(images.map((img) => img.sync()));
}

// ---------- SORTING: by number ----------

async function sortImagesByNumber(images) {
  const hasAnyEmptyTitle = images.some((img) => !getTitle(img));

  if (hasAnyEmptyTitle) {
    const geoOrder = sortByGeometry(images);
    let counter = 1;
    for (const img of geoOrder) {
      img.title = String(counter);
      counter++;
    }
    await Promise.all(geoOrder.map((img) => img.sync()));
    images = geoOrder;
  }

  const meta = images.map((img, index) => {
    const title = getTitle(img);
    const lower = title.toLowerCase();
    const num = extractTrailingNumber(title);
    const hasNumber = num !== null;
    return { img, index, title, lower, hasNumber, num };
  });

  console.groupCollapsed("Sorting (number) – titles & numbers");
  meta.forEach((m) => console.log(m.title || m.img.id, "=>", m.num));
  console.groupEnd();

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

// ---------- SORTING: by color (по Cxx/yyy в title) ----------

async function sortImagesByColor(images) {
  const meta = images.map((img, index) => {
    const title = getTitle(img);
    const match = title.match(/^C(\d{2})\/(\d{3})\s+/);

    if (!match) {
      return {
        img,
        index,
        title,
        hasCode: false,
        group: 1,
        satCode: null,
        briCode: null,
      };
    }

    const satCode = Number.parseInt(match[1], 10);
    const briCode = Number.parseInt(match[2], 10);
    const group = satCode <= SAT_GROUP_THRESHOLD ? 0 : 1;

    return {
      img,
      index,
      title,
      hasCode: true,
      satCode,
      briCode,
      group,
    };
  });

  const anyCode = meta.some((m) => m.hasCode);
  if (!anyCode) {
    console.warn(
      "No color codes found in titles; falling back to geometry sort."
    );
    return sortByGeometry(images);
  }

  console.groupCollapsed("Sorting (color) – titles, sat & bri");
  meta.forEach((m) => {
    console.log(
      m.title || m.img.id,
      "=>",
      m.hasCode
        ? `group=${m.group}, sat=${m.satCode}, bri=${m.briCode}`
        : "no-code"
    );
  });
  console.groupEnd();

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

// ---------- SORTING handler ----------

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
    let images = selection.filter((i) => i.type === "image");

    if (!images.length) {
      await board.notifications.showInfo(
        "Select at least one image on the board."
      );
      return;
    }

    if (imagesPerRow < 1) {
      await board.notifications.showError("“Rows” must be greater than 0.");
      return;
    }

    let orderedImages;

    if (sortMode === "color") {
      await board.notifications.showInfo("Sorting by color…");
      orderedImages = await sortImagesByColor(images);
    } else if (sortMode === "size") {
      await board.notifications.showInfo("Sorting by size…");
      orderedImages = sortImagesBySize(images, { sizeMode, sizeOrder });
    } else {
      orderedImages = await sortImagesByNumber(images);
    }

    await alignImagesInGivenOrder(orderedImages, {
      imagesPerRow,
      horizontalGap,
      verticalGap,
      sizeMode,
      startCorner,
    });

    await board.notifications.showInfo(
      `Done: aligned ${orderedImages.length} image${
        orderedImages.length === 1 ? "" : "s"
      }.`
    );
  } catch (err) {
    console.error(err);
    await board.notifications.showError(
      "Something went wrong while aligning images. Please check the console."
    );
  }
}


// ---------- SORTING: by size (area) ----------

function sortImagesBySize(images, { sizeMode, sizeOrder }) {
  const order = sizeOrder === "asc" ? 1 : -1;

  // Sort by *effective* area after applying the selected resize mode.
  // If resize is "Match width/height", the key reflects the size you will see after resizing.
  let targetWidth = null;
  let targetHeight = null;

  if (sizeMode === "width") {
    targetWidth = Math.min(...images.map((img) => img.width));
  } else if (sizeMode === "height") {
    targetHeight = Math.min(...images.map((img) => img.height));
  }

  const withKeys = images.map((img, index) => {
    const w0 = img.width || 0;
    const h0 = img.height || 0;

    let w = w0;
    let h = h0;

    // Miro keeps aspect ratio when setting width/height, so we simulate that here.
    if (targetWidth && w0 > 0) {
      const scale = targetWidth / w0;
      w = targetWidth;
      h = h0 * scale;
    } else if (targetHeight && h0 > 0) {
      const scale = targetHeight / h0;
      h = targetHeight;
      w = w0 * scale;
    }

    const area = w * h;

    return { img, index, area, w0, h0 };
  });

  withKeys.sort((a, b) => {
    if (a.area !== b.area) return (a.area - b.area) * order;
    if (a.w0 !== b.w0) return (a.w0 - b.w0) * order;
    if (a.h0 !== b.h0) return (a.h0 - b.h0) * order;
    return a.index - b.index; // stable fallback
  });

  return withKeys.map((x) => x.img);
}

// ---------- STITCH/S SLICE helpers ----------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function sortFilesByNameWithNumber(files) {
  const arr = Array.from(files).map((file, index) => {
    const name = file.name || "";
    const lower = name.toLowerCase();
    const num = extractTrailingNumber(name);
    return {
      file,
      index,
      name,
      lower,
      hasNumber: num !== null,
      num,
    };
  });

  console.groupCollapsed("Stitch/Slice – files & numbers");
  arr.forEach((m) => console.log(m.name, "=>", m.num));
  console.groupEnd();

  const anyHasNumber = arr.some((m) => m.hasNumber);

  if (!anyHasNumber) {
    // если ни у кого нет номера — просто рандомно перемешиваем
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

function canvasToDataUrlUnderLimit(canvas, maxBytes = TARGET_URL_BYTES) {
  // Цель: держать качество около 0.8–0.85 (примерно Photoshop 10–11),
  // но при этом НИКОГДА не пробивать жесткий лимит Miro по размеру dataURL.
  //
  // Алгоритм:
  // 1) Пробуем уложиться в target (maxBytes) качеством 0.85 → 0.82 → 0.80.
  // 2) Если target не достигается при 0.80 — оставляем 0.80 (размер будет больше target, но качество лучше).
  // 3) Если даже так превышаем жесткий лимит MAX_URL_BYTES — тогда уже снижаем качество ниже 0.80,
  //    пока не уложимся в MAX_URL_BYTES (чтобы не было падений/пропусков).

  const hardLimit = MAX_URL_BYTES;
  const target = Math.min(maxBytes, hardLimit);

  const tryQualities = [0.85, 0.82, 0.8];
  for (const q of tryQualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", q);
    if (dataUrl.length <= target) return dataUrl;
  }

  // Не влезли в target при 0.8 — оставляем 0.8 (это сознательный компромисс ради качества).
  let quality = 0.8;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  if (dataUrl.length <= hardLimit) return dataUrl;

  // Крайний случай: даже при 0.8 пробиваем hardLimit — уменьшаем качество, чтобы гарантированно не падать.
  const HARD_MIN_Q = 0.25;
  while (dataUrl.length > hardLimit && quality > HARD_MIN_Q) {
    quality -= 0.05;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  // Последняя страховка
  if (dataUrl.length > hardLimit) {
    dataUrl = canvas.toDataURL("image/jpeg", HARD_MIN_Q);
  }

  return dataUrl;
}


function computeVariableSlotCenters(
  orderedInfos,
  imagesPerRow,
  startCorner,
  viewCenterX,
  viewCenterY
) {
  const totalSlots = orderedInfos.length;
  if (!totalSlots) return [];

  const cols = Math.max(1, imagesPerRow);
  const rows = Math.ceil(totalSlots / cols);
  const horizontalGap = 0;
  const verticalGap = 0;

  const rowHeights = new Array(rows).fill(0);
  const rowWidths = new Array(rows).fill(0);

  for (let i = 0; i < totalSlots; i++) {
    const r = Math.floor(i / cols);
    const info = orderedInfos[i];
    const w = info.width;
    const h = info.height;

    if (h > rowHeights[r]) rowHeights[r] = h;
    if (rowWidths[r] > 0) rowWidths[r] += horizontalGap;
    rowWidths[r] += w;
  }

  const gridWidth = rowWidths.length ? Math.max(...rowWidths) : 0;
  const gridHeight =
    rowHeights.reduce((sum, h) => sum + h, 0) +
    verticalGap * Math.max(0, rows - 1);

  const rowTop = new Array(rows).fill(0);
  for (let r = 1; r < rows; r++) {
    rowTop[r] = rowTop[r - 1] + rowHeights[r - 1] + verticalGap;
  }

  const baseX = new Array(totalSlots).fill(0);
  const baseY = new Array(totalSlots).fill(0);
  const rowCursorX = new Array(rows).fill(0);

  for (let i = 0; i < totalSlots; i++) {
    const r = Math.floor(i / cols);
    const info = orderedInfos[i];
    const w = info.width;

    const centerY = rowTop[r] + rowHeights[r] / 2;
    const centerX = rowCursorX[r] + w / 2;

    baseX[i] = centerX;
    baseY[i] = centerY;

    rowCursorX[r] += w + horizontalGap;
  }

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

  const centers = [];
  for (let i = 0; i < totalSlots; i++) {
    let x0 = baseX[i] - gridWidth / 2;
    let y0 = baseY[i] - gridHeight / 2;

    if (flipX) x0 = -x0;
    if (flipY) y0 = -y0;

    const cx = viewCenterX + x0;
    const cy = viewCenterY + y0;
    centers.push({ x: cx, y: cy });
  }

  return centers;
}

function computeSkipMissingSlotCenters(
  tileInfos,
  imagesPerRow,
  startCorner,
  viewCenterX,
  viewCenterY
) {
  if (!tileInfos.length) return [];

  const nums = tileInfos.map((n) => n.num);
  const minNum = Math.min(...nums);
  const maxNum = Math.max(...nums);

  const cols = Math.max(1, imagesPerRow);
  const cellWidth = tileInfos[0].info.width;
  const cellHeight = tileInfos[0].info.height;

  const totalSlots = maxNum - minNum + 1;
  const rows = Math.ceil(totalSlots / cols);

  const gridWidth = cols * cellWidth;
  const gridHeight = rows * cellHeight;

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

  const centersByFileId = new Map();

  for (const { info, num } of tileInfos) {
    const pos = num - minNum;
    let row = Math.floor(pos / cols);
    let col = pos % cols;

    if (flipX) col = cols - 1 - col;
    if (flipY) row = rows - 1 - row;

    const left = viewCenterX - gridWidth / 2 + col * cellWidth;
    const top = viewCenterY - gridHeight / 2 + row * cellHeight;

    const cx = left + cellWidth / 2;
    const cy = top + cellHeight / 2;

    centersByFileId.set(info.file, { x: cx, y: cy });
  }

  return centersByFileId;
}

// ---------- STITCH/S SLICE handler ----------

async function handleStitchSubmit(event) {
  event.preventDefault();


  // ---- run-level timers & stats (declared early to avoid TDZ across reruns) ----
  var prepStartTs = performance.now();
  var prepEndTs = null;
  var uploadStartTs = null;
  var uploadEndTs = null;
  var uploadRetryEvents = 0;
  var uploadedBytesDone = 0;

  // createImage wall-time (includes retries/backoff)
  var createImageWallTimesMs = [];
  var createImageWallTimeSumMs = 0;
  var createImageWallTimeCount = 0;

  const stitchButton = document.getElementById("stitchButton");
  const progressBarEl = document.getElementById("stitchProgressBar");
  const progressMainEl = document.getElementById("stitchProgressMain");
  const progressEtaEl = document.getElementById("stitchProgressEta");

  // Stage label under the progress bar (inserted dynamically to avoid editing panel.html)
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
  let stageIndex = 1; // 1/2 = Preparing, 2/2 = Uploading

  const setStage = (idx) => {
    stageIndex = Math.max(1, Math.min(STAGES_TOTAL, idx));
    if (progressStageEl) {
      progressStageEl.textContent = `Stage ${stageIndex}/${STAGES_TOTAL}`;
    }
  };

  let setProgress = (done, total, labelOverride, displayDone, displayTotal) => {
  // total === 0 используется для "статусных" сообщений (например, Calculating layout…)
  // В этом случае НЕ трогаем ширину прогресс-бара, чтобы не было скачков.
  if (total > 0 && progressBarEl) {
    const frac = done / total;
    progressBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
  }

  if (!progressMainEl) return;

  const labelRaw = labelOverride !== undefined ? String(labelOverride) : "Creating";
  const label = labelRaw;

  // For some phases (e.g., Preparing), we want the progress bar to use "done/total steps"
  // but the visible counter to stay on "filesDone/filesTotal" to avoid confusion like 260/260 for 256 files.
  const showDisplayCounts =
    Number.isFinite(displayTotal) && displayTotal > 0 && Number.isFinite(displayDone);

  if (total > 0) {
    if (done < total) {
      progressMainEl.textContent = showDisplayCounts ? `${label} ${displayDone} / ${displayTotal}` : `${label} ${done} / ${total}`;
    } else {
      // Не показываем "Done!" после Preparing — это выглядит как будто всё закончилось.
      const keepCounts = labelRaw.startsWith("Preparing") || labelRaw.startsWith("Uploading");
      progressMainEl.textContent = keepCounts ? (showDisplayCounts ? `${label} ${displayDone} / ${displayTotal}` : `${label} ${done} / ${total}`) : "Done!";
    }
    return;
  }

  // total === 0: просто статусная строка
  progressMainEl.textContent = labelOverride !== undefined ? label : "";
};

  let setEtaText = (ms) => {
    if (!progressEtaEl) return;
    if (ms == null || !Number.isFinite(ms) || ms < 0) {
      progressEtaEl.textContent = "";
      return;
    }
    const totalSeconds = Math.round(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    const secsStr = secs.toString().padStart(2, "0");
    const text = mins ? `${mins}m ${secsStr}s left` : `${secsStr}s left`;
    progressEtaEl.textContent = text;
  };


// ---- UI update throttling (avoids excessive DOM reflows on 1000+ tiles) ----
const makeThrottled = (fn, intervalMs = 200) => {
  let lastCall = 0;
  let timer = null;
  let lastArgs = null;

  const throttled = (...args) => {
    lastArgs = args;
    const now = performance.now();
    const elapsed = now - lastCall;

    if (elapsed >= intervalMs) {
      lastCall = now;
      fn(...lastArgs);
      return;
    }

    if (timer) return;

    timer = setTimeout(() => {
      timer = null;
      lastCall = performance.now();
      fn(...lastArgs);
    }, Math.max(0, intervalMs - elapsed));
  };

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      lastCall = performance.now();
      fn(...lastArgs);
    }
  };

  return throttled;
};

// Wrap progress UI updates with throttling (only once per session)
if (!setProgress._throttleWrapped) {
  const _setProgressNow = setProgress;
  const _setEtaTextNow = setEtaText;
  const sp = makeThrottled(_setProgressNow, 200);
  const se = makeThrottled(_setEtaTextNow, 200);
  sp._throttleWrapped = true;
  se._throttleWrapped = true;
  setProgress = sp;
  setEtaText = se;
}
  try {
    prepStartTs = performance.now();

    const form = document.getElementById("stitch-form");
    if (!form) return;

    const imagesPerRow = Number(form.stitchImagesPerRow.value) || 1;
    const startCorner = form.stitchStartCorner.value;
    const skipMissingTiles = form.stitchSkipMissing.checked;

    const input = document.getElementById("stitchFolderInput");
    const files = input ? input.files : null;

    if (!files || !files.length) {
      await board.notifications.showError(
        "Please select one or more image files."
      );
      return;
    }

    if (imagesPerRow < 1) {
      await board.notifications.showError("“Rows” must be greater than 0.");
      return;
    }

    if (stitchButton) stitchButton.disabled = true;
    setProgress(0, 0, "");
    setEtaText(null);
    if (setEtaText.flush) setEtaText.flush();


    const filesArray = Array.from(files);

    // Stage 1/2: preparing (decode + analyze + planning). Мы НЕ храним base64 в памяти.
    setStage(1);
    const PREP_EXTRA_STEPS = 4; // sorting + indexing + tile counting + layout planning
    const prepTotalSteps = filesArray.length + PREP_EXTRA_STEPS;

    // ---- ETA for preparing (Stage 1/2) ----
    let prepLastTs = null;
    let prepLastDone = 0;
    let ewmaPrepRateStepsPerMs = null;
    const PREP_ETA_EWMA_ALPHA = 0.25;

    const startPrepEta = () => {
      prepLastTs = performance.now();

      prepLastDone = 0;
      ewmaPrepRateStepsPerMs = null;
      setEtaText(null);
    };

    const updatePrepEta = (doneSteps, totalSteps) => {
      if (!prepStartTs || !Number.isFinite(totalSteps) || totalSteps <= 0) return;

      const now = performance.now();
      const dt = now - (prepLastTs || now);
      const dd = doneSteps - prepLastDone;

      if (dt < 200 || dd <= 0) return;

      const instRate = dd / dt; // steps per ms
      ewmaPrepRateStepsPerMs =
        ewmaPrepRateStepsPerMs == null
          ? instRate
          : PREP_ETA_EWMA_ALPHA * instRate + (1 - PREP_ETA_EWMA_ALPHA) * ewmaPrepRateStepsPerMs;

      prepLastTs = now;
      prepLastDone = doneSteps;

      const remaining = totalSteps - doneSteps;
      if (remaining <= 0 || !ewmaPrepRateStepsPerMs || ewmaPrepRateStepsPerMs <= 0) {
        setEtaText(null);
        return;
      }
      const etaMs = remaining / ewmaPrepRateStepsPerMs;
      setEtaText(etaMs);
    };

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

        startPrepEta();
setProgress(0, prepTotalSteps, "Preparing files…", 0, filesArray.length);

    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];
      // Обновляем прогресс на этапе подготовки файлов
      setProgress(i + 1, prepTotalSteps, "Preparing files…", i + 1, filesArray.length);
      updatePrepEta(i + 1, prepTotalSteps);
      // Даем браузеру шанс отрисовать прогресс на больших партиях
      await new Promise((r) => setTimeout(r, 0));
// Используем object URL вместо dataURL, чтобы не держать гигантские base64-строки в памяти.
const objectUrl = URL.createObjectURL(file);

let imgEl;
try {
  // Для objectUrl crossOrigin не нужен, но в loadImage он выставлен — это ок.
  imgEl = await loadImage(objectUrl);
        URL.revokeObjectURL(objectUrl);
} catch (e) {
        URL.revokeObjectURL(objectUrl);

        console.error("Stitch/Slice: browser failed to decode image", file.name, e);
        await board.notifications.showError(
          `Cannot import "${file.name}": browser failed to decode the image.`
        );
        continue;
      }

      const width = imgEl.naturalWidth || imgEl.width;
      const height = imgEl.naturalHeight || imgEl.height;

      if (!width || !height) {
        console.error("Stitch/Slice: invalid dimensions", width, height, file.name);
        await board.notifications.showError(
          `Cannot import "${file.name}": image has invalid dimensions.`
        );
        continue;
      }

      if (width > MAX_SLICE_DIM || height > MAX_SLICE_DIM) {
        console.warn(
          `Stitch/Slice: image too large (${width}x${height}), limit is ${MAX_SLICE_DIM}px per side.`
        );
        await board.notifications.showError(
          `Image "${file.name}" is too large (${width}×${height}). ` +
            `Stitch/Slice supports up to ${MAX_SLICE_DIM}px per side on this device. ` +
            `Please downscale or pre-slice it externally.`
        );
        continue;
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
        console.warn(
          "Stitch/Slice: brightness/saturation calc failed for",
          file.name,
          e
        );
      }

      const briCodeRaw = Math.round((1 - brightness) * 999);
      const briCode = Math.max(0, Math.min(999, briCodeRaw));

      const boostedSat = Math.min(1, saturation * SAT_BOOST);
      const satCodeRaw = Math.round(boostedSat * SAT_CODE_MAX);
      const satCode = Math.max(0, Math.min(SAT_CODE_MAX, satCodeRaw));

      const needsSlice =
        width > SLICE_THRESHOLD_WIDTH || height > SLICE_THRESHOLD_HEIGHT;

      if (needsSlice) anySliced = true;

      let tilesX = 1;
      let tilesY = 1;
      let numTiles = 1;
      if (needsSlice) {
        tilesX = Math.ceil(width / SLICE_TILE_SIZE);
        tilesY = Math.ceil(height / SLICE_TILE_SIZE);
        numTiles = tilesX * tilesY;
      }
      // Освобождаем ссылку на декодированное изображение (помогает GC на больших партиях)
      try { imgEl.src = ""; } catch (e) {}


      fileInfos.push({
        file,
        width,
        height,
        briCode,
        satCode,
        needsSlice,
        tilesX,
        tilesY,
        numTiles,
      });
    }

    // Доп. шаги подготовки (раньше здесь было ощущение "простоя")
    let prepDone = filesArray.length;

    if (!fileInfos.length) {
      setProgress(0, 0, "Nothing to import.");
      setEtaText(null);
      return;
    }

    // 1) sorting
    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (sorting)", filesArray.length, filesArray.length);
    updatePrepEta(prepDone, prepTotalSteps);
    await new Promise((r) => setTimeout(r, 0));

    const orderedFiles = sortFilesByNameWithNumber(filesArray);

    // 2) indexing
    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (indexing)", filesArray.length, filesArray.length);
    updatePrepEta(prepDone, prepTotalSteps);
    await new Promise((r) => setTimeout(r, 0));
    const infoByFile = new Map();
    fileInfos.forEach((info) => infoByFile.set(info.file, info));

    const orderedInfos = orderedFiles
      .map((f) => infoByFile.get(f))
      .filter(Boolean);

    if (!orderedInfos.length) {
      setProgress(0, 0, "Nothing to import.");
      setEtaText(null);
      return;
    }

    // 3) tile counting
    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (counting tiles)", filesArray.length, filesArray.length);
    updatePrepEta(prepDone, prepTotalSteps);
    await new Promise((r) => setTimeout(r, 0));

    const totalTiles = orderedInfos.reduce(
      (sum, info) => sum + (info.needsSlice ? info.numTiles : 1),
      0
    );

    if (anySliced && skipMissingTiles) {
      await board.notifications.showInfo(
        '“Skip missing tiles” is ignored for large images (Stitch/Slice).'
      );
    }

    // 4) layout planning (не доводим прогресс до 100% ДО завершения расчётов)
    setProgress(prepDone, prepTotalSteps, "Preparing files… (layout)", filesArray.length, filesArray.length);
    updatePrepEta(prepDone, prepTotalSteps);
    await new Promise((r) => setTimeout(r, 0));

let slotCentersByFile = null;
    let slotCentersArray = null;

    const hasAnyNumber = orderedInfos.some((info) => {
      const name = info.file.name || "";
      return extractTrailingNumber(name) !== null;
    });

    if (!anySliced && skipMissingTiles && hasAnyNumber) {
      const tileInfos = [];
      let minNum = Infinity;
      let maxNum = -Infinity;

      for (const info of orderedInfos) {
        const name = info.file.name || "";
        const num = extractTrailingNumber(name);
        if (num === null) continue;
        tileInfos.push({ info, num });
        if (num < minNum) minNum = num;
        if (num > maxNum) maxNum = num;
      }

      if (!tileInfos.length) {
        slotCentersArray = computeVariableSlotCenters(
          orderedInfos,
          imagesPerRow,
          startCorner,
          viewCenterX,
          viewCenterY
        );
      } else {
        let current = maxNum;
        for (const info of orderedInfos) {
          const already = tileInfos.find((t) => t.info.file === info.file);
          if (!already) {
            current += 1;
            tileInfos.push({ info, num: current });
          }
        }
        slotCentersByFile = computeSkipMissingSlotCenters(
          tileInfos,
          imagesPerRow,
          startCorner,
          viewCenterX,
          viewCenterY
        );
      }
    } else {
      slotCentersArray = computeVariableSlotCenters(
        orderedInfos,
        imagesPerRow,
        startCorner,
        viewCenterX,
        viewCenterY
      );
    }

    // Завершили layout planning
    prepDone += 1;
    setProgress(prepDone, prepTotalSteps, "Preparing files… (layout)", filesArray.length, filesArray.length);
    updatePrepEta(prepDone, prepTotalSteps);
    await new Promise((r) => setTimeout(r, 0));

    const allCreatedTiles = [];
    let createdTiles = 0;

    // ---- ETA: считаем по фактической пропускной способности (учитывает параллелизм) ----
    // adaptive concurrency diagnostics
    let maxConcurrencySeen = 0;
    const concurrencyDecisions = []; // {idx, conc, mbps, ips, retriesPerTile, msPerTile, action}
    let lastEtaUpdateTs = null;
    let lastEtaCreated = 0;
    let ewmaRateTilesPerMs = null;
    // uploadedBytesDone is declared at the run-level (var) and reused here
    let lastEtaBytesDone = 0;
    let ewmaRateBytesPerMs = null;
    const ETA_EWMA_ALPHA = 0.25;

    const startEta = () => {
      uploadStartTs = performance.now();
      lastEtaUpdateTs = uploadStartTs;
      lastEtaCreated = 0;
      ewmaRateTilesPerMs = null;

      uploadedBytesDone = 0;
      lastEtaBytesDone = 0;
      ewmaRateBytesPerMs = null;
    };

    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");

    const updateCreationProgress = () => {
      setProgress(createdTiles, totalTiles, "Uploading to board…");

      if (!uploadStartTs) {
        setEtaText(null);
        return;
      }

      const remainingTiles = totalTiles - createdTiles;
      if (remainingTiles <= 0) {
        setEtaText(null);
        return;
      }


      const ETA_MIN_SAMPLES = 6;
      if (createdTiles < ETA_MIN_SAMPLES) {
        setEtaText(null);
        return;
      }
      const now = performance.now();
      const dt = now - (lastEtaUpdateTs || now);

      // Обновляем EWMA-рейт не чаще чем раз в ~200мс и только если был прогресс.
      const dc = createdTiles - lastEtaCreated;
      const db = uploadedBytesDone - lastEtaBytesDone;

      if (dt >= 200 && (dc > 0 || db > 0)) {
        if (dc > 0) {
          const instRateTiles = dc / dt; // tiles per ms
          ewmaRateTilesPerMs =
            ewmaRateTilesPerMs == null
              ? instRateTiles
              : ETA_EWMA_ALPHA * instRateTiles + (1 - ETA_EWMA_ALPHA) * ewmaRateTilesPerMs;
        }

        if (db > 0) {
          const instRateBytes = db / dt; // bytes per ms
          ewmaRateBytesPerMs =
            ewmaRateBytesPerMs == null
              ? instRateBytes
              : ETA_EWMA_ALPHA * instRateBytes + (1 - ETA_EWMA_ALPHA) * ewmaRateBytesPerMs;
        }

        lastEtaUpdateTs = now;
        lastEtaCreated = createdTiles;
        lastEtaBytesDone = uploadedBytesDone;
      }

      const elapsed = now - uploadStartTs;
      if (elapsed <= 0) {
        setEtaText(null);
        return;
      }

      // ETA считаем и по байтам, и по количеству тайлов. Берём более "пессимистичную" оценку — так меньше расхождение.
      const avgBytesPerTile = createdTiles > 0 ? (uploadedBytesDone / createdTiles) : null;
      const rateBytes = ewmaRateBytesPerMs && ewmaRateBytesPerMs > 0 ? ewmaRateBytesPerMs : null;

      let etaByBytes = null;
      if (avgBytesPerTile && rateBytes) {
        const remainingBytes = remainingTiles * avgBytesPerTile;
        etaByBytes = remainingBytes / rateBytes;
      }

      // Fallback: по тайлам
      const overallRateTiles = createdTiles > 0 ? createdTiles / elapsed : 0;
      const rateTiles =
        ewmaRateTilesPerMs && ewmaRateTilesPerMs > 0 ? ewmaRateTilesPerMs : overallRateTiles;

      if (!rateTiles || rateTiles <= 0) {
        setEtaText(null);
        return;
      }

      let etaByTiles = null;
      if (rateTiles && rateTiles > 0) {
        etaByTiles = remainingTiles / rateTiles;
      }

      let etaMs = null;
      if (etaByBytes != null && etaByTiles != null) {
        etaMs = Math.max(etaByBytes, etaByTiles);
      } else {
        etaMs = etaByBytes != null ? etaByBytes : etaByTiles;
      }

      setEtaText(etaMs);
    };

    // Stage 2/2: uploading to board
    prepEndTs = performance.now();
    setStage(2);
    startEta();
    setProgress(0, totalTiles, "Uploading to board…");
    setEtaText(null);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Real concurrency metric: how many board.createImage calls are actually in-flight
    let inFlightCreateImage = 0;
    let maxInFlightCreateImage = 0;


    const createImageWithRetry = async (params) => {
  let attempt = 0;
  let lastErr = null;

  const tStart = performance.now();

  while (attempt <= CREATE_IMAGE_MAX_RETRIES) {
    try {
      // Track real in-flight createImage requests (not just "allowed concurrency")
      inFlightCreateImage += 1;
      if (inFlightCreateImage > maxInFlightCreateImage) {
        maxInFlightCreateImage = inFlightCreateImage;
      }

      let res;
      try {
        res = await board.createImage(params);
      } finally {
        inFlightCreateImage -= 1;
      }

      const dt = performance.now() - tStart;
      createImageWallTimesMs.push(dt);
      createImageWallTimeSumMs += dt;
      createImageWallTimeCount += 1;

      return res;
    } catch (e) {
      lastErr = e;
      attempt += 1;
      uploadRetryEvents += 1;

      if (attempt > CREATE_IMAGE_MAX_RETRIES) break;

      const msg = e && e.message ? e.message : String(e);
      const isStackOverflow = msg.includes("Maximum call stack size exceeded");
      const baseDelay = isStackOverflow
        ? Math.max(1500, CREATE_IMAGE_BASE_DELAY_MS)
        : CREATE_IMAGE_BASE_DELAY_MS;

      const base = baseDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 250;
      await sleep(base + jitter);
    }
  }

  throw lastErr;
};


    const runWithConcurrency = async (items, worker, concurrency) => {
      let cursor = 0;

      const runners = new Array(concurrency).fill(0).map(async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) break;
          await worker(items[i], i);
        }
      });

      await Promise.all(runners);
    };



const runWithAdaptiveConcurrency = async (
  items,
  worker,
  initialConcurrency,
  minConcurrency,
  maxConcurrency
) => {
  // Adaptive concurrency by tile-jobs (1 job = 1 createImage).
  //
  // Key differences vs file-based:
  // - Real responsiveness (we can react within tens of tiles, not per whole-file).
  // - Enables a safe one-time "forced probe" at conc=5 on big imports.
  //
  // Notes:
  // - Concurrency here is "how many jobs run in parallel".
  // - Real in-flight createImage is tracked separately in createImageWithRetry.

  let concurrency = Math.max(minConcurrency, Math.min(maxConcurrency, initialConcurrency));
  let lockedMax = maxConcurrency;

  const EWMA_ALPHA = 0.25;
  const GAIN_THRESHOLD = 1.10; // need ~10% throughput gain to justify higher concurrency
  const PROBE_ONLY_IF_TILES_AT_LEAST = 200;

  // One-time forced probe at 5 for big imports (2 windows + tail guard)
  const shouldForcedProbe = items.length >= PROBE_ONLY_IF_TILES_AT_LEAST && maxConcurrency >= 5;
  const probeCfg = shouldForcedProbe
    ? {
        phase: "warmup", // warmup -> baseline -> probe -> done
        done: false,

        baseConc: Math.min(concurrency, 4),
        warmupTiles: 60,

        windowTiles: 20,
        windowsTarget: 2,

        // per-phase windows
        baselineWindows: [], // { mbps, ips, msPerTile, p95WallMs }
        probeWindows: [],

        // accumulators for the current window
        accTiles: 0,
        accBytes: 0,
        accMs: 0,
        accWall: [],

        // decision details (for logging/table)
        lastGain: null,
        lastTailFactor: null,
      }
    : null;

  const resetProbeAcc = () => {
    if (!probeCfg) return;
    probeCfg.accTiles = 0;
    probeCfg.accBytes = 0;
    probeCfg.accMs = 0;
    probeCfg.accWall = [];
  };
  const quantileMs = (arr, p) => {
    if (!arr || !arr.length) return null;
    const xs = arr.slice().sort((a, b) => a - b);
    const i = Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * p)));
    return Math.round(xs[i]);
  };

let idx = 0;
  let tpEwmaMbps = null;
  let cooldownBatches = 0;

  while (idx < items.length) {
    // Keep "allowed concurrency" metric (for diagnostics)
    maxConcurrencySeen = Math.max(maxConcurrencySeen, concurrency);

    const concUsed = concurrency;

    const batchSize = Math.min(
      items.length - idx,
      Math.max(concUsed * 4, 16)
    );
    const batch = items.slice(idx, idx + batchSize);

    const retryBefore = uploadRetryEvents;
    const bytesBefore = uploadedBytesDone;
    const tilesBefore = createdTiles;
    const wallBefore = createImageWallTimesMs.length;
    const t0 = performance.now();

    await runWithConcurrency(
      batch,
      async (item) => {
        await worker(item);
      },
      concUsed
    );

    const wallAfter = createImageWallTimesMs.length;
    const wallSlice = createImageWallTimesMs.slice(wallBefore, wallAfter);
    const p50WallMs = quantileMs(wallSlice, 0.5);
    const p95WallMs = quantileMs(wallSlice, 0.95);

    const dtMs = performance.now() - t0;
    const retries = uploadRetryEvents - retryBefore;

    const bytesDelta = uploadedBytesDone - bytesBefore;
    const tilesDelta = createdTiles - tilesBefore;

    const dtSec = Math.max(0.001, dtMs / 1000);
    const mbps = (bytesDelta / 1_000_000) / dtSec; // MB/sec
    const ips = tilesDelta / dtSec; // tiles/sec

    tpEwmaMbps =
      tpEwmaMbps == null ? mbps : EWMA_ALPHA * mbps + (1 - EWMA_ALPHA) * tpEwmaMbps;

    const msPerTile = dtMs / Math.max(1, tilesDelta);
    const retriesPerTile = retries / Math.max(1, tilesDelta);

    // Stability heuristics
    const unstable = retriesPerTile > 0.08 || msPerTile > 15000 || (p95WallMs != null && p95WallMs > 17000);
    const stable = retriesPerTile < 0.03 && msPerTile < 11000 && (p95WallMs == null || p95WallMs < 13000);

    let action = "keep";
    let concNext = concurrency;

    if (cooldownBatches > 0) cooldownBatches -= 1;

    // ---- Forced probe (once) ----
    const probePhase = probeCfg ? probeCfg.phase : null;

    if (probeCfg && !probeCfg.done) {
      const finalizeWindow = (kind) => {
        const sec = Math.max(0.001, probeCfg.accMs / 1000);
        const wMbps = (probeCfg.accBytes / 1_000_000) / sec;
        const wIps = probeCfg.accTiles / sec;
        const wMsPerTile = probeCfg.accMs / Math.max(1, probeCfg.accTiles);
        const wP95 = quantileMs(probeCfg.accWall, 0.95);

        const obj = {
          mbps: Number.isFinite(wMbps) ? wMbps : null,
          ips: Number.isFinite(wIps) ? wIps : null,
          msPerTile: Number.isFinite(wMsPerTile) ? wMsPerTile : null,
          p95WallMs: wP95,
        };

        if (kind === "baseline") probeCfg.baselineWindows.push(obj);
        else if (kind === "probe") probeCfg.probeWindows.push(obj);

        resetProbeAcc();
      };

      // Warmup: keep at base conc to "stabilize" startup noise
      if (probeCfg.phase === "warmup") {
        if (concUsed !== probeCfg.baseConc) {
          lockedMax = probeCfg.baseConc;
          concNext = probeCfg.baseConc;
          action = "probe-warmup";
          cooldownBatches = 1;
        }
        if (createdTiles >= probeCfg.warmupTiles) {
          probeCfg.phase = "baseline";
          resetProbeAcc();
        }
      }

      // Baseline: collect 2 windows at base conc
      if (probeCfg.phase === "baseline") {
        if (concUsed !== probeCfg.baseConc) {
          lockedMax = probeCfg.baseConc;
          concNext = probeCfg.baseConc;
          action = "probe-base";
          cooldownBatches = 1;
        } else {
          probeCfg.accTiles += tilesDelta;
          probeCfg.accBytes += bytesDelta;
          probeCfg.accMs += dtMs;
          if (wallSlice && wallSlice.length) probeCfg.accWall.push(...wallSlice);

          if (probeCfg.accTiles >= probeCfg.windowTiles) {
            finalizeWindow("baseline");
          }

          if (probeCfg.baselineWindows.length >= probeCfg.windowsTarget) {
            probeCfg.phase = "probe";
            resetProbeAcc();

            lockedMax = 5;
            concNext = 5;
            action = "probe-up";
            cooldownBatches = 1;
          }
        }
      }

      // Probe: collect 2 windows at conc=5, then decide using gain + p95 tail guard
      if (probeCfg.phase === "probe") {
        lockedMax = 5;

        if (concUsed !== 5) {
          concNext = 5;
          action = "probe-up";
          cooldownBatches = 1;
        } else {
          probeCfg.accTiles += tilesDelta;
          probeCfg.accBytes += bytesDelta;
          probeCfg.accMs += dtMs;
          if (wallSlice && wallSlice.length) probeCfg.accWall.push(...wallSlice);

          if (probeCfg.accTiles >= probeCfg.windowTiles) {
            finalizeWindow("probe");
          }

          if (probeCfg.probeWindows.length >= probeCfg.windowsTarget) {
            const median = (xs) => {
              const ys = xs
                .filter((v) => Number.isFinite(v))
                .slice()
                .sort((a, b) => a - b);
              if (!ys.length) return null;
              const mid = Math.floor((ys.length - 1) / 2);
              return ys.length % 2 ? ys[mid] : (ys[mid] + ys[mid + 1]) / 2;
            };

            const baseMbpsMed = median(probeCfg.baselineWindows.map((w) => w.mbps));
            const probeMbpsMed = median(probeCfg.probeWindows.map((w) => w.mbps));
            const baseP95Med = median(probeCfg.baselineWindows.map((w) => w.p95WallMs));
            const probeP95Med = median(probeCfg.probeWindows.map((w) => w.p95WallMs));
            const baseMsMed = median(probeCfg.baselineWindows.map((w) => w.msPerTile));
            const probeMsMed = median(probeCfg.probeWindows.map((w) => w.msPerTile));

            const gain =
              baseMbpsMed != null && probeMbpsMed != null
                ? probeMbpsMed / Math.max(1e-9, baseMbpsMed)
                : null;

            const tailFactor =
              baseP95Med != null && probeP95Med != null
                ? probeP95Med / Math.max(1e-9, baseP95Med)
                : null;

            probeCfg.lastGain = gain;
            probeCfg.lastTailFactor = tailFactor;

            const strongGain = gain != null && gain >= 1.07;
            const weakGain = gain != null && gain >= 1.03;

            const tailOkStrong = tailFactor == null || tailFactor <= 1.15;
            const tailOkWeak = tailFactor == null || tailFactor <= 1.05;
            const tailHardBad = tailFactor != null && tailFactor >= 1.25;

            // don't accept if per-tile time got worse (helps guard against noisy mbps)
            const msNotWorse =
              baseMsMed == null || probeMsMed == null || probeMsMed <= baseMsMed * 1.02;

            let accept = false;
            if (strongGain && tailOkStrong && msNotWorse) accept = true;
            else if (weakGain && tailOkWeak && msNotWorse) accept = true;

            if (!accept || tailHardBad) {
              lockedMax = probeCfg.baseConc;
              concNext = lockedMax;
              action = "force-cap";
            } else {
              lockedMax = 5;
              concNext = 5;
              action = "force-accept";
            }

            probeCfg.done = true;
            probeCfg.phase = "done";
            cooldownBatches = 2;
          }
        }
      }
    }

// ---- Normal adaptation (only if probe is done / not configured) ----
    const probeBlocking = probeCfg && !probeCfg.done;
    if (!probeBlocking) {
      if (unstable && concurrency > minConcurrency) {
        concNext = concurrency - 1;
        lockedMax = Math.min(lockedMax, concNext);
        action = action === "keep" ? "down" : action;
        cooldownBatches = Math.max(cooldownBatches, 1);
      } else if (stable && cooldownBatches === 0 && concurrency < lockedMax) {
        // attempt an up-step; keep it only if it doesn't destabilize later
        concNext = concurrency + 1;
        action = action === "keep" ? "up" : action;
        cooldownBatches = 1;
      }
    }

    concurrencyDecisions.push({
      idx,
      concUsed,
      concNext,
      lockedMax,
      mbps: Number.isFinite(mbps) ? Number(mbps.toFixed(2)) : null,
      ips: Number.isFinite(ips) ? Number(ips.toFixed(2)) : null,
      retriesPerTile: Number.isFinite(retriesPerTile) ? Number(retriesPerTile.toFixed(3)) : null,
      msPerTile: Number.isFinite(msPerTile) ? Math.round(msPerTile) : null,
      p50WallMs,
      p95WallMs,
      probePhase,
      probeGain: probeCfg && probeCfg.lastGain != null ? Number(probeCfg.lastGain.toFixed(3)) : null,
      probeTail: probeCfg && probeCfg.lastTailFactor != null ? Number(probeCfg.lastTailFactor.toFixed(3)) : null,
      action,
    });

    concurrency = Math.max(minConcurrency, Math.min(lockedMax, concNext));
    idx += batch.length;
  }
};
;

    // ---- Build tile jobs (1 job = 1 board.createImage call) ----
const tileJobs = [];
const remainingJobsByFile = new Map();

const registerJobForFile = (file) => {
  remainingJobsByFile.set(file, (remainingJobsByFile.get(file) || 0) + 1);
};

const originalNameByFile = new Map();

const getFileCenter = (info, fileIndex) => {
  if (slotCentersByFile) {
    return slotCentersByFile.get(info.file) || { x: viewCenterX, y: viewCenterY };
  }
  if (slotCentersArray) {
    return slotCentersArray[fileIndex] || { x: viewCenterX, y: viewCenterY };
  }
  return { x: viewCenterX, y: viewCenterY };
};

for (let i = 0; i < orderedInfos.length; i++) {
  const info = orderedInfos[i];
  const { file, needsSlice, width, height, tilesX, tilesY } = info;

  const center = getFileCenter(info, i);
  const originalName = file.name || "image";
  originalNameByFile.set(file, originalName);

  if (!needsSlice) {
    registerJobForFile(file);
    tileJobs.push({
      kind: "full",
      file,
      info,
      x: center.x,
      y: center.y,
      width,
      height,
    });
    continue;
  }

  const nameMatch = originalName.match(/^(.*?)(\.[^.]*$|$)/);
  const baseName = nameMatch ? nameMatch[1] : originalName;
  const originalExt = nameMatch && nameMatch[2] ? nameMatch[2] : "";

  const colWidths = [];
  const rowHeights = [];

  for (let tx = 0; tx < tilesX; tx++) {
    colWidths.push(Math.min(SLICE_TILE_SIZE, width - tx * SLICE_TILE_SIZE));
  }
  for (let ty = 0; ty < tilesY; ty++) {
    rowHeights.push(Math.min(SLICE_TILE_SIZE, height - ty * SLICE_TILE_SIZE));
  }

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

      const sx = tx * SLICE_TILE_SIZE;
      const sy = ty * SLICE_TILE_SIZE;

      const tileLeft = mosaicLeft + colPrefix[tx];
      const tileTop = mosaicTop + rowPrefix[ty];

      const centerX = tileLeft + sw / 2;
      const centerY = tileTop + sh / 2;

      const tileSuffix = pad2(tileIndex); // 01, 02...
      const tileBaseName = `${baseName}_${tileSuffix}`;
      const tileFullName = originalExt ? `${tileBaseName}${originalExt}` : tileBaseName;
      const title = `C${pad2(info.satCode)}/${pad3(info.briCode)} ${tileFullName}`;

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

// ---- Decoded image cache (so 256 tiles don't decode the same source 256 times) ----
const imageCache = new Map(); // file -> { imgPromise, imgEl }

const getDecodedImage = async (file) => {
  const cached = imageCache.get(file);
  if (cached) {
    return cached.imgPromise;
  }

  const objectUrl = URL.createObjectURL(file);
  const imgPromise = (async () => {
    try {
      const imgEl = await loadImage(objectUrl);
      return imgEl;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  })();

  imageCache.set(file, { imgPromise });
  return imgPromise;
};

const releaseDecodedImageIfDone = (file) => {
  const left = (remainingJobsByFile.get(file) || 0) - 1;
  if (left <= 0) {
    remainingJobsByFile.delete(file);
    const cached = imageCache.get(file);
    if (cached) {
      cached.imgPromise
        .then((imgEl) => {
          try { imgEl.src = ""; } catch (_) {}
        })
        .catch(() => {});
      imageCache.delete(file);
    }
    return;
  }
  remainingJobsByFile.set(file, left);
};

const processOneJob = async (job) => {
  const { file, info } = job;
  const imgEl = await getDecodedImage(file);

  // Per-job canvas (safe for concurrency)
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  let urlToUse;
  let title;

  if (job.kind === "full") {
    canvas.width = job.width;
    canvas.height = job.height;
    ctx.clearRect(0, 0, job.width, job.height);
    ctx.drawImage(imgEl, 0, 0, job.width, job.height);

    urlToUse = canvasToDataUrlUnderLimit(canvas, TARGET_URL_BYTES);
    title = `C${pad2(info.satCode)}/${pad3(info.briCode)} ${originalNameByFile.get(file) || "image"}`;
  } else {
    canvas.width = job.sw;
    canvas.height = job.sh;
    ctx.clearRect(0, 0, job.sw, job.sh);
    ctx.drawImage(imgEl, job.sx, job.sy, job.sw, job.sh, 0, 0, job.sw, job.sh);

    urlToUse = canvasToDataUrlUnderLimit(canvas, TARGET_URL_BYTES);
    title = job.title;
  }

  const imgWidget = await createImageWithRetry({
    url: urlToUse,
    x: job.x,
    y: job.y,
    title,
  });

  try {
    if (job.kind === "full") {
      await imgWidget.setMetadata(META_APP_ID, {
        fileName: originalNameByFile.get(file) || "image",
        satCode: info.satCode,
        briCode: info.briCode,
      });
    } else {
      await imgWidget.setMetadata(META_APP_ID, {
        fileName: originalNameByFile.get(file) || "image",
        satCode: info.satCode,
        briCode: info.briCode,
        tileIndex: job.tileIndex,
        tilesX: job.tilesX,
        tilesY: job.tilesY,
      });
    }
  } catch (e) {
    console.warn("setMetadata failed:", e);
  }

  allCreatedTiles.push(imgWidget);
  uploadedBytesDone += urlToUse ? urlToUse.length : 0;
  createdTiles += 1;
  updateCreationProgress();

  releaseDecodedImageIfDone(file);
};

// ---- Upload stage concurrency (tile-based) ----
// Starts at 4 for large imports, then adapts down/up between 2..5 based on retries/latency.
// For very large imports we also do a single forced probe at 5 to answer "can 5 help here?".
const initialConcurrency = UPLOAD_CONCURRENCY_INITIAL_LARGE; // always start at 4
const minConcurrency = UPLOAD_CONCURRENCY_MIN;
const maxConcurrency = UPLOAD_CONCURRENCY_MAX;

await runWithAdaptiveConcurrency(tileJobs, async (job) => processOneJob(job), initialConcurrency, minConcurrency, maxConcurrency);
setProgress(totalTiles, totalTiles);
    if (setProgress.flush) setProgress.flush();
    setEtaText(null);
    if (setEtaText.flush) setEtaText.flush();

    if (allCreatedTiles.length) {
      try {
        await board.viewport.zoomTo(allCreatedTiles);
      } catch (e) {
        console.warn("zoomTo failed in Stitch/Slice:", e);
      }
    }


    // Mark end of upload stage for stats/ETA
    uploadEndTs = performance.now();

    // ---- console stats (console only) ----
    try {
      const fmtMs = (ms) => {
        if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
        const s = Math.round(ms / 1000);
        const mins = Math.floor(s / 60);
        const secs = s % 60;
        const secsStr = String(secs).padStart(2, "0");
        return mins ? `${mins}m ${secsStr}s` : `${secsStr}s`;
      };


      const fmtSec = (ms) => {
        if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
        return `${(ms / 1000).toFixed(2)}s`;
      };

      const percentile = (arr, p) => {
        if (!arr || !arr.length) return null;
        const xs = arr.slice().sort((a, b) => a - b);
        const idx = Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * p)));
        return Math.round(xs[idx]);
      };

      const prepEnd = (prepEndTs != null ? prepEndTs : (uploadStartTs != null ? uploadStartTs : uploadEndTs));
      const prepMs = prepStartTs != null && prepEnd != null ? prepEnd - prepStartTs : null;
      const uploadMs = uploadStartTs != null && uploadEndTs != null ? uploadEndTs - uploadStartTs : null;
      const totalEnd = (uploadEndTs != null ? uploadEndTs : performance.now());
      const totalMs = prepStartTs != null ? totalEnd - prepStartTs : null;

      const totalMB = uploadedBytesDone / 1_000_000;
      const avgMBPerTile = createdTiles ? totalMB / createdTiles : 0;
      const mbps = uploadMs ? totalMB / (uploadMs / 1000) : null;

      const avgCreateMs = createImageWallTimeCount
        ? Math.round(createImageWallTimeSumMs / createImageWallTimeCount)
        : null;

      console.groupCollapsed("[Image Align Tool] Import stats");
      console.log("Files (sources):", fileInfos.length);
      console.log("Tiles:", { total: totalTiles, created: createdTiles });
      console.log("Time:", { preparing: fmtMs(prepMs), uploading: fmtMs(uploadMs), total: fmtMs(totalMs) });
      console.log("Upload:", {
        totalMB: Math.round(totalMB * 10) / 10,
        avgMBPerTile: Math.round(avgMBPerTile * 100) / 100,
        mbps: mbps != null ? Math.round(mbps * 100) / 100 : null,
        retries: uploadRetryEvents,
      });
      const p50Ms = percentile(createImageWallTimesMs, 0.5);
      const p95Ms = percentile(createImageWallTimesMs, 0.95);
      const wallHuman = avgCreateMs != null
        ? `${fmtSec(avgCreateMs)} avg (p50 ${fmtSec(p50Ms)}, p95 ${fmtSec(p95Ms)})`
        : null;

      console.log("createImage wall-time:", wallHuman);
      console.log("createImage wall-time (ms):", { avg: avgCreateMs, p50: p50Ms, p95: p95Ms });
      console.log("Concurrency:", {
        maxSeen: maxInFlightCreateImage,
        maxAllowedSeen: maxConcurrencySeen,
        configuredMax: UPLOAD_CONCURRENCY_MAX,
      });
      if (concurrencyDecisions.length) {
        console.table(concurrencyDecisions.slice(-12));
      }
      console.groupEnd();
    } catch (e) {
      console.warn("[Image Align Tool] stats failed:", e);
    }

    await board.notifications.showInfo(
      `Imported ${fileInfos.length} source image${
        fileInfos.length === 1 ? "" : "s"
      } into ${totalTiles} tile${totalTiles === 1 ? "" : "s"}.`
    );
  } catch (err) {
    console.error(err);
    setProgress(0, 0, "Error");
    setEtaText(null);
    await board.notifications.showError(
      "Something went wrong while importing images. Please check the console."
    );
  } finally {
    const stitchButton = document.getElementById("stitchButton");
    if (stitchButton) stitchButton.disabled = false;
  }
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  detectMaxSliceDim();

  const sortingForm = document.getElementById("sorting-form");
  if (sortingForm) sortingForm.addEventListener("submit", handleSortingSubmit);

  // Show "Size order" only when Sort by = Size
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
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === name;
      btn.classList.toggle("active", isActive);
    });

    Object.entries(tabContents).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle("active", key === name);
    });
  }

  if (tabButtons.length) {
    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
    // дефолт — Stitch/Slice
    activateTab("stitch");
  }

  const fileButton = document.getElementById("stitchFileButton");
  const fileInput = document.getElementById("stitchFolderInput");
  const fileLabel = document.getElementById("stitchFileLabel");

  if (fileButton && fileInput && fileLabel) {
    fileButton.addEventListener("click", () => fileInput.click());

    const updateLabel = () => {
      const files = fileInput.files;
      if (!files || files.length === 0) {
        fileLabel.textContent = "No files selected";
      } else if (files.length === 1) {
        fileLabel.textContent = files[0].name;
      } else {
        fileLabel.textContent = `${files.length} files selected`;
      }
    };

    fileInput.addEventListener("change", updateLabel);
    updateLabel();
  }
});
