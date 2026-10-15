#include "quickjs.h"
#include "types/qjs_extension/settimeout.h"
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <node_api.h>
#include <set>
#include <string>
#include <thread>
#include <uv.h>

static int released;
static std::string timerError;
static std::set<void *> timerAllocations;

extern "C" void *dimina_test_calloc(size_t count, size_t size) {
    void *value = std::calloc(count, size);
    if (value)
        timerAllocations.insert(value);
    return value;
}
extern "C" void dimina_test_free(void *value) {
    timerAllocations.erase(value);
    std::free(value);
}

extern "C" uv_loop_t *js_core_get_loop_from_ctx(JSContext *ctx) {
    return static_cast<uv_loop_t *>(JS_GetContextOpaque(ctx));
}

static void Log(const char *) {}
static void Exception(JSContext *ctx) {
    JSValue error = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, error);
    timerError = message ? message : "timer exception";
    JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, error);
}
static bool Eval(JSContext *ctx, const std::string &source) {
    JSValue value = JS_Eval(ctx, source.data(), source.size(), "timers", JS_EVAL_TYPE_GLOBAL);
    const bool ok = !JS_IsException(value);
    if (!ok)
        Exception(ctx);
    JS_FreeValue(ctx, value);
    return ok;
}
static void FreeBuffer(JSRuntime *, void *, void *data) {
    delete[] static_cast<uint8_t *>(data);
    ++released;
}
static JSValue TrackedBuffer(JSContext *ctx, JSValueConst, int, JSValueConst *) {
    auto bytes = new uint8_t[1024 * 1024]();
    return JS_NewArrayBuffer(ctx, bytes, 1024 * 1024, FreeBuffer, nullptr, false);
}
static JSValue ClearAll(JSContext *ctx, JSValueConst, int, JSValueConst *) {
    clearAllTimers(ctx);
    return JS_UNDEFINED;
}
static void DrainJobs(JSContext *ctx) {
    JSContext *jobContext;
    int result;
    while ((result = JS_ExecutePendingJob(JS_GetRuntime(ctx), &jobContext)) > 0) {
    }
    if (result < 0)
        Exception(jobContext);
}
static bool Drain(JSContext *ctx, uv_loop_t *loop) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    do {
        uv_run(loop, UV_RUN_NOWAIT);
        DrainJobs(ctx);
        if (!timerError.empty())
            return false;
        if (!uv_loop_alive(loop))
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while (std::chrono::steady_clock::now() < deadline);
    timerError = "timer event loop did not finish";
    return false;
}
static std::string Text(napi_env env, napi_value value) {
    size_t length;
    napi_get_value_string_utf8(env, value, nullptr, 0, &length);
    std::string result(length + 1, '\0');
    napi_get_value_string_utf8(env, value, result.data(), result.size(), &length);
    result.resize(length);
    return result;
}
static napi_value Run(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    const auto source = Text(env, args[0]);
    const auto verify = Text(env, args[1]);
    const auto mode = Text(env, args[2]);
    timerError.clear();
    released = 0;
    uv_loop_t loop;
    uv_loop_init(&loop);
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *context = JS_NewContext(runtime);
    JS_SetContextOpaque(context, &loop);
    timeoutInit(context);
    setLogger(Log, Exception);
    JSValue global = JS_GetGlobalObject(context);
    JS_SetPropertyStr(context, global, "trackedBuffer", JS_NewCFunction(context, TrackedBuffer, "trackedBuffer", 0));
    JS_SetPropertyStr(context, global, "clearAll", JS_NewCFunction(context, ClearAll, "clearAll", 0));
    JS_FreeValue(context, global);
    bool ok = Eval(context, "function assert(x, message) { if (!x) throw Error(message) };" + source);
    if (mode == "second-runtime") {
        uv_loop_t secondLoop;
        uv_loop_init(&secondLoop);
        JSRuntime *secondRuntime = JS_NewRuntime();
        JSContext *second = JS_NewContext(secondRuntime);
        JS_SetContextOpaque(second, &secondLoop);
        timeoutInit(second);
        JS_FreeContext(second);
        JS_FreeRuntime(secondRuntime);
        uv_loop_close(&secondLoop);
        ok = ok && Eval(context, "clearTimeout(id)");
    }
    if (ok)
        ok = Drain(context, &loop);
    if (ok)
        ok = Eval(context, verify);
    if (ok) {
        JS_RunGC(runtime);
        if (mode == "tracked" && released != 1) {
            timerError = "completed timer retained its captured buffer";
            ok = false;
        }
        int handles = 0;
        uv_walk(&loop, [](uv_handle_t *, void *data) { ++*static_cast<int *>(data); }, &handles);
        if (handles) {
            timerError = "timer retained libuv handles: " + std::to_string(handles);
            ok = false;
        }
        if (!timerAllocations.empty()) {
            timerError = "timer native allocations were not released";
            ok = false;
        }
    }
    // Failure runs in a disposable child process. Do not mask the regression
    // with a later QuickJS assertion caused by the original leaked references.
    if (!ok) {
        napi_throw_error(env, nullptr, timerError.c_str());
        return nullptr;
    }
    clearAllTimers(context);
    Drain(context, &loop);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    if (uv_loop_close(&loop) != 0) {
        napi_throw_error(env, nullptr, "timer loop still busy");
        return nullptr;
    }
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &function);
    napi_set_named_property(env, exports, "run", function);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
