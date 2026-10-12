#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace dimina::canvas {
// Private rle32-v1 wire format: a little-endian uint32 token stores the
// number of four-byte words. Bit31 selects a repeated word (one raw word
// follows); otherwise that many literal words follow. Payload bits are copied
// verbatim. Service enables this only after Render capability negotiation.
constexpr size_t MIN_CANVAS_RLE_BYTES = 64 * 1024;
constexpr size_t MAX_CANVAS_RLE_BYTES = 32 * 1024 * 1024;

inline uint32_t canvasRleWord(const uint8_t *bytes) {
    uint32_t word;
    std::memcpy(&word, bytes, sizeof(word));
    return word;
}

inline void appendCanvasRleToken(std::vector<uint8_t> &output, uint32_t token) {
    output.push_back(static_cast<uint8_t>(token));
    output.push_back(static_cast<uint8_t>(token >> 8));
    output.push_back(static_cast<uint8_t>(token >> 16));
    output.push_back(static_cast<uint8_t>(token >> 24));
}

inline std::vector<uint8_t> encodeCanvasRle32(const uint8_t *bytes, size_t length) {
    if (length > MAX_CANVAS_RLE_BYTES) throw std::length_error("canvas RLE input exceeds 32 MiB");
    if (length % 4 != 0 || (length != 0 && !bytes)) throw std::invalid_argument("invalid canvas RLE input");
    std::vector<uint8_t> output;
    if (length == 0) return output;
    output.reserve(length + 4);
    const size_t words = length / 4;
    size_t index = 0;
    size_t literalStart = 0;
    const auto appendLiteral = [&](size_t start, size_t count) {
        if (count == 0) return;
        appendCanvasRleToken(output, static_cast<uint32_t>(count));
        output.insert(output.end(), bytes + start * 4, bytes + (start + count) * 4);
    };
    while (index < words) {
        const uint32_t word = canvasRleWord(bytes + index * 4);
        size_t end = index + 1;
        while (end < words && canvasRleWord(bytes + end * 4) == word) ++end;
        const size_t count = end - index;
        if (count >= 3) {
            appendLiteral(literalStart, index - literalStart);
            appendCanvasRleToken(output, 0x80000000u | static_cast<uint32_t>(count));
            output.insert(output.end(), bytes + index * 4, bytes + index * 4 + 4);
            literalStart = end;
        }
        index = end;
    }
    appendLiteral(literalStart, words - literalStart);
    return output;
}

inline bool shouldUseCanvasRle32(size_t originalLength, size_t packedLength) {
    return originalLength >= MIN_CANVAS_RLE_BYTES && originalLength <= MAX_CANVAS_RLE_BYTES
        && originalLength % 4 == 0 && packedLength > 0 && packedLength <= originalLength * 3 / 4;
}

inline std::string canvasBytesToBase64(const uint8_t *bytes, size_t size) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string encoded((size + 2) / 3 * 4, '=');
    for (size_t i = 0, j = 0; i < size; i += 3, j += 4) {
        uint32_t value = uint32_t(bytes[i]) << 16;
        if (i + 1 < size) value |= uint32_t(bytes[i + 1]) << 8;
        if (i + 2 < size) value |= bytes[i + 2];
        encoded[j] = alphabet[(value >> 18) & 63];
        encoded[j + 1] = alphabet[(value >> 12) & 63];
        if (i + 1 < size) encoded[j + 2] = alphabet[(value >> 6) & 63];
        if (i + 2 < size) encoded[j + 3] = alphabet[value & 63];
    }
    return encoded;
}
}
