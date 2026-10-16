@smremde/jpegcropscale 1.0.0, from the npm registry tarball, unmodified runtime and WASM.
Source: https://github.com/smremde/jpegcropscale (package 1.0.0)
Runtime: libjpeg-turbo compiled to WebAssembly. License text is in LICENSE.
This software is based in part on the work of the Independent JPEG Group.
The app calls process_jpeg with downscale=1 only. It never enters the library's
lossy resizing/recompression path. It checks dimensions and ICC bytes on every output.
The wrapper's crop function in index.js is not used; the app calls the C entry point
in a dedicated worker, with exact MCU-aligned integer coordinates.
