// app.js
// Logic: take selected images and arrange them into a grid.

const { board } = window.miro;

/**
 * Extracts the LAST integer number from whatever name we can read.
 *
 * Uses item.title or item.alt (fallback to empty string).
 * Looks for the last group of digits anywhere in the string.
 */
function extractIndexFromItem(item) {
  const raw = (item.title || item.alt || "").toString();
  if (!raw) return null;

  // LAST group of digits in the string
  const match = raw.match(/(\d+)(?!.*\d)/);
  if (!match) return null;

  const num = Number.parseInt(match[1], 10);
  if (Number.isNaN(num)) return null;

  return num;
}

/**
 * Compare by geometry (top -> bottom, left -> right).
 */
function compareByGeometry(a, b) {
  const dy = a.y - b.y;
  if (Math.abs(dy) > Math.min(a.height, b.height) / 2) {
    return dy;
  }
  return a.x - b.x;
}

/**
 * Reads values from the form.
 */
function getFormValues() {
  const form = document.getElementById("align-form");

  const imagesPerRow = Number(form.imagesPerRow.value) || 1;
  const horizontalGap = Number(form.horizontalGap.value) || 0;
  const verticalGap = Number(form.verticalGap.value) || 0;

  const sizeMode = form.sizeMode.value; // 'none' | 'width' | 'height'
  const startCorner = form.startCorner.value; // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  const sortByNumber = document.getElementById("sortByNumber").checked;

  return {
    imagesPerRow,
    horizontalGap,
    verticalGap,
    sizeMode,
    startCorner,
    sortByNumber,
  };
}

/**
 * Main handler — called on form submit.
 */
async function onAlignSubmit(event) {
  event.preventDefault();

  try {
    const {
      imagesPerRow,
      horizontalGap,
      verticalGap,
      sizeMode,
      startCorner,
      sortByNumber,
    } = getFormValues();

    const selection = await board.getSelection();
    let images = selection.filter((item) => item.type === "image");

    if (images.length === 0) {
      await board.notifications.showInfo("Select at least one image.");
      return;
    }

    if (imagesPerRow < 1) {
      await board.notifications.showError(
        "Images per row must be greater than 0."
      );
      return;
    }

    // ---------- 1. Стабильная сортировка ----------

    let sortedImages;

    if (sortByNumber) {
      // Парсим номера у всех изображений
      const withIndex = images.map((img) => ({
        img,
        index: extractIndexFromItem(img),
      }));

      const someMissing = withIndex.some((m) => m.index === null);

      if (someMissing) {
        await board.notifications.showError(
          "Some images have no number. Rename or disable sorting."
        );
        return;
      }

      // Чистая сортировка только по числам
      withIndex.sort((a, b) => a.index - b.index);
      sortedImages = withIndex.map((m) => m.img);
    } else {
      // Без сортировки по номеру — просто геометрия
      sortedImages = [...images].sort(compareByGeometry);
    }

    images = sortedImages;

    // ---------- 2. Ресайз, если нужно ----------

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

    // После ресайза размеры актуальны
    const widths = images.map((img) => img.width);
    const heights = images.map((img) => img.height);

    const maxWidth = Math.max(...widths);
    const maxHeight = Math.max(...heights);

    // ---------- 3. Текущий bounding box ----------

    const bounds = images.map((img) => {
      return {
        item: img,
        left: img.x - img.width / 2,
        top: img.y - img.height / 2,
        right: img.x + img.width / 2,
        bottom: img.y + img.height / 2,
      };
    });

    const minLeft = Math.min(...bounds.map((b) => b.left));
    const minTop = Math.min(...bounds.map((b) => b.top));
    const maxRight = Math.max(...bounds.map((b) => b.right));
    const maxBottom = Math.max(...bounds.map((b) => b.bottom));

    // ---------- 4. Геометрия сетки ----------

    const total = images.length;
    const cols = Math.max(1, imagesPerRow);
    const rows = Math.ceil(total / cols);

    const cellWidth = maxWidth + horizontalGap;
    const cellHeight = maxHeight + verticalGap;

    const gridWidth = cols * maxWidth + (cols - 1) * horizontalGap;
    const gridHeight = rows * maxHeight + (rows - 1) * verticalGap;

    let originLeft;
    let originTop;

    // Куда "прилипает" сетка относительно старого bounding box
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

    // ---------- 5. Раскладываем по сетке ----------

    images.forEach((img, index) => {
      // базовые row/col для режима top-left
      let row = Math.floor(index / cols); // 0..rows-1 сверху вниз
      let col = index % cols; // 0..cols-1 слева направо

      // модифицируем row/col в зависимости от угла
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

    await board.notifications.showInfo(
      `Aligned ${images.length} image${images.length === 1 ? "" : "s"}.`
    );
  } catch (error) {
    console.error(error);
    await board.notifications.showError(
      "Aligning images failed. See console."
    );
  }
}

/**
 * Attach handler after panel DOM is ready.
 */
window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("align-form");
  form.addEventListener("submit", onAlignSubmit);
});
