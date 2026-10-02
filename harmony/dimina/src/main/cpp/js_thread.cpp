#include "js_thread.h"
#include "js_engine.h"
#include "video_decoder.h"
#include "log.h"
#include "napi/native_api.h"
#include <future>
#include "utils.h"
#include "types/qjs_extension/settimeout.h"
#include <sys/mman.h> // 包含 mmap, munmap 等函数
#include <unistd.h>   // 包含 close 函数
#include <map>
#include <memory>
#include <vector>

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

// Cross-thread replies contain only bytes. QuickJS values must be created on
// the owning JS thread, never on the ArkTS Worker handling a TSFN callback.
struct BridgeReply { std::string json; std::string error; };
using BridgePromise = std::shared_ptr<std::promise<BridgeReply>>;
struct OnMessageData {
    int type = 1;
    int webViewId = 0;
    int appIndex = 0;
    BridgePromise promise = std::make_shared<std::promise<BridgeReply>>();
    std::string str;
};

static BridgeReply serializeReply(napi_env env, napi_value value) {
    BridgeReply reply;
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok) return {"", "invalid bridge result"};
    if (type == napi_undefined) return reply;
    napi_value global, json, stringify, encoded;
    if (napi_get_global(env, &global) != napi_ok ||
        napi_get_named_property(env, global, "JSON", &json) != napi_ok ||
        napi_get_named_property(env, json, "stringify", &stringify) != napi_ok ||
        napi_call_function(env, json, stringify, 1, &value, &encoded) != napi_ok ||
        !getStringArgument(env, encoded, reply.json)) {
        napi_value exception;
        napi_get_and_clear_last_exception(env, &exception);
        reply.error = "cannot serialize bridge result";
    }
    return reply;
}

// Promise continuations own a shared reply without retaining a JSContext or
// engine. A late completion after shutdown/timeout cannot touch freed QuickJS.
static napi_value resolveBridgePromise(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1]; void *data = nullptr;
    napi_get_cb_info(env, info, &argc, args, nullptr, &data);
    auto promise = static_cast<BridgePromise *>(data);
    BridgeReply reply;
    if (argc != 1 || !getStringArgument(env, args[0], reply.json))
        reply.error = "invalid asynchronous canvas reply";
    (*promise)->set_value(std::move(reply));
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value rejectBridgePromise(napi_env env, napi_callback_info info) {
    size_t argc = 0; void *data = nullptr;
    napi_get_cb_info(env, info, &argc, nullptr, nullptr, &data);
    (*static_cast<BridgePromise *>(data))->set_value({"", "canvas bridge rejected"});
    napi_value result; napi_get_undefined(env, &result); return result;
}
static void finalizeBridgePromise(napi_env, void *data, void *) {
    delete static_cast<BridgePromise *>(data);
}
static bool attachBridgePromise(napi_env env, napi_value result, BridgePromise promise) {
    napi_value then, callbacks[2], ignored;
    napi_callback functions[2] = {resolveBridgePromise, rejectBridgePromise};
    if (napi_get_named_property(env, result, "then", &then) != napi_ok) return false;
    for (int i = 0; i < 2; ++i) {
        auto holder = std::make_unique<BridgePromise>(promise);
        if (napi_create_function(env, "canvasReply", NAPI_AUTO_LENGTH, functions[i], holder.get(), &callbacks[i]) != napi_ok)
            return false;
        if (napi_wrap(env, callbacks[i], holder.get(), finalizeBridgePromise, nullptr, nullptr) != napi_ok)
            return false;
        holder.release();
    }
    return napi_call_function(env, result, then, 2, callbacks, &ignored) == napi_ok;
}

static void onMessageCb(napi_env env, napi_value js_cb, void *, void *data) {
    std::unique_ptr<OnMessageData> message(static_cast<OnMessageData *>(data));
    if (!message) return;
    if (!env || !js_cb) {
        message->promise->set_value({"", "bridge is shutting down"});
        return;
    }
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        message->promise->set_value({"", "cannot open bridge scope"}); return;
    }
    napi_value args[4], undefined, result;
    if (napi_create_int32(env, message->type, &args[0]) != napi_ok ||
        napi_create_int32(env, message->webViewId, &args[1]) != napi_ok ||
        napi_get_undefined(env, &undefined) != napi_ok) {
        message->promise->set_value({"", "cannot allocate bridge arguments"});
        napi_close_handle_scope(env, scope); return;
    }
    args[2] = undefined; args[3] = undefined;
    if (message->type == 1) {
        if (napi_create_string_utf8(env, message->str.data(), message->str.size(), &args[2]) != napi_ok) {
            message->promise->set_value({"", "cannot allocate bridge message"});
            napi_close_handle_scope(env, scope); return;
        }
    } else {
        void *bytes = nullptr;
        if (napi_create_arraybuffer(env, message->str.size(), &bytes, &args[3]) != napi_ok) {
            message->promise->set_value({"", "cannot allocate bridge message"});
            napi_close_handle_scope(env, scope); return;
        }
        memcpy(bytes, message->str.data(), message->str.size());
    }
    const auto status = napi_call_function(env, undefined, js_cb, 4, args, &result);
    bool deferred = false;
    BridgeReply reply;
    if (status == napi_ok) {
        bool isPromise = false;
        napi_is_promise(env, result, &isPromise);
        if (message->type == 1 && isPromise) {
            deferred = attachBridgePromise(env, result, message->promise);
            if (!deferred) reply.error = "cannot attach canvas reply";
        } else if (message->type == 1) reply = serializeReply(env, result);
    } else reply.error = "container handler failed";
    if (!deferred) {
        napi_value exception;
        napi_get_and_clear_last_exception(env, &exception);
        message->promise->set_value(std::move(reply));
    }
    napi_close_handle_scope(env, scope);
}


