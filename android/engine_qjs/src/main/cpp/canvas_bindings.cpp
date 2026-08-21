#include "canvas_bindings.h"
#include "engine_common.h"
#include "dimina_canvas2d.h"
#include <map>
#include <string>
#include <mutex>
#include <future>
#include <vector>

// ─── Data structures ───

struct CanvasState {
    std::string nodeId;
    int instanceId;
    JSContext *ctx;
    JSValue opsArray;      // JS Array, caches operation objects
    int opsCount;
    DMCanvasRef glCanvas;  // NanoVG GL canvas (null if not using GL renderer)
};

// ─── Global state ───

// nodeId → state
static std::map<std::string, CanvasState *> canvasStates;
// instanceId → jobject (QuickJSEngine global ref for canvas callback)
static std::map<int, jobject> canvasCallbackMap;
// ctx → instanceId
static std::map<JSContext *, int> ctxInstanceIdMap;
// jmethodID cache (resolved once per JVM lifetime)
static jmethodID sOnCanvasMessageMethod = nullptr;

// ─── Helpers ───

static int findInstanceIdForCtx(JSContext *ctx) {
    auto it = ctxInstanceIdMap.find(ctx);
    if (it != ctxInstanceIdMap.end()) {
        return it->second;
    }
    // Fallback: scan engine instances
    EngineInstance *instance = findInstanceByContext(ctx);
    if (instance) {
        // Find instanceId from gEngineInstances
        std::lock_guard<std::mutex> lock(gEngineInstancesMutex);
        for (const auto &pair : gEngineInstances) {
            if (pair.second == instance) {
                return pair.first;
            }
        }
    }
    return -1;
}

// Call QuickJSEngine.onCanvasMessage(type, json) via JNI.
// For type=1 (async flush): returns null (fire-and-forget).
// For type=2,3,4 (sync ops): blocks until Kotlin returns a result string.
static std::string callCanvasMessage(int instanceId, int type, const std::string &json) {
    auto it = canvasCallbackMap.find(instanceId);
    if (it == canvasCallbackMap.end()) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "callCanvasMessage: no callback for instanceId=%d", instanceId);
        return "";
    }

    JNIEnvGuard envGuard;
    if (!envGuard.isValid()) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "callCanvasMessage: failed to get JNI env");
        return "";
    }
    JNIEnv *env = envGuard.get();

    // Resolve method ID once
    if (!sOnCanvasMessageMethod) {
        jclass cls = env->GetObjectClass(it->second);
        if (cls) {
            sOnCanvasMessageMethod = env->GetMethodID(
                cls, "onCanvasMessage",
                "(ILjava/lang/String;)Ljava/lang/String;");
            env->DeleteLocalRef(cls);
        }
        if (!sOnCanvasMessageMethod) {
            __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
                "callCanvasMessage: failed to resolve onCanvasMessage method");
            if (env->ExceptionCheck()) env->ExceptionClear();
            return "";
        }
    }

    jstring jJson = env->NewStringUTF(json.c_str());
    if (!jJson) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "callCanvasMessage: failed to create jstring");
        return "";
    }

    jstring jResult = (jstring)env->CallObjectMethod(
        it->second, sOnCanvasMessageMethod, type, jJson);

    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        env->DeleteLocalRef(jJson);
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "callCanvasMessage: Java exception during onCanvasMessage");
        return "";
    }

    std::string result;
    if (jResult) {
        const char *chars = env->GetStringUTFChars(jResult, nullptr);
        if (chars) {
            result = chars;
            env->ReleaseStringUTFChars(jResult, chars);
        }
        env->DeleteLocalRef(jResult);
    }
    env->DeleteLocalRef(jJson);

    return result;
}

// ─── Flush helper: serialize pending ops and send via JNI ───

