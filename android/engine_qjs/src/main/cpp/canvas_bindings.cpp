#include "canvas_bindings.h"
#include "engine_common.h"
#include "dimina_canvas2d.h"
#include <map>
#include <string>
#include <mutex>
#include <vector>
#include <android/native_window.h>
#include <android/native_window_jni.h>

// ─── Data structures ───

struct PendingImageUpload {
    std::string imageId;
    std::vector<unsigned char> rgbaData;
    int width;
    int height;
    std::string onloadCallbackId;
};

struct CanvasState {
    std::string nodeId;
    int instanceId;
    JSContext *ctx;
    // Op queue — each entry is a JSON string for dm_canvas_execute_ops
    std::vector<std::string> opQueue;
    DMCanvasRef glCanvas = nullptr;
    bool glInitialized = false;
    // Buffered ops before GL is ready
    std::vector<std::string> pendingOpsJson;
    bool swapScheduled = false;
    std::vector<PendingImageUpload> pendingImageUploads;
    // Op history for replay on surface rebind
    std::vector<std::string> opHistory;
    bool opHistoryComplete = true;
    static constexpr size_t OP_HISTORY_MAX = 10000;
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
// For type=5 (imageSetSrc): fire-and-forget to Java for download+decode.
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

// ─── JSON.stringify helper ───

static JSValue js_json_stringify(JSContext *ctx, JSValueConst value) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue json = JS_GetPropertyStr(ctx, global, "JSON");
    JSValue stringify = JS_GetPropertyStr(ctx, json, "stringify");

    JSValue args[1] = { JS_DupValue(ctx, value) };
    JSValue result = JS_Call(ctx, stringify, json, 1, args);

    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, stringify);
    JS_FreeValue(ctx, json);
    JS_FreeValue(ctx, global);
    return result;
}

// ─── JS callback invocation ───

static void invokeJSCallback(JSContext *ctx, const char *callbackId, const char *argsJson) {
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "invokeJSCallback: callbackId=%s args=%s", callbackId, argsJson);
    std::string script = "(function(){"
        "var cb=globalThis.__dimina_callback_registry;"
        "if(!cb){return 'no_registry'}"
        "if(!cb.invoke){return 'no_invoke'}"
        "cb.invoke('" + std::string(callbackId) + "'," + std::string(argsJson) + ");"
        "return 'ok'"
        "})()";
    JSValue ret = JS_Eval(ctx, script.c_str(), script.size(), "<img_cb>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        const char *msg = JS_ToCString(ctx, exc);
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "invokeJSCallback: JS exception: %s", msg ? msg : "(null)");
        JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
    } else {
        const char *result = JS_ToCString(ctx, ret);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "invokeJSCallback: result=%s", result ? result : "(null)");
        JS_FreeCString(ctx, result);
    }
    JS_FreeValue(ctx, ret);
}

// ─── Deferred swap helper ───
// Schedules a setTimeout(16) callback to call _render(nodeId).
// All ops within one frame period accumulate in the FBO, then one swap presents everything.

static void schedule_deferred_swap(CanvasState *state) {
    if (state->swapScheduled) {
        return;
    }
    if (!state->ctx) {
        return;
    }
    state->swapScheduled = true;
    JSContext *ctx = state->ctx;
    JSValue global = JS_GetGlobalObject(ctx);

    std::string code = "(function(){if(typeof __GLCanvas!=='undefined'&&__GLCanvas._render)__GLCanvas._render('" + state->nodeId + "')})";
    JSValue fn = JS_Eval(ctx, code.c_str(), code.size(), "<swap>", JS_EVAL_TYPE_GLOBAL);

    // Use setTimeout(fn, 16) (~60fps) — Android QuickJS uses libuv timers
    JSValue setTimeout = JS_GetPropertyStr(ctx, global, "setTimeout");
    if (JS_IsFunction(ctx, setTimeout)) {
        JSValue delay = JS_NewInt32(ctx, 16);
        JSValue args[] = { fn, delay };
        JSValue id = JS_Call(ctx, setTimeout, global, 2, args);
        JS_FreeValue(ctx, id);
        JS_FreeValue(ctx, delay);
    } else {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "schedule_deferred_swap: no setTimeout for nodeId=%s", state->nodeId.c_str());
        state->swapScheduled = false;
    }
    JS_FreeValue(ctx, setTimeout);

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
}

