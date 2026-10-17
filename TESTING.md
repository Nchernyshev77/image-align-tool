# Verified streaming import — version 60

Test branch: `test/original-upload-52`. Main and the Pages source branch are unchanged.

## Interface

The header/version explanations and Upload diagnostics panel are removed. Progress has three counters (Scanning, Preparing, Uploading), a short status, and an ordinary persistent error list. 100% is reserved for verified completion. Internal test/debug summary is available in `window.ImageAlignLastImport`; no image bytes or JSON diagnostics are placed in the UI.

## Large batches

JPEG/PNG scanning reads dimensions/EXIF from file headers, rather than decoding every full image. Four header reads can overlap. Unsupported formats fall back to a browser decode. Unreadable files are checked up to five times and remain in the final error list.

Two to four preparation workers run off the main thread, selected after header scanning from CPU count, reported memory and decoded dimensions. A one-file batch creates only one worker. They compute thumbnail tone codes, select JPEG coefficient crops for JPEG inputs or lossless PNG regions for other formats, cut and measure actual encoded sizes. The PNG encoder uses a native-resolution OffscreenCanvas. JPEGs are never routed through the PNG encoder, including 4:2:0 inputs. JPEG 4:2:2 prefers horizontal strips to retain exact seam rendering when the dimension limits permit it. Powers-of-two plans (2,4,8…) remain. Thumbnail complexity only changes the order in which candidate regions are measured: likely heavier regions are checked first so invalid layouts fail earlier. It never skips a valid smaller layout, changes output order, or replaces actual output-size checks. Originals that fit both the measured data-URL limit and Miro’s documented 8192×4096 pixel limits bypass slicing and format conversion; an 18MB 4096-square JPEG stays one unchanged JPEG. The fixed 4096 grid is removed for ordinary files: dimension and byte limits both participate in the minimal 2/4/8 plan. Dimension-invalid layouts are rejected before encoding. Huge sources retain their bounded-region handling.

Preparation and upload overlap after scanning/layout. At most five source files are uploading and at most one further source per preparation worker is being prepared/awaiting admission. Parts of a source upload concurrently (up to eight). Selected blobs are reused, then released after each upload attempt; no complete-batch IndexedDB staging and no all-batch Base64 cache. A retry regenerates only affected sources from the still-selected local Files. Prepared region metadata must not retain a reference to the worker's blob array.

## Completeness and automatic recovery

One initial upload plus at most four recovery passes: five total passes. Each pass reads the board image list and checks every expected part. Source/preparation failures also retry within that budget. A second fresh board read immediately before retransmission catches images appearing during the retry delay. A failed board read does not cause blind retransmission.

An import-specific part marker is provided atomically as the image `alt` during createImage. The marker is unique to this run and source/region/part, not to a filename. It allows reconciliation when Miro created an image but the create reply was lost. Known item IDs are also checked. Repeated names and pre-existing same-name images are not mistaken for this run. The marker fits the 140-character alt limit; display titles keep the normal filename and part labels.

An upload taking more than two minutes becomes uncertain. It is never sent again while its original SDK promise remains pending. New source dispatch pauses if this would exceed the concurrency/memory bounds; verification can still find a completed image. A late or failed read cannot become a false success. The SDK has no transactional idempotency key: a remote creation delayed beyond both a settled error and repeated board snapshots cannot be made exactly-once by a browser app. Duplicate markers are detected and reported, without deleting board content automatically.

As soon as every piece of a source receives its createImage acknowledgement, the source is queued for grouping immediately, while other sources keep uploading. A separate five-task grouping queue prevents duplicate concurrent group requests for the same source. Four metadata tasks can run independently; slow metadata never holds source upload slots. Final verification still reconciles the board, retries lost grouping replies and repairs a group if a missing image is replaced. Successfully recovered parts are grouped by source. Lost grouping replies are reconciled through groupId. Group errors are reported and retried. Requests are bounded and all settled requests are reconciled before final success. Grouping waits for a complete source until the last pass; on final partial failure, available pieces can remain grouped.

After five unsuccessful passes, the app shows an error and lists filenames/missing part counts; initial header failures cannot disappear from totals. Closing the app/browser stops the run; cross-session resume is not implemented.

## Miro rate limits

https://developers.miro.com/docs/websdk-reference-rate-limiting

Documented Web SDK limits are 100,000 credits/minute and 1,000,000/hour. Creating an image costs 500; metadata/group calls cost 50 and board.get costs 500. A shared gate reserves 95,000/minute and 950,000/hour, waiting for credits. Observed rate-limit errors also pause dispatch before another attempt. The five source slots still permit parallel requests, but cannot bypass Miro's service limits. Creating 1024 parts alone consumes 512,000 credits; workers cannot remove that network-side lower bound.

## Quality and rollback

The vendored JPEG coefficient transform, MCU alignment, all supported chroma sampling modes, ICC preservation, PNG precision restrictions, native resolution, reversed corners and missing source slots remain covered. No upload uses JPEG quality re-encoding or pixel resizing. JPEG crops copy quantized coefficients with scale hardcoded to 1 and preserve ICC bytes. Cropping 4:2:0, or cropping 4:2:2 across its subsampled axis, can change decoded RGB pixels in a narrow strip at new boundaries because chroma upsampling loses neighboring context. This mode intentionally accepts those edge differences instead of converting JPEG to PNG. Unsupported sliced JPEGs (including EXIF orientation transforms) fail explicitly rather than converting; fitting originals still upload unchanged. PNG input handling is unchanged.

The final internal summary also records each filename, original bytes, scanned dimensions, selected formats and part count to explain slicing without exposing image content.

Internal progress and final summaries include worker count and timings for scan, preparation, encoding probes, Base64 reads, SDK upload, metadata, grouping, verification, upload-slot waiting and rate-limit waiting. Concurrent stage work is summed and must not be added together to estimate elapsed time; rate-limit waiting is measured as a union of waiting intervals. The centered UI keeps its total elapsed time and no diagnostics panel is added.

Run `node --test tests/*.test.cjs` and syntax checks. New tests cover a 256-source/1024-part mock batch, two/four preparation lanes, bounded lookahead, overlap, immediate grouping while other uploads and metadata are blocked, independent metadata admission, unchanged originals within byte and pixel limits, lost/late replies, silently dropped images, five-pass failure, board-read failure, failed preparation, pending timeout, grouping response loss, request budgeting, header-only scanning, and persistent UI errors.

`tests/browser-lossless.html` exercises two real background preparation workers, nested JPEG WASM, JPEG-only processing for 4:2:0/4:2:2/4:4:4, actual automatic recovery against a local fake SDK, exact JPEG interior pixels, measured JPEG seam differences, ICC, and a 57.7MB 4096-square PNG in a worker. No synthetic images are sent to Miro. Real large-batch Miro performance must be checked by the user.

Pages remains `test/original-upload-52`, `/ (root)`. To revert: Settings > Pages > main > root > Save, wait for deployment, reopen the Miro app. Do not merge the experiment into main.