static void canvas_flush_state(CanvasState *state) {
    if (state->opsCount == 0) {
        return;
    }

    JSContext *ctx = state->ctx;

    // Build flush payload: { nodeId, operations }
    JSValue payload = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, payload, "nodeId", JS_NewString(ctx, state->nodeId.c_str()));
    JS_SetPropertyStr(ctx, payload, "operations", state->opsArray);

    // JSON.stringify the payload
    JSValue jsonVal = jsonStringify(ctx, payload);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);

    // Reset state — create new empty array for next batch
    state->opsArray = JS_NewArray(ctx);
    state->opsCount = 0;

    JS_FreeValue(ctx, payload);

    if (!jsonStr) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "canvas_flush_state: JSON.stringify failed for nodeId=%s", state->nodeId.c_str());
        JS_FreeValue(ctx, jsonVal);
        return;
    }

    std::string jsonCopy = jsonStr;
    int jsonLen = (int)strlen(jsonStr);
    JS_FreeCString(ctx, jsonStr);
    JS_FreeValue(ctx, jsonVal);

    // If GL canvas is available, execute ops directly via NanoVG renderer
    if (state->glCanvas) {
        dm_canvas_execute_ops(state->glCanvas, jsonCopy.c_str(), jsonLen);
        dm_canvas_swap_buffers(state->glCanvas);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_flush_state: GL flush nodeId=%s jsonLen=%d",
            state->nodeId.c_str(), jsonLen);
        return;
    }

    // Fallback: send async flush via JNI (type=1)
    callCanvasMessage(state->instanceId, 1, jsonCopy);

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "canvas_flush_state: JNI flush nodeId=%s jsonLen=%zu",
        state->nodeId.c_str(), jsonCopy.size());
}

// ─── C functions registered on __GLCanvas ───

// _flush(nodeId)
static JSValue canvas_flush(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_UNDEFINED;
    }

    auto it = canvasStates.find(nodeId);
    if (it != canvasStates.end()) {
        canvas_flush_state(it->second);
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _createCanvas(nodeId, width, height)
static JSValue canvas_create(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_createCanvas: nodeId required");
    }

    int instanceId = findInstanceIdForCtx(ctx);
    if (instanceId < 0) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowInternalError(ctx, "_createCanvas: no engine for context");
    }

    auto *state = new CanvasState();
    state->nodeId = nodeId;
    state->instanceId = instanceId;
    state->ctx = ctx;
    state->opsArray = JS_NewArray(ctx);
    state->opsCount = 0;
    state->glCanvas = nullptr;  // Set by NativeCanvasGLView when surface is ready

    canvasStates[nodeId] = state;

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "canvas_create: nodeId=%s instanceId=%d", nodeId, instanceId);
    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _destroyCanvas(nodeId)
