//
// Created on 2024/10/28.
//

#include "js_core.h"
#include <pthread.h>
#include <thread>
#include "log.h"
#include "utils.h"
#include "types/qjs_extension/settimeout.h"
#ifdef DIMINA_ENABLE_QUICKJS_DEBUGGER
#include "quickjs-debugger.h"

static int shouldCancelDebuggerWait(void *opaque) {
    return static_cast<JSCore *>(opaque)->closing.load() ? 1 : 0;
}
#endif

// 构造函数
JSCore::JSCore() : rt(nullptr), ctx(nullptr), js_loop(nullptr), starting(false), running(false), closing(false) {
    // 初始化其他成员变量
}

// 析构函数
JSCore::~JSCore() {
    OHWarn("core JSCore::~JSCore()");
    // 清理资源，释放内存
    if (ctx) {
        JS_FreeContext(ctx);
        ctx = nullptr;
    }
    if (rt) {
        JS_FreeRuntime(rt);
        rt = nullptr;
    }
    if (js_loop) {
        uv_loop_close(js_loop);
        free(js_loop);
        js_loop = nullptr;
    }
    // 关闭 uv 句柄
    uv_close((uv_handle_t *)&eval_handle, nullptr);
    uv_close((uv_handle_t *)&destroy_handle, nullptr);
    uv_close((uv_handle_t *)&idle_handle, nullptr);
    uv_close((uv_handle_t *)&prepare_handle, nullptr);
    uv_close((uv_handle_t *)&check_handle, nullptr);
    // 清空任务队列
    std::queue<JavaScriptTask> empty;
    std::swap(jsTaskQueue, empty);
}

// 实现成员函数
bool JSCore::executeJavaScript(const std::string &code, const std::string &sourceUrl) {
    if (firstTaskMark) {
        firstTaskMark = false;
        auto now = std::chrono::system_clock::now();
        auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
        PFLog("[launch-container][%{public}lld]JS引擎开始执行第一个任务", timestamp);
    }

    // 执行 JavaScript 代码
//     OHWarn("before JS_Eval:  %{public}s", code.c_str());
    JSValue result = JS_Eval(ctx, code.c_str(), code.size(), sourceUrl.c_str(), JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        exceptionLogFunc(ctx);
        JS_FreeValue(ctx, result);
        return false;
    }
    JS_FreeValue(ctx, result);
    return true;
}

void JSCore::processPendingJobs() {
    JSContext *ctx1;
    int err;

    OHLog("executePendingJobLoop executing");
//    OHLog("ctx地址: %{public}p", (void*)ctx);

    while ((err = JS_ExecutePendingJob(JS_GetRuntime(ctx), &ctx1)) > 0) {
//        OHLog("ctx1地址: %{public}p", (void*)ctx1);
        if (err < 0) {
            exceptionLogFunc(ctx1);
            break;
        }
    }
}

// 线程函数
void *JSCore::startEngine(int index, std::function<void(JSContext *ctx)> registerFunc,
                          const std::string &debuggerAddress) {
    auto now = std::chrono::system_clock::now();
    auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    PFLog("[launch-container][%{public}lld]JS引擎启动-Runtime/事件循环初始化开始", timestamp);

    thread::id this_id = this_thread::get_id();
    OHWarn("startEngine thread::id %{public}d index %{public}d", this_id, index);
    OHWarn("startEngine, core_closing: %{public}d", closing ? 1 : 0);

    starting = true;

    rt = JS_NewRuntime();
    JS_SetMaxStackSize(rt, 128 * 1024 * 1024);
    ctx = JS_NewContext(rt);

    registerFunc(ctx);

    consoleInit(ctx);
    timeoutInit(ctx);
    setLogger(debugLogFunc, exceptionLogFunc);

    js_loop = uv_loop_new();
    JS_SetContextOpaque(ctx, this);  // 存储 this 指针，而不是 js_loop

    uv_async_init(js_loop, &eval_handle, js_task_cb);
    eval_handle.data = this;
    uv_async_init(js_loop, &destroy_handle, destroy_cb);
    destroy_handle.data = this;
    uv_prepare_init(js_loop, &prepare_handle);
    prepare_handle.data = this;
    uv_prepare_start(&prepare_handle, prepare_cb);
    uv_check_init(js_loop, &check_handle);
    check_handle.data = this;
    uv_check_start(&check_handle, check_cb);
    uv_idle_init(js_loop, &idle_handle);
    idle_handle.data = this;
    uv_idle_start(&idle_handle, idle_cb);
    handlesReady.store(true);

#ifdef DIMINA_ENABLE_QUICKJS_DEBUGGER
    if (!debuggerAddress.empty() && !closing.load()) {
        OHLog("QuickJS engine %{public}d waiting for debugger at %{public}s", index, debuggerAddress.c_str());
        if (!js_debugger_wait_connection_interruptible(ctx, debuggerAddress.c_str(),
                                                       shouldCancelDebuggerWait, this) && !closing.load()) {
            OHError("QuickJS debugger failed to listen at %{public}s", debuggerAddress.c_str());
        }
    }
#endif

    if (closing.load()) {
        uv_async_send(&destroy_handle);
    }

    now = std::chrono::system_clock::now();
    timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    PFLog("[launch-container][%{public}lld]JS引擎启动-Runtime/事件循环初始化完成", timestamp);

    starting = false;
    running = true;
    uv_run(js_loop, UV_RUN_DEFAULT);

    if (js_loop) {
        while (uv_loop_alive(js_loop)) {
            uv_run(js_loop, UV_RUN_NOWAIT);
        }
        const int closeResult = uv_loop_close(js_loop);
        if (closeResult == 0) {
            free(js_loop);
        } else {
            OHError("QuickJS uv loop close failed: %{public}d", closeResult);
        }
        js_loop = nullptr;
    }

    if (ctx) {
#ifdef DIMINA_ENABLE_QUICKJS_DEBUGGER
        // Harmony currently keeps the runtime alive because JS_FreeRuntime can
        // hit an existing GC assertion. Explicitly release the debugger-owned
        // socket and protocol state before freeing the context.
        js_debugger_free(JS_GetRuntime(ctx), js_debugger_info(JS_GetRuntime(ctx)));
#endif
        JS_FreeContext(ctx);
        ctx = nullptr;
    }

    OHLog("jsThreadFunc end");
    return nullptr;
}

