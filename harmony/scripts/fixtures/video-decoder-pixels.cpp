#include "video_decoder_pixels.h"
#include <array>
#include <cfenv>
#include <cmath>
#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using dimina::video::ConvertNV12Pixels;
using dimina::video::ConvertNV12PixelsScalar;
using dimina::video::NV12PixelLayout;

namespace {
#if defined(__aarch64__) && defined(__ARM_NEON) && defined(__BYTE_ORDER__) && \
    __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
constexpr bool neonEnabled = true;
#else
constexpr bool neonEnabled = false;
#endif

void Require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}

// Independent copy of the original Convert expression and its operation grouping.
// Do not derive this reference from the optimized core or its scalar fallback.
__attribute__((noinline)) std::array<uint8_t, 4> Original(uint8_t y, uint8_t uByte, uint8_t vByte,
                                                       bool fullRange, bool bt709) {
    double luma = y;
    double scale = fullRange ? 1.0 : 255.0 / 224;
    double u = (uByte - 128.0) * scale, v = (vByte - 128.0) * scale;
    double yy = fullRange ? luma : (luma - 16) * 255.0 / 219;
    auto byte = [](double value) { return uint8_t(std::max(0.0, std::min(255.0, value))); };
    return {byte(yy + (bt709 ? 1.5748 : 1.402) * v),
            byte(yy - (bt709 ? 0.1873 : 0.3441) * u - (bt709 ? 0.4681 : 0.7141) * v),
            byte(yy + (bt709 ? 1.8556 : 1.772) * u), 255};
}

void Reference(const uint8_t *source, NV12PixelLayout layout, uint8_t *output) {
    for (int y = 0; y < layout.height; ++y) for (int x = 0; x < layout.width; ++x) {
        const int sx = layout.left + x, sy = layout.top + y;
        const size_t uv = layout.uvStart + size_t(sy / 2) * layout.stride + (sx / 2) * 2;
        const auto rgba = Original(source[size_t(sy) * layout.stride + sx], source[uv], source[uv + 1], layout.fullRange, layout.bt709);
        std::memcpy(output + (size_t(y) * layout.width + x) * 4, rgba.data(), 4);
    }
}

void Equal(const uint8_t *actual, const uint8_t *expected, size_t length, const std::string &description) {
    if (std::memcmp(actual, expected, length) == 0) return;
    for (size_t index = 0; index < length; ++index) if (actual[index] != expected[index]) {
        std::ostringstream error;
        error << description << " byte " << index << " expected " << unsigned(expected[index]) << " got " << unsigned(actual[index]);
        throw std::runtime_error(error.str());
    }
}

struct GuardedOutput {
    static constexpr uint8_t canary = 0xD3;
    std::vector<uint8_t> storage;
    size_t prefix, length;
    GuardedOutput(size_t bytes, size_t offset) : storage(32 + offset + bytes + 32, canary), prefix(32 + offset), length(bytes) {
        std::fill(storage.begin() + prefix, storage.begin() + prefix + length, 0xC5);
    }
    uint8_t *Data() { return storage.data() + prefix; }
    void Check(const std::string &description) const {
        Require(std::all_of(storage.begin(), storage.begin() + prefix, [](uint8_t byte) { return byte == canary; }), description + " changed prefix canary");
        Require(std::all_of(storage.begin() + prefix + length, storage.end(), [](uint8_t byte) { return byte == canary; }), description + " changed suffix canary");
    }
};

uint64_t Cube() {
    uint64_t pixels = 0;
    for (int variant = 0; variant < 4; ++variant) {
        const int left = variant & 1, top = (variant >> 1) & 1;
        const int stride = ((left + 256 + 1) / 2) * 2, slice = top + 1;
        NV12PixelLayout layout {256, 1, stride, left, top, bool(variant & 2), bool(variant & 1), size_t(stride) * slice};
        std::vector<uint8_t> source(layout.uvStart + size_t(stride) * ((slice + 1) / 2), 0x88);
        std::array<uint8_t, 256 * 4> expected {}, scalar {}, actual {};
        for (int x = 0; x < layout.width; ++x) source[size_t(top) * stride + left + x] = uint8_t(x);
        for (int u = 0; u < 256; ++u) for (int v = 0; v < 256; ++v) {
            // Each fixed Y position sees every chroma triple because these are
            // bijective byte offsets of the enumerated U/V. Adjacent pairs differ.
            for (int pair = 0; pair < stride / 2; ++pair) {
                source[layout.uvStart + pair * 2] = uint8_t(u + pair * 17);
                source[layout.uvStart + pair * 2 + 1] = uint8_t(v + pair * 29);
            }
            Reference(source.data(), layout, expected.data());
            ConvertNV12PixelsScalar(source.data(), layout, scalar.data());
            ConvertNV12Pixels(source.data(), layout, actual.data());
            const std::string context = "cube variant=" + std::to_string(variant) + " baseU=" + std::to_string(u) + " baseV=" + std::to_string(v);
            Equal(scalar.data(), expected.data(), expected.size(), context + " scalar differs from original formula");
            Equal(actual.data(), expected.data(), expected.size(), context + " core differs from original formula");
            pixels += layout.width;
        }
    }
    return pixels;
}

