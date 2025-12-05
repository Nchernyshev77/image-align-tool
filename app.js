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
 * "Name 10a2" -> 2 (last group)
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
    const top = originTop + row * cellH*