// ─── imageSetSrc handler for GL path ───
// Intercepts imageSetSrc ops and forwards to Java for download+decode.

static bool handleImageSetSrcGL(CanvasState *state, JSContext *ctx, JSValueConst opObj) {
    JSValue opTypeVal = JS_GetPropertyStr(ctx, opObj, "op");
    const char *opType = JS_ToCString(ctx, opTypeVal);
    bool isImageOp = opType && strcmp(opType, "imageSetSrc") == 0;
    JS_FreeCString(ctx, opType);
    JS_FreeValue(ctx, opTypeVal);
    if (!isImageOp) return false;

    if (!state->glCanvas) return false;

    // Forward to Java via callCanvasMessage type=5
    JSValue imageIdVal = JS_GetPropertyStr(ctx, opObj, "imageId");
    JSValue srcVal = JS_GetPropertyStr(ctx, opObj, "src");
    JSValue onloadVal = JS_GetPropertyStr(ctx, opObj, "onload");
    JSValue onerrorVal = JS_GetPropertyStr(ctx, opObj, "onerror");

    const char *imageId = JS_ToCString(ctx, imageIdVal);
    const char *src = JS_ToCString(ctx, srcVal);
    const char *onload = JS_ToCString(ctx, onloadVal);
    const char *onerror = JS_ToCString(ctx, onerrorVal);

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "handleImageSetSrcGL: forwarding imageId=%s src=%s",
        imageId ? imageId : "null", src ? src : "null");

    if (src && imageId) {
        std::string json = "{\"nodeId\":\"" + state->nodeId + "\","
            "\"imageId\":\"" + std::string(imageId) + "\","
            "\"src\":\"" + std::string(src) + "\","
            "\"onload\":\"" + std::string(onload ? onload : "") + "\","
            "\"onerror\":\"" + std::string(onerror ? onerror : "") + "\"}";
        callCanvasMessage(state->instanceId, 5, json);
    }

    if (imageId) JS_FreeCString(ctx, imageId);
    if (src) JS_FreeCString(ctx, src);
    if (onload) JS_FreeCString(ctx, onload);
    if (onerror) JS_FreeCString(ctx, onerror);
    JS_FreeValue(ctx, imageIdVal);
    JS_FreeValue(ctx, srcVal);
    JS_FreeValue(ctx, onloadVal);
    JS_FreeValue(ctx, onerrorVal);
    return true;
}

// ─── C functions registered on __GLCanvas ───

// _flush(nodeId) — kept as a no-op for JS compatibility.
static JSValue canvas_flush(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

    // Check if a state already exists (from nativeBindCanvasToNode or a previous canvas_create)
    auto existingIt = canvasStates.find(nodeId);
    if (existingIt != canvasStates.end()) {
        // Reuse existing state — preserves GL resources
        CanvasState *state = existingIt->second;
        state->instanceId = instanceId;
        state->ctx = ctx;
        state->opQueue.clear();
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_create: reusing state nodeId=%s instanceId=%d glCanvas=%p",
            nodeId, instanceId, state->glCanvas);
    } else {
        auto *state = new CanvasState();
        state->nodeId = nodeId;
        state->instanceId = instanceId;
        state->ctx = ctx;
        canvasStates[nodeId] = state;
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_create: nodeId=%s instanceId=%d", nodeId, instanceId);
    }

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

