

#include "napi/native_api.h"
#include "js_thread.h"
#include "brotli/decode.h"

#include <cstring>
#include <vector>

const char *log_v = "dimina/v1";

using namespace std;

static napi_value BrotliDecompress(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    if (napi_ok != napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) || argc < 1) {
        napi_throw_error(env, "-1000", "arguments invalid");
        return nullptr;
    }

    void *inputData = nullptr;
    size_t inputLength = 0;
    if (napi_ok != napi_get_arraybuffer_info(env, args[0], &inputData, &inputLength)) {
        napi_throw_error(env, "-1001", "Invalid ArrayBuffer");
        return nullptr;
    }

    BrotliDecoderState *state = BrotliDecoderCreateInstance(nullptr, nullptr, nullptr);
    if (state == nullptr) {
        napi_throw_error(env, "-1002", "brotli decompress fail");
        return nullptr;
    }

    const uint8_t *nextIn = static_cast<const uint8_t *>(inputData);
    size_t availableIn = inputLength;
    vector<uint8_t> output;
    constexpr size_t chunkSize = 64 * 1024;
    BrotliDecoderResult result;

    do {
        const size_t offset = output.size();
        output.resize(offset + chunkSize);
        uint8_t *nextOut = output.data() + offset;
        size_t availableOut = chunkSize;
        result = BrotliDecoderDecompressStream(state, &availableIn, &nextIn, &availableOut, &nextOut, nullptr);
        output.resize(offset + chunkSize - availableOut);
    } while (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT);

    BrotliDecoderDestroyInstance(state);

    if (result != BROTLI_DECODER_RESULT_SUCCESS) {
        napi_throw_error(env, "-1003", "brotli decompress fail");
        return nullptr;
    }

    void *arrayBufferData = nullptr;
    napi_value arrayBuffer;
    if (napi_ok != napi_create_arraybuffer(env, output.size(), &arrayBufferData, &arrayBuffer)) {
        napi_throw_error(env, "-1004", "create ArrayBuffer fail");
        return nullptr;
    }
    if (!output.empty()) {
        memcpy(arrayBufferData, output.data(), output.size());
    }
    return arrayBuffer;
}

EXTERN_C_START static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"StartJsEngine", nullptr, StartJsEngine, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"dispatchJsTask", nullptr, dispatchJsTask, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"dispatchJsTaskAb", nullptr, dispatchJsTaskAb, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"dispatchJsTaskPath", nullptr, dispatchJsTaskPath, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroyJsEngine", nullptr, destroyJsEngine, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"brotliDecompress", nullptr, BrotliDecompress, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);

    return exports;
}
EXTERN_C_END

static napi_module demoModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "dimina",
    .nm_priv = ((void *)0),
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterDiminaModule(void) { napi_module_register(&demoModule); }
