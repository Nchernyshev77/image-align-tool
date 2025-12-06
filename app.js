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
 * Загружаем изображение по URL в <img>, учитываем CORS.
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
 * Считаем средний цвет картинки через canvas.
 * Чтобы не тормозить, уменьшаем до smallSize x smallSize.
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

  const widths = images.map((img) => img.width);
  const heights = images.map((img) => img.height);

  const maxWidth = Math.max(...widths);
  const maxHeight = Math.max(...heights);

  // текущий bounding box выделения
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

  const total = images.length;
  const cols = Math.max(1, imagesPerRow);
  const rows = Math.ceil(total / cols);

  const cellWidth = maxWidth + horizontalGap;
  const cellHeight = maxHeight + verticalGap;

  const gridWidth = cols * maxWidth + (cols - 1) * horizontalGap;
  const gridHeight = rows * maxHeight + (rows - 1) * verticalGap;

  let originLeft;
  let originTop;

  if (startCorner.startsWith("top")) {
    originTop = minTop;
  } else {
    originTop = maxBottom - gridHeight;
  }

  if (startCorner.endsWith("left")) {
    originLeft = minLeft;
  } else {
    originLeft = maxRight - gridWidth;
  }

  images.forEach((img, index) => {
    // базовые row/col для top-left
    let row = Math.floor(index / cols); // 0..rows-1 (top->bottom)
    let col = index % cols; // 0..cols-1 (left->right)

    // корректировка под выбранный угол
    switch (startCorner) {
      case "top-left":
        break;
      case "top-right":
        col = cols - 1 - col;
        break;
      case "bottom-left":
        row = rows - 1 - row;
        break;
      case "bottom-right":
        row = rows - 1 - row;
        col = cols - 1 - col;
        break;
    }

    const left = originLeft + col * cellWidth;
    const top = originTop + row * cellHeight;

    img.x = left + img.width / 2;
    img.y = top + img.height / 2;
  });

  await Promise.all(images.map((img) => img.sync()));
}

/* ---------- SORTING TAB ---------- */

/**
 * Сортировка по номеру (title / автонумерация по геометрии).
 */
async function sortImagesByNumber(images) {
  // 1) если у кого-то пустой title -> нумеруем по геометрии (top-left -> bottom-right)
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

  // 2) сортировка по числу в title + алфавит
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
    // numbered first
    if (a.hasNumber && !b.hasNumber) return -1;
    if (!a.hasNumber && b.hasNumber) return 1;

    if (a.hasNumber && b.hasNumber) {
      if (a.num !== b.num) return a.num - b.num;
      if (a.lower < b.lower) return -1;
      if (a.lower > b.lower) return 1;
      return a.index - b.index;
    }

    // оба без чисел -> по алфавиту
    if (a.lower < b.lower) return -1;
    if (a.