// _bufferOp(nodeId, opObj) — push a draw operation to the op queue.
// Serializes the single op to JSON and pushes to state->opQueue.
// A setTimeout callback (_render) drains the queue and presents the frame.
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

    // Intercept imageSetSrc for GL path — forward to Java for download+decode
    if (handleImageSetSrcGL(state, ctx, argv[1])) {
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

    // Serialize single op: {"nodeId":"...","operations":[<op>]}
    JSValue wrapper = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, wrapper, "nodeId", JS_NewString(ctx, nodeId));
    JSValue opsArr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, opsArr, 0, JS_DupValue(ctx, argv[1]));
    JS_SetPropertyStr(ctx, wrapper, "operations", opsArr);

    JSValue jsonVal = js_json_stringify(ctx, wrapper);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);
    JS_FreeValue(ctx, wrapper);

    if (jsonStr) {
        if (state->glCanvas) {
            // Push to opQueue — canvas_render handles execution
            state->opQueue.emplace_back(jsonStr);
            schedule_deferred_swap(state);
        } else {
            // No GL canvas yet — buffer for later replay
            state->pendingOpsJson.emplace_back(jsonStr);
        }
        JS_FreeCString(ctx, jsonStr);
    }
    JS_FreeValue(ctx, jsonVal);

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

    // Determine sync type from 'name' property
    JSValue nameVal = JS_GetPropertyStr(ctx, argv[1], "name");
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

    // GL direct rendering path for sync operations
    if (state->glCanvas && state->glInitialized) {
        // Flush queued ops so the FBO reflects all prior draws
        if (!state->opQueue.empty()) {
            dm_canvas_begin_frame(state->glCanvas);
            for (const auto &op : state->opQueue) {
                dm_canvas_execute_ops(state->glCanvas, op.c_str(), op.size());
            }
            state->opQueue.clear();
            dm_canvas_end_frame(state->glCanvas);
        }

        char *result = nullptr;
        if (type == 2) {
            // getImageData
            JSValue xv = JS_GetPropertyStr(ctx, argv[1], "x");
            JSValue yv = JS_GetPropertyStr(ctx, argv[1], "y");
            JSValue wv = JS_GetPropertyStr(ctx, argv[1], "width");
            JSValue hv = JS_GetPropertyStr(ctx, argv[1], "height");
            int32_t x = 0, y = 0, w = 0, h = 0;
            JS_ToInt32(ctx, &x, xv);
            JS_ToInt32(ctx, &y, yv);
            JS_ToInt32(ctx, &w, wv);
            JS_ToInt32(ctx, &h, hv);
            JS_FreeValue(ctx, xv); JS_FreeValue(ctx, yv);
            JS_FreeValue(ctx, wv); JS_FreeValue(ctx, hv);
            result = dm_canvas_get_image_data(state->glCanvas, x, y, w, h);
        } else if (type == 3) {
            // toDataURL
            JSValue mv = JS_GetPropertyStr(ctx, argv[1], "type");
            JSValue qv = JS_GetPropertyStr(ctx, argv[1], "quality");
            const char *mime = JS_ToCString(ctx, mv);
            double quality = 0.92;
            JS_ToFloat64(ctx, &quality, qv);
            result = dm_canvas_to_data_url(state->glCanvas,
                                           mime ? mime : "image/png", quality);
            if (mime) JS_FreeCString(ctx, mime);
            JS_FreeValue(ctx, mv); JS_FreeValue(ctx, qv);
        } else if (type == 4) {
            // measureText
            JSValue tv = JS_GetPropertyStr(ctx, argv[1], "text");
            JSValue fv = JS_GetPropertyStr(ctx, argv[1], "font");
            const char *text = JS_ToCString(ctx, tv);
            const char *font = JS_ToCString(ctx, fv);
            result = dm_canvas_measure_text(state->glCanvas,
                                            text ? text : "",
                                            font ? font : "10px sans-serif");
            if (text) JS_FreeCString(ctx, text);
            if (font) JS_FreeCString(ctx, font);
            JS_FreeValue(ctx, tv); JS_FreeValue(ctx, fv);
        }

        JS_FreeCString(ctx, nodeId);

        if (result) {
            JSValue jsResult;
            if (type == 3) {
                // toDataURL returns a raw string, wrap it as {dataUrl: "..."}
                jsResult = JS_NewObject(ctx);
                JS_SetPropertyStr(ctx, jsResult, "dataUrl", JS_NewString(ctx, result));
            } else {
                jsResult = JS_ParseJSON(ctx, result, strlen(result), "<canvas_gl_sync>");
            }
            dm_canvas_free_string(result);
            return jsResult;
        }
        return JS_UNDEFINED;
    }

    // Fallback: JNI path for sync ops
    JSValue params = JS_DupValue(ctx, argv[1]);
    JS_SetPropertyStr(ctx, params, "nodeId", JS_NewString(ctx, nodeId));

    JSValue jsonVal = js_json_stringify(ctx, params);
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

    std::string resultJson = callCanvasMessage(state->instanceId, type, jsonCopy);

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "canvas_sync_op: nodeId=%s type=%d resultLen=%zu", nodeId, type, resultJson.size());
    JS_FreeCString(ctx, nodeId);

    if (resultJson.empty()) {
        return JS_NewObject(ctx);
    }

    JSValue result = JS_ParseJSON(ctx, resultJson.c_str(), resultJson.size(), "<canvas_sync_result>");
    if (JS_IsException(result)) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "canvas_sync_op: JS_ParseJSON failed");
        return JS_EXCEPTION;
    }

    return result;
}

