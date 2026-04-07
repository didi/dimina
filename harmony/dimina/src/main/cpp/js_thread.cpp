#include "js_thread.h"
#include "js_engine.h"
#include "log.h"
#include "napi/native_api.h"
#include <future>
#include "utils.h"
#include "types/qjs_extension/settimeout.h"
#include <sys/mman.h> // 包含 mmap, munmap 等函数
#include <unistd.h>   // 包含 close 函数
#include <map>

// 使用 map 存储多个 JSEngine 实例
std::map<int, JSEngine *> engineMap;
// 使用 map 存储每个引擎实例对应的线程安全函数
std::map<int, napi_threadsafe_function> tsfnMap;
// 引擎是否处于调试模式
bool isDebugMode = false;

// 获取指定 appIndex 的 JSEngine 实例
JSEngine *getEngine(int appIndex) {
    auto it = engineMap.find(appIndex);
    if (it != engineMap.end()) {
        return it->second;
    }
    return nullptr;
}

// 获取指定 appIndex 的线程安全函数
napi_threadsafe_function getTsfn(int appIndex) {
    auto it = tsfnMap.find(appIndex);
    if (it != tsfnMap.end()) {
        return it->second;
    }
    return nullptr;
}


void initBridges(JSContext *ctx);
void registerInvoke(JSContext *ctx);
void registerPublish(JSContext *ctx);

struct OnMessageData {
    napi_async_work asyncWork = nullptr;
    napi_ref callbackRef = nullptr;
    int type = 1; // 1 = invoke, 2 = publish , 3 = 日志打印
    int webViewId = 0;
    int appIndex = 0; // 添加 appIndex 字段
    std::promise<JSValue> promise;
    std::string str;
};

// 定义一个回调函数 onMessageCb，参数包括环境env，回调函数js_cb，上下文context，数据data
static void onMessageCb(napi_env env, napi_value js_cb, void *context, void *data) {
    //    OHLog("onMessageCb begin isMainThread: %{public}d", isMainThread());

    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);

    auto *asyncContext = static_cast<OnMessageData *>(data);
    const char *str = asyncContext->str.c_str();
    int appIndex = asyncContext->appIndex; // 添加 appIndex 到 OnMessageData 结构

    napi_status status;
    napi_value s;
    napi_value arrayBuffer;

    if (asyncContext->type == 1) {
        status = napi_create_string_utf8(env, str, NAPI_AUTO_LENGTH, &s);
        status = napi_get_undefined(env, &arrayBuffer);
    } else {
        status = napi_get_undefined(env, &s);
        void *dataPtr;
        status = napi_create_arraybuffer(env, strlen(str), &dataPtr, &arrayBuffer);
        memcpy(dataPtr, str, strlen(str));
    }

    napi_value type, webViewId;
    napi_create_int32(env, asyncContext->type, &type);
    napi_create_int32(env, asyncContext->webViewId, &webViewId);

    napi_value args[4] = {type, webViewId, s, arrayBuffer};

    napi_value undefined;
    napi_value result;
    status = napi_get_undefined(env, &undefined);

    //    OHLog("napi_call_function before type: %{public}d webViewId: %{public}d", asyncContext->type,
    //    asyncContext->webViewId); OHLog("napi_call_function before len: %{public}zu", strlen(str));
    OHLog("napi_call_function before str: %{public}s", str);

    status = napi_call_function(env, undefined, js_cb, 4, args, &result);

    //     OHLog("napi_call_function after");

    if (status == napi_pending_exception) {
        // 异常发生，获取并清除异常
        napi_value exception;
        napi_get_and_clear_last_exception(env, &exception);

        // 创建一个 napi_value 用于属性名 "message"
        napi_value message_key;
        napi_create_string_utf8(env, "message", NAPI_AUTO_LENGTH, &message_key);

        // 获取异常对象的 message 属性
        napi_value message;
        napi_get_property(env, exception, message_key, &message);

        // 获取 message 属性的字符串表示并记录
        char buffer[512];
        size_t buffer_size;
        napi_get_value_string_utf8(env, message, buffer, sizeof(buffer), &buffer_size);
        OHError("JavaScript Exception: %{public}s", buffer);

        // 创建一个 napi_value 用于属性名 "stack"
        napi_value stack_key;
        napi_create_string_utf8(env, "stack", NAPI_AUTO_LENGTH, &stack_key);

        // 获取异常对象的 stack 属性
        napi_value stack;
        napi_get_property(env, exception, stack_key, &stack);

        // 获取 stack 属性的字符串表示并记录
        char stack_buffer[2048]; // 可能需要更大的缓冲区取决于堆栈的大小
        size_t stack_buffer_size;
        napi_get_value_string_utf8(env, stack, stack_buffer, sizeof(stack_buffer), &stack_buffer_size);
        OHError("JavaScript Exception Stack Trace: %{public}s", stack_buffer);
    }

    JSValue jsValueResult = JS_EXCEPTION;
    if (status != napi_ok) {
        OHError("onMessage napi_call_function error: print value:");
        //         printJsValue(gCtx, v, 0);

        napi_value err;
        napi_status exception_status = napi_get_and_clear_last_exception(env, &err);
        if (exception_status == napi_ok) {
            OHError("onMessage napi_call_function exception clear");
        }
    } else {
        JSEngine *engine = getEngine(appIndex);
        if (engine) {
            JSValue jsResult = ConvertNapiValueToJsValue(env, engine->getContext(), result);
            jsValueResult = jsResult;
        }
        //        JS_FreeValue(gCtx, jsResult);
        OHLog("onMessageCb end");
    }
    asyncContext->promise.set_value(jsValueResult);
    delete asyncContext;
    napi_close_handle_scope(env, scope);
}