static JSValue canvas_destroy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_UNDEFINED;
    }

    auto it = canvasStates.find(nodeId);
    if (it != canvasStates.end()) {
        CanvasState *state = it->second;
        JS_FreeValue(ctx, state->opsArray);
        if (state->glCanvas) {
            dm_canvas_destroy(state->glCanvas);
            state->glCanvas = nullptr;
        }
        delete state;
        canvasStates.erase(it);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_destroy: nodeId=%s", nodeId);
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _bufferOp(nodeId, opObj)
static JSValue canvas_buffer_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_bufferOp: nodeId required");
    }

    auto it = canvasStates.find(nodeId);
    if (it == canvasStates.end()) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowReferenceError(ctx, "_bufferOp: unknown nodeId");
    }

    CanvasState *state = it->second;

    // DupValue the operation object and push into opsArray
    JSValue op = JS_DupValue(ctx, argv[1]);
    JS_SetPropertyUint32(ctx, state->opsArray, state->opsCount, op);
    state->opsCount++;

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _syncOp(nodeId, paramsObj) — synchronous canvas operation (getImageData, toDataURL, measureText)
static JSValue canvas_sync_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_syncOp: nodeId required");
    }

    auto it = canvasStates.find(nodeId);
    if (it == canvasStates.end()) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowReferenceError(ctx, "_syncOp: unknown nodeId");
    }

    CanvasState *state = it->second;

    // Build the params object: attach pending operations + nodeId
    JSValue params = JS_DupValue(ctx, argv[1]);
    JS_SetPropertyStr(ctx, params, "nodeId", JS_NewString(ctx, nodeId));

    // Attach pending operations
    if (state->opsCount > 0) {
        JS_SetPropertyStr(ctx, params, "operations", state->opsArray);
        state->opsArray = JS_NewArray(ctx);
        state->opsCount = 0;
    }

    // Determine sync type from 'name' property
    JSValue nameVal = JS_GetPropertyStr(ctx, params, "name");
    const char *name = JS_ToCString(ctx, nameVal);
    int type = 2; // default: getImageData
    if (name) {
        if (strcmp(name, "canvasToDataURLSync") == 0) {
            type = 3;
        } else if (strcmp(name, "canvasMeasureText") == 0) {
            type = 4;
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreeValue(ctx, nameVal);

    // JSON.stringify params
    JSValue jsonVal = jsonStringify(ctx, params);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);
    JS_FreeValue(ctx, params);

    if (!jsonStr) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "canvas_sync_op: JSON.stringify failed");
        JS_FreeValue(ctx, jsonVal);
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }

    std::string jsonCopy = jsonStr;
    JS_FreeCString(ctx, jsonStr);
    JS_FreeValue(ctx, jsonVal);

    std::string resultJson;

    // If GL canvas is available, handle sync ops directly
    if (state->glCanvas) {
        // First execute any pending operations
        if (jsonCopy.find("\"operations\"") != std::string::npos) {
            dm_canvas_execute_ops(state->glCanvas, jsonCopy.c_str(), (int)jsonCopy.size());
        }

        char *result = nullptr;
        if (type == 2) {
            // getImageData
            JSValue xVal = JS_GetPropertyStr(ctx, argv[1], "x");
            JSValue yVal = JS_GetPropertyStr(ctx, argv[1], "y");
            JSValue wVal = JS_GetPropertyStr(ctx, argv[1], "width");
            JSValue hVal = JS_GetPropertyStr(ctx, argv[1], "height");
            int32_t gx = 0, gy = 0, gw = 1, gh = 1;
            JS_ToInt32(ctx, &gx, xVal);
            JS_ToInt32(ctx, &gy, yVal);
            JS_ToInt32(ctx, &gw, wVal);
            JS_ToInt32(ctx, &gh, hVal);
            JS_FreeValue(ctx, xVal);
            JS_FreeValue(ctx, yVal);
            JS_FreeValue(ctx, wVal);
            JS_FreeValue(ctx, hVal);
            result = dm_canvas_get_image_data(state->glCanvas, gx, gy, gw, gh);
        } else if (type == 3) {
            // toDataURL
            JSValue typeVal = JS_GetPropertyStr(ctx, argv[1], "type");
            JSValue qualVal = JS_GetPropertyStr(ctx, argv[1], "quality");
            const char *mime = JS_ToCString(ctx, typeVal);
            double quality = 0.92;
            JS_ToFloat64(ctx, &quality, qualVal);
            result = dm_canvas_to_data_url(state->glCanvas,
                                           mime ? mime : "image/png", quality);
            if (mime) JS_FreeCString(ctx, mime);
            JS_FreeValue(ctx, typeVal);
            JS_FreeValue(ctx, qualVal);
        } else if (type == 4) {
            // measureText
            JSValue textVal = JS_GetPropertyStr(ctx, argv[1], "text");
            JSValue fontVal = JS_GetPropertyStr(ctx, argv[1], "font");
            const char *text = JS_ToCString(ctx, textVal);
            const char *font = JS_ToCString(ctx, fontVal);
            result = dm_canvas_measure_text(state->glCanvas,
                                            text ? text : "",
                                            font ? font : "10px sans-serif");
            if (text) JS_FreeCString(ctx, text);
            if (font) JS_FreeCString(ctx, font);
            JS_FreeValue(ctx, textVal);
            JS_FreeValue(ctx, fontVal);
        }

        if (result) {
            resultJson = result;
            dm_canvas_free_string(result);
        }
    } else {
        // Fallback: call via JNI (blocking — Kotlin side uses CountDownLatch)
        resultJson = callCanvasMessage(state->instanceId, type, jsonCopy);
    }

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "canvas_sync_op: nodeId=%s type=%d resultLen=%zu", nodeId, type, resultJson.size());
    JS_FreeCString(ctx, nodeId);

    if (resultJson.empty()) {
        return JS_NewObject(ctx);
    }

    // Parse the result JSON back to JSValue
    JSValue result = JS_ParseJSON(ctx, resultJson.c_str(), resultJson.size(), "<canvas_sync_result>");
    if (JS_IsException(result)) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "canvas_sync_op: JS_ParseJSON failed");
        return JS_EXCEPTION;
    }

    return result;
}