uint64_t Shapes() {
    constexpr std::array<int, 8> widths {1, 2, 3, 4, 7, 8, 15, 16};
    constexpr std::array<int, 3> heights {1, 2, 5};
    constexpr std::array<int, 5> offsets {0, 1, 2, 3, 7};
    constexpr std::array<int, 5> outputOffsets {3, 0, 7, 1, 2};
    uint64_t cases = 0;
    for (int width : widths) for (int height : heights) for (int left = 0; left < 4; ++left)
    for (int top = 0; top < 3; ++top) for (int padding : {0, 6}) for (size_t alignment = 0; alignment < offsets.size(); ++alignment)
    for (int variant = 0; variant < 4; ++variant) {
        const int stride = ((left + width + 1) / 2) * 2 + padding, slice = top + height + 1;
        NV12PixelLayout layout {width, height, stride, left, top, bool(variant & 2), bool(variant & 1), size_t(stride) * slice};
        const size_t sourceLength = layout.uvStart + size_t(stride) * ((slice + 1) / 2);
        const size_t prefix = 32 + offsets[alignment];
        std::vector<uint8_t> input(prefix + sourceLength + 32, 0xB7);
        for (size_t index = 0; index < sourceLength; ++index)
            input[prefix + index] = uint8_t((index * 73 + cases * 17) ^ (index >> 2) ^ (cases >> 3));
        const auto untouched = input;
        const size_t outputLength = size_t(width) * height * 4;
        GuardedOutput expected(outputLength, outputOffsets[alignment]), scalar(outputLength, outputOffsets[alignment]), actual(outputLength, outputOffsets[alignment]);
        Reference(input.data() + prefix, layout, expected.Data());
        ConvertNV12PixelsScalar(input.data() + prefix, layout, scalar.Data());
        ConvertNV12Pixels(input.data() + prefix, layout, actual.Data());
        std::ostringstream description;
        description << "shape " << cases << " width=" << width << " height=" << height << " left=" << left << " top=" << top
                    << " stride=" << stride << " inOffset=" << offsets[alignment] << " outOffset=" << outputOffsets[alignment] << " variant=" << variant;
        Equal(scalar.Data(), expected.Data(), outputLength, description.str() + " scalar differs from original formula");
        Equal(actual.Data(), expected.Data(), outputLength, description.str() + " core differs from original formula");
        expected.Check(description.str() + " reference"); scalar.Check(description.str() + " scalar"); actual.Check(description.str() + " core");
        Require(input == untouched, description.str() + " changed read-only input or its canaries");
        ++cases;
    }
    Require(cases == 11520, "shape matrix lost a dimension");
    return cases;
}

uint64_t Golden() {
    const std::array<uint8_t, 6> source {35, 35, 35, 35, 135, 21};
    std::array<uint8_t, 16> expected {0, 108, 47, 255, 0, 108, 47, 255, 0, 108, 47, 255, 0, 108, 47, 255};
    if (!neonEnabled) {
        // The unchanged scalar expression may be non-fused on other platforms.
        const auto green = Original(35, 135, 21, true, false)[1];
        Require(green == 108 || green == 109, "unexpected non-ARM original golden byte");
        for (size_t index = 1; index < expected.size(); index += 4) expected[index] = green;
    }
    const NV12PixelLayout layout {2, 2, 2, 0, 0, true, false, 4};
    std::array<uint8_t, 16> original {}, scalar {}, actual {};
    Reference(source.data(), layout, original.data());
    ConvertNV12PixelsScalar(source.data(), layout, scalar.data());
    ConvertNV12Pixels(source.data(), layout, actual.data());
    Equal(original.data(), expected.data(), expected.size(), "fixed original golden");
    Equal(scalar.data(), expected.data(), expected.size(), "scalar golden green 108");
    Equal(actual.data(), expected.data(), expected.size(), "core golden green 108");
    return 4;
}

uint64_t Empty() {
    const std::array<uint8_t, 16> source {};
    uint64_t cases = 0;
    for (const auto &size : {std::pair<int, int>{0, 0}, {0, 1}, {1, 0}}) {
        const NV12PixelLayout layout {size.first, size.second, 2, 0, 0, false, false, 4};
        std::array<uint8_t, 64> output; output.fill(0xC5);
        const auto expected = output;
        ConvertNV12Pixels(source.data(), layout, output.data() + 7);
        Require(output == expected, "empty core touched output");
        ConvertNV12PixelsScalar(source.data(), layout, output.data() + 7);
        Require(output == expected, "empty scalar fallback touched output");
        ++cases;
    }
    return cases;
}
} // namespace

int main(int argc, char **argv) {
    try {
        Require(std::fegetround() == FE_TONEAREST, "expected the production FE_TONEAREST rounding mode");
        Require(argc == 2, "expected cube, shapes, golden or empty case");
        const std::string name = argv[1];
        uint64_t cases = 0;
        if (name == "cube") cases = Cube();
        else if (name == "shapes") cases = Shapes();
        else if (name == "golden") cases = Golden();
        else if (name == "empty") cases = Empty();
        else throw std::runtime_error("unknown pixel fixture case");
        std::cout << "{\"cases\":" << cases << ",\"mismatchBytes\":0,\"neonEnabled\":" << (neonEnabled ? "true" : "false")
                  << ",\"roundingMode\":\"FE_TONEAREST\",\"fastMath\":"
#ifdef __FAST_MATH__
                  << "true"
#else
                  << "false"
#endif
                  << "}\n";
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