static JSValue invoke(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    OHLog("invoke begin isMainThread: %{public}d", isMainThread());

    // 获取当前引擎实例的 appIndex
    JSEngine *currentEngine = nullptr;
    for (const auto &pair : engineMap) {
        if (pair.second->getContext() == ctx) {
            currentEngine = pair.second;
            break;
        }
    }

    if (!currentEngine) {
        OHError("No engine found for context %{public}p", (void *)ctx);
        return JS_UNDEFINED;
    }

    if (currentEngine->closing) {
        OHLog("invoke engine_closing or not found");
        return JS_UNDEFINED;
    }

    // Use the proper QuickJS API instead of internal types
    JSValue v = JS_DupValue(ctx, argv[0]);
    //    OHLog("invoke printJsValue");
    //    printJsValue(ctx, v);

    const char *str = JSValueToString(ctx, v);
    auto *asyncContext = new OnMessageData();
    asyncContext->str = str;
    asyncContext->appIndex = currentEngine->getAppIndex(); // 设置 appIndex
    free((void *)str);
    asyncContext->type = 1;
    const bool blocking = true;

    napi_threadsafe_function tsfn = getTsfn(currentEngine->getAppIndex());
    if (!tsfn) {
        OHError("Threadsafe function not found for appIndex: %{public}d", currentEngine->getAppIndex());
        return JS_EXCEPTION;
    }

    napi_acquire_threadsafe_function(tsfn);
    napi_threadsafe_function_call_mode call_mode = blocking ? napi_tsfn_blocking : napi_tsfn_nonblocking;

    napi_status status = napi_call_threadsafe_function(tsfn, asyncContext, call_mode);
    if (status != napi_ok) {
        OHError("napi_call_threadsafe_function error");
        return JS_EXCEPTION;
    }

    std::future<JSValue> future = asyncContext->promise.get_future();
    try {
        JSValue value = future.get();
        if (JS_IsException(value)) {
            OHError("invoke error");
            return JS_EXCEPTION;
        }
        OHLog("invoke end");
        return value;
    } catch (const std::exception &e) {
        OHError("[dimina][service] invoke error: %{public}s", e.what());
        return JS_EXCEPTION;
    }
}

