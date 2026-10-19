#include "video_decoder_frame.h"
#include <iostream>
#include <cstring>
#include <stdexcept>
#include "registration.h"

static bool removed = false;
VideoDecoderFrame ReadVideoDecoderFrame(int owner, const std::string &id) {
    if (id == "codec-error") throw std::runtime_error("codec failed");
    if (removed || id != "decoder") return {};
    return {1, 1, owner * 1000, {uint8_t(owner), 0, 0, 255}, false, ""};
}

bool TrySeekVideoDecoderForward(int owner, const std::string &id, double position) {
    if (id == "codec-error") throw std::runtime_error("codec failed");
    return !removed && id == "decoder" && position == 200 && (owner == 7 || owner == 8);
}

int main() {
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(runtime);
    int result = 0;
    {
        // Packet storage shares the RGBA ArrayBuffer lifetime and must count
        // against the same QuickJS budget, including its reserved capacity.
        std::vector<uint8_t> bytes(65536, 1);
        for (size_t i = 0; i < bytes.size() / 2; i++) bytes[i] = uint8_t((i * 37 + i / 4) % 251);
        auto packet = dimina::canvas::PrepareCanvasPixels(bytes.data(), bytes.size());
        if (!packet) return 1;
        const size_t packetCapacity = packet->packed.capacity();
        const uint8_t *original = bytes.data();
        std::weak_ptr<const dimina::canvas::PreparedCanvasPixels> lifetime = packet;
        VideoDecoderFrame frame {128, 128, 0, std::move(bytes), false, "", std::move(packet)};
        JSMemoryUsage before, after;
        JS_ComputeMemoryUsage(runtime, &before);
        JSValue value = VideoDecoderFrameToJS(ctx, std::move(frame));
        JSValue data = JS_GetPropertyStr(ctx, value, "data");
        size_t length = 0;
        uint8_t *owned = JS_GetArrayBuffer(ctx, &length, data);
        JS_ComputeMemoryUsage(runtime, &after);
        if (owned != original || length != 65536 || lifetime.expired() ||
            after.malloc_size - before.malloc_size < int64_t(length + packetCapacity + sizeof(OwnedVideoPixels))) result = 1;
        if (!dimina::canvas::PreparedCanvasRegistry::Find(owned, length)) result = 1;
        if (owned) {
            owned[17] ^= 1;
            if (dimina::canvas::PreparedCanvasRegistry::Find(owned, length)) result = 1;
            owned[17] ^= 1;
            if (!dimina::canvas::PreparedCanvasRegistry::Find(owned, length)) result = 1;
        }
        JS_FreeValue(ctx, value);
        if (lifetime.expired()) result = 1; // The separately retained buffer owns it.
        JS_DetachArrayBuffer(ctx, data);
        if (!lifetime.expired() || dimina::canvas::PreparedCanvasRegistry::Find(original, length)) result = 1;
        JS_FreeValue(ctx, data);
        if (result) std::cerr << "prepared frame ownership, mutation validation or memory accounting failed\n";
    }
    {
        // A large real RGBA payload must remain owned after the decoder packet
        // and its source storage are released, with no base64 representation.
        std::vector<uint8_t> pixels(720 * 1080 * 4);
        for (size_t i = 0; i < pixels.size(); ++i) pixels[i] = uint8_t(i % 251);
        VideoDecoderFrame frame {720, 1080, 125000, std::move(pixels), false, ""};
        const uint8_t *originalPixels = frame.pixels.data();
        JSMemoryUsage before, after;
        JS_ComputeMemoryUsage(runtime, &before);
        JSValue value = VideoDecoderFrameToJS(ctx, std::move(frame));
        JSValue data = JS_GetPropertyStr(ctx, value, "data");
        size_t length;
        if (JS_GetArrayBuffer(ctx, &length, data) != originalPixels || length != 3110400) result = 1;
        JS_FreeValue(ctx, data);
        JS_ComputeMemoryUsage(runtime, &after);
        if (after.malloc_size - before.malloc_size < 3110400) result = 1;
        frame = {};
        JSValue global = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global, "frame", value);
        JS_FreeValue(ctx, global);
        auto engine = createEngine(7);
        engine->callback(ctx);
        delete engine;
        const char *script = R"JS(
            if (!(frame.data instanceof ArrayBuffer) || frame.data.byteLength !== 3110400)
                throw Error('missing owned RGBA buffer');
            if (frame.dataOwned !== true) throw Error('owned frame is not identified to its consumer');
            if (frame.width !== 720 || frame.height !== 1080 || frame.pts !== 125000 || frame.pkPts !== frame.pts)
                throw Error('frame metadata changed');
            const bytes = new Uint8Array(frame.data);
            for (let i = 0; i < bytes.length; i++) {
                if (bytes[i] !== i % 251) throw Error('frame bytes changed: ' + i);
            }
            bytes[0] = 99;
            const nativeFrame = readFrame('decoder', 8);
            const nextFrame = readFrame('decoder');
            if (nativeFrame.dataOwned !== true || nextFrame.dataOwned !== true || nativeFrame.data === nextFrame.data)
                throw Error('independent native frame buffers lost ownership');
            new Uint8Array(nextFrame.data)[0] = 91;
            if (nativeFrame.pts !== 7000 || new Uint8Array(nativeFrame.data)[0] !== 7)
                throw Error('caller changed decoder ownership');
            if (readFrame('missing').data !== undefined) throw Error('unknown decoder returned bytes');
            if (seekForward('decoder', 200, 999) !== true || seekForward('missing', 200) !== false || seekForward('decoder', 0) !== false)
                throw Error('native forward result or owner changed');
            try { seekForward('decoder', '200'); throw Error('expected a position type error'); }
            catch (error) { if (!(error instanceof TypeError)) throw error; }
            let invalid = false, failed = false;
            try { readFrame(7); } catch (error) { invalid = error instanceof TypeError; }
            try { readFrame('codec-error'); } catch (error) { failed = /codec failed/.test(error.message); }
            if (!invalid || !failed) throw Error('native reader swallowed an error');
        )JS";
        value = JS_Eval(ctx, script, std::strlen(script), "<video-frame>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(value)) result = 1;
        JS_FreeValue(ctx, value);

        for (const auto &packet : {
            VideoDecoderFrame{0, 0, 0, {}, false, ""},
            VideoDecoderFrame{0, 0, 0, {}, true, ""},
            VideoDecoderFrame{0, 0, 0, {}, false, "codec failed"}}) {
            value = VideoDecoderFrameToJS(ctx, packet);
            if (JS_IsException(value)) result = 1;
            data = JS_GetPropertyStr(ctx, value, "data");
            if (!JS_IsUndefined(data)) result = 1;
            JS_FreeValue(ctx, data);
            data = JS_GetPropertyStr(ctx, value, "dataOwned");
            if (!JS_IsUndefined(data)) result = 1;
            JS_FreeValue(ctx, data);
            if (packet.error.empty()) {
                JSValue ended = JS_GetPropertyStr(ctx, value, "ended");
                if (JS_ToBool(ctx, ended) != packet.ended) result = 1;
                JS_FreeValue(ctx, ended);
            } else {
                JSValue error = JS_GetPropertyStr(ctx, value, "error");
                const char *message = JS_ToCString(ctx, error);
                if (!message || packet.error != message) result = 1;
                if (message) JS_FreeCString(ctx, message);
                JS_FreeValue(ctx, error);
            }
            JS_FreeValue(ctx, value);
        }
        JSContext *other = JS_NewContext(runtime);
        engine = createEngine(8);
        engine->callback(other);
        delete engine;
        const char *scope = "if (new Uint8Array(readFrame('decoder').data)[0] !== 8) throw Error('app scope mixed');";
        value = JS_Eval(other, scope, std::strlen(scope), "<other-app>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(value)) result = 1;
        JS_FreeValue(other, value);
        JS_FreeContext(other);
        removed = true;
        const char *teardown = "if (readFrame('decoder').data !== undefined || seekForward('decoder',200) !== false) throw Error('removed decoder returned bytes or accepted a seek');";
        value = JS_Eval(ctx, teardown, std::strlen(teardown), "<teardown>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(value)) result = 1;
        JS_FreeValue(ctx, value);
        JS_SetMemoryLimit(runtime, 4 * 1024 * 1024);
        VideoDecoderFrame large {720, 1080, 0, std::vector<uint8_t>(720 * 1080 * 4), false, ""};
        value = VideoDecoderFrameToJS(ctx, std::move(large));
        if (!JS_IsException(value)) { result = 1; std::cerr << "owned frame bypassed QuickJS memory limit\n"; }
        JS_FreeValue(ctx, value);
        if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
        JS_SetMemoryLimit(runtime, SIZE_MAX);
        if (JS_HasException(ctx)) {
            JSValue error = JS_GetException(ctx);
            const char *message = JS_ToCString(ctx, error);
            std::cerr << (message ? message : "QuickJS frame failure") << '\n';
            JS_FreeCString(ctx, message);
            JS_FreeValue(ctx, error);
        }
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
    return result;
}
