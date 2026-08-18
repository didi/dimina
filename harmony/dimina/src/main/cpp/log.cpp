#include "log.h"
#include "cutils.h"
#include "quickjs.h"
#include "utils.h"
#include <cstdlib>
#include <exception>
#include <sstream>
#include "js_thread.h"
const char *js_engine_tag = "dimina/QuickJS";
const int js_engine_domain = 0x8989;

namespace {
// OwnedCStr 在 js_thread.h 里，两个文件共用。

// 自己造出来的 JSValue，离开作用域就还回去。
struct OwnedJSValue {
    JSContext *ctx;
    JSValue v;
    OwnedJSValue(JSContext *c, JSValue val) : ctx(c), v(val) {}
    ~OwnedJSValue() { JS_FreeValue(ctx, v); }
    OwnedJSValue(const OwnedJSValue &) = delete;
    OwnedJSValue &operator=(const OwnedJSValue &) = delete;
};
} // namespace

static void DumpObj(JSContext *ctx, JSValueConst val) {
    const char *str = JS_ToCString(ctx, val);
    OHError("%{public}s", str);
    JS_FreeCString(ctx, str);
}

static void StdDumpError(JSContext *ctx, JSValueConst exception_val) {
    JSValue val;
    BOOL is_error;

    is_error = JS_IsError(ctx, exception_val);
    DumpObj(ctx, exception_val);
    if (is_error) {
        val = JS_GetPropertyStr(ctx, exception_val, "stack");
        if (!JS_IsUndefined(val)) {
            DumpObj(ctx, val);
        }
        JS_FreeValue(ctx, val);
    }
}


void debugLogFunc(const char *str) { OHLog("%{public}s", str); }

void exceptionLogFunc(JSContext *ctx) {
    OHError("PrintJSException");
    JSValue exception_val = JS_GetException(ctx);
    StdDumpError(ctx, exception_val);
    JS_FreeValue(ctx, exception_val);
}


// 兼容多种 log 类型
static JSValue consoleLog(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    // stringstream 的构造函数不是 noexcept，内存不足时会抛。它必须在 try 里面构造，
    // 否则异常会越过 QuickJS 的 C 回调边界直接终止进程。
    try {
        std::stringstream msg;
        for (int i = 0; i < argc; i++) {
            OwnedCStr str(JSValueToString(ctx, argv[i]));
            if (str.get() != nullptr) {
                if (i > 0)
                    msg << " "; // Adding space between items
                msg << str.get();
            } else {
                // 转不出字符串时 QuickJS 可能已经挂了异常（比如 console.log(1n)）。
                // 打日志是尽力而为的，不该因此中断调用方，但异常必须取走——留在
                // runtime 上会被后面某个不相干的调用当成自己的错误报出来。
                discardPendingException(ctx);
                msg << "<invalid>"; // Placeholder for null or invalid strings
            }
        }

        LogLevel level = LOG_DEBUG;
        switch (magic) {
        case 0:
            level = LOG_DEBUG;
            break;
        case 1:
            level = LOG_INFO;
            break;
        case 2:
            level = LOG_WARN;
            break;
        case 3:
            level = LOG_ERROR;
            break;
        case 4:
            level = LOG_FATAL;
            break;
        }
        if (isDebugMode) {
            // sendLogToContainer 只读这两个值、不接管它们，这里造的就得这里还。
            // 调试模式下每条 console 日志都会走到，不还就是一条日志漏一个字符串对象。
            OwnedJSValue level_value(ctx, JS_NewInt32(ctx, magic));
            OwnedJSValue text_value(ctx, JS_NewString(ctx, msg.str().c_str()));
            JSValue args[2] = {level_value.v, text_value.v};
            sendLogToContainer(ctx, JS_UNDEFINED, 2, args);
        }

        OH_LOG_Print(LOG_APP, level, js_engine_domain, js_engine_tag, "[dimina][service]: %{public}s",
                     msg.str().c_str());
        

    } catch (const std::exception &e) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, js_engine_domain, js_engine_tag, "[dimina][service] exception: %{public}s",
                     e.what());
        // C++ 异常不会给 QuickJS 挂上异常对象，返回哨兵前得自己补一个。
        return throwNativeError(ctx, e.what());
    }

    return JS_UNDEFINED;
}

// 注册 Console 多种 log，不再依赖 NativeLog
void consoleInit(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_NewObject(ctx);

    // Register each console function
    JS_SetPropertyStr(ctx, console, "log",
                      JS_NewCFunctionMagic(ctx, consoleLog, "log", 1, JS_CFUNC_generic_magic, 5)); // LOG
    JS_SetPropertyStr(ctx, console, "debug",
                      JS_NewCFunctionMagic(ctx, consoleLog, "debug", 1, JS_CFUNC_generic_magic, 0)); // DEBUG
    JS_SetPropertyStr(ctx, console, "info",
                      JS_NewCFunctionMagic(ctx, consoleLog, "info", 1, JS_CFUNC_generic_magic, 1)); // INFO
    JS_SetPropertyStr(ctx, console, "warn",
                      JS_NewCFunctionMagic(ctx, consoleLog, "warn", 1, JS_CFUNC_generic_magic, 2)); // WARN
    JS_SetPropertyStr(ctx, console, "error",
                      JS_NewCFunctionMagic(ctx, consoleLog, "error", 1, JS_CFUNC_generic_magic, 3)); // ERROR

    JS_SetPropertyStr(ctx, global, "console", console);
    JS_FreeValue(ctx, global);
}
