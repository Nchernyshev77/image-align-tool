Native JPEG coefficient crop codec, rebuilt for Image Align Tool version 64.

libjpeg-turbo 3.2.0, source commit c85e6b905bf237038faa936dab160ebfc5da0344:
https://github.com/libjpeg-turbo/libjpeg-turbo
Emscripten 4.0.21, SDK commit b2436aafa7351ee1b581f15841f1b45ed716a279.

Reproducible wrapper and build flags: codec/jpeg_worker.c and codec/build.sh.
The wrapper was adapted from @smremde/jpegcropscale's MIT-licensed crop entry
point (https://github.com/smremde/jpegcropscale), with error handling and the
lossy resize/recompression path removed. The historical MIT license is retained
in LICENSE; current libjpeg-turbo licenses are in LIBJPEG-LICENSE.md and README.ijg.
This software is based in part on the work of the Independent JPEG Group.

The wasm32 maximum is 65536 pages (4 GiB); the additional memory64 build
uses 262144 pages (16 GiB), 64-bit allocation and pointer/size handling. Memory grows on demand; these are ceilings,
not a startup allocation or a guarantee of available device RAM. The app checks
native MCU-aligned dimensions and ICC bytes on every output.

Version 63 caches source coefficients across crops with open/crop/close entry
points; no inverse transform, pixel resampling or quantization is performed.
