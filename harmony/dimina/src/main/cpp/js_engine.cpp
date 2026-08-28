//
// Created on 2024/10/28.
//

#include "js_engine.h"
#include "js_core.h"
#include <pthread.h>
#include <future>
#include <thread>
#include "log.h"
#include "utils.h"
#include "types/qjs_extension/settimeout.h"

JSEngine::JSEngine(int idx, std::function<void(JSContext *ctx)> func, const std::string &debuggerAddress)
    : registerFunc(func), index(idx), core(nullptr), debuggerAddress(debuggerAddress) {
    if (!core) {
        OHWarn("engine JSEngine() idx: %{public}d", idx);
        core = new JSCore();

        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setstacksize(&attr, 1024 * 1024 * 128);

        pthread_t tid;

        pthread_create(
            &tid, &attr,
            [](void *arg) -> void * {
                auto *engine = static_cast<JSEngine *>(arg);
                engine->core->startEngine(engine->index, engine->registerFunc, engine->debuggerAddress);

                return nullptr;
            },
            this);

        pthread_detach(tid);
        pthread_attr_destroy(&attr);
    }
}

// 实现成员函数
bool JSEngine::executeJavaScript(const std::string &script, const std::string &sourceUrl) {
    {
        std::lock_guard<std::mutex> lock(core->queueMutex);
        core->jsTaskQueue.push({script, sourceUrl});
    }

    if (core->running) {
        uv_async_send(&(core->eval_handle));
    }
    return true;
}


// 停止引擎
void JSEngine::destroyEngine() {
    closing = true;
    if (core) {
        core->closing.store(true);
        if (core->handlesReady.load()) {
            OHWarn("engine uv_async_send destroy_handle");
            uv_async_send(&core->destroy_handle);
        }
    }
}


// 析构函数
JSEngine::~JSEngine() {
    if (core) {
        OHWarn("engine JSEngine::~JSEngine()");
        delete core; // 释放 core 的内存
        core = nullptr;
    }
}