// _render(nodeId) — deferred callback: execute all queued ops in one frame, then swap.
static JSValue canvas_render(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) return JS_UNDEFINED;

    auto it = canvasStates.find(nodeId);
    if (it == canvasStates.end()) {
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

    CanvasState *state = it->second;
    state->swapScheduled = false;

    if (!state->glCanvas || !state->glInitialized) {
        // GL not ready — reschedule if there are ops waiting
        if (!state->opQueue.empty() || !state->pendingOpsJson.empty()) {
            schedule_deferred_swap(state);
        }
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_render: GL not ready for nodeId=%s opQueue=%zu pendingOps=%zu",
            nodeId, state->opQueue.size(), state->pendingOpsJson.size());
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

    // Execute ALL queued ops in one frame
    if (!state->opQueue.empty()) {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_render: executing %zu ops for nodeId=%s",
            state->opQueue.size(), nodeId);
        dm_canvas_begin_frame(state->glCanvas);
        for (const auto &op : state->opQueue) {
            dm_canvas_execute_ops(state->glCanvas, op.c_str(), op.size());

            // Record ops in history for replay on surface rebind
            if (state->opHistoryComplete) {
                if (state->opHistory.size() < CanvasState::OP_HISTORY_MAX) {
                    state->opHistory.push_back(op);
                } else {
                    state->opHistoryComplete = false;
                    __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                        "canvas_render: opHistory cap reached for nodeId=%s", nodeId);
                }
            }
        }
        state->opQueue.clear();
        dm_canvas_end_frame(state->glCanvas);

        // Present
        dm_canvas_swap_buffers(state->glCanvas);
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _replayPendingOps(nodeId) — called after GL surface binds to replay buffered ops
static JSValue canvas_replay_pending(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_UNDEFINED;
    }

    auto it = canvasStates.find(nodeId);
    if (it == canvasStates.end()) {
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

    CanvasState *state = it->second;
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "canvas_replay_pending: nodeId=%s glCanvas=%p glInit=%d pendingCount=%zu",
        nodeId, state->glCanvas, state->glInitialized, state->pendingOpsJson.size());

    if (!state->glCanvas) {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_replay_pending: SKIP — no glCanvas for nodeId=%s", nodeId);
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

    // Replay op history to restore previous content on a new surface
    if (state->glInitialized && !state->opHistory.empty() && state->opHistoryComplete) {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_replay_pending: replaying %zu opHistory entries for nodeId=%s",
            state->opHistory.size(), nodeId);
        dm_canvas_reset_for_replay(state->glCanvas);
        dm_canvas_begin_frame(state->glCanvas);
        for (const auto &op : state->opHistory) {
            dm_canvas_execute_ops(state->glCanvas, op.c_str(), op.size());
        }
        dm_canvas_end_frame(state->glCanvas);
        dm_canvas_swap_buffers(state->glCanvas);
    }

    // Move pending ops to the front of opQueue
    if (state->glInitialized && !state->pendingOpsJson.empty()) {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_replay_pending: moving %zu pending ops to opQueue for nodeId=%s",
            state->pendingOpsJson.size(), nodeId);
        state->opQueue.insert(state->opQueue.begin(),
            std::make_move_iterator(state->pendingOpsJson.begin()),
            std::make_move_iterator(state->pendingOpsJson.end()));
        state->pendingOpsJson.clear();
        schedule_deferred_swap(state);
    }

    // Process pending image uploads
    if (state->glInitialized && !state->pendingImageUploads.empty()) {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_replay_pending: processing pending image uploads for nodeId=%s", nodeId);
        std::string uploadScript = "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._uploadPendingImages)"
                                   "__GLCanvas._uploadPendingImages('" + std::string(nodeId) + "')";
        JSValue result = JS_Eval(ctx, uploadScript.c_str(), uploadScript.size(), "<upload>", JS_EVAL_TYPE_GLOBAL);
        JS_FreeValue(ctx, result);
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _uploadPendingImages(nodeId) — process queued network image uploads on JS/GL thread
static JSValue canvas_upload_pending_images(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) return JS_UNDEFINED;

    auto it = canvasStates.find(nodeId);
    if (it == canvasStates.end()) {
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

    CanvasState *state = it->second;
    std::vector<PendingImageUpload> uploads = std::move(state->pendingImageUploads);
    state->pendingImageUploads.clear();

    if (!uploads.empty() && state->glCanvas && state->glInitialized) {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_upload_pending_images: nodeId=%s count=%zu",
            nodeId, uploads.size());

        std::vector<PendingImageUpload> retryUploads;
        for (auto &img : uploads) {
            int rc = dm_canvas_load_image_rgba(state->glCanvas, img.imageId.c_str(),
                                               img.width, img.height, img.rgbaData.data());
            if (rc == 0 && !img.onloadCallbackId.empty()) {
                char loadJson[128];
                snprintf(loadJson, sizeof(loadJson), "{\"width\":%d,\"height\":%d}", img.width, img.height);
                invokeJSCallback(ctx, img.onloadCallbackId.c_str(), loadJson);
                __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
                    "canvas_upload_pending_images: uploaded imageId=%s %dx%d",
                    img.imageId.c_str(), img.width, img.height);
            } else if (rc != 0) {
                __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
                    "canvas_upload_pending_images: upload failed imageId=%s", img.imageId.c_str());
            }
        }
    } else if (!uploads.empty()) {
        // GL not ready — put back for retry
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "canvas_upload_pending_images: GL not ready, requeueing %zu images for nodeId=%s",
            uploads.size(), nodeId);
        state->pendingImageUploads.insert(state->pendingImageUploads.begin(),
            std::make_move_iterator(uploads.begin()),
            std::make_move_iterator(uploads.end()));
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _putImageData(nodeId, dataArray, dataW, dataH, dx, dy [, dirtyX, dirtyY, dirtyW, dirtyH])
static JSValue canvas_put_image_data(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 6) {
        return JS_ThrowTypeError(ctx, "_putImageData: requires at least 6 args");
    }
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_putImageData: nodeId required");
    }

    auto it = canvasStates.find(nodeId);
    if (it == canvasStates.end()) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowReferenceError(ctx, "_putImageData: unknown nodeId");
    }

    CanvasState *state = it->second;

    if (state->glCanvas && state->glInitialized) {
        // Flush queued ops first
        if (!state->opQueue.empty()) {
            dm_canvas_begin_frame(state->glCanvas);
            for (const auto &op : state->opQueue) {
                dm_canvas_execute_ops(state->glCanvas, op.c_str(), op.size());
            }
            state->opQueue.clear();
            dm_canvas_end_frame(state->glCanvas);
        }

        // Extract pixel data from typed array / ArrayBuffer
        size_t dataLen = 0;
        uint8_t *dataBuf = nullptr;
        dataBuf = JS_GetArrayBuffer(ctx, &dataLen, argv[1]);
        if (!dataBuf) {
            size_t offset = 0, byteLen = 0;
            JSValue abuf = JS_GetTypedArrayBuffer(ctx, argv[1], &offset, &byteLen, nullptr);
            if (!JS_IsException(abuf)) {
                dataBuf = JS_GetArrayBuffer(ctx, &dataLen, abuf);
                if (dataBuf) {
                    dataBuf += offset;
                    dataLen = byteLen;
                }
                JS_FreeValue(ctx, abuf);
            }
        }

        if (!dataBuf || dataLen == 0) {
            __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
                "_putImageData: failed to extract pixel data");
            JS_FreeCString(ctx, nodeId);
            return JS_UNDEFINED;
        }

        int32_t dataW = 0, dataH = 0, dx = 0, dy = 0;
        JS_ToInt32(ctx, &dataW, argv[2]);
        JS_ToInt32(ctx, &dataH, argv[3]);
        JS_ToInt32(ctx, &dx, argv[4]);
        JS_ToInt32(ctx, &dy, argv[5]);

        int32_t dirtyX = 0, dirtyY = 0, dirtyW = dataW, dirtyH = dataH;
        if (argc >= 10) {
            JS_ToInt32(ctx, &dirtyX, argv[6]);
            JS_ToInt32(ctx, &dirtyY, argv[7]);
            JS_ToInt32(ctx, &dirtyW, argv[8]);
            JS_ToInt32(ctx, &dirtyH, argv[9]);
        }

        dm_canvas_put_image_data(state->glCanvas, dataBuf, dataW, dataH,
                                 dx, dy, dirtyX, dirtyY, dirtyW, dirtyH);
    } else {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "_putImageData: GL canvas not available for nodeId=%s", nodeId);
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// ─── GL Canvas binding (called from NativeCanvasGLView JNI) ───

