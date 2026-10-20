#pragma once
#include <algorithm>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace dimina::media {
struct VideoPlane {
    const uint8_t *bytes;
    size_t length;
    size_t offset;
    int rowStride;
    int pixelStride;
};

// Borrow the planes only for this call. The returned RGBA storage is independent
// of the codec image, including overlapping NV12/NV21 chroma planes.
inline std::vector<uint8_t> yuv420Rgba(int width, int height, int left, int top,
                                      const VideoPlane (&planes)[3], bool fullRange, bool bt709) {
#if defined(__clang__)
    // Preserve Kotlin/JVM double rounding and channel truncation byte for byte.
#pragma clang fp contract(off)
#endif
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096 ||
        static_cast<int64_t>(width) * height > 2097152 || left < 0 || top < 0 ||
        left > INT_MAX - width || top > INT_MAX - height)
        throw std::invalid_argument("video frame exceeds pixel budget or crop bounds");
    for (size_t index = 0; index < 3; ++index) {
        const auto &plane = planes[index];
        if (!plane.bytes || plane.length > INT_MAX || plane.offset >= plane.length || plane.rowStride <= 0 || plane.pixelStride <= 0)
            throw std::invalid_argument("invalid video plane");
        const int subsample = index == 0 ? 1 : 2;
        const uint64_t last = plane.offset + static_cast<uint64_t>((top + height - 1) / subsample) * plane.rowStride +
            static_cast<uint64_t>((left + width - 1) / subsample) * plane.pixelStride;
        if (last >= plane.length) throw std::invalid_argument("video plane is shorter than the crop");
    }
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4);
    const auto &yPlane = planes[0], &uPlane = planes[1], &vPlane = planes[2];
    const double chromaScale = fullRange ? 1.0 : 255.0 / 224;
    const double redV = bt709 ? 1.5748 : 1.402;
    const double greenU = bt709 ? 0.1873 : 0.3441;
    const double greenV = bt709 ? 0.4681 : 0.7141;
    const double blueU = bt709 ? 1.8556 : 1.772;
    const auto channel = [](double value) { return static_cast<uint8_t>(std::clamp(static_cast<int>(value), 0, 255)); };
    size_t offset = 0;
    for (int y = 0; y < height; ++y) {
        const auto sy = static_cast<size_t>(y + top);
        size_t yIndex = yPlane.offset + sy * yPlane.rowStride + static_cast<size_t>(left) * yPlane.pixelStride;
        const size_t uRow = uPlane.offset + sy / 2 * uPlane.rowStride;
        const size_t vRow = vPlane.offset + sy / 2 * vPlane.rowStride;
        int lastChroma = -1;
        double red = 0, greenFromU = 0, greenFromV = 0, blue = 0;
        for (int x = 0; x < width; ++x) {
            const int chroma = (x + left) / 2;
            if (chroma != lastChroma) {
                const double u = uPlane.bytes[uRow + static_cast<size_t>(chroma) * uPlane.pixelStride] - 128.0;
                const double v = vPlane.bytes[vRow + static_cast<size_t>(chroma) * vPlane.pixelStride] - 128.0;
                red = redV * v * chromaScale;
                greenFromU = greenU * u * chromaScale;
                greenFromV = greenV * v * chromaScale;
                blue = blueU * u * chromaScale;
                lastChroma = chroma;
            }
            const int luma = yPlane.bytes[yIndex];
            yIndex += yPlane.pixelStride;
            const double yy = fullRange ? static_cast<double>(luma) : (luma - 16) * 255.0 / 219;
            pixels[offset++] = channel(yy + red);
            pixels[offset++] = channel(yy - greenFromU - greenFromV);
            pixels[offset++] = channel(yy + blue);
            pixels[offset++] = 255;
        }
    }
    return pixels;
}
} // namespace dimina::media
