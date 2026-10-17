// Native coefficient-domain cropping only. No pixel decode, resize or re-encode.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <turbojpeg.h>
#include <emscripten.h>

static char last_error[256];

EMSCRIPTEN_KEEPALIVE
const char *jpeg_error(void) { return last_error; }

EMSCRIPTEN_KEEPALIVE
uint8_t *process_jpeg(uint8_t *input, unsigned long size, int scale,
                      int x, int y, int width, int height,
                      unsigned long *out_size) {
    *out_size = 0;
    last_error[0] = '\0';
    if (scale != 1) {
        snprintf(last_error, sizeof(last_error), "Only native-resolution JPEG crops are supported");
        return NULL;
    }
    tjhandle handle = tjInitTransform();
    if (!handle) {
        snprintf(last_error, sizeof(last_error), "%s", tjGetErrorStr2(NULL));
        return NULL;
    }
    tjtransform transform;
    memset(&transform, 0, sizeof(transform));
    transform.r.x = x;
    transform.r.y = y;
    transform.r.w = width;
    transform.r.h = height;
    transform.op = TJXOP_NONE;
    transform.options = TJXOPT_CROP;
    uint8_t *output = NULL;
    unsigned long output_size = 0;
    if (tjTransform(handle, input, size, 1, &output, &output_size,
                    &transform, 0) < 0) {
        snprintf(last_error, sizeof(last_error), "%s", tjGetErrorStr2(handle));
        tjFree(output);
        output = NULL;
    } else {
        *out_size = output_size;
    }
    tjDestroy(handle);
    return output;
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(uint8_t *buffer) { tjFree(buffer); }
