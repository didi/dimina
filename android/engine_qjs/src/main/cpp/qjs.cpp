#include <jni.h>
#include <string>
#include <cstring>
#include <android/log.h>
#include <atomic>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include <chrono>
#include <mutex>
#include <memory>
#include <uv.h>
#include "quickjs.h"
#include "cutils.h"
#include "libregexp.h"
#include "libunicode.h"

// Define log tag for Android logging
#define LOG_TAG "QuickJSEngine(cpp)"

// Logging interval for the event loop (log progress every N iterations)
static const int EVENT_LOOP_LOG_INTERVAL = 100;

// Global JavaVM pointer for JNI calls from any thread
static JavaVM* gJavaVM = nullptr;

// ============================================================================
// RAII Helper Classes
// ============================================================================

// RAII wrapper for JNI environment with automatic thread attach/detach
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
    
    // 禁止拷贝
    JNIEnvGuard(const JNIEnvGuard&) = delete;
    JNIEnvGuard& operator=(const JNIEnvGuard&) = delete;
};

// RAII wrapper for JSValue with automatic memory management
class JSValueGuard {
private:
    JSContext* ctx;
    JSValue value;
    bool released;
    
public:
    JSValueGuard(JSContext* c, JSValue v) : ctx(c), value(v), released(false) {}
    
    ~JSValueGuard() {
        if (!released && ctx) {
            JS_FreeValue(ctx, value);
        }
    }
    
    JSValue get() const { return value; }
    
    JSValue release() {
        released = true;
        return value;
    }
    
    bool isException() const { return JS_IsException(value); }
    bool isUndefined() const { return JS_IsUndefined(value); }
    bool isNull() const { return JS_IsNull(value); }
    
    // 禁止拷贝
    JSValueGuard(const JSValueGuard&) = delete;
    JSValueGuard& operator=(const JSValueGuard&) = delete;
};

// JNI_OnLoad is called when the native library is loaded
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* reserved) {
    // Store the JavaVM pointer for later use
    gJavaVM = vm;
    
    // Return the JNI version
    return JNI_VERSION_1_6;
}

// Forward declaration
struct EngineInstance;

// Timer data structure for libuv
struct TimerData {
    JSContext* ctx;
    int timerId;
    JSValue callback;
    int instanceId;
    bool isInterval;
    EngineInstance* instance;
    bool isExecuting = false;
    bool isCleared = false;
};

// Structure to hold instance-specific data
struct EngineInstance {
    JSRuntime* runtime = nullptr;
    JSContext* ctx = nullptr;
    jobject engineObj = nullptr;
    uv_loop_t* loop = nullptr;
    std::unordered_map<int, TimerData*> timerCallbacks;
    std::unordered_map<int, uv_timer_t*> uvTimers;
    std::atomic<int> nextTimerId{1};
    std::atomic<bool> shouldStop{false};
};

// Map to store engine instances by ID
static std::unordered_map<int, EngineInstance*> gEngineInstances;
static std::mutex gEngineInstancesMutex;

// ============================================================================
// Helper Functions
// ============================================================================

// Helper function to get an engine instance by ID
static EngineInstance* getEngineInstance(int instanceId) {
    std::lock_guard<std::mutex> lock(gEngineInstancesMutex);
    auto it = gEngineInstances.find(instanceId);
    if (it != gEngineInstances.end()) {
        return it->second;
    }
    return nullptr;
}

// Helper function to find engine instance by context
static EngineInstance* findInstanceByContext(JSContext* ctx) {
    std::lock_guard<std::mutex> lock(gEngineInstancesMutex);
    for (const auto& pair : gEngineInstances) {
        if (pair.second->ctx == ctx) {
            return pair.second;
        }
    }
    return nullptr;
}

// Helper function to perform JSON.stringify on a JSValue
static JSValue jsonStringify(JSContext* ctx, JSValue value) {
    JSValueGuard global(ctx, JS_GetGlobalObject(ctx));
    JSValueGuard jsonObj(ctx, JS_GetPropertyStr(ctx, global.get(), "JSON"));
    JSValueGuard stringifyFunc(ctx, JS_GetPropertyStr(ctx, jsonObj.get(), "stringify"));
    
    JSValueConst args[1] = { value };
    return JS_Call(ctx, stringifyFunc.get(), global.get(), 1, args);
}

// Helper function to create a JSValue error object for JNI
static jobject createJSError(JNIEnv* env, const char* errorMsg) {
    jclass jsValueClass = env->FindClass("com/didi/dimina/engine/qjs/JSValue");
    jmethodID createErrorMethod = env->GetStaticMethodID(
        jsValueClass, "createError", "(Ljava/lang/String;)Lcom/didi/dimina/engine/qjs/JSValue;");
    jstring jErrorMsg = env->NewStringUTF(errorMsg ? errorMsg : "Unknown error");
    jobject result = env->CallStaticObjectMethod(jsValueClass, createErrorMethod, jErrorMsg);
    env->DeleteLocalRef(jErrorMsg);
    env->DeleteLocalRef(jsValueClass);
    return result;
}

