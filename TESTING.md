# Lossless PNG slices — test 53

Branch: `test/original-upload-52`. Main remains at `ac272f733fe2b4c736475f5359eec310459ae685`.

## Upload behavior

The live test established a 30,000,000-byte limit on the SDK `url` property, including JSON quotes. Base64 contributes `4 * ceil(fileBytes / 3)` bytes, plus the data URL prefix and two quotes. For `image/jpeg`, the largest original fitting that formula is 22,499,979 bytes.

- Original tiles fitting that limit are passed through byte-for-byte.
- Oversized tiles are decoded once at native resolution. Try 2 strips, then 3, then 4, and further counts if necessary for a larger region (maximum 256). Use the longer axis; square tiles split left-to-right.
- Every candidate PNG is measured, including its color metadata, before any part of that layout uploads. An oversized part rejects the entire candidate layout.
- Pixel boundaries use integer coordinates. A 4096-wide tile split three ways has widths 1365, 1365, 1366. No resizing or smoothing. Parts exactly occupy the original tile's slot, including reversed grid corners and missing numbered slots.
- Ordinary large-image regions now use PNG too, replacing the old JPEG quality 0.8 encoding. Huge mode retains 2048-pixel base regions and now sends measured Base64 PNGs instead of browser-local blob URLs.
- Uploads are sequential, without automatic SDK retries. On a partial upload failure, existing pieces remain visible and the report says `partial`; remaining pieces of that region stop and the next source/region continues. This avoids creating duplicates after ambiguous failures.

## Color and precision

JPEG decoding uses `createImageBitmap` with `colorSpaceConversion: none`. The original RGB ICC profile, when present, is reassembled from APP2 segments, compressed into a PNG iCCP chunk, and attached unchanged. Conflicting canvas-generated color tags are removed. Untagged JPEGs are treated as sRGB. EXIF orientation is baked into the decoded pixels; it is not copied to the PNG. The huge worker uses the same ImageBitmap decoder and a tile-sized OffscreenCanvas, without applying the source profile, and reattaches the profile after encoding. This avoids the one-level RGB rounding differences observed with ImageDecoder / VideoFrame.copyTo.

PNG sources retain their original supported color chunks. PNG encoding is lossless for the decoded opaque 8-bit RGB pixels; it cannot restore information already lost when creating a JPEG. Canvas handling of semitransparent pixels can introduce premultiplication rounding. CMYK/non-RGB ICC, HDR, 16-bit PNG and animated PNG splitting explicitly fail instead of silently lowering precision or converting profiles. Originals under the limit are not affected by these splitting restrictions. Miro's own image processing/previews remain outside this app's control.

## Validation

`node --check app.js`, `node --check lossless-upload.js`, `node --check slice-worker.js`, `node --test tests/*.test.cjs`.

Tests cover the measured payload boundary, exact partition geometry, oversized later parts, ICC preservation, 2/3/4-part selection, full original pass-through, board widths and adjacent coordinates, reverse corners, missing source numbers, partial failures and continuing the next file. SDK calls are mocked.

Open `tests/browser-lossless.html` from the hosted app and click Run. The browser check uses generated sRGB and Display-P3 JPEG/PNG files to compare decoded RGBA and color-managed output before/after 2/3/4-part slicing, including the huge worker. Raw decoded pixels and color metadata must match exactly. Browser color-managed rendering is measured separately: JPEG and PNG decoder/color-conversion paths can round differently even when raw samples and ICC bytes are identical. A 4096-square noise PNG tests actual encoded sizes and pixel equality. It does not upload to Miro.

## Live Miro check

Reopen the app and verify **Lossless PNG slices · 53**. Select an oversized 4096-square JPG; start with one file. Check Upload diagnostics for `lossless-png`, candidate `attempts`, chosen `partCount`, dimensions and individual part status. Compare seams and color at full zoom. Then check a mixed batch of small originals and oversized tiles.

## Deployment and rollback

GitHub Settings > Pages: Source `Deploy from a branch`, branch `test/original-upload-52`, folder `/ (root)`. The app URL remains unchanged. To revert, select `main`, keep `/ (root)`, Save and wait for deployment; reopen the Miro app. Do not merge into main to deploy this experiment.

The two obsolete branches were removed after test 52. Recoverable commit references:
- `backup/main-before-image-align-tool-51-20260609`: `ac272f733fe2b4c736475f5359eec310459ae685`
- `feature/image-align-tool-51-lossless-upload`: `0d01b02c3ed591839d184362a4c3c2a7fefcd33a`
