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
#include <memory>

// 使用 map 存储多个 JSEngine 实例
std::map<int, JSEngine *> engineMap;
// 使用 map 存储每个引擎实例对应的线程安全函数
std::map<int, napi_threadsafe_function> tsfnMap;
// 引擎是否处于调试模式
bool isDebugMode = false;

static bool getStringArgument(napi_env env, napi_value value, std::string &result) {
    size_t length = 0;
    if (value == nullptr || napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
        return false;
    }
    std::unique_ptr<char[]> buffer(new char[length + 1]);
    if (napi_get_value_string_utf8(env, value, buffer.get(), length + 1, &length) != napi_ok) {
        return false;
    }
    result.assign(buffer.get(), length);
    return true;
}

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


// 原生这边出错时要返回 JS_EXCEPTION，但 JS_EXCEPTION 只是个哨兵值，本身不带异常对象。
// 底层已经挂了异常（比如 JSON 序列化失败）就原样保留，没挂的话（比如内存分配失败只返回
// 空指针）必须自己补一个，否则 JS 侧 catch 到的是未初始化的内部值。
JSValue throwNativeError(JSContext *ctx, const char *what) {
    if (!JS_HasException(ctx)) {
        JS_ThrowInternalError(ctx, "%s", what);
    }
    return JS_EXCEPTION;
}

// 调用方不看返回值的场合用这个：把已经挂上的异常取走丢掉。留着不取，它会一直挂在
// runtime 上，之后某个不相干的调用失败时会被当成自己的异常报出来，错得很难查。
void discardPendingException(JSContext *ctx) {
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
}