// Helper function to extract detailed error information from a JS exception
static std::string getDetailedJSError(JSContext* ctx, JSValue exception) {
    std::string errorMsg;
    
    // First try to get the error type (constructor name)
    JSValue constructor = JS_GetPropertyStr(ctx, exception, "constructor");
    if (!JS_IsException(constructor) && !JS_IsUndefined(constructor) && !JS_IsNull(constructor)) {
        JSValue name = JS_GetPropertyStr(ctx, constructor, "name");
        if (!JS_IsException(name) && !JS_IsUndefined(name) && !JS_IsNull(name)) {
            const char* typeName = JS_ToCString(ctx, name);
            if (typeName) {
                errorMsg = typeName;
                errorMsg += ": ";
                JS_FreeCString(ctx, typeName);
            }
        }
        JS_FreeValue(ctx, name);
    }
    JS_FreeValue(ctx, constructor);
    
    // Get the error message
    const char* str = JS_ToCString(ctx, exception);
    if (str) {
        errorMsg += str;
        JS_FreeCString(ctx, str);
    } else if (errorMsg.empty()) {
        errorMsg = "JavaScript error";
    }
    
    // Try to get stack trace if available
    JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
    if (!JS_IsUndefined(stack) && !JS_IsNull(stack)) {
        const char* stackStr = JS_ToCString(ctx, stack);
        if (stackStr) {
            // Only add the stack trace if it's not already part of the error message
            if (str && strstr(str, stackStr) == nullptr) {
                errorMsg += "\nStack trace: ";
                errorMsg += stackStr;
            }
            JS_FreeCString(ctx, stackStr);
        }
    }
    JS_FreeValue(ctx, stack);
    
    // Try to get line number and column if available
    JSValue lineNum = JS_GetPropertyStr(ctx, exception, "lineNumber");
    JSValue colNum = JS_GetPropertyStr(ctx, exception, "columnNumber");
    
    if (!JS_IsUndefined(lineNum) && !JS_IsNull(lineNum)) {
        int32_t line;
        if (JS_ToInt32(ctx, &line, lineNum) == 0) {
            errorMsg += "\nLine: " + std::to_string(line);
        }
    }
    
    if (!JS_IsUndefined(colNum) && !JS_IsNull(colNum)) {
        int32_t col;
        if (JS_ToInt32(ctx, &col, colNum) == 0) {
            errorMsg += ", Column: " + std::to_string(col);
        }
    }
    
    JS_FreeValue(ctx, lineNum);
    JS_FreeValue(ctx, colNum);
    
    // If we still have no meaningful error message, try to convert the exception to string directly
    if (errorMsg == "JavaScript error") {
        JSValue strVal = JS_ToString(ctx, exception);
        if (!JS_IsException(strVal)) {
            const char* directStr = JS_ToCString(ctx, strVal);
            if (directStr) {
                errorMsg = directStr;
                JS_FreeCString(ctx, directStr);
            }
        }
        JS_FreeValue(ctx, strVal);
    }
    
    // Add debugging info
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, "JS Error details: %s", errorMsg.c_str());
    
    return errorMsg;
}

// Helper function to handle JS errors
static jstring handleJSError(JNIEnv* env, JSContext* ctx) {
    JSValue exception = JS_GetException(ctx);
    std::string errorMsg = getDetailedJSError(ctx, exception);
    jstring result = env->NewStringUTF(errorMsg.c_str());
    JS_FreeValue(ctx, exception);
    return result;
}

// Callback for uv_close
static void uv_close_callback(uv_handle_t* handle);

// libuv timer callback
static void uv_timer_callback(uv_timer_t* handle) {
    TimerData* data = (TimerData*)handle->data;
    if (!data || !data->ctx) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "Invalid timer data in callback");
        return;
    }
    
    JSContext* ctx = data->ctx;
    JSValue callback = data->callback;
    int timerId = data->timerId;
    bool isInterval = data->isInterval;
    EngineInstance* instance = data->instance;
    
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "Executing %s %d", isInterval ? "interval" : "timer", timerId);
    
    data->isExecuting = true;

    // Execute the callback
    JSValue result;
    if (JS_IsFunction(ctx, callback)) {
        JSValue global = JS_GetGlobalObject(ctx);
        result = JS_Call(ctx, callback, global, 0, nullptr);
        JS_FreeValue(ctx, global);
    } else if (JS_IsString(callback)) {
        const char* code = JS_ToCString(ctx, callback);
        if (code) {
            result = JS_Eval(ctx, code, strlen(code), 
                isInterval ? "<setInterval>" : "<setTimeout>", JS_EVAL_TYPE_GLOBAL);
            JS_FreeCString(ctx, code);
        } else {
            result = JS_EXCEPTION;
        }
    } else {
        result = JS_UNDEFINED;
    }
    
    // Handle any exceptions
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(ctx);
        std::string errorMsg = getDetailedJSError(ctx, exception);
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, 
            "Error in %s callback: %s", isInterval ? "interval" : "timer", errorMsg.c_str());
        JS_FreeValue(ctx, exception);
    }
    
    JS_FreeValue(ctx, result);
    
    // Process any pending Promise jobs after timer execution
    JSContext *ctx1;
    while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &ctx1) > 0) {
        // Continue processing jobs
    }
    
    data->isExecuting = false;

    // For setTimeout, or an interval cleared from inside its callback, clean up once.
    if ((!isInterval || data->isCleared) && instance) {
        instance->timerCallbacks.erase(timerId);
        instance->uvTimers.erase(timerId);
        JS_FreeValue(ctx, data->callback);
        handle->data = nullptr;
        delete data;
        if (!uv_is_closing((uv_handle_t*)handle)) {
            uv_timer_stop(handle);
            uv_close((uv_handle_t*)handle, uv_close_callback);
        }
    }
}

// Callback for uv_close
static void uv_close_callback(uv_handle_t* handle) {
    delete (uv_timer_t*)handle;
}

