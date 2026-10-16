#pragma once
#include "quickjs.h"
#include <cstdint>
#include <string>
#include <exception>
#include <vector>
#include <memory>

// Own decoded bytes until the service thread creates its ArrayBuffer. No
// ArkTS/N-API handles or base64 strings cross into the QuickJS runtime.
struct VideoDecoderFrame {
    int width = 0, height = 0;
    int64_t pts = 0;
    std::vector<uint8_t> pixels;
    bool ended = false;
    std::string error;
};

VideoDecoderFrame ReadVideoDecoderFrame(int owner, const std::string &id);
bool TrySeekVideoDecoderForward(int owner, const std::string &id, double position);

inline JSValue VideoDecoderFrameToJS(JSContext *ctx, VideoDecoderFrame frame) {
    std::unique_ptr<std::vector<uint8_t>> pixels;
    if (!frame.pixels.empty()) pixels = std::make_unique<std::vector<uint8_t>>(std::move(frame.pixels));
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    const auto set = [&](const char *key, JSValue value) {
        if (JS_IsException(value) || JS_SetPropertyStr(ctx, result, key, value) < 0) {
            JS_FreeValue(ctx, result);
            return false;
        }
        return true;
    };
    if (pixels) {
        JSValue data = JS_NewArrayBufferOwned(ctx, pixels->data(), pixels->size(),
            pixels->capacity() + sizeof(*pixels),
            [](JSRuntime *, void *owner, void *) { delete static_cast<std::vector<uint8_t> *>(owner); }, pixels.get());
        if (!JS_IsException(data)) pixels.release();
        // The buffer is independent of decoder lifetime. Its finalizer releases
        // the original allocation; no duplicate clear or RGBA copy is needed.
        if (JS_IsException(data)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
        if (!set("width", JS_NewInt32(ctx, frame.width)) ||
            !set("height", JS_NewInt32(ctx, frame.height)) ||
            !set("pts", JS_NewInt64(ctx, frame.pts)) ||
            !set("pkPts", JS_NewInt64(ctx, frame.pts))) {
            JS_FreeValue(ctx, data); return JS_EXCEPTION;
        }
        if (!set("data", data)) return JS_EXCEPTION;
        // The vector now belongs exclusively to this ArrayBuffer and survives
        // seek/stop/removal. Consumers may keep it without copying RGBA again.
        if (!set("dataOwned", JS_TRUE)) return JS_EXCEPTION;
    } else if (!frame.error.empty()) {
        if (!set("error", JS_NewStringLen(ctx, frame.error.data(), frame.error.size()))) return JS_EXCEPTION;
    } else if (!set("ended", JS_NewBool(ctx, frame.ended))) return JS_EXCEPTION;
    return result;
}

inline JSValue ReadVideoDecoderFrameJS(JSContext *ctx, JSValueConst, int argc,
    JSValueConst *argv, int, JSValue *ownerData) {
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "Expected decoderId");
    int32_t owner = 0;
    if (JS_ToInt32(ctx, &owner, ownerData[0]) < 0) return JS_EXCEPTION;
    const char *id = JS_ToCString(ctx, argv[0]);
    if (!id) return JS_EXCEPTION;
    try {
        auto frame = ReadVideoDecoderFrame(owner, id);
        JS_FreeCString(ctx, id);
        id = nullptr;
        return VideoDecoderFrameToJS(ctx, std::move(frame));
    } catch (const std::exception &error) {
        if (id) JS_FreeCString(ctx, id);
        if (!JS_HasException(ctx)) JS_ThrowInternalError(ctx, "%s", error.what());
        return JS_EXCEPTION;
    }
}

inline JSValue CreateVideoDecoderFrameReader(JSContext *ctx, int owner) {
    // Bind ownership in native function data. JS cannot select another app,
    // and reading frames never needs to scan the cross-thread engine registry.
    JSValue ownerData = JS_NewInt32(ctx, owner);
    return JS_NewCFunctionData(ctx, ReadVideoDecoderFrameJS, 1, 0, 1, &ownerData);
}

inline JSValue SeekVideoDecoderForwardJS(JSContext *ctx, JSValueConst, int argc,
    JSValueConst *argv, int, JSValue *ownerData) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsNumber(argv[1])) return JS_ThrowTypeError(ctx, "Expected decoderId and position");
    int32_t owner = 0; double position = 0;
    if (JS_ToInt32(ctx, &owner, ownerData[0]) < 0 || JS_ToFloat64(ctx, &position, argv[1]) < 0) return JS_EXCEPTION;
    const char *id = JS_ToCString(ctx, argv[0]);
    if (!id) return JS_EXCEPTION;
    try {
        const bool advanced = TrySeekVideoDecoderForward(owner, id, position);
        JS_FreeCString(ctx, id); id = nullptr;
        return JS_NewBool(ctx, advanced);
    } catch (const std::exception &error) {
        if (id) JS_FreeCString(ctx, id);
        if (!JS_HasException(ctx)) JS_ThrowInternalError(ctx, "%s", error.what());
        return JS_EXCEPTION;
    }
}
inline JSValue CreateVideoDecoderForwardSeeker(JSContext *ctx, int owner) {
    JSValue ownerData = JS_NewInt32(ctx, owner);
    return JS_NewCFunctionData(ctx, SeekVideoDecoderForwardJS, 2, 0, 1, &ownerData);
}