JSValue sendLogToContainer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    OHLog("sendLogToContainer begin isMainThread: %{public}d", isMainThread());
    // 获取当前引擎实例的 appIndex
    JSEngine *currentEngine = nullptr;
    for (const auto &pair : engineMap) {
        if (pair.second->getContext() == ctx) {
            currentEngine = pair.second;
            break;
        }
    }
    if (!currentEngine || currentEngine->closing) {
        OHLog("sendLogToContainer engine_closing or not found");
        return JS_UNDEFINED;
    }
    if (argc < 2) {
        OHLog("sendLogToContainer expects at least one argument");
        return JS_ThrowTypeError(ctx, "publish expects at least one argument");
    }
    int32_t level;
    if (JS_ToInt32(ctx, &level, argv[0])) {
        return JS_EXCEPTION;
    }
    const char *logMessage = JSValueToString(ctx, JS_DupValue(ctx, argv[1]));
    auto *asyncContext = new OnMessageData();
    asyncContext->str = logMessage;
    asyncContext->appIndex = currentEngine->getAppIndex(); // 设置 appIndex
    free((void *)logMessage);
    asyncContext->type = 3;
    asyncContext->webViewId = level;
    napi_threadsafe_function tsfn = getTsfn(currentEngine->getAppIndex());
    if (!tsfn) {
        OHError("Threadsafe function not found for appIndex: %{public}d", currentEngine->getAppIndex());
        return JS_EXCEPTION;
    }
    napi_acquire_threadsafe_function(tsfn);
    napi_threadsafe_function_call_mode call_mode = napi_tsfn_nonblocking;
    napi_status status = napi_call_threadsafe_function(tsfn, asyncContext, call_mode);
    if (status != napi_ok) {
        OHError("napi_call_threadsafe_function error");
        return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

static JSValue publish(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    OHLog("publish begin isMainThread: %{public}d", isMainThread());

    // 获取当前引擎实例的 appIndex
    JSEngine *currentEngine = nullptr;
    for (const auto &pair : engineMap) {
        if (pair.second->getContext() == ctx) {
            currentEngine = pair.second;
            break;
        }
    }

    if (!currentEngine || currentEngine->closing) {
        OHLog("publish engine_closing or not found");
        return JS_UNDEFINED;
    }

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "publish expects at least one argument");
    }

    int32_t webViewId;
    if (JS_ToInt32(ctx, &webViewId, argv[0])) {
        return JS_EXCEPTION;
    }

    // Use the proper QuickJS API instead of internal types
    JSValue v = JS_DupValue(ctx, argv[1]);
    //    OHLog("publish printJsValue");
    //    printJsValue(ctx, v);

    const char *str = JSValueToString(ctx, v);

    auto *asyncContext = new OnMessageData();
    asyncContext->str = str;
    asyncContext->appIndex = currentEngine->getAppIndex(); // 设置 appIndex
    free((void *)str);
    asyncContext->type = 2;
    asyncContext->webViewId = webViewId;
    const bool blocking = false;

    napi_threadsafe_function tsfn = getTsfn(currentEngine->getAppIndex());
    if (!tsfn) {
        OHError("Threadsafe function not found for appIndex: %{public}d", currentEngine->getAppIndex());
        return JS_EXCEPTION;
    }

    napi_acquire_threadsafe_function(tsfn);
    napi_threadsafe_function_call_mode call_mode = blocking ? napi_tsfn_blocking : napi_tsfn_nonblocking;

    napi_status status = napi_call_threadsafe_function(tsfn, asyncContext, call_mode);
    if (status != napi_ok) {
        OHError("napi_call_threadsafe_function error");
        return JS_EXCEPTION;
    }

    return JS_UNDEFINED;
}


napi_value dispatchJsTask(napi_env env, napi_callback_info info) {
    size_t requireArgc = 2; // 修改为需要两个参数：appIndex 和 script
    napi_value args[2] = {nullptr};

    if (napi_ok != napi_get_cb_info(env, info, &requireArgc, args, nullptr, nullptr)) {
        napi_throw_error(env, "-1000", "arguments invalid");
        return nullptr;
    }

    // 获取 appIndex
    int appIndex;
    if (napi_ok != napi_get_value_int32(env, args[0], &appIndex)) {
        napi_throw_error(env, "-1001", "Invalid appIndex");
        return nullptr;
    }

    JSEngine *engine = getEngine(appIndex);
    if (!engine || engine->closing) {
        OHLog("dispatchJsTask engine_closing or not found for appIndex: %{public}d", appIndex);
        return nullptr;
    }

    size_t length = 0;
    if (napi_ok != napi_get_value_string_utf8(env, args[1], nullptr, 0, &length)) {
        napi_throw_error(env, "-1003", "napi_get_value_string_utf8 error");
        return nullptr;
    }
    if (length == 0) {
        napi_throw_error(env, "-1004", "the param length invalid");
        return nullptr;
    }

    // 使用 unique_ptr 自动管理内存
    length = length + 1;
    unique_ptr<char[]> buffer(new char[length]);
    if (napi_ok != napi_get_value_string_utf8(env, args[1], buffer.get(), length, &length)) {
        napi_throw_error(env, "-1005", "napi_get_value_string_utf8 error");
        return nullptr;
    }

    engine->executeJavaScript(buffer.get());

    return nullptr;
}

