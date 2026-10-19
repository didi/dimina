#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>

#if defined(__aarch64__) && defined(__ARM_NEON) && defined(__BYTE_ORDER__) && \
    __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#include <arm_neon.h>
#endif

namespace dimina::video {

// The decoder validates buffer bounds and layout before invoking this core.
struct NV12PixelLayout {
    int width, height, stride, left, top;
    bool fullRange, bt709;
    size_t uvStart;
};

namespace detail {
// These are the same double expressions used by the scalar formula. Each
// input byte has only 256 possible levels; keep FMA color conversion unchanged.
struct NV12Levels {
    double luma[256], chroma[256];
    uint32_t neutralRGBA[256];
    explicit NV12Levels(bool fullRange) {
        const double scale = fullRange ? 1.0 : 255.0 / 224;
        for (int index = 0; index < 256; ++index) {
            const double value = index;
            luma[index] = fullRange ? value : (value - 16) * 255.0 / 219;
            chroma[index] = (value - 128.0) * scale;
            const auto gray = uint32_t(std::max(0.0, std::min(255.0, luma[index])));
            neutralRGBA[index] = 0xff000000u | gray * 0x010101u;
        }
    }
};
inline const NV12Levels &Levels(bool fullRange) {
    static const NV12Levels full(true), limited(false);
    return fullRange ? full : limited;
}
inline uint8_t PixelByte(double value) {
    return uint8_t(std::max(0.0, std::min(255.0, value)));
}
inline void Pixel(const uint8_t *y, const uint8_t *uv, NV12PixelLayout layout, uint8_t *out) {
    double luma = *y;
    double scale = layout.fullRange ? 1.0 : 255.0 / 224;
    double u = (uv[0] - 128.0) * scale, v = (uv[1] - 128.0) * scale;
    double yy = layout.fullRange ? luma : (luma - 16) * 255.0 / 219;
    out[0] = PixelByte(yy + (layout.bt709 ? 1.5748 : 1.402) * v);
    out[1] = PixelByte(yy - (layout.bt709 ? 0.1873 : 0.3441) * u - (layout.bt709 ? 0.4681 : 0.7141) * v);
    out[2] = PixelByte(yy + (layout.bt709 ? 1.8556 : 1.772) * u);
    out[3] = 255;
}

#if defined(__aarch64__) && defined(__ARM_NEON) && defined(__BYTE_ORDER__) && \
    __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
inline uint32x2_t PixelBytes(float64x2_t value) {
    value = vmaxq_f64(vdupq_n_f64(0), vminq_f64(vdupq_n_f64(255), value));
    return vmovn_u64(vcvtq_u64_f64(value));
}
#endif
} // namespace detail

inline void ConvertNV12PixelsScalar(const uint8_t *bytes, NV12PixelLayout layout, uint8_t *pixels) {
    for (int y = 0; y < layout.height; ++y) for (int x = 0; x < layout.width; ++x) {
        int sx = x + layout.left, sy = y + layout.top;
        auto uv = layout.uvStart + size_t(sy / 2) * layout.stride + (sx / 2) * 2;
        detail::Pixel(bytes + size_t(sy) * layout.stride + sx, bytes + uv, layout,
            pixels + (size_t(y) * layout.width + x) * 4);
    }
}

inline void ConvertNV12Pixels(const uint8_t *bytes, NV12PixelLayout layout, uint8_t *pixels) {
    if (layout.width <= 0 || layout.height <= 0) return;
#if defined(__aarch64__) && defined(__ARM_NEON) && defined(__BYTE_ORDER__) && \
    __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    const auto rV = vdupq_n_f64(layout.bt709 ? 1.5748 : 1.402);
    const auto gU = vdupq_n_f64(layout.bt709 ? 0.1873 : 0.3441);
    const auto gV = vdupq_n_f64(layout.bt709 ? 0.4681 : 0.7141);
    const auto bU = vdupq_n_f64(layout.bt709 ? 1.8556 : 1.772);
    const auto &levels = detail::Levels(layout.fullRange);
    for (int y = 0; y < layout.height; ++y) {
        const int sy = y + layout.top;
        const uint8_t *ys = bytes + size_t(sy) * layout.stride + layout.left;
        const uint8_t *uvs = bytes + layout.uvStart + size_t(sy / 2) * layout.stride + (layout.left / 2) * 2;
        uint8_t *out = pixels + size_t(y) * layout.width * 4;
        int x = 0;
        // An odd crop starts in the second pixel of its NV12 chroma pair.
        if ((layout.left & 1) && x < layout.width) {
            detail::Pixel(ys, uvs, layout, out);
            ++x; uvs += 2;
        }
        for (; x + 1 < layout.width; x += 2, uvs += 2) {
            // Neutral chroma contributes exactly zero in both color matrices.
            // Reuse the same normalized luma byte for all three channels.
            if (uvs[0] == 128 && uvs[1] == 128) {
                const uint32x2_t gray {levels.neutralRGBA[ys[x]], levels.neutralRGBA[ys[x + 1]]};
                vst1_u8(out + x * 4, vreinterpret_u8_u32(gray));
                continue;
            }
            const float64x2_t yy {levels.luma[ys[x]], levels.luma[ys[x + 1]]};
            const auto u = vdupq_n_f64(levels.chroma[uvs[0]]);
            const auto v = vdupq_n_f64(levels.chroma[uvs[1]]);
            // Preserve the original double FMA order, especially both green
            // subtraction steps. Separately rounded products change bytes.
            const auto red = vfmaq_f64(yy, rV, v);
            const auto green = vfmsq_f64(vfmsq_f64(yy, gU, u), gV, v);
            const auto blue = vfmaq_f64(yy, bU, u);
            auto rgba = vorr_u32(detail::PixelBytes(red), vshl_n_u32(detail::PixelBytes(green), 8));
            rgba = vorr_u32(rgba, vshl_n_u32(detail::PixelBytes(blue), 16));
            rgba = vorr_u32(rgba, vdup_n_u32(0xff000000));
            // Byte stores allow unaligned output without type-punning UB.
            vst1_u8(out + x * 4, vreinterpret_u8_u32(rgba));
        }
        if (x < layout.width) detail::Pixel(ys + x, uvs, layout, out + x * 4);
    }
#else
    ConvertNV12PixelsScalar(bytes, layout, pixels);
#endif
}

} // namespace dimina::video