// Function to run the JavaScript event loop and process pending Promise jobs
static bool runJavaScriptEventLoop(JSContext *ctx) {
    int count = 0;
    JSContext *ctx1;
    int err;
    
    // Get start time for logging purposes only
    auto startTime = std::chrono::steady_clock::now();
    
    // Process pending jobs until none are left
    for(;;) {
        err = JS_ExecutePendingJob(JS_GetRuntime(ctx), &ctx1);
        if (err <= 0) {
            // No more pending jobs or error
            if (err < 0) {
                __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "Error executing pending job");
            }
            
            // Calculate total execution time for logging
            auto endTime = std::chrono::steady_clock::now();
            auto totalMs = std::chrono::duration_cast<std::chrono::milliseconds>(endTime - startTime).count();
            
            __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
                "Completed %d pending jobs in %.2f ms", count, (float)totalMs);
            
            return err == 0; // true if no more jobs, false if error
        }
        
        count++;
        
        // Periodically log progress for debugging purposes
        if (count % EVENT_LOOP_LOG_INTERVAL == 0) {
            auto currentTime = std::chrono::steady_clock::now();
            auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(currentTime - startTime).count();
            
            __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
                "Processed %d pending jobs so far (%.2f ms elapsed)", 
                count, (float)elapsedMs);
        }
    }
}

// Helper function to create a JSValue object from native JSValue
static jobject createJSValueObject(JNIEnv* env, JSContext* ctx, JSValue value) {
    jclass jsValueClass = env->FindClass("com/didi/dimina/engine/qjs/JSValue");
    
    if (JS_IsString(value)) {
        const char* str = JS_ToCString(ctx, value);
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createString", "(Ljava/lang/String;)Lcom/didi/dimina/engine/qjs/JSValue;");
        jstring jstr = env->NewStringUTF(str ? str : "");
        jobject result = env->CallStaticObjectMethod(jsValueClass, method, jstr);
        env->DeleteLocalRef(jstr);
        JS_FreeCString(ctx, str);
        return result;
    } 
    
    if (JS_IsNumber(value)) {
        double num;
        JS_ToFloat64(ctx, &num, value);
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createNumber", "(D)Lcom/didi/dimina/engine/qjs/JSValue;");
        return env->CallStaticObjectMethod(jsValueClass, method, num);
    } 
    
    if (JS_IsBool(value)) {
        jboolean boolValue = JS_ToBool(ctx, value);
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createBoolean", "(Z)Lcom/didi/dimina/engine/qjs/JSValue;");
        return env->CallStaticObjectMethod(jsValueClass, method, boolValue);
    } 
    
    if (JS_IsNull(value)) {
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createNull", "()Lcom/didi/dimina/engine/qjs/JSValue;");
        return env->CallStaticObjectMethod(jsValueClass, method);
    } 
    
    if (JS_IsUndefined(value)) {
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createUndefined", "()Lcom/didi/dimina/engine/qjs/JSValue;");
        return env->CallStaticObjectMethod(jsValueClass, method);
    } 
    
    if (JS_IsObject(value)) {
        // Use helper function to stringify
        JSValueGuard jsonStr(ctx, jsonStringify(ctx, value));
        
        const char* str = JS_ToCString(ctx, jsonStr.get());
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createObject", "(Ljava/lang/String;)Lcom/didi/dimina/engine/qjs/JSValue;");
        jstring jstr = env->NewStringUTF(str ? str : "[object Object]");
        jobject result = env->CallStaticObjectMethod(jsValueClass, method, jstr);
        env->DeleteLocalRef(jstr);
        JS_FreeCString(ctx, str);
        
        return result;
    } 
    
    if (JS_IsException(value)) {
        JSValueGuard exception(ctx, JS_GetException(ctx));
        std::string errorMsg = getDetailedJSError(ctx, exception.get());
        
        jmethodID method = env->GetStaticMethodID(
            jsValueClass, "createError", "(Ljava/lang/String;)Lcom/didi/dimina/engine/qjs/JSValue;");
        jstring jstr = env->NewStringUTF(errorMsg.c_str());
        jobject result = env->CallStaticObjectMethod(jsValueClass, method, jstr);
        env->DeleteLocalRef(jstr);
        return result;
    }
    
    // Default case: undefined
    jmethodID method = env->GetStaticMethodID(
        jsValueClass, "createUndefined", "()Lcom/didi/dimina/engine/qjs/JSValue;");
    return env->CallStaticObjectMethod(jsValueClass, method);
}

// QuickJSEngine methods

