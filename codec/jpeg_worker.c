// Read coefficients once, then copy native MCU-aligned regions without re-encoding.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include <jpeglib.h>
#include <emscripten.h>

static struct jpeg_decompress_struct source;
static struct jpeg_compress_struct destination;
static struct jpeg_error_mgr errors;
static jvirt_barray_ptr *source_blocks;
static int source_created, destination_created, source_ready;
static unsigned char *output;
static unsigned long output_size;
static char last_error[JMSG_LENGTH_MAX];
static jmp_buf failure;

static void fail(j_common_ptr info) {
    (*info->err->format_message)(info, last_error);
    longjmp(failure, 1);
}
static void warning(j_common_ptr info, int level) {
    if (level < 0) fail(info);
}

EMSCRIPTEN_KEEPALIVE
const char *jpeg_error(void) { return last_error; }

EMSCRIPTEN_KEEPALIVE
void close_jpeg(void) {
    if (source_created) jpeg_destroy_decompress(&source);
    source_created = source_ready = 0;
    source_blocks = NULL;
    memset(&source, 0, sizeof(source));
}

EMSCRIPTEN_KEEPALIVE
int open_jpeg(uint8_t *input, unsigned long size) {
    close_jpeg();
    last_error[0] = '\0';
    source.err = jpeg_std_error(&errors);
    errors.error_exit = fail;
    errors.emit_message = warning;
    if (setjmp(failure)) { close_jpeg(); return -1; }
    source_created = 1;
    jpeg_create_decompress(&source);
    for (int i = 0; i < 16; ++i) jpeg_save_markers(&source, JPEG_APP0 + i, 0xffff);
    jpeg_save_markers(&source, JPEG_COM, 0xffff);
    jpeg_mem_src(&source, input, size);
    jpeg_read_header(&source, TRUE);
    source_blocks = jpeg_read_coefficients(&source);
    source_ready = source_blocks != NULL;
    return source_ready ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *crop_jpeg(int x, int y, int width, int height, unsigned long *out_size) {
    *out_size = 0;
    last_error[0] = '\0';
    if (!source_ready || x < 0 || y < 0 || width < 1 || height < 1 ||
        (unsigned)x > source.image_width || (unsigned)y > source.image_height ||
        (unsigned)width > source.image_width - x || (unsigned)height > source.image_height - y ||
        x % (source.max_h_samp_factor * DCTSIZE) || y % (source.max_v_samp_factor * DCTSIZE)) {
        snprintf(last_error, sizeof(last_error), "Invalid native MCU crop or source is not open");
        return NULL;
    }
    memset(&destination, 0, sizeof(destination));
    destination.err = &errors;
    destination_created = 0;
    output = NULL;
    output_size = 0;
    if (setjmp(failure)) {
        if (destination_created) jpeg_destroy_compress(&destination);
        destination_created = 0;
        free(output); output = NULL;
        return NULL;
    }
    destination_created = 1;
    jpeg_create_compress(&destination);
    jpeg_mem_dest(&destination, &output, &output_size);
    jpeg_copy_critical_parameters(&source, &destination);
    destination.image_width = width;
    destination.image_height = height;
    jvirt_barray_ptr arrays[MAX_COMPONENTS];
    JDIMENSION columns[MAX_COMPONENTS], rows[MAX_COMPONENTS];
    for (int i = 0; i < source.num_components; ++i) {
        jpeg_component_info *component = &source.comp_info[i];
        unsigned h = component->h_samp_factor, v = component->v_samp_factor;
        columns[i] = ((width + source.max_h_samp_factor * DCTSIZE - 1) /
                      (source.max_h_samp_factor * DCTSIZE)) * h;
        rows[i] = ((height + source.max_v_samp_factor * DCTSIZE - 1) /
                   (source.max_v_samp_factor * DCTSIZE)) * v;
        arrays[i] = (*destination.mem->request_virt_barray)((j_common_ptr)&destination,
            JPOOL_IMAGE, TRUE, columns[i], rows[i], v);
    }
    jpeg_write_coefficients(&destination, arrays);
    for (jpeg_saved_marker_ptr marker = source.marker_list; marker; marker = marker->next) {
        if (destination.write_JFIF_header && marker->marker == JPEG_APP0 &&
            marker->data_length >= 5 && !memcmp(marker->data, "JFIF\0", 5)) continue;
        if (destination.write_Adobe_marker && marker->marker == JPEG_APP0 + 14 &&
            marker->data_length >= 5 && !memcmp(marker->data, "Adobe", 5)) continue;
        jpeg_write_marker(&destination, marker->marker, marker->data, marker->data_length);
    }
    for (int i = 0; i < source.num_components; ++i) {
        jpeg_component_info *component = &source.comp_info[i];
        JDIMENSION sx = x / (source.max_h_samp_factor * DCTSIZE) * component->h_samp_factor;
        JDIMENSION sy = y / (source.max_v_samp_factor * DCTSIZE) * component->v_samp_factor;
        for (JDIMENSION row = 0; row < rows[i]; ++row) {
            JBLOCKARRAY from = (*source.mem->access_virt_barray)((j_common_ptr)&source,
                source_blocks[i], sy + row, 1, FALSE);
            JBLOCKARRAY to = (*destination.mem->access_virt_barray)((j_common_ptr)&destination,
                arrays[i], row, 1, TRUE);
            memcpy(to[0], from[0] + sx, columns[i] * sizeof(JBLOCK));
        }
    }
    jpeg_finish_compress(&destination);
    jpeg_destroy_compress(&destination);
    destination_created = 0;
    *out_size = output_size;
    return output;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *process_jpeg(uint8_t *input, unsigned long size, int scale,
                      int x, int y, int width, int height, unsigned long *out_size) {
    *out_size = 0;
    if (scale != 1) {
        snprintf(last_error, sizeof(last_error), "Only native-resolution crops are supported");
        return NULL;
    }
    if (open_jpeg(input, size) < 0) return NULL;
    uint8_t *result = crop_jpeg(x, y, width, height, out_size);
    close_jpeg();
    return result;
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(uint8_t *buffer) { free(buffer); }