static JSValue invoke(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    OHLog("invoke begin isMainThread: %{public}d", isMainThread());
    if (argc < 1) return JS_ThrowTypeError(ctx, "invoke expects a message");

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

        // Capture the future before posting: the Worker may delete this packet
        // immediately. Promise continuations keep only the shared reply alive.
        std::future<BridgeReply> future = asyncContext->promise->get_future();

        if (napi_acquire_threadsafe_function(tsfn) != napi_ok) {
            // acquire 都没成功就不要再往下调用了，句柄可能已经在关闭。
            OHError("napi_acquire_threadsafe_function error");
            return throwNativeError(ctx, "invoke: bridge is shutting down");
        }
        napi_threadsafe_function_call_mode call_mode = blocking ? napi_tsfn_blocking : napi_tsfn_nonblocking;

        napi_status status = napi_call_threadsafe_function(tsfn, asyncContext.get(), call_mode);
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
        if (status != napi_ok) {
            // 只有返回 napi_ok 才代表 packet 已入队、所有权移交给 onMessageCb；
            // 其余返回码（队列满、正在关闭）都没入队，unique_ptr 会把它收掉。
            OHError("napi_call_threadsafe_function error");
            return throwNativeError(ctx, "invoke: failed to post message to the container");
        }
        asyncContext.release();

        if (future.wait_for(std::chrono::seconds(6)) != std::future_status::ready)
            return throwNativeError(ctx, "invoke: bridge reply timed out");
        BridgeReply reply = future.get();
        if (!reply.error.empty()) return throwNativeError(ctx, reply.error.c_str());
        return reply.json.empty() ? JS_UNDEFINED : JS_ParseJSON(ctx, reply.json.data(), reply.json.size(), "<bridge-reply>");
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
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
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

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "publish expects a webViewId and message");
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
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
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
    std::string virtualFilePrefix = "difile://";
    if (argc > 4) {
        if (!getStringArgument(env, args[4], virtualFilePrefix)) {
            napi_throw_error(env, "-1004", "Invalid virtual file prefix");
            return nullptr;
        }
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
    DisposeVideoDecoders(appIndex);
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


static JSValue js_encode_array_buffer(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "Expected ArrayBuffer");
    size_t size = 0;
    const uint8_t *bytes = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (!bytes) return JS_EXCEPTION;
    try {
        static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string encoded((size + 2) / 3 * 4, '=');
        for (size_t i = 0, j = 0; i < size; i += 3, j += 4) {
            uint32_t value = uint32_t(bytes[i]) << 16;
            if (i + 1 < size) value |= uint32_t(bytes[i + 1]) << 8;
            if (i + 2 < size) value |= bytes[i + 2];
            encoded[j] = alphabet[(value >> 18) & 63];
            encoded[j + 1] = alphabet[(value >> 12) & 63];
            if (i + 1 < size) encoded[j + 2] = alphabet[(value >> 6) & 63];
            if (i + 2 < size) encoded[j + 3] = alphabet[value & 63];
        }
        return JS_NewStringLen(ctx, encoded.data(), encoded.size());
    } catch (const std::exception &error) { return throwNativeError(ctx, error.what()); }
}

static JSValue js_decode_array_buffer(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "Expected base64 string");
    size_t length = 0;
    const char *text = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!text) return JS_EXCEPTION;
    try {
        std::vector<uint8_t> bytes;
        bytes.reserve(length / 4 * 3);
        uint32_t value = 0;
        int bits = 0;
        for (size_t i = 0; i < length; ++i) {
            const unsigned char ch = text[i];
            if (ch == '=' || ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t') continue;
            const int digit = ch >= 'A' && ch <= 'Z' ? ch - 'A'
                : ch >= 'a' && ch <= 'z' ? ch - 'a' + 26
                : ch >= '0' && ch <= '9' ? ch - '0' + 52 : ch == '+' ? 62 : ch == '/' ? 63 : -1;
            if (digit < 0) {
                JS_FreeCString(ctx, text);
                return JS_ThrowTypeError(ctx, "Invalid base64 string");
            }
            value = (value << 6) | digit;
            bits += 6;
            if (bits >= 8) { bits -= 8; bytes.push_back(uint8_t(value >> bits)); }
        }
        JS_FreeCString(ctx, text);
        return JS_NewArrayBufferCopy(ctx, bytes.data(), bytes.size());
    } catch (const std::exception &error) {
        JS_FreeCString(ctx, text);
        return throwNativeError(ctx, error.what());
    }
}


void initBridges(JSContext *ctx, const char* virtualFilePrefix) {
    JSValue diminaServiceBridge = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, diminaServiceBridge, "canvasSyncSupported", JS_TRUE);
    JS_SetPropertyStr(ctx, diminaServiceBridge, "encodeArrayBuffer", JS_NewCFunction(ctx, js_encode_array_buffer, "encodeArrayBuffer", 1));
    JS_SetPropertyStr(ctx, diminaServiceBridge, "decodeArrayBuffer", JS_NewCFunction(ctx, js_decode_array_buffer, "decodeArrayBuffer", 1));
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
