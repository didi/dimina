#pragma once
#include "../bridge/quickjs_value.hpp"
#include <cstring>

namespace dimina::canvas {
constexpr size_t MAX_CANVAS_PACKET_BUFFERS = 4096;
constexpr size_t MAX_CANVAS_PACKET_BYTES = 64 * 1024 * 1024;
struct CanvasBody {
    std::string json;
    std::vector<std::vector<uint8_t>> buffers;
};
// Function data owns ordinary QuickJS values. A retained JSON replacer cannot
// refer to a C++ stack frame or an engine/decoder pointer.
inline JSValue CanvasBufferReplacer(JSContext *ctx, JSValueConst thisValue, int argc, JSValueConst *argv,
                                    int, JSValue *state) {
    if (argc != 2) return JS_ThrowTypeError(ctx, "invalid canvas JSON callback");
    if (!JS_IsObject(argv[1])) return JS_DupValue(ctx, argv[1]);
    uint32_t bufferClass = 0; JS_ToUint32(ctx, &bufferClass, state[1]);
    if (JS_GetClassID(argv[1]) != bufferClass) return JS_DupValue(ctx, argv[1]);
    // Only the negotiated Canvas descriptor is binary. Ordinary application
    // ArrayBuffers keep the existing JSON.stringify representation.
    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;
    const bool packed = std::strcmp(key, "packed") == 0;
    JS_FreeCString(ctx, key);
    if (!packed) return JS_DupValue(ctx, argv[1]);
    JSAtom atom = JS_NewAtom(ctx, "__canvasTypedArray");
    if (atom == JS_ATOM_NULL) return JS_EXCEPTION;
    JSPropertyDescriptor descriptor;
    const int own = JS_GetOwnProperty(ctx, &descriptor, thisValue, atom);
    JS_FreeAtom(ctx, atom);
    if (own < 0) return JS_EXCEPTION;
    const bool wire = own > 0 && (descriptor.flags & JS_PROP_ENUMERABLE) && JS_IsString(descriptor.value);
    if (own > 0) {
        JS_FreeValue(ctx, descriptor.value); JS_FreeValue(ctx, descriptor.getter); JS_FreeValue(ctx, descriptor.setter);
    }
    if (!wire) return JS_DupValue(ctx, argv[1]);
    if (!JS_ToBool(ctx, state[2])) return JS_ThrowTypeError(ctx, "canvas binary session is unavailable");
    size_t size = 0; JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (JS_HasException(ctx)) return JS_EXCEPTION;
    uint32_t count = 0, bytes = 0;
    JS_ToUint32(ctx, &count, state[4]); JS_ToUint32(ctx, &bytes, state[3]);
    if (count >= MAX_CANVAS_PACKET_BUFFERS || size > MAX_CANVAS_PACKET_BYTES - bytes)
        return JS_ThrowRangeError(ctx, "canvas binary value exceeds budget");
    if (JS_DefinePropertyValueUint32(ctx, state[0], count, JS_DupValue(ctx, argv[1]), JS_PROP_C_W_E) < 0)
        return JS_EXCEPTION;
    JSValue placeholder = JS_NewObject(ctx);
    if (JS_IsException(placeholder)) return placeholder;
    if (JS_DefinePropertyValueStr(ctx, placeholder, "__canvasBinaryIndex", JS_NewUint32(ctx, count), JS_PROP_C_W_E) < 0) {
        JS_FreeValue(ctx, placeholder); return JS_EXCEPTION;
    }
    state[3] = JS_NewUint32(ctx, bytes + size); state[4] = JS_NewUint32(ctx, count + 1);
    return placeholder;
}
inline CanvasBody SerializeCanvasBody(JSContext *ctx, JSValueConst input, bool binary) {
    using dimina::bridge::OwnedJSValue;
    OwnedJSValue buffers(ctx, JS_NewArray(ctx)), probe(ctx, JS_NewArrayBufferCopy(ctx, nullptr, 0));
    if (JS_IsException(buffers.value) || JS_IsException(probe.value)) throw std::runtime_error("cannot allocate canvas packet");
    JSValue state[] = {buffers.value, JS_NewUint32(ctx, JS_GetClassID(probe.value)), JS_NewBool(ctx, binary),
        JS_NewUint32(ctx, 0), JS_NewUint32(ctx, 0)};
    OwnedJSValue replacer(ctx, JS_NewCFunctionData(ctx, CanvasBufferReplacer, 2, 0, 5, state));
    if (JS_IsException(replacer.value)) throw std::runtime_error("cannot allocate canvas JSON callback");
    OwnedJSValue text(ctx, JS_JSONStringify(ctx, input, replacer.value, JS_UNDEFINED));
    if (JS_IsException(text.value) || !JS_IsString(text.value)) throw std::runtime_error("cannot serialize canvas packet");
    size_t size = 0; const char *json = JS_ToCStringLen(ctx, &size, text.value);
    if (!json) throw std::runtime_error("cannot read canvas JSON");
    CanvasBody result;
    try {
        if (size > MAX_CANVAS_PACKET_BYTES - 1024) throw std::length_error("canvas JSON exceeds budget");
        result.json.assign(json, size);
    } catch (...) { JS_FreeCString(ctx, json); throw; }
    JS_FreeCString(ctx, json);
    OwnedJSValue length(ctx, JS_GetPropertyStr(ctx, buffers.value, "length"));
    uint32_t count = 0;
    if (JS_ToUint32(ctx, &count, length.value) < 0) throw std::runtime_error("cannot read canvas buffers");
    result.buffers.reserve(count);
    size_t copied = 0;
    for (uint32_t i = 0; i < count; ++i) {
        OwnedJSValue value(ctx, JS_GetPropertyUint32(ctx, buffers.value, i));
        size_t length = 0; const uint8_t *data = JS_GetArrayBuffer(ctx, &length, value.value);
        if (JS_HasException(ctx)) throw std::runtime_error("cannot read canvas buffer");
        if (length > MAX_CANVAS_PACKET_BYTES - copied) throw std::length_error("canvas binary value exceeds budget");
        copied += length;
        result.buffers.emplace_back();
        if (length) result.buffers.back().assign(data, data + length);
    }
    return result;
}
} // namespace dimina::canvas
