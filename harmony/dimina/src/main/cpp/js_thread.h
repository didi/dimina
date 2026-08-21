//
// Created on 2024/6/26.
//
// Node APIs are not fully supported. To solve the compilation error of the interface cannot be found,
// please include "napi/native_api.h".

#ifndef DIMINA_HARMONYOS_THREAD_H
#define DIMINA_HARMONYOS_THREAD_H

#include "napi/native_api.h"
#include "quickjs.h"
#include <map>
#include <future>
#include <string>
#include <cstdlib>
using namespace std;

class JSEngine;

// RAII wrapper for C strings returned by JSValueToString (strdup'd, must be free'd).
struct OwnedCStr {
    char *ptr;
    explicit OwnedCStr(char *p) : ptr(p) {}
    ~OwnedCStr() { free(ptr); }
    OwnedCStr(const OwnedCStr &) = delete;
    OwnedCStr &operator=(const OwnedCStr &) = delete;
    const char *get() const { return ptr; }
    explicit operator bool() const { return ptr != nullptr; }
};

// Throw a JS InternalError (or keep an existing pending exception) and return JS_EXCEPTION.
JSValue throwNativeError(JSContext *ctx, const char *what);

// Silently discard a pending JS exception so it doesn't leak into unrelated calls.
void discardPendingException(JSContext *ctx);

// Multi-instance engine storage
extern std::map<int, JSEngine *> engineMap;
extern std::map<int, napi_threadsafe_function> tsfnMap;

// Get engine/tsfn by appIndex
JSEngine *getEngine(int appIndex);
napi_threadsafe_function getTsfn(int appIndex);

// Data passed through threadsafe function calls
struct OnMessageData {
    napi_async_work asyncWork = nullptr;
    napi_ref callbackRef = nullptr;
    int type = 1; // 1 = invoke, 2 = publish, 3 = log
    int webViewId = 0;
    int appIndex = 0;
    std::promise<JSValue> promise;
    std::string str;
};

extern napi_value StartJsEngine(napi_env env, napi_callback_info info);
extern napi_value dispatchJsTask(napi_env env, napi_callback_info info);
extern napi_value dispatchJsTaskAb(napi_env env, napi_callback_info info);
extern napi_value dispatchJsTaskPath(napi_env env, napi_callback_info info);
extern napi_value destroyJsEngine(napi_env env, napi_callback_info info);

// Canvas NAPI functions
extern napi_value canvasBindSurface(napi_env env, napi_callback_info info);
extern napi_value canvasUnbindSurface(napi_env env, napi_callback_info info);
extern napi_value canvasResizeSurface(napi_env env, napi_callback_info info);
extern napi_value canvasUploadImage(napi_env env, napi_callback_info info);

extern JSValue sendLogToContainer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
extern bool isDebugMode;
#endif //DIMINA_HARMONYOS_THREAD_H
