// app.js
// Image Tools: Sorting (align selection) & Stitch (import and align).
const { board } = window.miro;

// ключ в metadata, куда пишем нашу информацию
const METADATA_KEY = "imageGridAligner";

/* ---------- helpers: titles & numbers ---------- */

function getTitle(item) {
  return (item.title || "").toString();
}

/**
 * Попробовать вытащить URL картинки из разных полей виджета.
 */
function getImageUrlFromWidget(widget) {
  if (!widget) return null;

  if (widget.url) return widget.url;
  if (widget.contentUrl) return widget.contentUrl;
  if (widget.previewUrl) return widget.previewUrl;
  if (widget.originalUrl) return widget.originalUrl;

  if (widget.style) {
    if (widget.style.imageUrl) return widget.style.imageUrl;
    if (widget.style.backgroundImage) return widget.style.backgroundImage;
    if (widget.style.src) return widget.style.src;
  }

  if (widget.metadata) {
    if (widget.metadata.imageUrl) return widget.metadata.imageUrl;
    if (widget.metadata.url) return widget.metadata.url;
  }

  return null;
}

/**
 * Вытянуть ПОСЛЕДНЕЕ целое число из строки.
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
 * Сортировка по геометрии: сверху вниз, внутри строки слева направо.
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

/* ---------- helpers: image loading & brightness ---------- */

/**
 * Загрузить картинку по URL в <img>.
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
 * Средняя яркость (luminance) Y в [0..1] из РАЗМЫТОГО изображения.
 * 1) уменьшаем картинку до smallSize x smallSize;
 * 2) применяем blur(blurPx);
 * 3) считаем среднюю яркость по всем пикселям.
 */
function getBlurredAverageLuminanceFromImageElement(
  img,
  smallSize = 50,
  blurPx = 3
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
  } catch (e) {
    // если фильтры не поддерживаются, просто игнорируем
  }

  ctx.drawImage(img, 0, 0, width, height);

  ctx.filter = prevFilter;

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch (e) {
    console.error("getImageData failed (CORS?):", e);
    return null;
  }

  const data = imageData.data;
  let sumY = 0;
  const totalPixels = width * height;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumY += y;
  }

  const avgY = sumY / totalPixels; // 0..255
  return avgY / 255; // 0..1
}

/* ---------- helpers: alignment ---------- */

/**
 * Выравнять картинки в том порядке, в котором они приходят в массиве images.
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

  // нормализация размера при необходимости
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

/* ---------- SORTING: by number ---------- */

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

/* ---------- SORTING: by color / brightness ---------- */

/**
 * Сортировка по средней яркости:
 *  - сначала читаем brightness из metadata (для картинок, импортированных через Stitch),
 *  - если brightness нет — пытаемся посчитать по URL (если Miro его отдаёт),
 *  - если ни для кого не получилось — fallback на геометрию.
 */
async function sortImagesByColor(images) {
  const meta = [];

  for (const imgItem of images) {
    let y;

    // 1) пытаемся взять яркость из metadata
    const md = imgItem.metadata && imgItem.metadata[METADATA_KEY];
    if (md && typeof md.brightness === "number") {
      y = md.brightness;
      meta.push({ img: imgItem, y, source: "metadata" });
      continue;
    }

    // 2) fallback: пробуем посчитать по URL, если он есть
    const url = getImageUrlFromWidget(imgItem);
    if (!url) {
      console.warn("No URL found for image (no color data):", imgItem.id);
      continue;
    }

    try {
      const img = await loadImage(url);
      const yy = getBlurredAverageLuminanceFromImageElement(img);
      if (yy == null) {
        console.warn(
          "Failed to compute blurred luminance, fallback neutral:",
          imgItem.id
        );
        meta.push({ img: imgItem, y: 0.5, source: "fallback" });
      } else {
        meta.push({ img: imgItem, y: yy, source: "url" });
      }
    } catch (e) {
      console.error("Error reading image for brightness sort", imgItem.id, e);
      meta.push({ img: imgItem, y: 0.5, source: "error" });
    }
  }

  if (!meta.length) {
    console.warn(
      "Could not compute brightness for any image, falling back to geometry sort."
    );
    return sortByGeometry(images);
  }

  console.groupCollapsed("Sorting (brightness) – metadata/url luminance");
  meta.forEach((m) => {
    console.log(
      m.img.title || m.img.id,
      "=>",
      `y=${m.y.toFixed(3)}`,
      `(${m.source})`
    );
  });
  console.groupEnd();

  meta.sort((a, b) => b.y - a.y); // ярче -> раньше

  return meta.map((m) => m.img);
}

