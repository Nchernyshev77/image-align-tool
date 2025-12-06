// app.js
// Image Tools: Sorting (align selection) & Stitch (import and align).
const { board } = window.miro;

/* ---------- helpers: titles & numbers ---------- */

function getTitle(item) {
  return (item.title || "").toString();
}

/**
 * Extract the LAST integer number from a string.
 * "Name_01"   -> 1
 * "Name0003"  -> 3
 * "Name 10a2" -> 2 (последняя группа цифр)
 */
function extractTrailingNumber(str) {
  const match = str.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isNaN(num) ? null : num;
}

/**
 * Geometry sort: top -> bottom, then left -> right
 */
function sortByGeometry(images) {
  return [...images].sort((a, b) => {
    if (a.y < b.y) return -1;
    if (a.y > b.y) return 1;
    if (a.x < b.x) return -1;
    if (a.x > b.x) return 1;
    return 0;
  });
}

/* ---------- helpers: colors ---------- */

/**
 * Load image by URL into <img> (with CORS support).
 */
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
 * Average color via canvas. Downscale to smallSize x smallSize for speed.
 */
function getAverageColorFromImageElement(img, smallSize = 50) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const width = smallSize;
  const height = smallSize;

  canvas.width = width;
  canvas.height = height;

  ctx.drawImage(img, 0, 0, width, height);

  let data;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch (e) {
    console.error("getImageData failed (CORS?):", e);
    return null;
  }

  let r = 0,
    g = 0,
    b = 0;
  const totalPixels = width * height;

  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }

  r = Math.round(r / totalPixels);
  g = Math.round(g / totalPixels);
  b = Math.round(b / totalPixels);

  return { r, g, b };
}

/**
 * RGB (0-255) -> HSL (h:0-360, s:0-1, l:0-1)
 */
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h;
  let s;
  const l = (max + min) / 2;

  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }

    h *= 60;
  }

  return { h, s, l };
}

/* ---------- helpers: alignment ---------- */

/**
 * Align images in the order they are given in `images` array.
 *
 * Горизонтально:
 *   - внутри строки картинки идут одна за другой;
 *   - расстояние между ними всегда = horizontalGap.
 *
 * Вертикально:
 *   - высота строки = max высота картинок в этой строке;
 *   - расстояние между строками = verticalGap.
 *
 * `config`:
 *  - imagesPerRow
 *  - horizontalGap
 *  - verticalGap
 *  - sizeMode  ('none' | 'width' | 'height')
 *  - startCorner ('top-left', 'top-right', 'bottom-left', 'bottom-right')
 */
