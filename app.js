// app.js
// Arrange selected images into a grid.

const { board } = window.miro;

/**
 * Extract the LAST integer number from item.title.
 * Any number of leading zeros is OK: 1, 01, 0001, 10, 011…
 *
 * Examples:
 *  "tile_01"          -> 1
 *  "tile01"           -> 1
 *  "tile_0003.png"    -> 3
 *  "my-tile-10 (copy)"-> 10
 *  "img_42"           -> 42
 */
function extractIndexFromItem(item) {
  const raw = (item.title || "").toString();
  if (!raw) return null;

  // Last group of digits in the string
  const match = raw.match(/(\d+)(?!.*\d)/);
  if (!match) return null;

  const num = Number.parseInt(match[1], 10);
  return Number.isNaN(num) ? null : num;
}

/**
 * STRICT sort:
 * - If sortByNumber = true:
 *     * every image MUST have a number in the title;
 *     * otherwise we throw an error and do NOT move anything.
 *     * sort = pure numeric order (1,2,3,…).
 * - If sortByNumber = false:
 *     * keep original selection order (no sorting).
 */
function sortImages(images, sortByNumber) {
  const meta = images.map((item, i) => ({
    item,
    index: extractIndexFromItem(item),
    orig: i,
  }));

  console.groupCollapsed("Image Grid Aligner – parsed indices");
  meta.forEach((m) => {
    console.log(m.item.title || m.item.id, "->", m.index);
  });
  console.groupEnd();

  if (sortByNumber) {
    const missing = meta.filter((m) => m.index === null);
    if (missing.length > 0) {
      const examples = missing
        .slice(0, 3)
        .map((m) => m.item.title || m.item.id)
        .join(", ");
      throw new Error(
        `Some selected images don't contain a number in their name. ` +
          `Examples: ${examples}`
      );
    }

    meta.sort((a, b) => a.index - b.index);
  } else {
    // No numeric sort – keep selection order
    meta.sort((a, b) => a.orig - b.orig);
  }

  return meta.map((m) => m.item);
}

/**
 * Read form values.
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

    // 1. STRICT sort
    images = sortImages(images, sortByNumber);

    // 2. Resize images if needed
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

    // After resizing, sizes are up to date
    const widths = images.map((img) => img.width);
    const heights = images.map((img) => img.height);

    const maxWidth = Math.max(...widths);
    const maxHeight = Math.max(...heights);

    // 3. Current bounding box of selection
    const bounds = images.map((img) => ({
      item: img,
      left: img.x - img.width / 2,
      top: img.y - img.height / 2,
      right: img.x + img.width / 2,
      bottom: img.y + img.height / 2,
    }));

    const minLeft = Math.min(...bounds.map((b) => b.left));
    const minTop = Math.min(...bounds.map((b) => b.top));
    const maxRight = Math.max(...bounds.map((b) => b.right));
    const maxBottom = Math.max(...bounds.map((b) => b.bottom));

    // 4. Grid geometry
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

    // 5. Place images into grid
    images.forEach((img, index) => {
      // row/col for top-left mode
      let row = Math.floor(index / cols); // 0..rows-1, top -> bottom
      let col = index % cols; // 0..cols-1, left -> right

      // Adjust row/col depending on corner
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
      `Done: aligned ${images.length} image${images.length === 1 ? "" : "s"}.`
    );
  } catch (error) {
    console.error(error);

    if (error.message && error.message.startsWith("Some selected images")) {
      await board.notifications.showError(error.message);
    } else {
      await board.notifications.showError(
        "Something went wrong while aligning images. Please check the console."
      );
    }
  }
}

/**
 * Attach handler after panel DOM is ready.
 */
window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("align-form");
  form.addEventListener("submit", onAlignSubmit);
});
