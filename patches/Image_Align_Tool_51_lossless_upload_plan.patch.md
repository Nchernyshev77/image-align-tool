# Image Align Tool_51 — lossless upload patch

## Goal

Remove hidden JPEG recompression from Stitch/Slice import.

Rules:

1. If the original file fits Miro upload limit and does not need dimension slicing, upload the original File directly.
2. If the file does not fit the limit or needs slicing, crop it into image regions.
3. Cropped regions must be encoded as PNG Blob.
4. If a PNG Blob region is still too large, split the region again.
5. Do not generate JPEG from canvas at all.

## New constants

Replace:

```js
const MAX_URL_BYTES = 11000000;
```

with:

```js
const MIRO_IMAGE_LIMIT_BYTES = 32 * 1024 * 1024;
const SAFE_IMAGE_LIMIT_BYTES = 31 * 1024 * 1024;
const TILE_MIME = "image/png";
```

Keep `HUGE_TILE_MIME = "image/png"` or replace it with `TILE_MIME`.

## Replace JPEG data URL encoder

Remove the current JPEG encoder:

```js
function canvasToDataUrlUnderLimit(canvas) {
  const q = 0.8;
  const dataUrl = canvas.toDataURL("image/jpeg", q);
  if (dataUrl.length > MAX_URL_BYTES) {
    throw new DataUrlTooLargeError(
      `dataURL too large at q=${q} (len=${dataUrl.length}, cap=${MAX_URL_BYTES})`,
      dataUrl.length,
      MAX_URL_BYTES
    );
  }
  return dataUrl;
}
```

Add a PNG Blob encoder:

```js
function canvasToPngBlobUnderLimit(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PNG tile encode failed"));
        return;
      }
      if (blob.size > SAFE_IMAGE_LIMIT_BYTES) {
        reject(new DataUrlTooLargeError(
          `PNG blob too large (size=${blob.size}, cap=${SAFE_IMAGE_LIMIT_BYTES})`,
          blob.size,
          SAFE_IMAGE_LIMIT_BYTES
        ));
        return;
      }
      resolve(blob);
    }, TILE_MIME);
  });
}
```

The existing `DataUrlTooLargeError` class can remain for compatibility with current catch logic, but the message should now refer to PNG Blob, not data URL.

## Slice condition

Replace:

```js
const needsSlice = width > SLICE_THRESHOLD_WIDTH || height > SLICE_THRESHOLD_HEIGHT;
```

with:

```js
const needsDimensionSlice = width > SLICE_THRESHOLD_WIDTH || height > SLICE_THRESHOLD_HEIGHT;
const needsSizeSlice = file.size > SAFE_IMAGE_LIMIT_BYTES;
const needsSlice = needsDimensionSlice || needsSizeSlice;
```

## Direct upload for original files

In `processOneJob`, when `job.kind === "full"` and `file.size <= SAFE_IMAGE_LIMIT_BYTES`, upload the original file directly:

```js
const uploadOriginalFile = async () => {
  const title = `C${String(info.satCode).padStart(2, "0")}/${String(info.briCode).padStart(3, "0")} ${fileName}`;
  const url = URL.createObjectURL(file);
  try {
    await uploadOne(
      url,
      job.x,
      job.y,
      title,
      {
        fileName,
        satCode: info.satCode,
        briCode: info.briCode,
        originalUpload: true,
        originalMime: file.type || null,
        sourceFileSize: file.size || 0,
      },
      file.size || 0
    );
  } finally {
    URL.revokeObjectURL(url);
  }
};
```

Then:

```js
if (job.kind === "full" && file.size <= SAFE_IMAGE_LIMIT_BYTES) {
  await uploadOriginalFile();
  return;
}
```

This preserves original JPEG/PNG/WebP bytes when they fit the limit.

## Regular crop upload

In `uploadRegularRegionWithSubslice`, replace this part:

```js
const url = canvasToDataUrlUnderLimit(canvas);
await uploadOne(url, region.left + region.w / 2, region.top + region.h / 2, region.titleBase, region.metaBase, url.length);
```

with:

```js
const blob = await canvasToPngBlobUnderLimit(canvas);
const url = URL.createObjectURL(blob);
try {
  await uploadOne(
    url,
    region.left + region.w / 2,
    region.top + region.h / 2,
    region.titleBase,
    {
      ...region.metaBase,
      tileMime: TILE_MIME,
      blobSize: blob.size,
    },
    blob.size
  );
} finally {
  URL.revokeObjectURL(url);
}
```

## Split oversized regions

Current sub-slice logic splits into 4 parts. It is valid, but for fewer board objects the preferred rule is split by the longest side:

```js
function splitRegionByLongestSide(region, nextDepth, titleBase, mkMeta) {
  if (region.w >= region.h) {
    const w1 = Math.ceil(region.w / 2);
    const w2 = region.w - w1;
    const sw1 = Math.ceil(region.sw / 2);
    const sw2 = region.sw - sw1;
    return [
      {
        sx: region.sx,
        sy: region.sy,
        sw: sw1,
        sh: region.sh,
        left: region.left,
        top: region.top,
        w: w1,
        h: region.h,
        titleBase: `${titleBase} s${nextDepth}a`,
        metaBase: mkMeta("x", 0),
        depth: nextDepth,
      },
      {
        sx: region.sx + sw1,
        sy: region.sy,
        sw: sw2,
        sh: region.sh,
        left: region.left + w1,
        top: region.top,
        w: w2,
        h: region.h,
        titleBase: `${titleBase} s${nextDepth}b`,
        metaBase: mkMeta("x", 1),
        depth: nextDepth,
      },
    ];
  }

  const h1 = Math.ceil(region.h / 2);
  const h2 = region.h - h1;
  const sh1 = Math.ceil(region.sh / 2);
  const sh2 = region.sh - sh1;
  return [
    {
      sx: region.sx,
      sy: region.sy,
      sw: region.sw,
      sh: sh1,
      left: region.left,
      top: region.top,
      w: region.w,
      h: h1,
      titleBase: `${titleBase} s${nextDepth}a`,
      metaBase: mkMeta("y", 0),
      depth: nextDepth,
    },
    {
      sx: region.sx,
      sy: region.sy + sh1,
      sw: region.sw,
      sh: sh2,
      left: region.left,
      top: region.top + h1,
      w: region.w,
      h: h2,
      titleBase: `${titleBase} s${nextDepth}b`,
      metaBase: mkMeta("y", 1),
      depth: nextDepth,
    },
  ];
}
```

When splitting into two parts:

```js
totalTiles += 1;
```

not `+= 3`.

## Huge mode

Huge mode already renders tiles and encodes them to PNG Blob. Add the same size check after:

```js
const blob = await rgbaBufferToPngBlob(buffer, width, height);
```

If `blob.size > SAFE_IMAGE_LIMIT_BYTES`, split that region again instead of uploading or recompressing.

## Required test cases

1. Small JPEG under 31 MiB: uploads original file, no canvas encoding.
2. Small PNG under 31 MiB: uploads original file, no canvas encoding.
3. Existing tile folder under 31 MiB per tile: uploads original tiles as-is.
4. Single file over 31 MiB: slices to PNG tiles.
5. PNG tile over 31 MiB: splits recursively.
6. Huge image path: still uses worker, PNG only.
7. No generated `image/jpeg` remains in `app.js` except references in MIME detection or comments.
