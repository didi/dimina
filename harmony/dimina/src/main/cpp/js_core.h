//
// Created on 2024/10/28.
//
// Node APIs are not fully supported. To solve the compilation error of the interface cannot be found,
// please include "napi/native_api.h".

#ifndef DIMINA_HARMONYOS_JS_CORE_H
#define DIMINA_HARMONYOS_JS_CORE_H

#include "quickjs.h"
#include "napi/native_api.h"
#include <atomic>
#include <mutex>
#include <queue>
#include <string>
#include <uv.h>

// 为 C 文件提供的 API
#ifdef __cplusplus
extern "C" {
#endif
    uv_loop_t* js_core_get_loop_from_ctx(JSContext* ctx);
#ifdef __cplusplus
}
#endif

class JSCore {
public:
    JSCore();
    ~JSCore();
    
    struct JavaScriptTask {
        std::string code;
        std::string sourceUrl;
    };

    bool executeJavaScript(const std::string &code, const std::string &sourceUrl);
    void processPendingJobs();
    void *startEngine(int index, std::function<void(JSContext *ctx)> registerFunc,
                      const std::string &debuggerAddress);
    
    void destroy_cb_impl(uv_async_t *handle);
    void prepare_cb_impl(uv_prepare_t *handle);
    void idle_cb_impl(uv_idle_t *handle);
    void js_task_cb_impl(uv_async_t *handle);
    void check_cb_impl(uv_check_t *handle);
    
    static void destroy_cb(uv_async_t *handle);
    static void prepare_cb(uv_prepare_t *handle);
    static void idle_cb(uv_idle_t *handle);
    static void js_task_cb(uv_async_t *handle);
    static void check_cb(uv_check_t *handle);
    
    std::atomic<bool> starting;
    std::atomic<bool> running;
    std::atomic<bool> closing;
    std::atomic<bool> handlesReady{false};

    JSContext* getContext() {
        return ctx;
    };

    std::mutex queueMutex;
    std::queue<JavaScriptTask> jsTaskQueue;
    uv_async_t eval_handle;
    uv_async_t destroy_handle;
    
    uv_loop_t *js_loop;

private:
    JSRuntime *rt;
    JSContext *ctx;

    uv_idle_t idle_handle;
    uv_prepare_t prepare_handle;
    uv_check_t check_handle;

    bool firstTaskMark = true;
};

#endif //DIMINA_HARMONYOS_JS_CORE_H
