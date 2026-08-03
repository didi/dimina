//
// Created on 2024/6/26.
//
// Node APIs are not fully supported. To solve the compilation error of the interface cannot be found,
// please include "napi/native_api.h".

#ifndef DIMINA_HARMONYOS_THREAD_H
#define DIMINA_HARMONYOS_THREAD_H

#include "napi/native_api.h"
#include "quickjs.h"
#include <cstdlib>
#include <memory>

// JSValueToString 返回的是 strdup 出来的缓冲区，得由调用方 free。中途抛异常也要还，
// 所以统一用带 free 删除器的 unique_ptr 接住，不自己写作用域类。
// 删除器用无状态仿函数，unique_ptr 不会为它多占空间。
struct FreeDeleter {
    void operator()(char *p) const noexcept { std::free(p); }
};
using OwnedCStr = std::unique_ptr<char, FreeDeleter>;

extern napi_value StartJsEngine(napi_env env, napi_callback_info info);
extern napi_value dispatchJsTask(napi_env env, napi_callback_info info);
extern napi_value dispatchJsTaskAb(napi_env env, napi_callback_info info);
extern napi_value dispatchJsTaskPath(napi_env env, napi_callback_info info);
extern napi_value destroyJsEngine(napi_env env, napi_callback_info info);

extern JSValue sendLogToContainer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
extern bool isDebugMode;

// JS_EXCEPTION 只是个哨兵值，本身不带异常对象。底层已经挂了异常就原样保留，没挂的
// （比如内存分配失败只返回空指针）自己补一个，否则 JS 侧拿到的是未初始化的内部值。
extern JSValue throwNativeError(JSContext *ctx, const char *what);
// 调用方不看返回值的场合用：把挂着的异常取走丢掉，避免它被后面不相干的调用误报。
extern void discardPendingException(JSContext *ctx);
#endif //DIMINA_HARMONYOS_THREAD_H