/* ---------- SORTING: main handler ---------- */

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
      await board.notifications.showError(
        "“Images per row” must be greater than 0."
      );
      return;
    }

    let orderedImages;

    if (sortMode === "color") {
      await board.notifications.showInfo("Sorting by brightness…");
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
 * Сортировка файлов по имени:
 *  - сначала с числовым суффиксом, внутри — по числу,
 *  - затем без чисел, по алфавиту.
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
 * Stitch:
 *  - читаем выбранные файлы,
 *  - считаем яркость и сохраняем её в metadata,
 *  - сортируем файлы по имени (с учётом чисел),
 *  - создаём картинки на доске,
 *  - выравниваем без gap,
 *  - зумим в область.
 */
async function handleStitchSubmit(event) {
  event.preventDefault();

  const stitchButton = document.getElementById("stitchButton");
  const progressEl = document.getElementById("stitchProgress");

  try {
    const form = document.getElementById("stitch-form");
    if (!form) return;

    const imagesPerRow = Number(form.stitchImagesPerRow.value) || 1;
    const startCorner = form.stitchStartCorner.value;

    const input = document.getElementById("stitchFolderInput");
    const files = input ? input.files : null;

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

    if (stitchButton) stitchButton.disabled = true;
    if (progressEl) progressEl.textContent = "Preparing files…";

    const sortedFiles = sortFilesByNameWithNumber(files);

    const createdImages = [];
    const baseX = 0;
    const baseY = 0;
    const offsetStep = 50;

    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];

      if (progressEl) {
        progressEl.textContent = `Importing ${i + 1} / ${sortedFiles.length}…`;
      }

      const dataUrl = await readFileAsDataUrl(file);

      // считаем яркость для metadata
      let brightness = 0.5;
      try {
        const imgForColor = await loadImage(dataUrl);
        const y = getBlurredAverageLuminanceFromImageElement(imgForColor);
        if (y != null) brightness = y;
      } catch (e) {
        console.warn("Failed to compute brightness for stitched image:", e);
      }

      const img = await board.createImage({
        url: dataUrl,
        x: baseX + (i % 5) * offsetStep,
        y: baseY + Math.floor(i / 5) * offsetStep,
        title: file.name,
        metadata: {
          [METADATA_KEY]: {
            brightness,
          },
        },
      });

      createdImages.push(img);
    }

    if (progressEl) progressEl.textContent = "Aligning images…";

    await alignImagesInGivenOrder(createdImages, {
      imagesPerRow,
      horizontalGap: 0,
      verticalGap: 0,
      sizeMode: "none",
      startCorner,
    });

    try {
      await board.viewport.zoomTo(createdImages);
    } catch (e) {
      console.warn("zoomTo failed or not supported with items:", e);
    }

    if (progressEl) progressEl.textContent = "Done.";
    await board.notifications.showInfo(
      `Imported and stitched ${createdImages.length} image${
        createdImages.length === 1 ? "" : "s"
      }.`
    );
  } catch (err) {
    console.error(err);
    if (progressEl) progressEl.textContent = "Error.";
    await board.notifications.showError(
      "Something went wrong while importing images. Please check the console."
    );
  } finally {
    if (stitchButton) stitchButton.disabled = false;
  }
}

/* ---------- init ---------- */

window.addEventListener("DOMContentLoaded", () => {
  const sortingForm = document.getElementById("sorting-form");
  if (sortingForm) sortingForm.addEventListener("submit", handleSortingSubmit);

  const stitchForm = document.getElementById("stitch-form");
  if (stitchForm) stitchForm.addEventListener("submit", handleStitchSubmit);
});
