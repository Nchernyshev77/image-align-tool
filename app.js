// app.js
// Arrange selected images into a grid in Miro.

const { board } = window.miro;

/**
 * Get readable title for an item.
 * We rely on title; alt is just a fallback in case.
 */
function getTitle(item) {
  return (item.title || item.alt || "").toString();
}

/**
 * Build sorted list of images according to the rules:
 * 1) Images whose title contains a number go first, sorted by that number (asc).
 * 2) Images without numbers go after them, sorted alphabetically by title.
 * 3) If titles are identical, we keep a stable order using original index.
 *
 * If sortByNumber is false, we ignore numbers and sort simply by title.
 */
function sortImages(images, sortByNumber) {
  const meta = images.map((item, index) => {
    const title = getTitle(item);
    const titleLower = title.toLowerCase();

    // Last group of digits in the string (so "tile_001_02" -> 2)
    const match = title.match(/(\d+)(?!.*\d)/);
    const hasNumber = !!match;
    const number = hasNumber ? parseInt(match[1], 10) : null;

    return { item, index, title, titleLower, hasNumber, number };
  });

  console.groupCollapsed("Image Grid Aligner – titles & numbers");
  meta.forEach((m) => {
    console.log(m.title || m.item.id, "=>", m.number);
  });
  console.groupEnd();

  if (sortByNumber) {
    meta.sort((a, b) => {
      const aNum = a.hasNumber;
      const bNum = b.hasNumber;

      // 1) numbered first
      if (aNum && !bNum) return -1;
      if (!aNum && bNum) return 1;

      // 2) both numbered -> by number
      if (aNum && bNum) {
        if (a.number !== b.number) return a.number - b.number;
        // tie -> by title to keep it neat
        if (a.titleLower < b.titleLower) return -1;
        if (a.titleLower > b.titleLower) return 1;
        // absolute tie -> keep original index
        return a.index - b.index;
      }

      // 3) both WITHOUT numbers -> alphabetical by title
      if (a.titleLower < b.titleLower) return -1;
      if (a.titleLower > b.titleLower) return 1;
      return a.index - b.index;
    });
  } else {
    // Ignore numbers: pure alphabetical order by title
    meta.sort((a, b) => {
      if (a.titleLower < b.titleLower) return -1;
      if (a.titleLower > b.titleLower) return 1;
      return a.index - b.index;
    });
  }

  return meta.map((m) => m.item);
}

/**
 * Read form values from panel.html
 */
function getFormValues() {
  const form = document.getElementById("align-form");

  const imagesPerRow = Number(form.imagesPerRow.value) || 1;
  const horizontalGap = Number(form.horizontalGap.value) || 0;
  const verticalGap = Number(form.verticalGap.value) || 0;

  const sizeMode = form.sizeMode.value; // 'none' | 'width' | 'height'
  const startCorner = form.startCorner.value; // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

  const sortCheckbox = document.getElementById("sortByNumber");
  const sortByNumber = sortCheckbox ? sortCheckbox.checked : true;

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
 * Main handler — called when you click "Align selection" in the panel.
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

    // 1. Sort images ONLY by titles (numbers + alphabet) – no geometry.
    images = sortImages(images, sortByNumber);

    // 2. Optional resize
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

    // 3. Bounding box of current selection
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

    // Anchor grid to existing bounding box depending on chosen corner
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
      // Base indices for top-left
      let row = Math.floor(index / cols); // 0..rows-1 (top to bottom)
      let col = index % cols; // 0..cols-1 (left to right)

      // Adjust for corner
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
    await board.notifications.showError(
      "Something went wrong while aligning images. Please check the console."
    );
  }
}

/**
 * Hook up the form once the panel DOM is loaded.
 */
window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("align-form");
  if (form) {
    form.addEventListener("submit", onAlignSubmit);
  }
});
