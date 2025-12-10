// app.js
// Image Align Tool: Sorting (align selection) + Stitch/Slice (импорт + автослайс больших изображений)

const { board } = window.miro;

// ---- color / slice settings ----
const SAT_CODE_MAX = 99;
const SAT_BOOST = 4.0;
const SAT_GROUP_THRESHOLD = 35;      // порог сатурации: <= серые, > цветные
const SLICE_TILE_SIZE = 4096;        // размер тайла при слайсе
const SLICE_THRESHOLD_WIDTH = 8192;  // если ширина > этого, режем
const SLICE_THRESHOLD_HEIGHT = 4096; // если высота > этого, режем
let   MAX_SLICE_DIM = 16384;         // уточняется через WebGL (16k / 32k)
const MAX_URL_BYTES = 30000000;      // лимит размера поля url в Miro (из ошибки)

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
 * Возвращает среднюю яркость и "сырую" сатурацию по ROI:
 *   - уменьшаем до smallSize
 *   - блюрим (blurPx)
 *   - обрезаем верхнюю часть и боковые поля
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
      if (a.group !== b.group) return a.group - b.group;        // серые → цветные
      if (a.briCode !== b.briCode) return a.briCode - b.briCode; // светлее → темнее
      if (a.satCode !== b.satCode) return a.satCode - b.satCode; // бледнее → насыщеннее
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

/**
 * Кодирует canvas в JPEG и, при необходимости, понижает качество,
 * чтобы строка dataURL была меньше maxBytes. Если не получилось — возвращает null.
 */
function canvasToDataUrlUnderLimit(canvas, maxBytes = MAX_URL_BYTES) {
  let quality = 0.9;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);

  while (dataUrl.length > maxBytes && quality > 0.3) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > maxBytes) {
    console.error(
      "Slice: tile dataURL is still too large after compression:",
      dataUrl.length,
      "bytes"
    );
    return null;
  }

  return dataUrl;
}

/**
 * Вычисляет центры "слотов" для файлов (все размеры разные),
 * без пропусков, с учётом startCorner.
 */
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

/**
 * Вычисляет центры "слотов" при Skip missing tiles.
 * Все тайлы считаются одного размера (по первому).
 */