// DiminaServiceBridge invoke method implementation
static JSValue js_dimina_invoke(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "Expected object argument");
    }

    // Find the engine instance for this context
    EngineInstance* instance = findInstanceByContext(ctx);
    if (!instance || !instance->engineObj) {
        return JS_ThrowInternalError(ctx, "Engine instance not found or not initialized");
    }

    // Get JNI environment with RAII guard
    JNIEnvGuard envGuard;
    if (!envGuard.isValid()) {
        return JS_ThrowInternalError(ctx, "Failed to get JNI environment");
    }
    JNIEnv* env = envGuard.get();

    // Stringify the input object
    JSValueGuard jsonStr(ctx, jsonStringify(ctx, argv[0]));
    if (jsonStr.isException()) {
        return JS_EXCEPTION;
    }

    // Get the JSON string
    const char* jsonData = JS_ToCString(ctx, jsonStr.get());
    if (!jsonData) {
        return JS_EXCEPTION;
    }

    // Call the Kotlin invokeFromJS method with JSValue? return type
    jclass cls = env->GetObjectClass(instance->engineObj);
    jclass jsonObjectClass = env->FindClass("org/json/JSONObject");
    jmethodID jsonObjectConstructor = env->GetMethodID(jsonObjectClass, "<init>", "(Ljava/lang/String;)V");
    jclass jsValueClass = env->FindClass("com/didi/dimina/engine/qjs/JSValue");
    jmethodID invokeMethod = env->GetMethodID(cls, "invokeFromJS", "(Lorg/json/JSONObject;)Lcom/didi/dimina/engine/qjs/JSValue;");

    jobject resultObj = nullptr;
    if (invokeMethod && jsonObjectConstructor) {
        jstring jJsonData = env->NewStringUTF(jsonData);
        jobject jsonObject = env->NewObject(jsonObjectClass, jsonObjectConstructor, jJsonData);
        resultObj = env->CallObjectMethod(instance->engineObj, invokeMethod, jsonObject);
        env->DeleteLocalRef(jsonObject);
        env->DeleteLocalRef(jJsonData);
    }

    JS_FreeCString(ctx, jsonData);

    // Convert the returned JSValue? to a QuickJS JSValue
    JSValue result;
    if (resultObj == nullptr) {
        result = JS_NULL; // Kotlin returned null
    } else {
        // Get the Type enum field
        jclass typeClass = env->FindClass("com/didi/dimina/engine/qjs/JSValue$Type");
        jfieldID typeField = env->GetFieldID(jsValueClass, "type", "Lcom/didi/dimina/engine/qjs/JSValue$Type;");
        jobject typeObj = env->GetObjectField(resultObj, typeField);

        // Get the name of the enum value
        jmethodID nameMethod = env->GetMethodID(typeClass, "name", "()Ljava/lang/String;");
        auto jTypeName = (jstring)env->CallObjectMethod(typeObj, nameMethod);
        const char* typeName = env->GetStringUTFChars(jTypeName, nullptr);

        // Handle each type
        if (strcmp(typeName, "NULL") == 0) {
            result = JS_NULL;
        } else if (strcmp(typeName, "STRING") == 0) {
            jfieldID stringField = env->GetFieldID(jsValueClass, "stringValue", "Ljava/lang/String;");
            auto jStringValue = (jstring)env->GetObjectField(resultObj, stringField);
            const char* stringValue = jStringValue ? env->GetStringUTFChars(jStringValue, nullptr) : nullptr;
            result = JS_NewString(ctx, stringValue ? stringValue : "");
            if (stringValue) env->ReleaseStringUTFChars(jStringValue, stringValue);
            if (jStringValue) env->DeleteLocalRef(jStringValue);
        } else if (strcmp(typeName, "NUMBER") == 0) {
            jfieldID numberField = env->GetFieldID(jsValueClass, "numberValue", "D");
            jdouble numberValue = env->GetDoubleField(resultObj, numberField);
            result = JS_NewFloat64(ctx, numberValue);
        } else if (strcmp(typeName, "BOOLEAN") == 0) {
            jfieldID booleanField = env->GetFieldID(jsValueClass, "booleanValue", "Z");
            jboolean booleanValue = env->GetBooleanField(resultObj, booleanField);
            result = JS_NewBool(ctx, booleanValue);
        } else if (strcmp(typeName, "OBJECT") == 0) {
            jfieldID stringField = env->GetFieldID(jsValueClass, "stringValue", "Ljava/lang/String;");
            auto jStringValue = (jstring)env->GetObjectField(resultObj, stringField);
            const char* stringValue = jStringValue ? env->GetStringUTFChars(jStringValue, nullptr) : nullptr;
            if (stringValue) {
                result = JS_ParseJSON(ctx, stringValue, strlen(stringValue), "<invokeFromJS>");
                if (JS_IsException(result)) {
                    result = JS_NULL; // Fallback to null on parsing error
                }
            } else {
                result = JS_NewObject(ctx); // Empty object if stringValue is null
            }
            if (stringValue) env->ReleaseStringUTFChars(jStringValue, stringValue);
            if (jStringValue) env->DeleteLocalRef(jStringValue);
        } else if (strcmp(typeName, "ERROR") == 0) {
            jfieldID errorField = env->GetFieldID(jsValueClass, "errorMessage", "Ljava/lang/String;");
            auto jErrorMessage = (jstring)env->GetObjectField(resultObj, errorField);
            const char* errorMessage = jErrorMessage ? env->GetStringUTFChars(jErrorMessage, nullptr) : "Unknown error";
            result = JS_ThrowInternalError(ctx, "%s", errorMessage);
            if (errorMessage) env->ReleaseStringUTFChars(jErrorMessage, errorMessage);
            if (jErrorMessage) env->DeleteLocalRef(jErrorMessage);
        } else {
            result = JS_UNDEFINED; // Fallback for unexpected types
        }

        // Free JNI resources
        env->ReleaseStringUTFChars(jTypeName, typeName);
        env->DeleteLocalRef(jTypeName);
        env->DeleteLocalRef(typeObj);
        env->DeleteLocalRef(typeClass);
        env->DeleteLocalRef(resultObj);
        env->DeleteLocalRef(jsValueClass);
    }

    return result;
}