napi_value dispatchJsTaskAb(napi_env env, napi_callback_info info) {
    size_t requireArgc = 2; // 修改为需要两个参数：appIndex 和 ArrayBuffer
    napi_value args[2] = {nullptr};

    if (napi_ok != napi_get_cb_info(env, info, &requireArgc, args, nullptr, nullptr)) {
        napi_throw_error(env, "-1000", "arguments invalid");
        return nullptr;
    }

    // 获取 appIndex
    int appIndex;
    if (napi_ok != napi_get_value_int32(env, args[0], &appIndex)) {
        napi_throw_error(env, "-1001", "Invalid appIndex");
        return nullptr;
    }

    JSEngine *engine = getEngine(appIndex);
    if (!engine || engine->closing) {
        OHLog("dispatchJsTaskAb engine_closing or not found for appIndex: %{public}d", appIndex);
        return nullptr;
    }

    void *data = nullptr;
    size_t length = 0;
    if (napi_ok != napi_get_arraybuffer_info(env, args[1], &data, &length)) {
        napi_throw_error(env, "-1003", "napi_get_arraybuffer_info error");
        return nullptr;
    }

    if (length == 0) {
        napi_throw_error(env, "-1004", "the param length invalid");
        return nullptr;
    }

    std::unique_ptr<char[]> buffer(new char[length + 1]);
    memcpy(buffer.get(), data, length);
    buffer[length] = '\0'; // 确保字符串以 null 结尾
    engine->executeJavaScript(buffer.get());

    return nullptr;
}


napi_value dispatchJsTaskPath(napi_env env, napi_callback_info info) {
    size_t requireArgc = 2; // 修改为需要两个参数：appIndex 和文件路径
    napi_value args[2] = {nullptr};

    if (napi_ok != napi_get_cb_info(env, info, &requireArgc, args, nullptr, nullptr)) {
        napi_throw_error(env, "-1000", "arguments invalid");
        return nullptr;
    }

    // 获取 appIndex
    int appIndex;
    if (napi_ok != napi_get_value_int32(env, args[0], &appIndex)) {
        napi_throw_error(env, "-1001", "Invalid appIndex");
        return nullptr;
    }

    JSEngine *engine = getEngine(appIndex);
    if (!engine || engine->closing) {
        OHLog("dispatchJsTaskPath engine_closing or not found for appIndex: %{public}d", appIndex);
        return nullptr;
    }

    // 获取文件路径
    size_t length = 0;
    if (napi_ok != napi_get_value_string_utf8(env, args[1], nullptr, 0, &length)) {
        napi_throw_error(env, "-1003", "napi_get_value_string_utf8 error");
        return nullptr;
    }
    if (length == 0) {
        napi_throw_error(env, "-1004", "the param length invalid");
        return nullptr;
    }

    length = length + 1; // 为结尾的空字符留出空间
    std::unique_ptr<char[]> filePath(new char[length]);
    if (napi_ok != napi_get_value_string_utf8(env, args[1], filePath.get(), length, &length)) {
        napi_throw_error(env, "-1005", "napi_get_value_string_utf8 error");
        return nullptr;
    }

    // 打开文件
    int fd = open(filePath.get(), O_RDONLY);
    if (fd == -1) {
        napi_throw_error(env, "-1006", "Unable to open file");
        return nullptr;
    }

    // 获取文件大小
    struct stat sb;
    if (fstat(fd, &sb) == -1) {
        close(fd);
        napi_throw_error(env, "-1007", "Error getting file size");
        return nullptr;
    }
    size_t fileSize = sb.st_size;
    if (fileSize == 0) {
        close(fd);
        napi_throw_error(env, "-1008", "File is empty");
        return nullptr;
    }

    // 使用 mmap 将文件映射到内存
    char *data = static_cast<char *>(mmap(nullptr, fileSize, PROT_READ, MAP_PRIVATE, fd, 0));
    if (data == MAP_FAILED) {
        close(fd);
        napi_throw_error(env, "-1009", "Error mapping file to memory");
        return nullptr;
    }

    close(fd);

    std::unique_ptr<char[]> buffer(new char[fileSize + 1]);
    memcpy(buffer.get(), data, fileSize);
    buffer[fileSize] = '\0'; // 确保字符串以 null 结尾

    // 解除映射
    if (munmap(data, fileSize) == -1) {
        napi_throw_error(env, "-1010", "Error unmapping file");
        return nullptr;
    }

    engine->executeJavaScript(buffer.get());

    return nullptr;
}