void setCanvasGLHandle(const char *nodeId, DMCanvasRef glCanvas) {
    auto it = canvasStates.find(nodeId);
    if (it != canvasStates.end()) {
        it->second->glCanvas = glCanvas;
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "setCanvasGLHandle: nodeId=%s canvas=%p", nodeId, glCanvas);
    } else {
        // Create state entry for later adoption by canvas_create
        auto *state = new CanvasState();
        state->nodeId = nodeId;
        state->glCanvas = glCanvas;
        canvasStates[nodeId] = state;
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "setCanvasGLHandle: pre-created state nodeId=%s canvas=%p", nodeId, glCanvas);
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
    JS_SetPropertyStr(ctx, glCanvasObj, "_render",
        JS_NewCFunction(ctx, canvas_render, "_render", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_replayPendingOps",
        JS_NewCFunction(ctx, canvas_replay_pending, "_replayPendingOps", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_uploadPendingImages",
        JS_NewCFunction(ctx, canvas_upload_pending_images, "_uploadPendingImages", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_putImageData",
        JS_NewCFunction(ctx, canvas_put_image_data, "_putImageData", 10));

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
    jobject globalRef = env->NewGlobalRef(thiz);
    canvasCallbackMap[instanceId] = globalRef;

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "nativeRegisterCanvasCallback: instanceId=%d", instanceId);
}

// ─── NativeCanvasGLView JNI functions ───

extern "C" JNIEXPORT jlong JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeCreateCanvas(
        JNIEnv *env, jobject thiz, jint width, jint height) {
    DMCanvasRef canvas = dm_canvas_create(width, height);
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "nativeCreateCanvas: %dx%d canvas=%p", width, height, canvas);
    return (jlong)canvas;
}

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeDestroyCanvas(
        JNIEnv *env, jobject thiz, jlong handle) {
    if (handle != 0) {
        dm_canvas_destroy((DMCanvasRef)handle);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "nativeDestroyCanvas: handle=%p", (void*)handle);
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeInitSurface(
        JNIEnv *env, jobject thiz, jlong handle, jobject surface) {
    if (handle == 0 || !surface) return -1;

    ANativeWindow *nativeWindow = ANativeWindow_fromSurface(env, surface);
    if (!nativeWindow) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
            "nativeInitSurface: ANativeWindow_fromSurface failed");
        return -1;
    }

    int rc = dm_canvas_init_surface((DMCanvasRef)handle, nativeWindow);
    ANativeWindow_release(nativeWindow);

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "nativeInitSurface: handle=%p rc=%d", (void*)handle, rc);
    return rc;
}

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeDestroySurface(
        JNIEnv *env, jobject thiz, jlong handle) {
    if (handle != 0) {
        dm_canvas_destroy_surface((DMCanvasRef)handle);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "nativeDestroySurface: handle=%p", (void*)handle);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeResize(
        JNIEnv *env, jobject thiz, jlong handle, jint width, jint height) {
    if (handle != 0) {
        dm_canvas_resize((DMCanvasRef)handle, width, height);
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
            "nativeResize: handle=%p %dx%d", (void*)handle, width, height);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeSwapBuffers(
        JNIEnv *env, jobject thiz, jlong handle) {
    if (handle != 0) {
        dm_canvas_swap_buffers((DMCanvasRef)handle);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeBindCanvasToNode(
        JNIEnv *env, jobject thiz, jstring jNodeId, jlong handle) {
    const char *nodeIdChars = env->GetStringUTFChars(jNodeId, nullptr);
    if (!nodeIdChars) return;

    std::string nodeIdStr = nodeIdChars;
    env->ReleaseStringUTFChars(jNodeId, nodeIdChars);

    DMCanvasRef canvas = (DMCanvasRef)handle;
    setCanvasGLHandle(nodeIdStr.c_str(), canvas);

    // Mark GL as initialized (surface was already init'd by caller)
    auto it = canvasStates.find(nodeIdStr);
    if (it != canvasStates.end()) {
        it->second->glInitialized = true;
    }

    // Get instanceId to schedule JS evaluation
    int instanceId = -1;
    if (it != canvasStates.end() && it->second->instanceId > 0) {
        instanceId = it->second->instanceId;
    }

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "nativeBindCanvasToNode: nodeId=%s handle=%p instanceId=%d",
        nodeIdStr.c_str(), (void*)handle, instanceId);

    // Schedule _replayPendingOps on JS thread via canvas message type=6 (eval script)
    if (instanceId > 0) {
        std::string script = "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._replayPendingOps)"
                             "__GLCanvas._replayPendingOps('" + nodeIdStr + "')";
        callCanvasMessage(instanceId, 6, script);
    }
}

// ─── Image upload JNI (called from Java after download+decode) ───

extern "C" JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeUploadImage(
        JNIEnv *env, jobject thiz, jstring jNodeId, jstring jImageId,
        jbyteArray jRgba, jint width, jint height, jstring jCallbackId) {
    const char *nodeId = env->GetStringUTFChars(jNodeId, nullptr);
    const char *imageId = env->GetStringUTFChars(jImageId, nullptr);
    const char *callbackId = env->GetStringUTFChars(jCallbackId, nullptr);

    if (!nodeId || !imageId) {
        if (nodeId) env->ReleaseStringUTFChars(jNodeId, nodeId);
        if (imageId) env->ReleaseStringUTFChars(jImageId, imageId);
        if (callbackId) env->ReleaseStringUTFChars(jCallbackId, callbackId);
        return;
    }

    // Copy RGBA data
    jsize dataLen = env->GetArrayLength(jRgba);
    std::vector<unsigned char> rgbaData(dataLen);
    env->GetByteArrayRegion(jRgba, 0, dataLen, (jbyte*)rgbaData.data());

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
        "nativeUploadImage: nodeId=%s imageId=%s %dx%d dataLen=%d",
        nodeId, imageId, width, height, dataLen);

    // Store in CanvasState for JS thread to process
    auto it = canvasStates.find(nodeId);
    if (it != canvasStates.end()) {
        PendingImageUpload pending;
        pending.imageId = imageId;
        pending.width = width;
        pending.height = height;
        pending.onloadCallbackId = callbackId ? callbackId : "";
        pending.rgbaData = std::move(rgbaData);
        it->second->pendingImageUploads.push_back(std::move(pending));

        // Schedule _uploadPendingImages on JS thread via canvas message type=6
        int instanceId = it->second->instanceId;
        if (instanceId > 0) {
            std::string script = "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._uploadPendingImages)"
                                 "__GLCanvas._uploadPendingImages('" + std::string(nodeId) + "')";
            callCanvasMessage(instanceId, 6, script);
        }
    }

    env->ReleaseStringUTFChars(jNodeId, nodeId);
    env->ReleaseStringUTFChars(jImageId, imageId);
    if (callbackId) env->ReleaseStringUTFChars(jCallbackId, callbackId);
}

// ─── Cleanup ───

void cleanupCanvasBindings(int instanceId) {
    // Remove all CanvasState entries for this instanceId
    auto it = canvasStates.begin();
    while (it != canvasStates.end()) {
        if (it->second->instanceId == instanceId) {
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
