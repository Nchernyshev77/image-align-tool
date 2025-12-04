// app.js
// Logic: take selected images and arrange them into a grid.

const { board } = window.miro;

/**
 * Extracts the first integer number from an image title.
 * Supports any number of leading zeros: 1, 01, 0003, 10, 011, etc.
 * Returns number or null if no digits found.
 */
function extractIndexFromTitle(title) {
  if (!title) return null;
  const match = String(title).match(/\d+/);
  if (!match) return null;
  return Number.parseInt(match[0], 10);
}

/**
 * Compare function for geometric ordering (top -> bottom, left -> right).
 */
function compareByGeometry(a, b) {
  const dy = a.y - b.y;
  // если по вертикали сильно различаются — сравниваем по Y
  if (Math.abs(dy) > Math.min(a.height, b.height) / 2) {
    return dy;
  }
  // иначе считаем, что в одной строке, и сравниваем по X
  return a.x - b.x;
}

/**
 * Sort images either by number in title (if present) or by geometry.
 */
function sortImages(images, sortByNumber) {
  const withMeta = images.map((item) => ({
    item,
    index: extractIndexFromTitle(item.title),
  }));

  const anyIndex = withMeta.some((m) => m.index !== null);

  if (sortByNumber && anyIndex) {
    withMeta.sort((a, b) => {
      const ai = a.index;
      const bi = b.index;

      if (ai !== null && bi !== null) {
        if (ai !== bi) return ai - bi;
        // если числа равны, fallback к геометрии
        return compareByGeometry(a.item, b.item);
      }

      if (ai !== null) return -1; // с номером раньше без номера
      if (bi !== null) return 1;
      return compareByGeometry(a.item, b.item);
    });
  } else {
    withMeta.sort((a, b) => compareByGeometry(a.item, b.item));
  }

  return withMeta.map((m) => m.item);
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
  const sortByNumber = form.sortByNumber.checked;

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
 * Computes grid position (row from top, col from left) for a given
 * linear index based on the chosen starting corner.
 */
function computeGridPosition(index, cols, rows, startCorner) {
  const rowIndex = Math.floor(index / cols);
  const colIndex = index % cols;

  const fromTop = startCorner.startsWith("top");
  const fromLeft = startCorner.endsWith("left");

  const rowFromTop = fromTop ? rowIndex : rows - 1 - rowIndex;
  const colFromLeft = fromLeft ? colIndex : cols - 1 - colIndex;

  return { rowFromTop, colFromLeft };
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

    // Get current selection on the board
    const selection = await board.getSelection();
    let images = selection.filter((item) => item.type === "image");

    if (images.length === 0) {
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

    // Sort images (by number in title if possible, otherwise by geometry)
    images = sortImages(images, sortByNumber);

    // -----------------------------
    // 1. Resize images if needed
    // -----------------------------
    if (sizeMode === "width") {
      const targetWidth = Math.min(...images.map((img) => img.width));
      for (const img of images) {
        img.width = targetWidth; // height keeps aspect ratio
      }
      await Promise.all(images.map((img) => img.sync()));
    } else if (sizeMode === "height") {
      const targetHeight = Math.min(...images.map((img) => img.height));
      for (const img of images) {
        img.height = targetHeight; // width keeps aspect ratio
      }
      await Promise.all(images.map((img) => img.sync()));
    }

    // After resizing, sizes are up to date
    const widths = images.map((img) => img.width);
    const heights = images.map((img) => img.height);

    const maxWidth = Math.max(...widths);
    const maxHeight = Math.max(...heights);

    // -----------------------------
    // 2. Current bounding box of selection
    // -----------------------------
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

    // -----------------------------
    // 3. Grid geometry
    // -----------------------------
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

    // -----------------------------
    // 4. Place images into grid
    // -----------------------------
    images.forEach((img, index) => {
      const { rowFromTop, colFromLeft } = computeGridPosition(
        index,
        cols,
        rows,
        startCorner
      );

      const targetLeft = originLeft + colFromLeft * cellWidth;
      const targetTop = originTop + rowFromTop * cellHeight;

      img.x = targetLeft + img.width / 2;
      img.y = targetTop + img.height / 2;
    });

    await Promise.all(images.map((img) => img.sync()));

    await board.notifications.showInfo(
      `Done: aligned ${images.length} image${images.length === 1 ? "" : "s"}.`
    );
  } catch (error) {
    console.error(error);
    await board.notifications.showError(
      "Something went wrong while aligning images. Please check the console."
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