// DiminaServiceBridge publish method implementation
static JSValue js_dimina_publish(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsObject(argv[1])) {
        return JS_ThrowTypeError(ctx, "Expected string and object arguments");
    }
    
    // Find the engine instance for this context
    EngineInstance* instance = findInstanceByContext(ctx);
    if (!instance || !instance->engineObj) {
        return JS_ThrowInternalError(ctx, "Engine instance not found or not initialized");
    }
    
    // Get JNI environment with RAII guard
    JNIEnvGuard envGuard;
    if (!envGuard.isValid()) {
        return JS_ThrowInternalError(ctx, "Failed to get JNI environment");
    }
    JNIEnv* env = envGuard.get();
    
    // Stringify the object
    JSValueGuard jsonStr(ctx, jsonStringify(ctx, argv[1]));
    if (jsonStr.isException()) {
        return JS_EXCEPTION;
    }
    
    // Get the JSON string and id
    const char* jsonData = JS_ToCString(ctx, jsonStr.get());
    const char* id = JS_ToCString(ctx, argv[0]);
    
    if (!jsonData || !id) {
        if (jsonData) JS_FreeCString(ctx, jsonData);
        if (id) JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }
    
    // Call the Kotlin publish method
    jclass cls = env->GetObjectClass(instance->engineObj);
    jclass jsonObjectClass = env->FindClass("org/json/JSONObject");
    jmethodID jsonObjectConstructor = env->GetMethodID(jsonObjectClass, "<init>", "(Ljava/lang/String;)V");
    jmethodID publishMethod = env->GetMethodID(cls, "publishFromJS", "(Ljava/lang/String;Lorg/json/JSONObject;)V");
    
    if (publishMethod && jsonObjectConstructor) {
        jstring jId = env->NewStringUTF(id);
        jstring jJsonData = env->NewStringUTF(jsonData);
        jobject jsonObject = env->NewObject(jsonObjectClass, jsonObjectConstructor, jJsonData);
        env->CallVoidMethod(instance->engineObj, publishMethod, jId, jsonObject);
        env->DeleteLocalRef(jsonObject);
        env->DeleteLocalRef(jJsonData);
        env->DeleteLocalRef(jId);
    }
    
    JS_FreeCString(ctx, id);
    JS_FreeCString(ctx, jsonData);
    
    return JS_UNDEFINED;
}

// Unified timer clearing implementation (for both setTimeout and setInterval)
static JSValue js_clear_timer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1 || !JS_IsNumber(argv[0])) {
        return JS_ThrowTypeError(ctx, "clearTimeout/clearInterval expects a timer ID as first argument");
    }
    
    // Get the timer ID
    int32_t timerId = 0;
    JS_ToInt32(ctx, &timerId, argv[0]);
    
    // Find the engine instance for this context
    EngineInstance* instance = findInstanceByContext(ctx);
    if (!instance) {
        return JS_ThrowInternalError(ctx, "Could not find engine instance for this context");
    }
    
    // Find and stop the timer
    auto timerIt = instance->uvTimers.find(timerId);
    auto dataIt = instance->timerCallbacks.find(timerId);
    if (dataIt != instance->timerCallbacks.end() && dataIt->second->isExecuting) {
        dataIt->second->isCleared = true;
        if (timerIt != instance->uvTimers.end()) {
            uv_timer_stop(timerIt->second);
        }
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, "Marked running timer %d as cleared", timerId);
        return JS_UNDEFINED;
    }

    if (timerIt != instance->uvTimers.end()) {
        uv_timer_t* timer = timerIt->second;
        uv_timer_stop(timer);
        uv_close((uv_handle_t*)timer, uv_close_callback);
        instance->uvTimers.erase(timerIt);
        
        // Clean up timer data
        if (dataIt != instance->timerCallbacks.end()) {
            TimerData* data = dataIt->second;
            JS_FreeValue(ctx, data->callback);
            delete data;
            instance->timerCallbacks.erase(dataIt);
        }
        
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, "Cleared timer %d", timerId);
    }
    
    return JS_UNDEFINED;
}

// Unified timer creation implementation (for both setTimeout and setInterval)
static JSValue js_create_timer(JSContext *ctx, JSValueConst *argv, int argc, bool isInterval) {
    if (argc < 1 || (!JS_IsFunction(ctx, argv[0]) && !JS_IsString(argv[0]))) {
        return JS_ThrowTypeError(ctx, isInterval ? 
            "setInterval expects at least a function or string as first argument" :
            "setTimeout expects at least a function or string as first argument");
    }
    
    // Get the delay/interval time in milliseconds (default to 0 if not provided)
    int32_t delay = 0;
    if (argc >= 2 && JS_IsNumber(argv[1])) {
        JS_ToInt32(ctx, &delay, argv[1]);
        if (delay < 0) delay = 0;
    }
    
    // Find the engine instance for this context
    EngineInstance* instance = findInstanceByContext(ctx);
    if (!instance || !instance->loop) {
        return JS_ThrowInternalError(ctx, "Could not find engine instance or event loop");
    }
    
    // Generate a unique timer ID
    int timerId = instance->nextTimerId++;
    
    // Create timer data
    TimerData* data = new TimerData{
        .ctx = ctx,
        .timerId = timerId,
        .callback = JS_DupValue(ctx, argv[0]),
        .instanceId = 0,
        .isInterval = isInterval,
        .instance = instance
    };
    
    // Create and initialize uv timer
    uv_timer_t* timer = new uv_timer_t();
    timer->data = data;
    
    int result = uv_timer_init(instance->loop, timer);
    if (result != 0) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, 
            "Failed to init uv_timer: %s", uv_strerror(result));
        JS_FreeValue(ctx, data->callback);
        delete data;
        delete timer;
        return JS_ThrowInternalError(ctx, "Failed to initialize timer");
    }
    
    // For intervals, set repeat parameter; for timeouts, set repeat to 0
    result = uv_timer_start(timer, uv_timer_callback, delay, isInterval ? delay : 0);
    if (result != 0) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, 
            "Failed to start uv_timer: %s", uv_strerror(result));
        JS_FreeValue(ctx, data->callback);
        delete data;
        uv_close((uv_handle_t*)timer, uv_close_callback);
        return JS_ThrowInternalError(ctx, "Failed to start timer");
    }
    
    // Store timer references
    instance->timerCallbacks[timerId] = data;
    instance->uvTimers[timerId] = timer;
    
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "Scheduled %s %d with delay %d ms using libuv", 
        isInterval ? "interval" : "timer", timerId, delay);
    
    return JS_NewInt32(ctx, timerId);
}