void initBridges(JSContext *ctx, const char* virtualFilePrefix);
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

    // 整段放进 try：内存不足时 new / std::string 赋值都会抛，而这里是 QuickJS 的 C 回调
    // 边界，C++ 异常越过去会直接终止进程。要转成 JS 侧能接住的异常。
    try {
        // JSValueToString 只读传入值、不接管它，所以这里不需要先加一次引用——加了也没人还，
        // 那个对象就再也释放不掉。argv 的引用由调用方持有，整个调用期间都有效。
        // 它返回的是 strdup 出来的缓冲区，交给作用域对象保证任何出口都会还。
        OwnedCStr str(JSValueToString(ctx, argv[0]));
        if (!str) {
            // 转不出字符串就没有可投递的内容。这里不挡住的话，下面拿 NULL 去构造
            // std::string 是未定义行为。
            OHError("invoke JSValueToString failed");
            return throwNativeError(ctx, "invoke: failed to serialize message");
        }
        // packet 在成功投递之前都归这边所有，用 unique_ptr 持有，任何提前返回或抛异常
        // 都不会漏；投递成功后再 release，把所有权交给 onMessageCb。
        std::unique_ptr<OnMessageData> asyncContext(new OnMessageData());
        asyncContext->str = str.get();
        asyncContext->appIndex = currentEngine->getAppIndex(); // 设置 appIndex
        asyncContext->type = 1;
        const bool blocking = true;

        napi_threadsafe_function tsfn = getTsfn(currentEngine->getAppIndex());
        if (!tsfn) {
            OHError("Threadsafe function not found for appIndex: %{public}d", currentEngine->getAppIndex());
            return throwNativeError(ctx, "invoke: bridge is not available");
        }

        // future 必须在投递之前取。投递之后 ArkTS 线程随时可能跑完 onMessageCb，
        // 那里 set_value 完就 delete asyncContext，promise 析构会把共享状态的引用
        // 计数减到 0 并释放掉；等这条线程再回来取 future，拿到的就是已释放的内存，
        // 后面 future.get() 收尾时解引用它必然崩。
        std::future<JSValue> future = asyncContext->promise.get_future();

        if (napi_acquire_threadsafe_function(tsfn) != napi_ok) {
            // acquire 都没成功就不要再往下调用了，句柄可能已经在关闭。
            OHError("napi_acquire_threadsafe_function error");
            return throwNativeError(ctx, "invoke: bridge is shutting down");
        }
        napi_threadsafe_function_call_mode call_mode = blocking ? napi_tsfn_blocking : napi_tsfn_nonblocking;

        napi_status status = napi_call_threadsafe_function(tsfn, asyncContext.get(), call_mode);
        if (status != napi_ok) {
            // 只有返回 napi_ok 才代表 packet 已入队、所有权移交给 onMessageCb；
            // 其余返回码（队列满、正在关闭）都没入队，unique_ptr 会把它收掉。
            OHError("napi_call_threadsafe_function error");
            return throwNativeError(ctx, "invoke: failed to post message to the container");
        }
        asyncContext.release();

        JSValue value = future.get();
        if (JS_IsException(value)) {
            OHError("invoke error");
            return throwNativeError(ctx, "invoke: container handler failed");
        }
        OHLog("invoke end");
        return value;
    } catch (const std::exception &e) {
        OHError("[dimina][service] invoke error: %{public}s", e.what());
        return throwNativeError(ctx, e.what());
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
    // 这个函数不对 JS 暴露，只由 log.cpp 的 console 实现内部调用，而那边不看返回值。
    // 所以它必须是「尽力而为」：转发不出去就算了，但绝不能把异常挂在 runtime 上不管，
    // 否则下一个不相干的调用会把这条日志的失败当成自己的错误报出来。
    if (argc < 2) {
        OHLog("sendLogToContainer expects at least two arguments");
        return JS_UNDEFINED;
    }
    int32_t level;
    if (JS_ToInt32(ctx, &level, argv[0])) {
        discardPendingException(ctx);
        return JS_UNDEFINED;
    }
    // 打日志是尽力而为的，内存不足之类的 C++ 异常也不该让它冒到调用方去。
    try {
        // 同 invoke：JSValueToString 不接管所有权，多加的那次引用没人还。
        OwnedCStr logMessage(JSValueToString(ctx, argv[1]));
        if (!logMessage) {
            OHError("sendLogToContainer JSValueToString failed");
            discardPendingException(ctx);
            return JS_UNDEFINED;
        }
        std::unique_ptr<OnMessageData> asyncContext(new OnMessageData());
        asyncContext->str = logMessage.get();
        asyncContext->appIndex = currentEngine->getAppIndex(); // 设置 appIndex
        asyncContext->type = 3;
        asyncContext->webViewId = level;
        napi_threadsafe_function tsfn = getTsfn(currentEngine->getAppIndex());
        if (!tsfn) {
            OHError("Threadsafe function not found for appIndex: %{public}d", currentEngine->getAppIndex());
            return JS_UNDEFINED;
        }
        if (napi_acquire_threadsafe_function(tsfn) != napi_ok) {
            OHError("napi_acquire_threadsafe_function error");
            return JS_UNDEFINED;
        }
        napi_threadsafe_function_call_mode call_mode = napi_tsfn_nonblocking;
        napi_status status = napi_call_threadsafe_function(tsfn, asyncContext.get(), call_mode);
        if (status != napi_ok) {
            // 同 invoke：非 napi_ok 表示没入队，所有权还在这边，unique_ptr 会收掉。
            OHError("napi_call_threadsafe_function error");
            return JS_UNDEFINED;
        }
        asyncContext.release();
    } catch (const std::exception &e) {
        OHError("sendLogToContainer error: %{public}s", e.what());
        discardPendingException(ctx);
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

    // 同 invoke：整段放进 try，别让 C++ 异常越过 QuickJS 的 C 回调边界。
    try {
        // JSValueToString 不接管所有权，多加的那次引用没人还；返回的缓冲区交给作用域对象。
        OwnedCStr str(JSValueToString(ctx, argv[1]));
        if (!str) {
            OHError("publish JSValueToString failed");
            return throwNativeError(ctx, "publish: failed to serialize message");
        }

        std::unique_ptr<OnMessageData> asyncContext(new OnMessageData());
        asyncContext->str = str.get();
        asyncContext->appIndex = currentEngine->getAppIndex(); // 设置 appIndex
        asyncContext->type = 2;
        asyncContext->webViewId = webViewId;
        const bool blocking = false;

        napi_threadsafe_function tsfn = getTsfn(currentEngine->getAppIndex());
        if (!tsfn) {
            OHError("Threadsafe function not found for appIndex: %{public}d", currentEngine->getAppIndex());
            return throwNativeError(ctx, "publish: bridge is not available");
        }

        if (napi_acquire_threadsafe_function(tsfn) != napi_ok) {
            // acquire 都没成功就不要再往下调用了，句柄可能已经在关闭。
            OHError("napi_acquire_threadsafe_function error");
            return throwNativeError(ctx, "publish: bridge is shutting down");
        }
        napi_threadsafe_function_call_mode call_mode = blocking ? napi_tsfn_blocking : napi_tsfn_nonblocking;

        napi_status status = napi_call_threadsafe_function(tsfn, asyncContext.get(), call_mode);
        if (status != napi_ok) {
            // 同 invoke：非 napi_ok 表示没入队，所有权还在这边，unique_ptr 会收掉。
            OHError("napi_call_threadsafe_function error");
            return throwNativeError(ctx, "publish: failed to post message to the container");
        }
        asyncContext.release();
    } catch (const std::exception &e) {
        OHError("[dimina][service] publish error: %{public}s", e.what());
        return throwNativeError(ctx, e.what());
    }

    return JS_UNDEFINED;
}


napi_value dispatchJsTask(napi_env env, napi_callback_info info) {
    size_t requireArgc = 3;
    napi_value args[3] = {nullptr};

    if (napi_ok != napi_get_cb_info(env, info, &requireArgc, args, nullptr, nullptr) || requireArgc < 3) {
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

    std::string script;
    if (!getStringArgument(env, args[1], script)) {
        napi_throw_error(env, "-1003", "Invalid JavaScript source");
        return nullptr;
    }
    if (script.empty()) {
        napi_throw_error(env, "-1004", "the param length invalid");
        return nullptr;
    }

    std::string sourceUrl;
    if (!getStringArgument(env, args[2], sourceUrl) || sourceUrl.empty()) {
        napi_throw_error(env, "-1005", "Invalid JavaScript source URL");
        return nullptr;
    }

    engine->executeJavaScript(script, sourceUrl);

    return nullptr;
}

napi_value dispatchJsTaskAb(napi_env env, napi_callback_info info) {
    size_t requireArgc = 3;
    napi_value args[3] = {nullptr};

    if (napi_ok != napi_get_cb_info(env, info, &requireArgc, args, nullptr, nullptr) || requireArgc < 3) {
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

    std::string sourceUrl;
    if (!getStringArgument(env, args[2], sourceUrl) || sourceUrl.empty()) {
        napi_throw_error(env, "-1005", "Invalid JavaScript source URL");
        return nullptr;
    }

    engine->executeJavaScript(std::string(static_cast<const char *>(data), length), sourceUrl);

    return nullptr;
}


napi_value dispatchJsTaskPath(napi_env env, napi_callback_info info) {
    size_t requireArgc = 3;
    napi_value args[3] = {nullptr};

    if (napi_ok != napi_get_cb_info(env, info, &requireArgc, args, nullptr, nullptr) || requireArgc < 3) {
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

    std::string filePath;
    if (!getStringArgument(env, args[1], filePath)) {
        napi_throw_error(env, "-1003", "Invalid JavaScript file path");
        return nullptr;
    }
    if (filePath.empty()) {
        napi_throw_error(env, "-1004", "the param length invalid");
        return nullptr;
    }

    std::string sourceUrl;
    if (!getStringArgument(env, args[2], sourceUrl) || sourceUrl.empty()) {
        napi_throw_error(env, "-1005", "Invalid JavaScript source URL");
        return nullptr;
    }

    // 打开文件
    int fd = open(filePath.c_str(), O_RDONLY);
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

    std::string script(data, fileSize);

    // 解除映射
    if (munmap(data, fileSize) == -1) {
        napi_throw_error(env, "-1010", "Error unmapping file");
        return nullptr;
    }

    engine->executeJavaScript(script, sourceUrl);

    return nullptr;
}

void registerFunc(JSContext *ctx, const std::string &virtualFilePrefix) {
    initBridges(ctx, virtualFilePrefix.c_str());
    registerInvoke(ctx);
    registerPublish(ctx);
}

// StartJsEngine 对应JS代码中的接口实现
napi_value StartJsEngine(napi_env env, napi_callback_info info) {
    OHLog("StartJsEngine begin");

    size_t argc = 5;
    napi_value args[5] = {nullptr};
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 4) {
        napi_throw_error(env, "-1000", "StartJsEngine requires at least four arguments");
        return nullptr;
    }

    int appIndex;
    if (napi_get_value_int32(env, args[0], &appIndex) != napi_ok) {
        napi_throw_error(env, "-1001", "Invalid appIndex");
        return nullptr;
    }
    // 获取调试模式
    if (napi_get_value_bool(env, args[2], &isDebugMode) != napi_ok) {
        napi_throw_error(env, "-1002", "Invalid debug mode");
        return nullptr;
    }
    std::string debuggerAddress;
    if (!getStringArgument(env, args[3], debuggerAddress)) {
        napi_throw_error(env, "-1003", "Invalid debugger address");
        return nullptr;
    }

    // 获取虚拟文件前缀
    std::string virtualFilePrefix;
    if (argc > 4) {
        size_t prefixLen = 0;
        napi_get_value_string_utf8(env, args[4], nullptr, 0, &prefixLen);
        virtualFilePrefix.resize(prefixLen);
        napi_get_value_string_utf8(env, args[4], &virtualFilePrefix[0], prefixLen + 1, &prefixLen);
    }

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

    JSEngine *newEngine = new JSEngine(appIndex, [virtualFilePrefix](JSContext *ctx) {
        registerFunc(ctx, virtualFilePrefix);
    }, debuggerAddress);
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


void initBridges(JSContext *ctx, const char* virtualFilePrefix) {
    JSValue diminaServiceBridge = JS_NewObject(ctx);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "DiminaServiceBridge", diminaServiceBridge);

    // Inject virtual file prefix for JSSDK
    JS_SetPropertyStr(ctx, global, "__VIRTUAL_FILE_PREFIX__",
                      JS_NewString(ctx, virtualFilePrefix));

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
