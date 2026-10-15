# Original upload test 52

Branch: `test/original-upload-52`, based on `main` at `ac272f733fe2b4c736475f5359eec310459ae685`.

Unsliced images (including 4096 x 4096 JPG tiles) are sent as the original file via FileReader and the Miro Web SDK. There is no canvas re-encoding, application payload cap, downscaling, automatic subdivision, or retry for this path. Image width on the board is set explicitly to preserve grid spacing. Files upload one at a time to bound memory use.

Large-image slicing retains the existing implementation, including JPEG quality 0.8 for regular slices and PNG for Huge mode. This branch tests original uploads only; it does not claim to solve all large-image paths.

## Deploy and revert

In this repository's Settings > Pages, keep Source set to Deploy from a branch, choose `test/original-upload-52`, folder `/ (root)`, and Save. Wait for the Pages deployment to succeed, then reopen the Miro app. Its panel must display **Original upload test · 52**. The hosted URL remains the same, so the Miro application URL does not need to change.

To restore the previous application, choose `main` and `/ (root)` in the same Pages settings and Save. Wait for deployment and reopen the app; the test label should disappear. Do not merge the test into main to deploy it.

## Live check

1. Select one original JPG tile (about 28 MB, 4096 x 4096) in the Miro app and run Stitch / Slice.
2. Inspect Upload diagnostics. It reports the source byte count, pixel dimensions, Base64 length, elapsed time, and success or the SDK error. It does not include image bytes or request bodies.
3. If it fails, copy the diagnostics. The app will not compress, resize, subdivide, or manually re-upload that file.
4. If it succeeds, confirm that there is one image item and inspect its quality. SDK acceptance does not alone prove that Miro's display previews match the original file.

## Local checks

Run `node --test tests/original-upload.test.cjs`.

The tests exercise the actual import handler with a fake SDK: a 28,000,000-byte payload is preserved byte-for-byte, 4096-pixel spacing is retained, rejection causes no fallback or repeated upload, and a file read failure does not stop the next file. These checks do not establish the real Miro server limit.

## Requested old branch removal

Before this test, the two non-main branches were:

- `backup/main-before-image-align-tool-51-20260609` at `ac272f733fe2b4c736475f5359eec310459ae685`
- `feature/image-align-tool-51-lossless-upload` at `0d01b02c3ed591839d184362a4c3c2a7fefcd33a`

These commit references are recorded for traceability; this document does not assert that the branches have been deleted or that Pages has been switched.
