#pragma once
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dimina::bridge {
// Cross-thread packets own bytes and scalars, never runtime handles.
struct Value {
    enum Kind { Undefined, Null, Boolean, Number, String, Bytes, Array, Object } kind = Undefined;
    bool boolean = false;
    double number = 0;
    std::u16string string;
    std::vector<uint8_t> bytes;
    std::vector<Value> array;
    std::vector<std::pair<std::u16string, Value>> object;
};

// CESU-8 preserves all JavaScript UTF-16 code units, including lone surrogates
// and embedded NULs, across JNI and N-API.
inline std::u16string decodeString(const char *bytes, size_t size) {
    std::u16string result;
    for (size_t i = 0; i < size;) {
        uint32_t c = static_cast<uint8_t>(bytes[i++]);
        if (c >= 0xc0 && c < 0xe0 && i < size) {
            c = ((c & 31) << 6) | (static_cast<uint8_t>(bytes[i++]) & 63);
        } else if (c >= 0xe0 && i + 1 < size) {
            c = ((c & 15) << 12) | ((static_cast<uint8_t>(bytes[i]) & 63) << 6)
                | (static_cast<uint8_t>(bytes[i + 1]) & 63);
            i += 2;
        }
        result.push_back(static_cast<char16_t>(c));
    }
    return result;
}
inline std::string encodeString(const std::u16string &string) {
    std::string result;
    for (uint16_t c : string) {
        if (c < 0x80) result.push_back(static_cast<char>(c));
        else if (c < 0x800) {
            result.push_back(static_cast<char>(0xc0 | (c >> 6)));
            result.push_back(static_cast<char>(0x80 | (c & 63)));
        } else {
            result.push_back(static_cast<char>(0xe0 | (c >> 12)));
            result.push_back(static_cast<char>(0x80 | ((c >> 6) & 63)));
            result.push_back(static_cast<char>(0x80 | (c & 63)));
        }
    }
    return result;
}
inline void checkDepth(unsigned depth) {
    if (depth > 128) throw std::runtime_error("bridge value is cyclic or too deeply nested");
}
}