void registerFunc(JSContext *ctx) {
    initBridges(ctx);
    registerInvoke(ctx);
    registerPublish(ctx);
}

// StartJsEngine 对应JS代码中的接口实现
napi_value StartJsEngine(napi_env env, napi_callback_info info) {
    OHLog("StartJsEngine begin");

    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);
    // 获取调试模式
    napi_get_value_bool(env, args[2], &isDebugMode);

    // 检查是否已存在该 appIndex 的实例
    if (getEngine(appIndex) != nullptr) {
        napi_throw_error(env, "-1001", "Engine already exists for this appIndex");
        return nullptr;
    }

    napi_value workBName;
    napi_create_string_utf8(env, "onMessage", NAPI_AUTO_LENGTH, &workBName);

    // 为每个引擎实例创建独立的线程安全函数
    napi_threadsafe_function tsfn;
    napi_create_threadsafe_function(env, args[1], nullptr, workBName, 0, 1, nullptr, nullptr, nullptr, onMessageCb,
                                    &tsfn);
    tsfnMap[appIndex] = tsfn;

    auto now = std::chrono::system_clock::now();
    auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    PFLog("[launch-container][%{public}lld]JS引擎启动 appIndex: %{public}d", timestamp, appIndex);

    JSEngine *newEngine = new JSEngine(appIndex, registerFunc);
    engineMap[appIndex] = newEngine;
    OHLog("engine 地址: %{public}p for appIndex: %{public}d", (void *)newEngine, appIndex);

    OHLog("StartJsEngine end");
    napi_value result;
    napi_create_double(env, 0, &result);
    return result;
}


napi_value destroyJsEngine(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);

    JSEngine *engine = getEngine(appIndex);
    if (!engine) {
        napi_throw_error(env, "-1001", "Engine not found for this appIndex");
        return nullptr;
    }

    OHWarn("thread destroyJsEngine for appIndex: %{public}d", appIndex);
    engine->destroyEngine();
    OHWarn("thread delete engine for appIndex: %{public}d", appIndex);

    // 从 map 中移除并删除实例
    engineMap.erase(appIndex);
    //    delete engine;

    // 释放对应的线程安全函数
    napi_threadsafe_function tsfn = getTsfn(appIndex);
    if (tsfn != nullptr) {
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
        tsfnMap.erase(appIndex);
    }

    napi_value result;
    napi_create_double(env, 0, &result);
    return result;
}


void initBridges(JSContext *ctx) {
    JSValue diminaServiceBridge = JS_NewObject(ctx);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "DiminaServiceBridge", diminaServiceBridge);

    JS_FreeValue(ctx, global);
}

void registerInvoke(JSContext *ctx) {
    JSValue pm_func = JS_NewCFunction(ctx, invoke, "invoke", 1);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue bridge = JS_GetPropertyStr(ctx, global, "DiminaServiceBridge");
    JS_SetPropertyStr(ctx, bridge, "invoke", pm_func);

    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, bridge);

    OHLog("registerInvoke done");
}

void registerPublish(JSContext *ctx) {
    JSValue pm_func = JS_NewCFunction(ctx, publish, "publish", 2);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue bridge = JS_GetPropertyStr(ctx, global, "DiminaServiceBridge");
    JS_SetPropertyStr(ctx, bridge, "publish", pm_func);

    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, bridge);

    OHLog("registerPublish done");
}