// ─── GL Canvas binding (called from NativeCanvasGLView JNI) ───

void setCanvasGLHandle(const char *nodeId, DMCanvasRef glCanvas) {
    auto it = canvasStates.find(nodeId);
    if (it != canvasStates.end()) {
        it->second->glCanvas = glCanvas;
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "setCanvasGLHandle: nodeId=%s canvas=%p", nodeId, glCanvas);
    }
}

// ─── Register __GLCanvas on JSContext ───

void registerGLCanvas(JSContext *ctx, int instanceId) {
    // Cache ctx → instanceId mapping
    ctxInstanceIdMap[ctx] = instanceId;

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue glCanvasObj = JS_NewObject(ctx);

    // Mark as available
    JS_SetPropertyStr(ctx, glCanvasObj, "available", JS_TRUE);

    // Store instanceId for reference
    JS_SetPropertyStr(ctx, glCanvasObj, "_instanceId", JS_NewInt32(ctx, instanceId));

    // Register C functions
    JS_SetPropertyStr(ctx, glCanvasObj, "_createCanvas",
        JS_NewCFunction(ctx, canvas_create, "_createCanvas", 3));
    JS_SetPropertyStr(ctx, glCanvasObj, "_destroyCanvas",
        JS_NewCFunction(ctx, canvas_destroy, "_destroyCanvas", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_bufferOp",
        JS_NewCFunction(ctx, canvas_buffer_op, "_bufferOp", 2));
    JS_SetPropertyStr(ctx, glCanvasObj, "_flush",
        JS_NewCFunction(ctx, canvas_flush, "_flush", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_syncOp",
        JS_NewCFunction(ctx, canvas_sync_op, "_syncOp", 2));

    JS_SetPropertyStr(ctx, global, "__GLCanvas", glCanvasObj);
    JS_FreeValue(ctx, global);

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "registerGLCanvas: done instanceId=%d available=true", instanceId);
}

// ─── JNI: register canvas callback object ───

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_engine_qjs_QuickJSEngine_nativeRegisterCanvasCallback(
        JNIEnv* env,
        jobject thiz,
        jint instanceId) {
    // Store a global reference to the QuickJSEngine object for canvas callbacks
    jobject globalRef = env->NewGlobalRef(thiz);
    canvasCallbackMap[instanceId] = globalRef;

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "nativeRegisterCanvasCallback: instanceId=%d", instanceId);
}

// ─── Cleanup ───

void cleanupCanvasBindings(int instanceId) {
    // Remove all CanvasState entries for this instanceId
    auto it = canvasStates.begin();
    while (it != canvasStates.end()) {
        if (it->second->instanceId == instanceId) {
            JS_FreeValue(it->second->ctx, it->second->opsArray);
            if (it->second->glCanvas) {
                dm_canvas_destroy(it->second->glCanvas);
                it->second->glCanvas = nullptr;
            }
            delete it->second;
            it = canvasStates.erase(it);
        } else {
            ++it;
        }
    }

    // Remove ctx → instanceId mappings
    auto ctxIt = ctxInstanceIdMap.begin();
    while (ctxIt != ctxInstanceIdMap.end()) {
        if (ctxIt->second == instanceId) {
            ctxIt = ctxInstanceIdMap.erase(ctxIt);
        } else {
            ++ctxIt;
        }
    }

    // Release canvas callback global ref
    auto cbIt = canvasCallbackMap.find(instanceId);
    if (cbIt != canvasCallbackMap.end()) {
        JNIEnvGuard envGuard;
        if (envGuard.isValid()) {
            envGuard.get()->DeleteGlobalRef(cbIt->second);
        }
        canvasCallbackMap.erase(cbIt);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "cleanupCanvasBindings: released callback for instanceId=%d", instanceId);
    }

    // Reset cached method ID since the class may be unloaded
    sOnCanvasMessageMethod = nullptr;

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "cleanupCanvasBindings: done for instanceId=%d", instanceId);
}
