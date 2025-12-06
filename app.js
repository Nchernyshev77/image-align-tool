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

  // current bounding box of selection
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
    // base row/col for top-left
    let row = Math.floor(index / cols); // 0..rows-1 (top->bottom)
    let col = index % cols; // 0..cols-1 (left->right)

    // adjust for chosen corner
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

    // both without numbers: alphabet
    if (a.lower < b.lower) return -1;
    if (a.lower > b.lower) return 1;
    return a.index - b.index;
  });

  return meta.map((m) => m.img);
}

/**
 * Сортировка по среднему цвету:
 *  - цветные (s >= threshold) идут первыми, по hue (0..360)
 *  - серые / почти серые (s < threshold) — в конце, по lightness
 */
async function sortImagesByColor(images) {
  const meta = [];

  for (const imgItem of images) {
    const url = imgItem.url;
    if (!url) {
      console.warn("No url for image:", imgItem.id);
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
        });
        continue;
      }
      const { h, s, l } = rgbToHsl(avg.r, avg.g, avg.b);
      meta.push({ img: imgItem, h, s, l });
    } catch (e) {
      console.error("Error reading image for color sort", imgItem.id, e);
      meta.push({
        img: imgItem,
        h: 0,
        s: 0,
        l: 0.5,
      });
    }
  }

  if (!meta.length) {
    throw new Error("Could not compute colors for any image.");
  }

  console.groupCollapsed("Sorting (color) – HSL");
  meta.forEach((m) => {
    console.log(
      m.img.title || m.img.id,
      "=>",
      `h=${m.h.toFixed(1)}, s=${m.s.toFixed(2)}, l=${m.l.toFixed(2)}`
    );
  });
  console.groupEnd();

  const SAT_GRAY_THRESHOLD = 0.1;

  meta.sort((a, b) => {
    const aGray = a.s < SAT_GRAY_THRESHOLD;
    const bGray = b.s < SAT_GRAY_THRESHOLD;

    // цветные сначала, серые потом
    if (aGray && !bGray) return 1;
    if (!aGray && bGray) return -1;

    if (!aGray && !bGray) {
      // оба цветные => по hue, потом по lightness
      if (a.h !== b.h) return a.h - b.h;
      return a.l - b.l;
    }

    // оба серые => по lightness
    return a.l - b.l;
  });

  return meta.map((m) => m.img);
}

/**
 * Главный handler вкладки Sorting.
 * Выбор режима:
 *  - sortMode = 'number' -> sortImagesByNumber
 *  - sortMode = 'color'  -> sortImagesByColor
 * Потом alignImagesInGivenOrder.
 */
async function handleSortingSubmit(event) {
  event.preventDefault();

  try {
    const form = document.getElementById("sorting-form");
    const imagesPerRow = Number(form.sortingImagesPerRow.value) || 1;
    const horizontalGap = Number(form.sortingHorizontalGap.value) || 0;
    const verticalGap = Number(form.sortingVerticalGap.value) || 0;
    const sizeMode = form.sortingSizeMode.value;
    const startCorner = form.sortingStartCorner.value;
    const sortMode = form.sortingSortMode.value || "number";

    const selection = await board.getSelection();
    let images = selection.filter((i) => i.type === "image");

    if (!images.length) {
      await board.notifications.showInfo(
        "Select at least one image on the board."
      );
      return;
    }

    if (imagesPerRow < 1) {
      await board.notifications.showError(
        "“Images per row” must be greater than 0."
      );
      return;
    }

    let orderedImages;

    if (sortMode === "color") {
      await board.notifications.showInfo("Sorting by average color…");
      orderedImages = await sortImagesByColor(images);
    } else {
      // number mode
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

/* ---------- STITCH TAB ---------- */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Sort File objects by name:
 *  - files with trailing number go first, sorted by that number
 *  - then files without number, sorted alphabetically
 */
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

  console.groupCollapsed("Stitch – files & numbers");
  arr.forEach((m) => {
    console.log(m.name, "=>", m.num);
  });
  console.groupEnd();

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

  return arr.map((m) => m.file);
}

/**
 * Handle Stitch tab:
 *  - read selected files,
 *  - sort files by name (with numeric suffix),
 *  - create images on the board,
 *  - align them into a grid in the chosen corner with gap = 0,
 *  - zoom viewport to the stitched area.
 */
async function handleStitchSubmit(event) {
  event.preventDefault();

  const stitchButton = document.getElementById("stitchButton");
  const progressEl = document.getElementById("stitchProgress");

  try {
    const form = document.getElementById("stitch-form");
    const imagesPerRow = Number(form.stitchImagesPerRow.value) || 1;
    const startCorner = form.stitchStartCorner.value;

    const input = document.getElementById("stitchFolderInput");
    const files = input.files;

    if (!files || !files.length) {
      await board.notifications.showError(
        "Please choose one or more image files."
      );
      return;
    }

    if (imagesPerRow < 1) {
      await board.notifications.showError(
        "“Images per row” must be greater than 0."
      );
      return;
    }

    stitchButton.disabled = true;
    progressEl.textContent = "Preparing files…";

    const sortedFiles = sortFilesByNameWithNumber(files);

    const createdImages = [];
    const baseX = 0;
    const baseY = 0;
    const offsetStep = 50;

    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];

      progressEl.textContent = `Importing ${i + 1} / ${sortedFiles.length}…`;

      const dataUrl = await readFileAsDataUrl(file);

      const img = await board.createImage({
        url: dataUrl,
        x: baseX + (i % 5) * offsetStep,
        y: baseY + Math.floor(i / 5) * offsetStep,
        title: file.name, // сохраним имя файла в title
      });

      createdImages.push(img);
    }

    progressEl.textContent = "Aligning images…";

    // align with no gaps
    await alignImagesInGivenOrder(createdImages, {
      imagesPerRow,
      horizontalGap: 0,
      verticalGap: 0,
      sizeMode: "none",
      startCorner,
    });

    // zoom to stitched area
    try {
      await board.viewport.zoomTo(createdImages);
    } catch (e) {
      console.warn("zoomTo failed or not supported with items:", e);
    }

    progressEl.textContent = "Done.";
    await board.notifications.showInfo(
      `Imported and stitched ${createdImages.length} image${
        createdImages.length === 1 ? "" : "s"
      }.`
    );
  } catch (err) {
    console.error(err);
    progressEl.textContent = "Error.";
    await board.notifications.showError(
      "Something went wrong while importing images. Please check the console."
    );
  } finally {
    stitchButton.disabled = false;
  }
}

/* ---------- init ---------- */

window.addEventListener("DOMContentLoaded", () => {
  const sortingForm = document.getElementById("sorting-form");
  if (sortingForm) sortingForm.addEventListener("submit", handleSortingSubmit);

  const stitchForm = document.getElementById("stitch-form");
  if (stitchForm) stitchForm.addEventListener("submit", handleStitchSubmit);
});