// setTimeout wrapper
static JSValue js_set_timeout(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return js_create_timer(ctx, argv, argc, false);
}

// setInterval wrapper
static JSValue js_set_interval(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return js_create_timer(ctx, argv, argc, true);
}

// Note: Timer execution is now handled directly by libuv callbacks
// The old nativeExecuteTimer, nativeClearTimer, nativeExecuteInterval, and nativeClearInterval
// methods are no longer needed as libuv manages the event loop

// Native log function to call into Java/Kotlin with integer log level
static JSValue js_native_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int level) {
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    // Convert all arguments to strings and concatenate them
    std::string logMessage;
    for (int i = 0; i < argc; i++) {
        if (i > 0) {
            logMessage += " ";
        }

        if (JS_IsObject(argv[i])) {
            // For objects, use JSON.stringify
            JSValueGuard jsonStr(ctx, jsonStringify(ctx, argv[i]));
            const char* str = JS_ToCString(ctx, jsonStr.get());
            if (str) {
                logMessage += str;
                JS_FreeCString(ctx, str);
            } else {
                logMessage += "[object Object]";
            }
        } else {
            const char* str = JS_ToCString(ctx, argv[i]);
            if (str) {
                logMessage += str;
                JS_FreeCString(ctx, str);
            }
        }
    }

    // Log directly using Android logging API based on level
    switch (level) {
        case 0: // LOG
            __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, "[JS] %s", logMessage.c_str());
            break;
        case 1: // INFO
            __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "[JS] %s", logMessage.c_str());
            break;
        case 2: // WARN
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "[JS] %s", logMessage.c_str());
            break;
        case 3: // ERROR
            __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "[JS] %s", logMessage.c_str());
            break;
        default:
            __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, "[JS] [Unknown Level %d] %s", level, logMessage.c_str());
            break;
    }

    return JS_UNDEFINED;
}
// Register console API
static void register_console_api(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);

    JSValue console = JS_NewObject(ctx);

    // Register each console function
    JS_SetPropertyStr(ctx, console, "log",
                      JS_NewCFunctionMagic(ctx, js_native_log, "log", 1, JS_CFUNC_generic_magic, 0)); // LOG
    JS_SetPropertyStr(ctx, console, "info",
                      JS_NewCFunctionMagic(ctx, js_native_log, "info", 1, JS_CFUNC_generic_magic, 1)); // INFO
    JS_SetPropertyStr(ctx, console, "warn",
                      JS_NewCFunctionMagic(ctx, js_native_log, "warn", 1, JS_CFUNC_generic_magic, 2)); // WARN
    JS_SetPropertyStr(ctx, console, "error",
                      JS_NewCFunctionMagic(ctx, js_native_log, "error", 1, JS_CFUNC_generic_magic, 3)); // ERROR

    // Register console methods
    JS_SetPropertyStr(ctx, global, "console", console);

    // Free the global object reference
    JS_FreeValue(ctx, global);
}

// Register timer functions (setTimeout and clearTimeout)
static void register_timer_functions(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    
    // Register setTimeout and setInterval functions
    JS_SetPropertyStr(ctx, global, "setTimeout",
                      JS_NewCFunction(ctx, js_set_timeout, "setTimeout", 2));
    JS_SetPropertyStr(ctx, global, "setInterval",
                      JS_NewCFunction(ctx, js_set_interval, "setInterval", 2));

    // Register unified clear function for both timeout and interval
    JSValue clearFunc = JS_NewCFunction(ctx, js_clear_timer, "clearTimer", 1);
    JS_SetPropertyStr(ctx, global, "clearTimeout", JS_DupValue(ctx, clearFunc));
    JS_SetPropertyStr(ctx, global, "clearInterval", clearFunc);

    JS_FreeValue(ctx, global);
}

// Register DiminaServiceBridge global object and methods
static void register_dimina_service_bridge(JSContext *ctx) {
    // Create the DiminaServiceBridge object
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue diminaObj = JS_NewObject(ctx);
    
    // Register methods
    JS_SetPropertyStr(ctx, diminaObj, "invoke", 
                      JS_NewCFunction(ctx, js_dimina_invoke, "invoke", 1));
    JS_SetPropertyStr(ctx, diminaObj, "publish", 
                      JS_NewCFunction(ctx, js_dimina_publish, "publish", 1));
    
    // Add DiminaServiceBridge to global object
    JS_SetPropertyStr(ctx, global, "DiminaServiceBridge", diminaObj);
    
    // Free the global object reference
    JS_FreeValue(ctx, global);
}

