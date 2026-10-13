#include "quickjs.h"
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>
#include <cstring>

static int released = 0;
static void ReleaseOwned(JSRuntime *, void *opaque, void *) {
    delete static_cast<std::vector<uint8_t> *>(opaque);
    ++released;
}

static bool Succeeded(JSContext *ctx, JSValue value) {
    if (!JS_IsException(value)) return true;
    JSValue error = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, error);
    std::cerr << (message ? message : "QuickJS exception") << '\n';
    JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, error);
    return false;
}

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *context = JS_NewContext(runtime);
    std::ifstream input(argv[1]);
    std::string source((std::istreambuf_iterator<char>(input)), {});
    JSValue result = JS_Eval(context, source.data(), source.size(), "json-parity", JS_EVAL_TYPE_GLOBAL);
    if (!Succeeded(context, result)) return 2;
    JS_FreeValue(context, result);

    const char *zeros = R"JS(
        for (let i = 0; i < 12; i++) {
            const bytes = new Uint8Array(new ArrayBuffer(2 * 1024 * 1024 + i));
            for (let j = 0; j < bytes.length; j++) if (bytes[j] !== 0) throw Error('ArrayBuffer lost zero initialization');
            bytes.fill(173);
        }
    )JS";
    result = JS_Eval(context, zeros, std::strlen(zeros), "zeroed-large-buffers", JS_EVAL_TYPE_GLOBAL);
    if (!Succeeded(context, result)) return 24;
    JS_FreeValue(context, result);

    // A bulk append must propagate allocation failure and leave the context usable.
    std::string large(1024 * 1024, 'A');
    JSValue value = JS_NewStringLen(context, large.data(), large.size());
    if (!Succeeded(context, value)) return 3;
    JSMemoryUsage memory;
    JS_ComputeMemoryUsage(runtime, &memory);
    JS_SetMemoryLimit(runtime, memory.malloc_size + 1024);
    result = JS_JSONStringify(context, value, JS_UNDEFINED, JS_UNDEFINED);
    if (!JS_IsException(result)) return 4;
    JS_FreeValue(context, JS_GetException(context));
    JS_SetMemoryLimit(runtime, static_cast<size_t>(-1));
    result = JS_JSONStringify(context, value, JS_UNDEFINED, JS_UNDEFINED);
    if (!Succeeded(context, result)) return 5;
    size_t length;
    const char *text = JS_ToCStringLen(context, &length, result);
    if (!text || length != large.size() + 2 || text[0] != '"' || text[length - 1] != '"') return 6;
    JS_FreeCString(context, text);
    JS_FreeValue(context, result);
    JS_FreeValue(context, value);

    // Adoption must use the original bytes, charge their capacity, and release
    // once on detach. Failed adoption leaves ownership with the embedding.
    auto owned = new std::vector<uint8_t>(1024 * 1024, 173);
    JS_ComputeMemoryUsage(runtime, &memory);
    const auto priorBytes = memory.malloc_size;
    value = JS_NewArrayBufferOwned(context, owned->data(), owned->size(), owned->capacity() + sizeof(*owned), ReleaseOwned, owned);
    if (!Succeeded(context, value)) return 7;
    size_t bytesLength;
    if (JS_GetArrayBuffer(context, &bytesLength, value) != owned->data() || bytesLength != owned->size()) return 8;
    JS_ComputeMemoryUsage(runtime, &memory);
    if (memory.malloc_size - priorBytes < 1024 * 1024) return 9;
    JS_DetachArrayBuffer(context, value);
    if (released != 1) return 10;
    JS_ComputeMemoryUsage(runtime, &memory);
    if (memory.malloc_size > priorBytes + 65536) return 11;
    JS_FreeValue(context, value);
    JS_RunGC(runtime);
    if (released != 1) return 12;

    owned = new std::vector<uint8_t>(1024 * 1024, 181);
    JS_ComputeMemoryUsage(runtime, &memory);
    JS_SetMemoryLimit(runtime, memory.malloc_size + 65536);
    value = JS_NewArrayBufferOwned(context, owned->data(), owned->size(), owned->capacity() + sizeof(*owned), ReleaseOwned, owned);
    if (!JS_IsException(value) || released != 1 || owned->front() != 181) return 13;
    JS_FreeValue(context, JS_GetException(context));
    delete owned;
    JS_SetMemoryLimit(runtime, static_cast<size_t>(-1));

    // A source object's finalizer runs after transfer too. It must not release
    // the new owner's bytes or dereference the retired accounting record.
    const char *transferSource = "b => b.transfer(b.byteLength)";
    JSValue transfer = JS_Eval(context, transferSource, std::strlen(transferSource), "transfer", JS_EVAL_TYPE_GLOBAL);
    if (!Succeeded(context, transfer)) return 14;
    owned = new std::vector<uint8_t>(1024 * 1024, 191);
    value = JS_NewArrayBufferOwned(context, owned->data(), owned->size(), owned->capacity() + sizeof(*owned), ReleaseOwned, owned);
    result = JS_Call(context, transfer, JS_UNDEFINED, 1, &value);
    if (!Succeeded(context, result)) return 15;
    JS_FreeValue(context, value);
    if (released != 1) return 16;
    auto data = JS_GetArrayBuffer(context, &bytesLength, result);
    if (data != owned->data() || bytesLength != 1024 * 1024 || data[bytesLength - 1] != 191) return 17;
    JS_FreeValue(context, result);
    if (released != 2) return 18;
    JS_FreeValue(context, transfer);

    transferSource = "b => b.transfer(b.byteLength + 4)";
    transfer = JS_Eval(context, transferSource, std::strlen(transferSource), "grow-transfer", JS_EVAL_TYPE_GLOBAL);
    owned = new std::vector<uint8_t>(1024 * 1024, 193);
    value = JS_NewArrayBufferOwned(context, owned->data(), owned->size(), owned->capacity() + sizeof(*owned), ReleaseOwned, owned);
    result = JS_Call(context, transfer, JS_UNDEFINED, 1, &value);
    if (!Succeeded(context, result)) return 19;
    JS_FreeValue(context, value);
    if (released != 3) return 20;
    data = JS_GetArrayBuffer(context, &bytesLength, result);
    if (!data || bytesLength != 1024 * 1024 + 4 || data[0] != 193 || data[bytesLength - 5] != 193) return 21;
    for (size_t index = bytesLength - 4; index < bytesLength; ++index) if (data[index]) return 22;
    JS_FreeValue(context, result);
    JS_FreeValue(context, transfer);
    if (released != 3) return 23;
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return 0;
}