function computeSkipMissingSlotCenters(
  tileInfos,
  imagesPerRow,
  startCorner,
  viewCenterX,
  viewCenterY
) {
  if (!tileInfos.length) return [];

  const numbered = tileInfos.map(({ info, num }) => ({ info, num }));

  const nums = numbered.map((n) => n.num);
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
    const pos = num - minNum; // 0-based
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

  const stitchButton = document.getElementById("stitchButton");
  const progressBarEl = document.getElementById("stitchProgressBar");
  const progressMainEl = document.getElementById("stitchProgressMain");
  const progressEtaEl = document.getElementById("stitchProgressEta");

  const setProgress = (done, total, labelOverride) => {
    const frac = total > 0 ? done / total : 0;
    if (progressBarEl) {
      progressBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
    }
    if (progressMainEl) {
      if (labelOverride !== undefined) {
        progressMainEl.textContent = labelOverride;
      } else if (total > 0) {
        progressMainEl.textContent =
          done < total
            ? `Creating ${done} / ${total}`
            : "Done!";
      } else {
        progressMainEl.textContent = "";
      }
    }
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
    const text = mins ? `${mins}m ${secsStr}s left` : `${secsStr}s left`;
    progressEtaEl.textContent = text;
  };

  try {
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

    const filesArray = Array.from(files);

    // центр текущего вида
    let viewCenterX = 0;
    let viewCenterY = 0;
    try {
      const viewport = await board.viewport.get();
      viewCenterX = viewport.x + viewport.width / 2;
      viewCenterY = viewport.y + viewport.height / 2;
    } catch (e) {
      console.warn("Stitch/Slice: could not get viewport, fallback to 0,0", e);
    }

    // --- 1. подготовка: читаем файлы, узнаём размеры, считаем brightness/sat, классифицируем ---
    const fileInfos = [];
    let anySliced = false;

    setProgress(0, 0, "Preparing files…");

    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];

      const dataUrl = await readFileAsDataUrl(file);

      let imgEl;
      try {
        imgEl = await loadImage(dataUrl);
      } catch (e) {
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

      fileInfos.push({
        file,
        dataUrl,
        imgEl,
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

    if (!fileInfos.length) {
      setProgress(0, 0, "Nothing to import.");
      setEtaText(null);
      return;
    }

    // сортировка файлов по имени/номеру
    const orderedFiles = sortFilesByNameWithNumber(filesArray);
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

    const totalTiles = orderedInfos.reduce(
      (sum, info) => sum + (info.needsSlice ? info.numTiles : 1),
      0
    );

    if (anySliced && skipMissingTiles) {
      await board.notifications.showInfo(
        '“Skip missing tiles” is ignored for large images (Stitch/Slice).'
      );
    }

    // --- 2. считаем центры слотов для файлов ---

    let slotCentersByFile = null; // Map(file -> {x,y}) для режима skipMissing
    let slotCentersArray = null;  // [{x,y}] для общего случая

    const hasAnyNumber = orderedInfos.some((info) => {
      const name = info.file.name || "";
      return extractTrailingNumber(name) !== null;
    });

    if (!anySliced && skipMissingTiles && hasAnyNumber) {
      // режим Skip missing tiles (все файлы маленькие, есть номера)
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
        // для тайлов без номера — добавим после maxNum
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
      // обычная сетка (в том числе, когда есть большие картинки)
      slotCentersArray = computeVariableSlotCenters(
        orderedInfos,
        imagesPerRow,
        startCorner,
        viewCenterX,
        viewCenterY
      );
    }

    // --- 3. создаём тайлы (обычные и слайс), считаем прогресс и ETA ---

    const allCreatedTiles = [];
    let createdTiles = 0;
    let creationCount = 0;
    let creationTimeSumMs = 0;

    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const updateCreationProgress = () => {
      setProgress(createdTiles, totalTiles);
      if (creationCount > 0) {
        const avgPerTile = creationTimeSumMs / creationCount;
        const remaining = totalTiles - createdTiles;
        const etaMs = remaining > 0 ? avgPerTile * remaining : null;
        setEtaText(etaMs);
      } else {
        setEtaText(null);
      }
    };

    for (let i = 0; i < orderedInfos.length; i++) {
      const info = orderedInfos[i];
      const { file, needsSlice, imgEl, width, height, tilesX, tilesY } = info;

      let center;
      if (slotCentersByFile) {
        center =
          slotCentersByFile.get(file) ||
          { x: viewCenterX, y: viewCenterY };
      } else if (slotCentersArray) {
        center = slotCentersArray[i];
      } else {
        center = { x: viewCenterX, y: viewCenterY };
      }

      if (!needsSlice) {
        // обычный маленький тайл
        const title = `C${pad2(info.satCode)}/${pad3(info.briCode)} ${file.name}`;

        const t0 = performance.now();
        const imgWidget = await board.createImage({
          url: info.dataUrl,
          x: center.x,
          y: center.y,
          title,
        });
        const t1 = performance.now();

        allCreatedTiles.push(imgWidget);
        createdTiles += 1;
        creationCount += 1;
        creationTimeSumMs += t1 - t0;
        updateCreationProgress();
      } else {
        // большой тайл → режем, собираем в пределах "слота" с габаритами исходной картинки
        const colWidths = [];
        const rowHeights = [];

        for (let tx = 0; tx < tilesX; tx++) {
          const sw = Math.min(SLICE_TILE_SIZE, width - tx * SLICE_TILE_SIZE);
          colWidths.push(sw);
        }
        for (let ty = 0; ty < tilesY; ty++) {
          const sh = Math.min(SLICE_TILE_SIZE, height - ty * SLICE_TILE_SIZE);
          rowHeights.push(sh);
        }

        const mosaicWidth = colWidths.reduce((a, b) => a + b, 0);
        const mosaicHeight = rowHeights.reduce((a, b) => a + b, 0);

        const mosaicLeft = center.x - mosaicWidth / 2;
        const mosaicTop = center.y - mosaicHeight / 2;

        // префиксные суммы для удобства:
        const colPrefix = [0];
        for (let tx = 0; tx < tilesX; tx++) {
          colPrefix.push(colPrefix[colPrefix.length - 1] + colWidths[tx]);
        }
        const rowPrefix = [0];
        for (let ty = 0; ty < tilesY; ty++) {
          rowPrefix.push(rowPrefix[rowPrefix.length - 1] + rowHeights[ty]);
        }

        for (let ty = 0; ty < tilesY; ty++) {
          for (let tx = 0; tx < tilesX; tx++) {
            const sx = tx * SLICE_TILE_SIZE;
            const sy = ty * SLICE_TILE_SIZE;
            const sw = Math.min(SLICE_TILE_SIZE, width - sx);
            const sh = Math.min(SLICE_TILE_SIZE, height - sy);

            // 👇 ключевое изменение: холст подгоняем под реальный размер тайла
            canvas.width = sw;
            canvas.height = sh;
            ctx.clearRect(0, 0, sw, sh);

            ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);

            const tileDataUrl = canvasToDataUrlUnderLimit(canvas);
            if (!tileDataUrl) {
              await board.notifications.showError(
                `One of the tiles from "${file.name}" is too large even after compression. Skipped.`
              );
              createdTiles++;
              updateCreationProgress();
              continue;
            }

            const tileLeft = mosaicLeft + colPrefix[tx];
            const tileTop = mosaicTop + rowPrefix[ty];
            const centerX = tileLeft + sw / 2;
            const centerY = tileTop + sh / 2;

            const t0 = performance.now();
            const tileWidget = await board.createImage({
              url: tileDataUrl,
              x: centerX,
              y: centerY,
            });
            const t1 = performance.now();

            allCreatedTiles.push(tileWidget);
            createdTiles++;
            creationCount++;
            creationTimeSumMs += t1 - t0;
            updateCreationProgress();
          }
        }
      }
    }

    setProgress(totalTiles, totalTiles);
    setEtaText(null);

    if (allCreatedTiles.length) {
      try {
        await board.viewport.zoomTo(allCreatedTiles);
      } catch (e) {
        console.warn("zoomTo failed in Stitch/Slice:", e);
      }
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
  // авто-детект максимального размера стороны для Slice
  detectMaxSliceDim();

  const sortingForm = document.getElementById("sorting-form");
  if (sortingForm) sortingForm.addEventListener("submit", handleSortingSubmit);

  const stitchForm = document.getElementById("stitch-form");
  if (stitchForm) stitchForm.addEventListener("submit", handleStitchSubmit);

  // табы
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
    // дефолтная вкладка — Stitch/Slice
    activateTab("stitch");
  }

  // кастомный файл-пикер для Stitch/Slice
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
