// Render-only SIMD decoder. All scratch storage is fixed and cleared by its JS owner.
#include <stdint.h>
#include <wasm_simd128.h>

static uint8_t input[1048576];
static uint8_t text[2097152];
uint8_t *text_ptr(void) { return text; }
static const int8_t table[256] = {
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1, -1, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
    -1, -1, -1, 0,  -1, -1, -1, 0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, -1, -1, -1, -1, -1, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
    45, 46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};

static uint32_t output_words[1048576];
#define output ((uint8_t *)output_words)
static uint32_t tail_word, tail_words;

uint8_t *input_ptr(void) { return input; }
uint8_t *output_ptr(void) { return output; }
uint32_t last_word(void) { return tail_word; }
uint32_t last_words(void) { return tail_words; }

static uint32_t word(uint32_t offset) {
    return (uint32_t)input[offset] | ((uint32_t)input[offset + 1] << 8) | ((uint32_t)input[offset + 2] << 16) |
           ((uint32_t)input[offset + 3] << 24);
}

int decode(uint32_t encoded, uint32_t total, uint32_t prefix) {
    if (encoded > sizeof(input) || encoded % 4 || prefix > sizeof(output_words) || prefix > total || prefix % 4)
        return 1;
    uint32_t cursor = 0, written = 0;
    tail_word = tail_words = 0;
    while (cursor < encoded) {
        uint32_t token = word(cursor);
        cursor += 4;
        uint32_t count = token & 0x7fffffff;
        if (!count)
            return 2;
        if (count > (total - written) / 4)
            return 3;
        uint32_t size = count * 4;
        if (token & 0x80000000) {
            if (encoded - cursor < 4)
                return 4;
            uint32_t value = word(cursor);
            cursor += 4;
            tail_word = value;
            tail_words = count;
            uint32_t copied = written < prefix ? (size < prefix - written ? size : prefix - written) : 0;
            for (uint32_t i = 0; i < copied; i += 4)
                output_words[(written + i) / 4] = value;
        } else {
            if (encoded - cursor < size)
                return 5;
            tail_words = 0;
            uint32_t copied = written < prefix ? (size < prefix - written ? size : prefix - written) : 0;
            for (uint32_t i = 0; i < copied; ++i)
                output[written + i] = input[cursor + i];
            cursor += size;
        }
        written += size;
    }
    return written == total ? 0 : 6;
}

int decode_base64(uint32_t length) {
    if (!length || length > sizeof(text) || length % 4)
        return -1;
    uint32_t padding = (text[length - 1] == '=') + (text[length - 2] == '=');
    uint32_t size = length / 4 * 3 - padding;
    if (size > sizeof(input))
        return -1;
    uint32_t written = 0, i = 0;
    // Leave the final quartet to the scalar path's canonical padding checks.
    for (; i + 16 < length; i += 16) {
        v128_t ascii = wasm_v128_load(text + i);
        v128_t high = wasm_u8x16_shr(ascii, 4), low = wasm_v128_and(ascii, wasm_i8x16_splat(15));
        // Class bits describe the legal low nibbles in each ASCII group.
        v128_t classes = wasm_i8x16_swizzle(wasm_i8x16_const(0,0,1,2,4,8,4,8,0,0,0,0,0,0,0,0), high);
        v128_t allowed = wasm_i8x16_swizzle(wasm_i8x16_const(10,14,14,14,14,14,14,14,14,14,12,5,4,4,4,5), low);
        if (!wasm_i8x16_all_true(wasm_v128_and(classes, allowed))) return -1;
        v128_t offset = wasm_i8x16_swizzle(wasm_i8x16_const(0,0,19,4,-65,-65,-71,-71,0,0,0,0,0,0,0,0), high);
        v128_t value = wasm_i8x16_add(ascii, offset);
        value = wasm_i8x16_sub(value, wasm_v128_and(wasm_i8x16_eq(ascii, wasm_i8x16_splat('/')), wasm_i8x16_splat(3)));
        // Merge adjacent sextets into twelve-bit pairs, then twenty-four-bit
        // lanes. Reverse each lane's three bytes for the original byte order.
        v128_t pair = wasm_v128_or(wasm_v128_and(wasm_i16x8_shl(value, 6), wasm_i16x8_splat(0x0FC0)), wasm_u16x8_shr(value, 8));
        v128_t packed = wasm_v128_or(wasm_v128_and(wasm_i32x4_shl(pair, 12), wasm_i32x4_splat(0x00FFF000)), wasm_u32x4_shr(pair, 16));
        packed = wasm_i8x16_shuffle(packed, packed, 2,1,0,6,5,4,10,9,8,14,13,12,0,0,0,0);
        wasm_v128_store64_lane(input + written, packed, 0);
        wasm_v128_store32_lane(input + written + 8, packed, 2);
        written += 12;
    }
    for (; i < length; i += 4) {
        uint8_t aa = text[i], bb = text[i + 1], cc = text[i + 2], dd = text[i + 3];
        int a = table[aa], b = table[bb], c = table[cc], d = table[dd];
        if (a < 0 || b < 0 || c < 0 || d < 0 || aa == '=' || bb == '=')
            return -1;
        if (cc == '=' && (i + 4 != length || dd != '=' || (b & 15)))
            return -1;
        if (dd == '=' && (i + 4 != length || (cc != '=' && (c & 3))))
            return -1;
        uint32_t word = ((uint32_t)a << 18) | ((uint32_t)b << 12) | ((uint32_t)c << 6) | d;
        input[written++] = word >> 16;
        if (written < size)
            input[written++] = word >> 8;
        if (written < size)
            input[written++] = word;
    }
    return (int)size;
}
