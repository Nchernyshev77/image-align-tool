# Verified streaming import — version 56

Test branch: `test/original-upload-52`. Main and the Pages source branch are unchanged.

## Interface

The header/version explanations and Upload diagnostics panel are removed. Progress has three counters (Scanning, Preparing, Uploading), a short status, and an ordinary persistent error list. 100% is reserved for verified completion. Internal test/debug summary is available in `window.ImageAlignLastImport`; no image bytes or JSON diagnostics are placed in the UI.

## Large batches

JPEG/PNG scanning reads dimensions/EXIF from file headers, rather than decoding every full image. Four header reads can overlap. Unsupported formats fall back to a browser decode. Unreadable files are checked up to five times and remain in the final error list.

Two preparation workers run off the main thread. They compute thumbnail tone codes, select lossless JPEG crops or PNG fallback, cut and measure actual encoded sizes. The PNG encoder uses a native-resolution OffscreenCanvas. JPEGs already known to need PNG do not incur a second full-file read just to rediscover their chroma sampling. Powers-of-two plans (2,4,8…) and original pass-through behavior remain.

Preparation and upload overlap after scanning/layout. At most five source files are uploading and two further sources are being prepared/awaiting admission. Parts of a source upload concurrently (up to eight). Selected blobs are reused, then released after each upload attempt; no complete-batch IndexedDB staging and no all-batch Base64 cache. A retry regenerates only affected sources from the still-selected local Files. Prepared region metadata must not retain a reference to the worker's blob array.

## Completeness and automatic recovery

One initial upload plus at most four recovery passes: five total passes. Each pass reads the board image list and checks every expected part. Source/preparation failures also retry within that budget. A second fresh board read immediately before retransmission catches images appearing during the retry delay. A failed board read does not cause blind retransmission.

An import-specific part marker is provided atomically as the image `alt` during createImage. The marker is unique to this run and source/region/part, not to a filename. It allows reconciliation when Miro created an image but the create reply was lost. Known item IDs are also checked. Repeated names and pre-existing same-name images are not mistaken for this run. The marker fits the 140-character alt limit; display titles keep the normal filename and part labels.

An upload taking more than two minutes becomes uncertain. It is never sent again while its original SDK promise remains pending. New source dispatch pauses if this would exceed the concurrency/memory bounds; verification can still find a completed image. A late or failed read cannot become a false success. The SDK has no transactional idempotency key: a remote creation delayed beyond both a settled error and repeated board snapshots cannot be made exactly-once by a browser app. Duplicate markers are detected and reported, without deleting board content automatically.

Successfully verified parts are grouped by source. Lost grouping replies are reconciled through groupId. Group errors are reported and retried. Requests are bounded and all settled requests are reconciled before final success. Grouping waits for a complete source until the last pass; on final partial failure, available pieces can remain grouped.

After five unsuccessful passes, the app shows an error and lists filenames/missing part counts; initial header failures cannot disappear from totals. Closing the app/browser stops the run; cross-session resume is not implemented.

## Miro rate limits

https://developers.miro.com/docs/websdk-reference-rate-limiting

Documented Web SDK limits are 100,000 credits/minute and 1,000,000/hour. Creating an image costs 500; metadata/group calls cost 50 and board.get costs 500. A shared gate reserves 95,000/minute and 950,000/hour, waiting for credits. Observed rate-limit errors also pause dispatch before another attempt. The five source slots still permit parallel requests, but cannot bypass Miro's service limits. Creating 1024 parts alone consumes 512,000 credits; workers cannot remove that network-side lower bound.

## Quality and rollback

The vendored JPEG coefficient transform, MCU alignment, full-chroma seam guards, ICC preservation, PNG precision restrictions, native resolution, reversed corners and missing source slots remain covered. No upload uses JPEG quality re-encoding or pixel resizing.

Run `node --test tests/*.test.cjs` and syntax checks. New tests cover a 256-source/1024-part mock batch, two preparation lanes, bounded lookahead, overlap, lost/late replies, silently dropped images, five-pass failure, board-read failure, failed preparation, pending timeout, grouping response loss, request budgeting, header-only scanning, and persistent UI errors.

`tests/browser-lossless.html` exercises two real background preparation workers, nested JPEG WASM, PNG fallback, actual automatic recovery against a local fake SDK, exact raw pixels and ICC, and a 57.7MB 4096-square PNG in a worker. No synthetic images are sent to Miro. Real large-batch Miro performance must be checked by the user.

Pages remains `test/original-upload-52`, `/ (root)`. To revert: Settings > Pages > main > root > Save, wait for deployment, reopen the Miro app. Do not merge the experiment into main.
