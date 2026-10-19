#pragma once
#include "canvas_rle32.h"
#include <map>
#include <memory>
#include <mutex>

namespace dimina::canvas {
// A prepared packet is a candidate only. The mutable input is compared with
// every decoded byte before it can replace encoding on the service thread.
inline bool MatchesCanvasRle32(const uint8_t *bytes, size_t length, const std::vector<uint8_t> &packed) {
    if ((length && !bytes) || length % 4 || length > MAX_CANVAS_RLE_BYTES) return false;
    size_t source = 0, destination = 0;
    while (source < packed.size()) {
        if (packed.size() - source < 4) return false;
        const uint32_t token = canvasRleWord(packed.data() + source);
        const size_t count = token & 0x7fffffffu;
        const bool run = token & 0x80000000u;
        source += 4;
        if (!count || count > (length - destination) / 4) return false;
        const size_t size = count * 4, payload = run ? 4 : size;
        if (payload > packed.size() - source) return false;
        if (run) {
            // Equality to the shifted input proves every adjacent word is the
            // same. libc can compare a long run without a branch per pixel.
            if (std::memcmp(bytes + destination, packed.data() + source, 4) ||
                (size > 4 && std::memcmp(bytes + destination, bytes + destination + 4, size - 4))) return false;
        } else if (std::memcmp(bytes + destination, packed.data() + source, size)) return false;
        source += payload;
        destination += size;
    }
    return destination == length;
}

struct PreparedCanvasPixels {
    size_t length;
    std::vector<uint8_t> packed;
};
inline std::shared_ptr<const PreparedCanvasPixels> PrepareCanvasPixels(const uint8_t *bytes, size_t length) noexcept {
    try {
        if (length < MIN_CANVAS_RLE_BYTES || length > MAX_CANVAS_RLE_BYTES || length % 4) return nullptr;
        auto packed = encodeCanvasRle32(bytes, length);
        if (!shouldUseCanvasRle32(length, packed.size())) return nullptr;
        // The encoder reserves its worst-case output. Keep only packed bytes
        // while a decoded frame remains live in JS.
        std::vector<uint8_t>(packed.begin(), packed.end()).swap(packed);
        return std::make_shared<const PreparedCanvasPixels>(PreparedCanvasPixels {length, std::move(packed)});
    } catch (...) { return nullptr; }
}

class PreparedCanvasRegistry {
    inline static std::mutex mutex;
    inline static std::map<const uint8_t *, std::weak_ptr<const PreparedCanvasPixels>> packets;
public:
    static void Add(const uint8_t *data, std::shared_ptr<const PreparedCanvasPixels> packet) noexcept {
        if (!data || !packet) return;
        try {
            std::lock_guard<std::mutex> guard(mutex);
            if (packets.size() >= 32) {
                for (auto it = packets.begin(); it != packets.end();) {
                    if (it->second.expired()) it = packets.erase(it); else ++it;
                }
            }
            if (packets.size() < 32) packets[data] = packet;
        } catch (...) { /* A missed optimization must not fail frame delivery. */ }
    }
    static void Remove(const uint8_t *data) noexcept {
        try { std::lock_guard<std::mutex> guard(mutex); packets.erase(data); } catch (...) {}
    }
    static std::shared_ptr<const PreparedCanvasPixels> Find(const uint8_t *data, size_t length) {
        std::shared_ptr<const PreparedCanvasPixels> packet;
        {
            std::lock_guard<std::mutex> guard(mutex);
            const auto found = packets.find(data);
            if (found != packets.end()) packet = found->second.lock();
        }
        return packet && packet->length == length && MatchesCanvasRle32(data, length, packet->packed) ? packet : nullptr;
    }
};
} // namespace dimina::canvas
