#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Returns an owned RLE block only when it saves at least 25%; otherwise NULL.
// The input is borrowed for this call. Release a non-NULL result with free().
uint8_t *dimina_canvas_rle32(const uint8_t *bytes, size_t length, size_t *packed_length);
#ifdef __cplusplus
}
#endif
