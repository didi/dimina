#include "../../../native/canvas/rle32.h"
#include "include/dimina_canvas.h"
#include <cstdlib>

extern "C" uint8_t *dimina_canvas_rle32(const uint8_t *bytes, size_t length, size_t *packed_length) {
    if (!packed_length) return nullptr;
    *packed_length = 0;
    if (length < dimina::canvas::MIN_CANVAS_RLE_BYTES || length > dimina::canvas::MAX_CANVAS_RLE_BYTES || length % 4) return nullptr;
    try {
        const auto packed = dimina::canvas::encodeCanvasRle32(bytes, length);
        if (!dimina::canvas::shouldUseCanvasRle32(length, packed.size())) return nullptr;
        auto *result = static_cast<uint8_t *>(std::malloc(packed.size()));
        if (!result) return nullptr;
        std::memcpy(result, packed.data(), packed.size());
        *packed_length = packed.size();
        return result;
    } catch (...) { return nullptr; }
}