// 静态回调函数实现，作为桥接
void JSCore::destroy_cb(uv_async_t *handle) {
    JSCore *core = static_cast<JSCore *>(handle->data);
    core->destroy_cb_impl(handle);
}

void JSCore::prepare_cb(uv_prepare_t *handle) {
    JSCore *core = static_cast<JSCore *>(handle->data);
    core->prepare_cb_impl(handle);
}

void JSCore::idle_cb(uv_idle_t *handle) {
    JSCore *core = static_cast<JSCore *>(handle->data);
    core->idle_cb_impl(handle);
}

void JSCore::js_task_cb(uv_async_t *handle) {
    JSCore *core = static_cast<JSCore *>(handle->data);
    core->js_task_cb_impl(handle);
}

void JSCore::check_cb(uv_check_t *handle) {
    JSCore *core = static_cast<JSCore *>(handle->data);
    core->check_cb_impl(handle);
}

// 实例回调方法实现
void JSCore::destroy_cb_impl(uv_async_t *handle) {
    thread::id this_id = this_thread::get_id();
    OHWarn("core destroy begin %{public}d", this_id);

    running = false;
    closing = true;
    handlesReady = false;
    clearAllTimers(ctx);

    {
        std::lock_guard<std::mutex> lock(queueMutex);
        std::queue<JavaScriptTask> emptyQueue;
        jsTaskQueue.swap(emptyQueue);
    }

    if (js_loop) {
        if (!uv_is_closing((uv_handle_t *)&idle_handle)) {
            uv_close((uv_handle_t *)&idle_handle, NULL);
        }
        if (!uv_is_closing((uv_handle_t *)&prepare_handle)) {
            uv_close((uv_handle_t *)&prepare_handle, NULL);
        }
        if (!uv_is_closing((uv_handle_t *)&check_handle)) {
            uv_close((uv_handle_t *)&check_handle, NULL);
        }
        if (!uv_is_closing((uv_handle_t *)&eval_handle)) {
            uv_close((uv_handle_t *)&eval_handle, NULL);
        }
        if (!uv_is_closing((uv_handle_t *)&destroy_handle)) {
            uv_close((uv_handle_t *)&destroy_handle, NULL);
        }
        uv_stop(js_loop);
    }

    // 检查 JS 运行时是否存在，然后销毁
    // fixme 如果直接调用 JS_FreeRuntime 会导致 assert(list_empty(&rt->gc_obj_list)); 报错所以注释了。
    // fixme 当前 pthread_exit 已经可以确保整个线程退出了，精细化管理 qtr 可以暂时不做
    //    if (rt) {
    //        JS_FreeRuntime(rt);
    //        rt = nullptr;
    //    }

    OHWarn("core destroy end %{public}d", this_id);
}

void JSCore::prepare_cb_impl(uv_prepare_t *handle) {
    processPendingJobs();

    bool queueEmpty;
    {
        std::lock_guard<std::mutex> lock(queueMutex);
        queueEmpty = jsTaskQueue.empty();
    }
    if (queueEmpty) {
        uv_idle_stop(&idle_handle);
    }
}

void JSCore::idle_cb_impl(uv_idle_t *handle) {
    // 可以留空，或执行低优先级任务
}

void JSCore::js_task_cb_impl(uv_async_t *handle) {
    if (closing.load()) {
        return;
    }
    if (!uv_is_active((uv_handle_t *)&idle_handle)) {
        uv_idle_start(&idle_handle, idle_cb);
    }
}

void JSCore::check_cb_impl(uv_check_t *handle) {
    JavaScriptTask task;
    {
        std::lock_guard<std::mutex> lock(queueMutex);
        if (!jsTaskQueue.empty()) {
            task = std::move(jsTaskQueue.front());
            jsTaskQueue.pop();
        } else {
            return;
        }
    }
    executeJavaScript(task.code, task.sourceUrl);
}

// C 兼容的接口函数实现
extern "C" {
    uv_loop_t* js_core_get_loop_from_ctx(JSContext* ctx) {
        JSCore* core = static_cast<JSCore*>(JS_GetContextOpaque(ctx));
        if (core) {
            return core->js_loop;
        }
        return nullptr;
    }
}