// Initialize QuickJS runtime, context, and libuv event loop
extern "C" JNIEXPORT jboolean JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeInitialize(
        JNIEnv* env,
        jobject thiz,
        jint instanceId) {
    
    // Check if instance already exists
    std::lock_guard<std::mutex> lock(gEngineInstancesMutex);
    if (gEngineInstances.find(instanceId) != gEngineInstances.end()) {
        __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "Instance %d already initialized", instanceId);
        return JNI_FALSE;
    }
    
    // Create new engine instance
    auto* instance = new EngineInstance();
    
    // Store global reference to Java object
    instance->engineObj = env->NewGlobalRef(thiz);
    
    // Create libuv event loop
    instance->loop = new uv_loop_t();
    int result = uv_loop_init(instance->loop);
    if (result != 0) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, 
            "Failed to initialize libuv loop for instance %d: %s", instanceId, uv_strerror(result));
        env->DeleteGlobalRef(instance->engineObj);
        delete instance->loop;
        delete instance;
        return JNI_FALSE;
    }
    
    // Create QuickJS runtime
    instance->runtime = JS_NewRuntime();
    if (!instance->runtime) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "Failed to create QuickJS runtime for instance %d", instanceId);
        uv_loop_close(instance->loop);
        delete instance->loop;
        env->DeleteGlobalRef(instance->engineObj);
        delete instance;
        return JNI_FALSE;
    }
    
    // Create QuickJS context
    instance->ctx = JS_NewContext(instance->runtime);
    if (!instance->ctx) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "Failed to create QuickJS context for instance %d", instanceId);
        JS_FreeRuntime(instance->runtime);
        uv_loop_close(instance->loop);
        delete instance->loop;
        env->DeleteGlobalRef(instance->engineObj);
        delete instance;
        return JNI_FALSE;
    }
    
    // Register DiminaServiceBridge global object
    register_dimina_service_bridge(instance->ctx);
    
    // Register console API
    register_console_api(instance->ctx);
    
    // Register timer functions
    register_timer_functions(instance->ctx);
    
    // Store pointers in Java object
    jclass cls = env->GetObjectClass(thiz);
    jfieldID runtimeField = env->GetFieldID(cls, "nativeRuntimePtr", "J");
    jfieldID contextField = env->GetFieldID(cls, "nativeContextPtr", "J");
    jfieldID loopField = env->GetFieldID(cls, "nativeLoopPtr", "J");
    
    env->SetLongField(thiz, runtimeField, (jlong)instance->runtime);
    env->SetLongField(thiz, contextField, (jlong)instance->ctx);
    env->SetLongField(thiz, loopField, (jlong)instance->loop);
    
    // Store instance in global map
    gEngineInstances[instanceId] = instance;
    
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "QuickJS instance %d initialized successfully with libuv event loop", instanceId);
    return JNI_TRUE;
}

// Execute JavaScript from a file path and return JSValue
extern "C" JNIEXPORT jobject JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeEvaluateFromFile(
        JNIEnv* env,
        jobject thiz,
        jstring filePath,
        jint instanceId) {
    
    // Get the engine instance
    EngineInstance* instance = getEngineInstance(instanceId);
    if (!instance || !instance->ctx) {
        return createJSError(env, "QuickJS context is null or instance not found");
    }
    
    JSContext* ctx = instance->ctx;
    
    // Convert Java string to C string
    const char* filePathStr = env->GetStringUTFChars(filePath, nullptr);
    if (!filePathStr) {
        return createJSError(env, "Failed to get file path string");
    }
    
    // Read file content
    std::ifstream file(filePathStr);
    if (!file.is_open()) {
        std::string errorMsg = "Failed to open file: ";
        errorMsg += filePathStr;
        env->ReleaseStringUTFChars(filePath, filePathStr);
        return createJSError(env, errorMsg.c_str());
    }
    
    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string scriptContent = buffer.str();
    file.close();
    
    if (scriptContent.empty()) {
        env->ReleaseStringUTFChars(filePath, filePathStr);
        return createJSError(env, "File is empty");
    }
    
    // Evaluate JavaScript
    JSValueGuard val(ctx, JS_Eval(ctx, scriptContent.c_str(), scriptContent.length(), 
                                   filePathStr, JS_EVAL_TYPE_GLOBAL));
    
    // Release file path string
    env->ReleaseStringUTFChars(filePath, filePathStr);
    
    // Check if there was an exception during evaluation
    if (val.isException()) {
        jstring errorMsg = handleJSError(env, ctx);
        jobject errorResult = createJSError(env, env->GetStringUTFChars(errorMsg, nullptr));
        env->DeleteLocalRef(errorMsg);
        return errorResult;
    }
    
    // Run the event loop to process any pending Promise jobs
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "Running event loop to process pending Promise jobs from file for instance %d", instanceId);
    bool allJobsProcessed = runJavaScriptEventLoop(ctx);
    if (!allJobsProcessed) {
        __android_log_print(ANDROID_LOG_WARN, LOG_TAG, 
            "Error processing async jobs from file for instance %d", instanceId);
    } else {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
            "All pending Promise jobs from file processed successfully for instance %d", instanceId);
    }
    
    // Create JSValue object from result
    return createJSValueObject(env, ctx, val.get());
}

// Evaluate JavaScript code and return JSValue
extern "C" JNIEXPORT jobject JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeEvaluate(
        JNIEnv* env,
        jobject thiz,
        jstring script,
        jint instanceId) {
    
    // Get the engine instance
    EngineInstance* instance = getEngineInstance(instanceId);
    if (!instance || !instance->ctx) {
        return createJSError(env, "QuickJS context is null or instance not found");
    }
    
    JSContext* ctx = instance->ctx;
    
    // Convert Java string to C string
    const char* scriptStr = env->GetStringUTFChars(script, nullptr);
    if (!scriptStr) {
        return createJSError(env, "Failed to get script string");
    }
    
    // Evaluate JavaScript
    JSValueGuard val(ctx, JS_Eval(ctx, scriptStr, strlen(scriptStr), "<input>", JS_EVAL_TYPE_GLOBAL));
    env->ReleaseStringUTFChars(script, scriptStr);
    
    // Check if there was an exception during evaluation
    if (val.isException()) {
        jstring errorMsg = handleJSError(env, ctx);
        jobject errorResult = createJSError(env, env->GetStringUTFChars(errorMsg, nullptr));
        env->DeleteLocalRef(errorMsg);
        return errorResult;
    }
    
    // Run the event loop to process any pending Promise jobs
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "Running event loop to process pending Promise jobs for instance %d", instanceId);
    bool allJobsProcessed = runJavaScriptEventLoop(ctx);
    if (!allJobsProcessed) {
        __android_log_print(ANDROID_LOG_WARN, LOG_TAG, 
            "Error processing async jobs for instance %d", instanceId);
    } else {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
            "All pending Promise jobs processed successfully for instance %d", instanceId);
    }
    
    // Convert result to JSValue object
    return createJSValueObject(env, ctx, val.get());
}

