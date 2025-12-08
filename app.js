// app.js
// Image Align Tool: Sorting (align selection) & Stitch (import and align).
const { board } = window.miro;

// --- color settings ---
const SAT_CODE_MAX = 99;
const SAT_BOOST = 4.0;
const SAT_GROUP_THRESHOLD = 10; // <= порога — "серые", > — цветные

/* ---------- helpers: titles & numbers ---------- */

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

/* ---------- SORTING: by color ---------- */

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
      if (a.group !== b.group) return a.group - b.group;         // серые → цветные
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

/* ---------- SORTING handler ---------- */

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

/* ---------- STITCH helpers ---------- */

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

/* ---------- STITCH handler (прогресс-бар + ETA по средней скорости создания) ---------- */

async function handleStitchSubmit(event) {
  event.preventDefault();

  const stitchButton = document.getElementById("stitchButton");
  const progressBarEl = document.getElementById("stitchProgressBar");
  const progressMainEl = document.getElementById("stitchProgressMain");
  const progressEtaEl = document.getElementById("stitchProgressEta");

  const updateBarAndText = (label, doneSteps, totalSteps) => {
    const frac = totalSteps > 0 ? doneSteps / totalSteps : 0;
    if (progressBarEl) {
      progressBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
    }
    if (progressMainEl) {
      progressMainEl.textContent = label || "";
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

    // reset progress UI
    if (progressBarEl) progressBarEl.style.width = "0%";
    if (progressMainEl) progressMainEl.textContent = "";
    if (progressEtaEl) progressEtaEl.textContent = "";

    const filesArray = Array.from(files);
    const totalSteps = filesArray.length * 2 + 1; // чтение+анализ, создание, выравнивание
    let doneSteps = 0;

    const fileInfos = [];

    // центр текущего вида
    let baseX = 0;
    let baseY = 0;
    try {
      const viewport = await board.viewport.get();
      baseX = viewport.x + viewport.width / 2;
      baseY = viewport.y + viewport.height / 2;
    } catch (e) {
      console.warn("Could not get viewport, falling back to (0,0):", e);
    }

    // --- 1. чтение и анализ файлов (ETA здесь не считаем, только прогресс) ---
    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];

      updateBarAndText(
        `Processing ${i + 1} / ${filesArray.length}`,
        doneSteps,
        totalSteps
      );
      setEtaText(null); // без времени на этом этапе

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

      const briCodeRaw = Math.round((1 - brightness) * 999);
      const briCode = Math.max(0, Math.min(999, briCodeRaw));

      const boostedSat = Math.min(1, saturation * SAT_BOOST);
      const satCodeRaw = Math.round(boostedSat * SAT_CODE_MAX);
      const satCode = Math.max(0, Math.min(SAT_CODE_MAX, satCodeRaw));

      fileInfos.push({ file, dataUrl, brightness, saturation, briCode, satCode });

      doneSteps++;
      updateBarAndText(
        `Processing ${i + 1} / ${filesArray.length}`,
        doneSteps,
        totalSteps
      );
    }

    // --- 2. сортировка файлов ---
    updateBarAndText("Ordering files…", doneSteps, totalSteps);
    setEtaText(null);

    const orderedFiles = sortFilesByNameWithNumber(filesArray);
    const infoByFile = new Map();
    fileInfos.forEach((info) => infoByFile.set(info.file, info));
    const orderedInfos = orderedFiles.map((f) => infoByFile.get(f));

    // --- 3. создание виджетов + ETA по средней скорости создания ---
    const createdImages = [];
    const offsetStep = 50;
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");

    const totalImages = orderedInfos.length;
    let creationCount = 0;
    let creationTimeSumMs = 0;

    for (let i = 0; i < orderedInfos.length; i++) {
      const info = orderedInfos[i];
      const title = `C${pad2(info.satCode)}/${pad3(info.briCode)} ${info.file.name}`;

      const indexHuman = i + 1;
      updateBarAndText(
        `Creating ${indexHuman} / ${totalImages}`,
        doneSteps,
        totalSteps
      );

      const t0 = performance.now();
      const img = await board.createImage({
        url: info.dataUrl,
        x: baseX + (i % 5) * offsetStep,
        y: baseY + Math.floor(i / 5) * offsetStep,
        title,
      });
      const t1 = performance.now();

      createdImages.push(img);

      const duration = t1 - t0; // ms
      creationCount += 1;
      creationTimeSumMs += duration;
      const avgPerImageMs = creationTimeSumMs / creationCount;
      const remainingImages = totalImages - creationCount;
      const etaMs =
        remainingImages > 0 ? avgPerImageMs * remainingImages : null;

      doneSteps++;
      updateBarAndText(
        `Creating ${indexHuman} / ${totalImages}`,
        doneSteps,
        totalSteps
      );
      setEtaText(etaMs);
    }

    // --- 4. выравнивание ---
    updateBarAndText("Aligning images…", doneSteps, totalSteps);
    setEtaText(null);

    await alignImagesInGivenOrder(createdImages, {
      imagesPerRow,
      horizontalGap: 0,
      verticalGap: 0,
      sizeMode: "none",
      startCorner,
    });

    doneSteps++;
    updateBarAndText("Done!", doneSteps, totalSteps);
    setEtaText(null);

    try {
      await board.viewport.zoomTo(createdImages);
    } catch (e) {
      console.warn("zoomTo failed or not supported with items:", e);
    }

    await board.notifications.showInfo(
      `Imported and stitched ${createdImages.length} image${
        createdImages.length === 1 ? "" : "s"
      }.`
    );
  } catch (err) {
    console.error(err);
    if (progressMainEl) progressMainEl.textContent = "Error";
    if (progressEtaEl) progressEtaEl.textContent = "";
    if (progressBarEl) progressBarEl.style.width = "0%";
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

  // кастомный файл-пикер
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