async function alignImagesInGivenOrder(images, config) {
  const {
    imagesPerRow,
    horizontalGap,
    verticalGap,
    sizeMode,
    startCorner,
  } = config;

  if (!images.length) return;

  // resize if needed
  if (sizeMode === "width") {
    const targetWidth = Math.min(...images.map((img) => img.width));
    for (const img of images) {
      img.width = targetWidth;
    }
    await Promise.all(images.map((img) => img.sync()));
  } else if (sizeMode === "height") {
    const targetHeight = Math.min(...images.map((img) => img.height));
    for (const img of images) {
      img.height = targetHeight;
    }
    await Promise.all(images.map((img) => img.sync()));
  }

  const total = images.length;
  const cols = Math.max(1, imagesPerRow);
  const rows = Math.ceil(total / cols);

  // Разбиваем индексы на строки
  const rowsIndices = [];
  for (let r = 0; r < rows; r++) {
    rowsIndices.push([]);
  }
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    rowsIndices[r].push(i);
  }

  // Высота и ширина каждой строки (с учётом horizontalGap)
  const rowHeights = new Array(rows).fill(0);
  const rowWidths = new Array(rows).fill(0);

  for (let r = 0; r < rows; r++) {
    let maxH = 0;
    let width = 0;
    const indices = rowsIndices[r];
    for (let j = 0; j < indices.length; j++) {
      const img = images[indices[j]];
      if (img.height > maxH) maxH = img.height;
      if (j > 0) width += horizontalGap;
      width += img.width;
    }
    rowHeights[r] = maxH;
    rowWidths[r] = width;
  }

  const gridWidth = rowWidths.length ? Math.max(...rowWidths) : 0;
  const gridHeight =
    rowHeights.reduce((sum, h) => sum + h, 0) +
    verticalGap * Math.max(0, rows - 1);

  // Y-координаты верхней границы каждой строки (für top-left origin)
  const rowTop = new Array(rows).fill(0);
  for (let r = 1; r < rows; r++) {
    rowTop[r] = rowTop[r - 1] + rowHeights[r - 1] + verticalGap;
  }

  // Базовые координаты (top-left ориентация, origin (0,0))
  const baseX = new Array(total).fill(0);
  const baseY = new Array(total).fill(0);

  for (let r = 0; r < rows; r++) {
    const indices = rowsIndices[r];
    const top = rowTop[r];
    const centerY = top + rowHeights[r] / 2;

    let cursorX = 0;
    for (let j = 0; j < indices.length; j++) {
      const idx = indices[j];
      const img = images[idx];

      const centerX = cursorX + img.width / 2;
      baseX[idx] = centerX;
      baseY[idx] = centerY;

      cursorX += img.width + horizontalGap;
    }
  }

  // Текущее bounding box выделения (чтобы приклеить сетку к нему)
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

  // Определяем, нужно ли зеркалить по X/Y и куда ставить origin.
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

  // Применяем зеркалирование и смещение
  for (let i = 0; i < total; i++) {
    let x0 = baseX[i];
    let y0 = baseY[i];

    if (flipX) {
      x0 = gridWidth - x0;
    }
    if (flipY) {
      y0 = gridHeight - y0;
    }

    const img = images[i];
    img.x = originLeft + x0;
    img.y = originTop + y0;
  }

  await Promise.all(images.map((img) => img.sync()));
}

/* ---------- SORTING: by number ---------- */

async function sortImagesByNumber(images) {
  // если есть картинки без title — один раз пронумеруем по геометрии
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
  meta.forEach((m) => {
    console.log(m.title || m.img.id, "=>", m.num);
  });
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

/* ---------- SORTING: by color (gray first + luminance) ---------- */

/**
 * Сортировка по среднему цвету:
 *  1) сначала серо-белые (низкая насыщенность),
 *  2) потом цветные.
 * Внутри каждой группы:
 *  - сортируем по яркости Y (luminance) по убыванию (светлые → тёмные);
 *  - если Y одинаковая — по l по убыванию как запасной вариант.
 * Если совсем не удалось посчитать цвет — fallback на sortByGeometry.
 */
async function sortImagesByColor(images) {
  const meta = [];

  for (const imgItem of images) {
    const url = imgItem.url || imgItem.contentUrl;
    if (!url) {
      console.warn("No image URL (url/contentUrl) for image:", imgItem.id);
      continue;
    }

    try {
      const img = await loadImage(url);
      const avg = getAverageColorFromImageElement(img);
      if (!avg) {
        console.warn("Failed to compute color, fallback neutral:", imgItem.id);
        meta.push({
          img: imgItem,
          h: 0,
          s: 0,
          l: 0.5,
          y: 0.5,
          isGray: true,
        });
        continue;
      }

      const { r, g, b } = avg;
      const { h, s, l } = rgbToHsl(r, g, b);

      // яркость (luminance) в [0..1]
      const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

      const SAT_GRAY_THRESHOLD = 0.1;
      const isGray = s < SAT_GRAY_THRESHOLD;

      meta.push({ img: imgItem, h, s, l, y, isGray });
    } catch (e) {
      console.error("Error reading image for color sort", imgItem.id, e);
      meta.push({
        img: imgItem,
        h: 0,
        s: 0,
        l: 0.5,
        y: 0.5,
        isGray: true,
      });
    }
  }

  if (!meta.length) {
    console.warn(
      "Could not compute colors for any image, falling back to geometry sort."
    );
    return sortByGeom
