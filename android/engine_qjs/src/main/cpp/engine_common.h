#ifndef DIMINA_ENGINE_COMMON_H
#define DIMINA_ENGINE_COMMON_H

#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <mutex>
#include <unordered_map>
#include "quickjs.h"

// ─── Log tag ───
#define LOG_TAG "QuickJSEngine(cpp)"

// ─── Global JavaVM ───
extern JavaVM* gJavaVM;

// ─── RAII wrapper for JNI environment ───
class JNIEnvGuard {
private:
    JNIEnv* env;
    bool needsDetach;

public:
    JNIEnvGuard() : env(nullptr), needsDetach(false) {
        if (!gJavaVM) return;

        jint result = gJavaVM->GetEnv((void**)&env, JNI_VERSION_1_6);
        if (result == JNI_EDETACHED) {
            if (gJavaVM->AttachCurrentThread(&env, nullptr) == JNI_OK) {
                needsDetach = true;
            }
        }
    }

    ~JNIEnvGuard() {
        if (needsDetach && gJavaVM) {
            gJavaVM->DetachCurrentThread();
        }
    }

    JNIEnv* get() const { return env; }
    operator JNIEnv*() const { return env; }
    bool isValid() const { return env != nullptr; }

    JNIEnvGuard(const JNIEnvGuard&) = delete;
    JNIEnvGuard& operator=(const JNIEnvGuard&) = delete;
};

// ─── Engine instance ───
struct EngineInstance {
    JSRuntime* runtime = nullptr;
    JSContext* ctx = nullptr;
    jobject engineObj = nullptr;
    struct uv_loop_s* loop = nullptr;
    std::unordered_map<int, struct TimerData*> timerCallbacks;
    std::unordered_map<int, struct uv_timer_s*> uvTimers;
    std::atomic<int> nextTimerId{1};
    std::atomic<bool> shouldStop{false};
};

// ─── Global engine instances map ───
extern std::unordered_map<int, EngineInstance*> gEngineInstances;
extern std::mutex gEngineInstancesMutex;

// ─── Helper functions ───
EngineInstance* getEngineInstance(int instanceId);
EngineInstance* findInstanceByContext(JSContext* ctx);
JSValue jsonStringify(JSContext* ctx, JSValue value);

#endif // DIMINA_ENGINE_COMMON_H
