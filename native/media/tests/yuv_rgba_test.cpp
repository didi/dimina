#include "../yuv_rgba.h"
#include <array>
#include <iostream>
#include <string>

using dimina::media::VideoPlane;
using dimina::media::yuv420Rgba;

static void check(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}

static std::vector<uint8_t> reference(int width, int height, int left, int top,
                                     const VideoPlane (&planes)[3], bool full, bool bt709) {
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
    const auto component = [&](int plane, int x, int y) {
        const auto &p = planes[plane];
        return p.bytes[p.offset + static_cast<size_t>(y) * p.rowStride + static_cast<size_t>(x) * p.pixelStride];
    };
    const auto byte = [](double value) { return static_cast<uint8_t>(std::clamp(static_cast<int>(value), 0, 255)); };
    std::vector<uint8_t> result;
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        const auto sx = x + left, sy = y + top;
        const int luma = component(0, sx, sy);
        const double u = component(1, sx / 2, sy / 2) - 128.0, v = component(2, sx / 2, sy / 2) - 128.0;
        const double yy = full ? luma : (luma - 16) * 255.0 / 219;
        const double scale = full ? 1.0 : 255.0 / 224;
        result.push_back(byte(yy + (bt709 ? 1.5748 : 1.402) * v * scale));
        result.push_back(byte(yy - (bt709 ? .1873 : .3441) * u * scale - (bt709 ? .4681 : .7141) * v * scale));
        result.push_back(byte(yy + (bt709 ? 1.8556 : 1.772) * u * scale));
        result.push_back(255);
    }
    return result;
}

int main() {
    try {
        int cases = 0;
        for (bool full : {false, true}) for (bool bt709 : {false, true})
        for (int stride : {1, 2, 3}) for (int crop : {0, 1})
        for (int width : {1, 2, 7, 63, 257}) for (int height : {1, 5, 129}) {
            std::array<std::vector<uint8_t>, 3> storage;
            VideoPlane planes[3];
            for (int plane = 0; plane < 3; ++plane) {
                const int sub = plane == 0 ? 1 : 2;
                const int row = ((crop + width) / sub + 2) * stride + 7;
                const size_t offset = plane + 3;
                const size_t length = offset + static_cast<size_t>((crop + height - 1) / sub) * row +
                    static_cast<size_t>((crop + width - 1) / sub) * stride + 1;
                storage[plane].resize(length);
                for (size_t index = 0; index < length; ++index) storage[plane][index] = (index * 37 + plane * 71) & 255;
                planes[plane] = {storage[plane].data(), length, offset, row, stride};
            }
            const auto expected = reference(width, height, crop, crop, planes, full, bt709);
            const auto pixels = yuv420Rgba(width, height, crop, crop, planes, full, bt709);
            check(pixels == expected, "native color/stride/crop bytes changed");
            std::fill(storage[0].begin(), storage[0].end(), 0);
            check(pixels == expected, "output aliases source pixels");
            ++cases;
        }

        uint8_t storage[64] = {};
        VideoPlane planes[3] = {{storage, 64, 0, 8, 1}, {storage, 64, 0, 8, 1}, {storage, 64, 0, 8, 1}};
        const auto reject = [&](auto action) {
            bool failed = false;
            try { action(); } catch (const std::invalid_argument &) { failed = true; }
            check(failed, "unsafe image metadata was accepted");
        };
        reject([&] { yuv420Rgba(0, 4, 0, 0, planes, false, false); });
        reject([&] { yuv420Rgba(4096, 4096, 0, 0, planes, false, false); });
        reject([&] { yuv420Rgba(4, 4, INT_MAX, 0, planes, false, false); });
        reject([&] { yuv420Rgba(4, 4, 0, -1, planes, false, false); });
        planes[0].length = 8;
        reject([&] { yuv420Rgba(4, 4, 0, 0, planes, false, false); });
        planes[0].length = 64; planes[0].rowStride = INT_MAX;
        reject([&] { yuv420Rgba(4, 4, 0, 0, planes, false, false); });
        planes[0].rowStride = 8; planes[0].pixelStride = 0;
        reject([&] { yuv420Rgba(4, 4, 0, 0, planes, false, false); });
        planes[0].pixelStride = 1; planes[0].length = SIZE_MAX; planes[0].offset = SIZE_MAX - 1;
        reject([&] { yuv420Rgba(4, 4, 0, 0, planes, false, false); });
        std::cout << cases << " native color/layout/ownership cases and invalid metadata passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
