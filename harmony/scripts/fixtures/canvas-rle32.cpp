#include "canvas_rle32.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

size_t parseSize(const char *value) {
    size_t consumed = 0;
    const auto parsed = std::stoull(value, &consumed);
    if (value[consumed] != '\0' || parsed > std::numeric_limits<size_t>::max()) {
        throw std::invalid_argument("invalid size argument");
    }
    return static_cast<size_t>(parsed);
}

std::vector<uint8_t> readBytes(const char *filename) {
    std::ifstream stream(filename, std::ios::binary);
    if (!stream) throw std::runtime_error("cannot read input file");
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(stream), {});
}

void writeBytes(const char *filename, const uint8_t *bytes, size_t length) {
    std::ofstream stream(filename, std::ios::binary);
    if (!stream) throw std::runtime_error("cannot open output file");
    if (length > 0) stream.write(reinterpret_cast<const char *>(bytes), length);
    if (!stream) throw std::runtime_error("cannot write output file");
}

void probe(size_t length, bool nullSource) {
    try {
        std::vector<uint8_t> bytes(nullSource ? 0 : length, 0xAB);
        const auto packed = dimina::canvas::encodeCanvasRle32(nullSource ? nullptr : bytes.data(), length);
        std::cout << "{\"exception\":null,\"packedBytes\":" << packed.size() << "}\n";
    } catch (const std::length_error &) {
        std::cout << "{\"exception\":\"length_error\"}\n";
    } catch (const std::invalid_argument &) {
        std::cout << "{\"exception\":\"invalid_argument\"}\n";
    }
}

} // namespace

int main(int argc, char **argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "constants") {
            std::cout << "{\"minBytes\":" << dimina::canvas::MIN_CANVAS_RLE_BYTES
                      << ",\"maxBytes\":" << dimina::canvas::MAX_CANVAS_RLE_BYTES << "}\n";
        } else if (argc == 4 && std::string(argv[1]) == "gate") {
            const auto eligible = dimina::canvas::shouldUseCanvasRle32(parseSize(argv[2]), parseSize(argv[3]));
            std::cout << (eligible ? "true\n" : "false\n");
        } else if (argc == 4 && std::string(argv[1]) == "probe") {
            probe(parseSize(argv[2]), std::string(argv[3]) == "null");
        } else if (argc == 4 && std::string(argv[1]) == "base64") {
            const auto bytes = readBytes(argv[2]);
            const auto encoded = dimina::canvas::canvasBytesToBase64(bytes.data(), bytes.size());
            writeBytes(argv[3], reinterpret_cast<const uint8_t *>(encoded.data()), encoded.size());
        } else if ((argc == 5 || argc == 6) && std::string(argv[1]) == "pack") {
            const auto bytes = readBytes(argv[2]);
            const auto offset = argc == 6 ? parseSize(argv[5]) : 0;
            std::vector<uint8_t> storage(bytes.size() + offset, 0xCD);
            std::copy(bytes.begin(), bytes.end(), storage.begin() + offset);
            const auto start = std::chrono::steady_clock::now();
            const auto packed = dimina::canvas::encodeCanvasRle32(storage.data() + offset, bytes.size());
            const auto elapsed = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - start).count();
            writeBytes(argv[3], packed.data(), packed.size());
            const auto base64 = dimina::canvas::canvasBytesToBase64(packed.data(), packed.size());
            std::ofstream metadata(argv[4]);
            if (!metadata) throw std::runtime_error("cannot open metadata file");
            metadata << "{\"codec\":\"rle32\",\"originalByteLength\":" << bytes.size()
                     << ",\"packedByteLength\":" << packed.size()
                     << ",\"eligible\":"
                     << (dimina::canvas::shouldUseCanvasRle32(bytes.size(), packed.size()) ? "true" : "false")
                     << ",\"encodeMilliseconds\":" << elapsed
                     << ",\"base64\":\"" << base64 << "\"}\n";
            if (!metadata) throw std::runtime_error("cannot write metadata file");
        } else {
            throw std::invalid_argument("expected constants, gate, probe, base64 or pack command");
        }
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
