#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace dimina::video {
constexpr size_t MAX_CODEC_HEADER_BYTES = 64 * 1024;
constexpr size_t MAX_CODEC_PROBE_BYTES = 1024 * 1024;
inline int ParameterKind(const std::string &mime, const uint8_t *data, size_t size) {
    if (!data || size < 2 || (data[0] & 0x80)) return -1;
    if (mime == "video/avc") {
        const int type = data[0] & 31;
        return type == 7 ? 1 : type == 8 ? 2 : 0;
    }
    if (mime == "video/hevc" && (data[1] & 7)) {
        const int type = (data[0] >> 1) & 63;
        return type == 32 ? 4 : type == 33 ? 1 : type == 34 ? 2 : 0;
    }
    return -1;
}
inline bool AppendParameter(std::vector<uint8_t> &out, const uint8_t *data, size_t size) {
    if (size > MAX_CODEC_HEADER_BYTES - 4 || out.size() > MAX_CODEC_HEADER_BYTES - 4 - size) return false;
    out.insert(out.end(), {0, 0, 0, 1});
    out.insert(out.end(), data, data + size);
    return true;
}
inline size_t StartCode(const uint8_t *data, size_t size, size_t position, size_t &prefix) {
    for (size_t index = position; index + 3 <= size; ++index) {
        if (data[index] || data[index + 1]) continue;
        if (data[index + 2] == 1) { prefix = 3; return index; }
        if (index + 4 <= size && data[index + 2] == 0 && data[index + 3] == 1) { prefix = 4; return index; }
    }
    prefix = 0; return size;
}
// Extract only parameter NALs, never replay an IDR/frame or its timestamp.
inline std::vector<uint8_t> AnnexBHeaders(const std::string &mime, const uint8_t *data, size_t size) {
    std::vector<uint8_t> headers;
    if (!data || !size) return headers;
    size_t prefix = 0, position = StartCode(data, size, 0, prefix);
    if (position == size) return {};
    for (size_t index = 0; index < position; ++index) if (data[index]) return {};
    int kinds = 0;
    while (position < size) {
        const size_t begin = position + prefix;
        size_t nextPrefix = 0, next = StartCode(data, size, begin, nextPrefix), end = next;
        while (end > begin && data[end - 1] == 0) --end;
        const int kind = ParameterKind(mime, data + begin, end - begin);
        if (kind < 0) return {};
        if (kind && !AppendParameter(headers, data + begin, end - begin)) return {};
        kinds |= kind;
        position = next; prefix = nextPrefix;
    }
    const int required = mime == "video/avc" ? 3 : mime == "video/hevc" ? 7 : -1;
    return kinds == required ? headers : std::vector<uint8_t>{};
}
inline std::vector<uint8_t> CodecHeaders(const std::string &mime, const uint8_t *data, size_t size) {
    if (size > MAX_CODEC_HEADER_BYTES) return {};
    auto headers = AnnexBHeaders(mime, data, size);
    if (!headers.empty()) return headers;
    // A strictly bounded AVCDecoderConfigurationRecord from the selected track
    // may be converted to AnnexB. Unknown records (including hvcC) use rebuild.
    if (mime != "video/avc" || !data || size < 7 || size > MAX_CODEC_HEADER_BYTES ||
        data[0] != 1 || (data[4] & 0xfc) != 0xfc || (data[4] & 3) == 2 || (data[5] & 0xe0) != 0xe0) return {};
    size_t position = 6;
    const int spsCount = data[5] & 31;
    if (!spsCount) return {};
    for (int pass = 0; pass < 2; ++pass) {
        if (pass && position >= size) return {};
        const int count = pass ? data[position++] : spsCount;
        if (!count) return {};
        for (int index = 0; index < count; ++index) {
            if (size - position < 2) return {};
            const size_t length = size_t(data[position]) << 8 | data[position + 1]; position += 2;
            if (length > size - position || ParameterKind(mime, data + position, length) != pass + 1 ||
                !AppendParameter(headers, data + position, length)) return {};
            position += length;
        }
    }
    return position == size ? headers : std::vector<uint8_t>{};
}
} // namespace dimina::video
