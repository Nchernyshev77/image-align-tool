# Lossless JPEG tiles — test 55

Branch: `test/original-upload-52`. Main is unchanged. Pages stays on the test branch.

## Behavior

- Miro's measured URL property cap is 30,000,000 bytes, including JSON string quotes. The app measures Base64 plus MIME prefix before every SDK call. JPEG originals up to 22,499,979 bytes fit that formula.
- Fitting original tiles pass through byte-for-byte.
- Oversized tiles try 2, 4, 8, 16… parts (up to 256), with exact integer coordinates. Binary splits choose the longer permitted axis: a square becomes halves, a 2×2 layout, then 4×2. JPEG split positions also respect its MCU boundaries. Odd dimensions remain intact.
- JPEG crops use vendored libjpeg-turbo WebAssembly in a dedicated local worker. The only invoked C path is `process_jpeg(..., downscale=1, ...)`. It preserves the original coefficients and ICC profile. Output dimensions and ICC bytes are checked on every crop. No remote image server or CDN codec is used.
- JPEG chroma interpolation can change seam pixels when cutting along a subsampled axis. The app only cuts on axes with full chroma sampling. 4:4:4 can split either way; 4:2:2 can split horizontally into full-width strips. 4:2:0 and rotated EXIF sources use PNG to preserve seam pixels. Existing large-image base regions also fall back if their boundaries would cut an unsafe axis.
- PNG fallback likewise tries powers of two, preserving original supported RGB color metadata. It has the existing precision restrictions (no splitting 16-bit/HDR/APNG/CMYK; alpha premultiplication may round semitransparent pixels). Fitting originals are unaffected.

## Two stages

Stage 1 reads dimensions, lays out sources, determines exact candidate counts, cuts and measures each candidate. Only a complete fitting layout is accepted. Selected output blobs are placed in a temporary device-local IndexedDB database. They are not encoded again for upload and are not kept as batch-wide Base64 strings. Original pass-through Files need no storage copy. Preparation/storage failures skip that source region with a visible diagnostic; other sources continue.

Stage 2 runs **five original source files** at a time. The 2/4/8 pieces inside each source upload concurrently and share its source slot. For example, four originals plus one four-part source produce eight concurrent requests; five four-part sources produce twenty. Larger files with many regions are limited to eight requests per active source. Base64 is read only after acquiring a part slot. The source slot remains occupied until all requests and grouping finish.

Successful pieces of each source are grouped with `miro.board.group({items})` if at least two exist. Partial failures leave successful pieces visible/grouped; started requests finish, queued parts of the failed region stop, and other sources continue. No automatic SDK retry creates duplicates. Group failure is reported separately without reuploading images. All requests settle before final progress and the button re-enables. Staged blobs are deleted after each request and the temporary database is deleted at completion.

## Diagnostics

Version: `lossless-jpeg-test-55`. Per source region: `mode`, `attempts`, `partCount`, optional `jpegFallback`, `preparationMs` (including local staging), `uploadMs`, `parts`, `group`. Per part: native coordinates/dimensions, byte count, Base64 characters, `dataUrlMs`, successful `createImageMs`, and request/metadata `elapsedMs`. Concurrent times overlap.

## Checks

`node --test tests/*.test.cjs`, syntax checks on app/helper/worker files.

Tests execute the actual handler against controlled SDK responses. They cover 2/4/8 JPEG and PNG selection, no SDK calls in Stage 1, exact positions/coverage, original pass-through, five source slots, eight/twenty parallel requests, waiting for grouping before slot reuse, partial uploads, grouping errors, local storage quota failure, cleanup, reverse grid corners and missing source numbers. Production worker tests run the vendored WASM and check ICC, native dimensions and MCU guards.

`tests/browser-lossless.html`: click Run. It exercises real browser workers and IndexedDB, compares every decoded pixel and rendered sRGB pixel for lossless JPEG crops (sRGB/Display-P3 and JPEG 4:4:4/4:2:2), checks 4:2:0/EXIF guards, compares PNG samples/metadata, and measures actual 4096×4096 PNG part sizes. JPEG fixtures are synthetic. No test images upload to Miro. SDK grouping/concurrency tests use mocks; actual Miro behavior needs user verification.

## Deployment and rollback

Reopen the Miro app and verify **Lossless JPEG tiles · 55**. Upload one oversized tile first, then a mixed batch. Inspect `mode`/`jpegFallback`, group selection, seams, completion and errors.

GitHub Settings > Pages: Source `Deploy from a branch`, branch `test/original-upload-52`, folder `/ (root)`. To revert, select `main`, keep root, Save, wait for deployment and reopen the app. No merge to main is required.

Removed obsolete branch recovery references:
- `backup/main-before-image-align-tool-51-20260609`: `ac272f733fe2b4c736475f5359eec310459ae685`
- `feature/image-align-tool-51-lossless-upload`: `0d01b02c3ed591839d184362a4c3c2a7fefcd33a`