// Run the libuv event loop
extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeRunEventLoop(
        JNIEnv* env,
        jobject thiz,
        jint instanceId) {
    
    // Get the engine instance
    EngineInstance* instance = getEngineInstance(instanceId);
    if (!instance || !instance->loop) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, 
            "Failed to run event loop: Instance %d not found or loop is null", instanceId);
        return;
    }

    // Run the event loop in non-blocking mode with a timeout
    // This allows the loop to process events without blocking indefinitely
    uv_run(instance->loop, UV_RUN_NOWAIT);
    
    // Also process any pending JavaScript jobs
    JSContext *ctx1;
    while (JS_ExecutePendingJob(instance->runtime, &ctx1) > 0) {
        // Continue processing jobs
    }
}

// Stop the libuv event loop
extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeStopEventLoop(
        JNIEnv* env,
        jobject thiz,
        jint instanceId) {
    
    // Get the engine instance
    EngineInstance* instance = getEngineInstance(instanceId);
    if (!instance || !instance->loop) {
        __android_log_print(ANDROID_LOG_WARN, LOG_TAG, 
            "Failed to stop event loop: Instance %d not found or loop is null", instanceId);
        return;
    }
    
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "Stopping libuv event loop for instance %d", instanceId);
    
    instance->shouldStop = true;
    uv_stop(instance->loop);
}

// Destroy QuickJS runtime, context, and libuv event loop
extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeDestroy(
        JNIEnv* env,
        jobject thiz,
        jint instanceId) {
    
    // Get the engine instance
    EngineInstance* instance = nullptr;
    {
        std::lock_guard<std::mutex> lock(gEngineInstancesMutex);
        auto it = gEngineInstances.find(instanceId);
        if (it == gEngineInstances.end()) {
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "Instance %d not found in nativeDestroy", instanceId);
            return;
        }
        instance = it->second;
        // Remove from map immediately to prevent double-free issues
        gEngineInstances.erase(it);
    }
    
    // Stop the event loop
    instance->shouldStop = true;
    if (instance->loop) {
        uv_stop(instance->loop);
    }
    
    // Set fields to 0 in Java object
    jclass cls = env->GetObjectClass(thiz);
    jfieldID runtimeField = env->GetFieldID(cls, "nativeRuntimePtr", "J");
    jfieldID contextField = env->GetFieldID(cls, "nativeContextPtr", "J");
    jfieldID loopField = env->GetFieldID(cls, "nativeLoopPtr", "J");
    env->SetLongField(thiz, contextField, 0L);
    env->SetLongField(thiz, runtimeField, 0L);
    env->SetLongField(thiz, loopField, 0L);
    
    // Clean up all active timers
    for (auto& pair : instance->uvTimers) {
        uv_timer_stop(pair.second);
        uv_close((uv_handle_t*)pair.second, uv_close_callback);
    }
    instance->uvTimers.clear();
    
    // Clean up timer data and callbacks
    if (instance->ctx) {
        for (auto& pair : instance->timerCallbacks) {
            TimerData* data = pair.second;
            JS_FreeValue(instance->ctx, data->callback);
            delete data;
        }
    }
    instance->timerCallbacks.clear();
    
    // Close the event loop and wait for all handles to close
    if (instance->loop) {
        // Run the loop once more to process close callbacks
        uv_run(instance->loop, UV_RUN_DEFAULT);
        
        // Close the loop
        int result = uv_loop_close(instance->loop);
        if (result != 0) {
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG, 
                "Failed to close uv loop for instance %d: %s", instanceId, uv_strerror(result));
            // Force close any remaining handles
            uv_walk(instance->loop, [](uv_handle_t* handle, void* arg) {
                if (!uv_is_closing(handle)) {
                    uv_close(handle, nullptr);
                }
            }, nullptr);
            uv_run(instance->loop, UV_RUN_DEFAULT);
            uv_loop_close(instance->loop);
        }
        delete instance->loop;
        instance->loop = nullptr;
    }
    
    // Free context and runtime in the correct order
    if (instance->ctx && instance->runtime) {
        // Run garbage collection before freeing the context
        JS_RunGC(instance->runtime);
        
        // Free the context first
        JS_FreeContext(instance->ctx);
        instance->ctx = nullptr;
        
        // Run garbage collection one more time before freeing the runtime
        JS_RunGC(instance->runtime);
        
        // Free the runtime last
        JS_FreeRuntime(instance->runtime);
        instance->runtime = nullptr;
    } else {
        // Handle partial initialization cases
        if (instance->ctx) {
            JS_FreeContext(instance->ctx);
        }
        
        if (instance->runtime) {
            JS_FreeRuntime(instance->runtime);
        }
    }
    
    // Release global reference to Java object
    if (instance->engineObj != nullptr) {
        env->DeleteGlobalRef(instance->engineObj);
        instance->engineObj = nullptr;
    }
    
    // Delete the instance
    delete instance;
    
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, 
        "QuickJS instance %d destroyed successfully with libuv cleanup", instanceId);
}
