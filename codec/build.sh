#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="${RUNNER_TEMP:-/tmp}/image-align-jpeg-build"
mkdir -p "$build_dir"
if [ ! -d "$build_dir/libjpeg-turbo/.git" ]; then
  git clone --depth 1 --branch 3.2.0 https://github.com/libjpeg-turbo/libjpeg-turbo.git "$build_dir/libjpeg-turbo"
fi
test "$(git -C "$build_dir/libjpeg-turbo" rev-parse HEAD)" = c85e6b905bf237038faa936dab160ebfc5da0344
emcmake cmake -S "$build_dir/libjpeg-turbo" -B "$build_dir/wasm" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS=-O3 \
  -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF \
  -DWITH_TOOLS=OFF -DWITH_TESTS=OFF
cmake --build "$build_dir/wasm" --target turbojpeg-static -j 2
emcc "$repo_dir/codec/jpeg_worker.c" "$build_dir/wasm/libturbojpeg.a" \
  -I"$build_dir/libjpeg-turbo/src" -I"$build_dir/wasm" -O3 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=32MB \
  -sMALLOC=emmalloc -sENVIRONMENT=worker,node \
  -sEXPORTED_FUNCTIONS='["_open_jpeg","_crop_jpeg","_close_jpeg","_process_jpeg","_jpeg_error","_free_buffer","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPU8","HEAPU32"]' \
  -o "$repo_dir/vendor/jpegcropscale/jpeg_worker.js"
