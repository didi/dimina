#pragma once
#include "quickjs.h"
#include <cstdint>
#include <string>
#include <exception>
#include <vector>

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

inline JSValue VideoDecoderFrameToJS(JSContext *ctx, const VideoDecoderFrame &frame) {
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    const auto set = [&](const char *key, JSValue value) {
        if (JS_IsException(value) || JS_SetPropertyStr(ctx, result, key, value) < 0) {
            JS_FreeValue(ctx, result);
            return false;
        }
        return true;
    };
    if (!frame.pixels.empty()) {
        if (!set("width", JS_NewInt32(ctx, frame.width)) ||
            !set("height", JS_NewInt32(ctx, frame.height)) ||
            !set("pts", JS_NewInt64(ctx, frame.pts)) ||
            !set("pkPts", JS_NewInt64(ctx, frame.pts)) ||
            !set("data", JS_NewArrayBufferCopy(ctx, frame.pixels.data(), frame.pixels.size()))) return JS_EXCEPTION;
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
        return VideoDecoderFrameToJS(ctx, frame);
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
