// app.js
// Image Align Tool: Sorting (align selection) & Stitch (import and align).
const { board } = window.miro;

// --- color settings ---
const SAT_CODE_MAX = 99;              // максимум кода сатурации (00..99)
const SAT_BOOST = 4.0;                // усиливаем сатурацию, чтобы растянуть шкалу
const SAT_GROUP_THRESHOLD = 10;       // <= порога — считаем "серым", > — цветным

/* ---------- helpers: titles & numbers ---------- */

function getTitle(item) {
  return (item.title || "").toString();
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
 * Яркость + сатурация по размытой центральной части изображения.
 * Обрезаем 30% сверху и по 20% слева/справа.
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

    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; // яркость
    sumY += y;

    const maxv = Math.max(r, g, b);
    const minv = Math.min(r, g, b);
    sumDiff += maxv - minv; // разброс каналов = цветность
  }

  const avgY = sumY / totalPixels;
  const avgDiff = sumDiff / totalPixels;

  const brightness = avgY / 255;
  const saturationApprox = avgDiff / 255;

  return { brightness, saturation: saturationApprox };
}

/* ---------- helpers: alignment ---------- */

async function alignImagesInGivenOrder(images, config) {
  const {
    imagesPerRow,
    horizontalGap,
    verticalGap,
    sizeMode,
    startCorner,
  } = config;

  if (!images.length) return;

  // нормализация размера
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
  const maxBottom = Math.min
    ? Math.max(...bounds.map((b) => b.bottom))
    : Math.max(...bounds.map((b) => b.bottom));

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

/* ---------- SORTING: by color (через коды в title) ---------- */

/**
 * Title: "CSS/BBB имя"
 *   SS  = 0..99   – код сатурации (0 – серое/бледное, 99 – очень цветное)
 *   BBB = 0..999  – код яркости (000 – белое, 999 – чёрное)
 *
 * Порядок:
 *   0. сначала серые: SS <= SAT_GROUP_THRESHOLD,
 *      затем цветные: SS > SAT_GROUP_THRESHOLD;
 *   1. внутри каждой группы – по яркости от белого к чёрному (BBB по возрастанию);
 *   2. при одинаковой яркости – по сатурации (от бледных к насыщенным).
 */
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
      if (a.group !== b.group) return a.group - b.group;           // серые → цветные
      if (a.briCode !== b.briCode) return a.briCode - b.briCode;   // светлее → темнее
      if (a.satCode !== b.satCode) return a.satCode - b.satCode;   // бледнее → насыщеннее
      return a.index - b.index;
    }
    if (a.hasCode) return -1;
    if (b.hasCode) return 1;
    return a.index - b.index;
  });

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
        "“Rows” must be greater than 0."
      );
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

/* ---------- STITCH TAB ---------- */

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

  console.groupCollapsed("Stitch – files & numbers");
  arr.forEach((m) => console.log(m.name, "=>", m.num));
  console.groupEnd();

  const anyHasNumber = arr.some((m) => m.hasNumber);

  if (!anyHasNumber) {
    // ни у одного файла нет числа в имени — просто рандом
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
        "Please select one or more image files."
      );
      return;
    }

    if (imagesPerRow < 1) {
      await board.notifications.showError(
        "“Rows” must be greater than 0."
      );
      return;
    }

    if (stitchButton) stitchButton.disabled = true;
    if (progressEl) progressEl.textContent = "Reading files…";

    const filesArray = Array.from(files);
    const fileInfos = [];

    // Центр текущего вида
    let baseX = 0;
    let baseY = 0;
    try {
      const viewport = await board.viewport.get();
      baseX = viewport.x + viewport.width / 2;
      baseY = viewport.y + viewport.height / 2;
    } catch (e) {
      console.warn("Could not get viewport, falling back to (0,0):", e);
    }

    // читаем и считаем яркость/сатурацию
    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];

      if (progressEl) {
        progressEl.textContent = `Processing ${i + 1} / ${filesArray.length}…`;
      }

      const dataUrl = await readFileAsDataUrl(file);

      let brightness = 0.5;
      let saturation = 0.0;

      try {
        const imgEl = await loadImage(dataUrl);
        const res = getBrightnessAndSaturationFromImageElement(imgEl);
        if (res) {
          brightness = res.brightness;
          saturation = res.saturation;
        }
      } catch (e) {
        console.warn(
          "Failed to compute brightness/saturation for stitched image:",
          file.name,
          e
        );
      }

      // яркость -> код 000..999 (0 – белое, 999 – чёрное)
      const briCodeRaw = Math.round((1 - brightness) * 999);
      const briCode = Math.max(0, Math.min(999, briCodeRaw));

      // сатурация -> код 00..99 (усиленная)
      const boostedSat = Math.min(1, saturation * SAT_BOOST);
      const satCodeRaw = Math.round(boostedSat * SAT_CODE_MAX);
      const satCode = Math.max(0, Math.min(SAT_CODE_MAX, satCodeRaw));

      fileInfos.push({ file, dataUrl, brightness, saturation, briCode, satCode });
    }

    if (progressEl) progressEl.textContent = "Ordering files…";

    const orderedFiles = sortFilesByNameWithNumber(filesArray);
    const infoByFile = new Map();
    fileInfos.forEach((info) => infoByFile.set(info.file, info));
    const orderedInfos = orderedFiles.map((f) => infoByFile.get(f));

    if (progressEl) progressEl.textContent = "Creating images…";

    const createdImages = [];
    const offsetStep = 50;

    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");

    for (let i = 0; i < orderedInfos.length; i++) {
      const info = orderedInfos[i];
      const title = `C${pad2(info.satCode)}/${pad3(info.briCode)} ${info.file.name}`;

      if (progressEl) {
        progressEl.textContent = `Creating ${i + 1} / ${orderedInfos.length}…`;
      }

      const img = await board.createImage({
        url: info.dataUrl,
        x: baseX + (i % 5) * offsetStep,
        y: baseY + Math.floor(i / 5) * offsetStep,
        title,
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

/* ---------- init (tabs + forms + file button) ---------- */

window.addEventListener("DOMContentLoaded", () => {
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

  if (tabButtons.length && tabContents.sorting && tabContents.stitch) {
    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
    activateTab("sorting");
  }

  // кастомная кнопка выбора файлов
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
