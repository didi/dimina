#include "canvas_bindings.h"
#include "js_engine.h"
#include "log.h"
#include "utils.h"
#include <map>
#include <string>
#include <mutex>
#include <future>
#include <vector>
#include <atomic>

#ifdef CANVAS2D_AVAILABLE
#include "dimina_canvas2d.h"
#include <native_window/external_window.h>
#endif

// ─── External access to engine map (defined in js_thread.cpp) ───
extern std::map<int, JSEngine *> engineMap;
extern JSEngine *getEngine(int appIndex);

// ─── Data structures ───

// Pending image upload — pixel data stored by main thread (canvasUploadImage),
// consumed by QuickJS thread (_uploadPendingImages).
struct PendingImageUpload {
    std::string imageId;
    std::vector<unsigned char> rgbaData;
    int width;
    int height;
    std::string onloadCallbackId;
};

struct CanvasState {
    std::string nodeId;
    int appIndex;
    JSContext *ctx;
    // Op queue — each entry is a JSON string for dm_canvas_execute_ops
    std::vector<std::string> opQueue;
    // GL direct rendering (NanoVG)
    // glCanvas & glInitialized are atomic because they are written on the main
    // thread (canvasBindSurface) and read on the QuickJS thread (canvas_render,
    // canvas_replay_pending).  Without atomics, ARM memory ordering can cause
    // the QuickJS thread to see stale values → first render fails.
#ifdef CANVAS2D_AVAILABLE
    std::atomic<DMCanvasRef> glCanvas{nullptr};
    std::atomic<OHNativeWindow *> nativeWindow{nullptr};
    std::atomic<int> surfaceWidth{0};
    std::atomic<int> surfaceHeight{0};
    std::atomic<bool> glInitialized{false};
    uint32_t bindGeneration = 0;  // incremented on each canvasBindSurface call
    std::string lastSurfaceId;   // dedup: skip rebind if same surfaceId
    std::vector<std::string> pendingOpsJson;  // buffered ops before GL is ready
    bool offscreen = false;      // true for createOffscreenCanvas canvases
    bool swapScheduled = false;  // deferred swap pending (setTimeout scheduled)
    std::atomic<bool> rebindPending{false};  // surface rebind needed (same surfaceId but underlying surface recreated)
    std::vector<PendingImageUpload> pendingImageUploads; // guarded by canvasStatesMutex
    // Op history — accumulated executed ops for replay on surface rebind (resize).
    // Cleared when JS sets canvas.width/height (setCanvasProperty), matching
    // Web Canvas spec where setting dimensions resets the canvas.
    std::vector<std::string> opHistory;
    bool opHistoryComplete = true;  // false if history exceeded cap and was truncated
    static constexpr size_t OP_HISTORY_MAX = 10000;
#endif
};

// Threadsafe function callback data
struct CanvasTsfnData {
    int type;              // 1 = async flush, 2 = getImageData, 3 = toDataURL
    std::string json;
    std::promise<std::string> *promise; // non-null for sync ops (type 2, 3)
};

// ─── Global state ───

static std::map<std::string, CanvasState *> canvasStates;      // nodeId → state
static std::mutex canvasStatesMutex;                            // protects canvasStates (accessed from main + QuickJS threads)
static std::map<int, napi_threadsafe_function> canvasTsfnMap;   // appIndex → main-thread tsfn
static std::map<JSContext *, int> ctxAppIndexMap;                // ctx → appIndex (set during registerGLCanvas)

#ifdef CANVAS2D_AVAILABLE
// Pending GL resource destruction — EGL resources must be freed on the same
// thread that created them (QuickJS thread).  Main-thread callers (unbind,
// cleanup) push old pointers here; the QuickJS thread drains it.
struct PendingGLDestroy {
    DMCanvasRef canvas;
    OHNativeWindow *nativeWindow;
};
static std::vector<PendingGLDestroy> pendingGLDestroys;        // guarded by glDestroyMutex
static std::mutex glDestroyMutex;                               // separate mutex for GL destroy queue

static void drainPendingGLDestroys() {
    std::vector<PendingGLDestroy> items;
    {
        std::lock_guard<std::mutex> lock(glDestroyMutex);
        items.swap(pendingGLDestroys);
    }
    for (auto &item : items) {
        if (item.canvas) {
            OHLog("[canvas] drainPendingGLDestroys: destroying glCanvas=%{public}p", (void*)item.canvas);
            dm_canvas_destroy(item.canvas);
        }
        if (item.nativeWindow) {
            OH_NativeWindow_DestroyNativeWindow(item.nativeWindow);
        }
    }
}

static void queueGLDestroy(DMCanvasRef canvas, OHNativeWindow *nw) {
    std::lock_guard<std::mutex> lock(glDestroyMutex);
    pendingGLDestroys.push_back({canvas, nw});
}
#endif

// ─── Helpers ───

static int findAppIndexForCtx(JSContext *ctx) {
    auto it = ctxAppIndexMap.find(ctx);
    if (it != ctxAppIndexMap.end()) {
        return it->second;
    }
    // Fallback: scan engineMap
    for (const auto &pair : engineMap) {
        if (pair.second->getContext() == ctx) {
            return pair.first;
        }
    }
    return -1;
}

static napi_threadsafe_function getCanvasTsfn(int appIndex) {
    auto it = canvasTsfnMap.find(appIndex);
    if (it != canvasTsfnMap.end()) {
        return it->second;
    }
    return nullptr;
}

// ─── JSON.stringify helper using QuickJS built-in ───

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

// ─── Deferred swap helper ───
// Schedules a requestAnimationFrame callback to call _render(nodeId).
// This aligns the swap with the display refresh cycle — all ops within one
// frame period accumulate in the FBO, then one swap presents everything.
// Falls back to setTimeout(fn, 16) if requestAnimationFrame is unavailable.
#ifdef CANVAS2D_AVAILABLE
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

    // Try requestAnimationFrame first (vsync-aligned)
    JSValue raf = JS_GetPropertyStr(ctx, global, "requestAnimationFrame");
    if (JS_IsFunction(ctx, raf)) {
        JSValue args[] = { fn };
        JSValue id = JS_Call(ctx, raf, global, 1, args);
        JS_FreeValue(ctx, id);
        OHLog("[canvas] schedule_deferred_swap: rAF scheduled for nodeId=%{public}s", state->nodeId.c_str());
    } else {
        // Fallback: setTimeout(fn, 16) (~60fps)
        JS_FreeValue(ctx, raf);
        JSValue setTimeout = JS_GetPropertyStr(ctx, global, "setTimeout");
        if (JS_IsFunction(ctx, setTimeout)) {
            JSValue delay = JS_NewInt32(ctx, 16);
            JSValue args[] = { fn, delay };
            JSValue id = JS_Call(ctx, setTimeout, global, 2, args);
            JS_FreeValue(ctx, id);
            JS_FreeValue(ctx, delay);
            OHLog("[canvas] schedule_deferred_swap: setTimeout(16) fallback for nodeId=%{public}s", state->nodeId.c_str());
        } else {
            OHError("[canvas] schedule_deferred_swap: no rAF or setTimeout for nodeId=%{public}s", state->nodeId.c_str());
            state->swapScheduled = false;
        }
        JS_FreeValue(ctx, setTimeout);
        raf = JS_UNDEFINED; // already freed
    }
    if (!JS_IsUndefined(raf)) {
        JS_FreeValue(ctx, raf);
    }

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
}
#endif

// _flush(nodeId) — kept as a no-op for JS compatibility.
static JSValue canvas_flush(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_UNDEFINED;
}

// ─── C functions registered on __GLCanvas ───

// _createCanvas(nodeId, width, height, isOffscreen)
static JSValue canvas_create(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_createCanvas: nodeId required");
    }

    int appIndex = findAppIndexForCtx(ctx);
    if (appIndex < 0) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowInternalError(ctx, "_createCanvas: no engine for context");
    }

    int32_t width = 300, height = 150;
    if (argc >= 2) JS_ToInt32(ctx, &width, argv[1]);
    if (argc >= 3) JS_ToInt32(ctx, &height, argv[2]);

    bool isOffscreen = false;
    if (argc >= 4) {
        isOffscreen = JS_ToBool(ctx, argv[3]);
    }

    // Check if a state already exists (from canvasBindSurface or a previous canvas_create)
    CanvasState *state;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto existingIt = canvasStates.find(nodeId);
        if (existingIt != canvasStates.end()) {
            // Reuse existing state — preserves GL resources from canvasBindSurface
            state = existingIt->second;
            if (state->ctx && state->ctx != ctx) {
                OHLog("[canvas] canvas_create: reusing state (ctx changed) for nodeId=%{public}s", nodeId);
            } else if (state->ctx == nullptr) {
                OHLog("[canvas] canvas_create: adopted pre-existing GL state for nodeId=%{public}s", nodeId);
            } else {
                OHLog("[canvas] canvas_create: reusing state (same ctx) for nodeId=%{public}s", nodeId);
            }
            state->appIndex = appIndex;
            state->ctx = ctx;
            state->opQueue.clear();
        } else {
            state = new CanvasState();
            state->nodeId = nodeId;
            state->appIndex = appIndex;
            state->ctx = ctx;
            canvasStates[nodeId] = state;
        }
    }

#ifdef CANVAS2D_AVAILABLE
    if (isOffscreen && !state->glCanvas.load()) {
        // Create offscreen GL canvas immediately — no canvasBindSurface needed
        DMCanvasRef glCanvas = dm_canvas_create(width, height);
        if (glCanvas) {
            int rc = dm_canvas_init_offscreen(glCanvas);
            if (rc == 0) {
                state->glCanvas.store(glCanvas);
                state->glInitialized.store(true);
                state->surfaceWidth.store(width);
                state->surfaceHeight.store(height);
                state->offscreen = true;
                OHLog("[canvas] canvas_create: offscreen GL canvas ready nodeId=%{public}s %{public}dx%{public}d",
                      nodeId, width, height);
            } else {
                dm_canvas_destroy(glCanvas);
                OHError("[canvas] canvas_create: offscreen GL init failed nodeId=%{public}s", nodeId);
            }
        }
    }

    OHLog("[canvas] canvas_create: nodeId=%{public}s appIndex=%{public}d glCanvas=%{public}p glInit=%{public}d nw=%{public}p pendingOps=%{public}zu offscreen=%{public}d",
          nodeId, appIndex, (void*)state->glCanvas.load(), state->glInitialized.load(),
          (void*)state->nativeWindow.load(), state->pendingOpsJson.size(), isOffscreen);
#else
    OHLog("[canvas] canvas_create: nodeId=%{public}s appIndex=%{public}d", nodeId, appIndex);
#endif
    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _destroyCanvas(nodeId)
static JSValue canvas_destroy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_UNDEFINED;
    }

    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            CanvasState *state = it->second;
#ifdef CANVAS2D_AVAILABLE
            DMCanvasRef gc = state->glCanvas.exchange(nullptr);
            if (gc) {
                dm_canvas_destroy(gc);
            }
            OHNativeWindow *nw = state->nativeWindow.exchange(nullptr);
            if (nw) {
                OH_NativeWindow_DestroyNativeWindow(nw);
            }
#endif
            delete state;
            canvasStates.erase(it);
            OHLog("[canvas] canvas_destroy: nodeId=%{public}s", nodeId);
        }
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// ─── imageSetSrc handler for GL path ───
// Loads image from local file on QuickJS thread and invokes JS onload/onerror callback.
// For network URLs, the op is buffered normally and forwarded via TSFN to ArkTS.
#ifdef CANVAS2D_AVAILABLE
static void invokeJSCallback(JSContext *ctx, const char *callbackId, const char *argsJson) {
    OHLog("[canvas] invokeJSCallback: callbackId=%{public}s args=%{public}s", callbackId, argsJson);
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
        OHError("[canvas] invokeJSCallback: JS exception: %{public}s", msg ? msg : "(null)");
        JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
    } else {
        const char *result = JS_ToCString(ctx, ret);
        OHLog("[canvas] invokeJSCallback: result=%{public}s", result ? result : "(null)");
        JS_FreeCString(ctx, result);
    }
    JS_FreeValue(ctx, ret);
}

static bool handleImageSetSrcGL(CanvasState *state, JSContext *ctx, JSValueConst opObj) {
    // Extract op type
    JSValue opTypeVal = JS_GetPropertyStr(ctx, opObj, "op");
    const char *opType = JS_ToCString(ctx, opTypeVal);
    bool isImageOp = opType && strcmp(opType, "imageSetSrc") == 0;
    JS_FreeCString(ctx, opType);
    JS_FreeValue(ctx, opTypeVal);
    if (!isImageOp) return false;

    DMCanvasRef glCanvas = state->glCanvas.load();
    if (!glCanvas) return false; // No GL canvas — let TSFN handle it

    // Forward ALL imageSetSrc to ArkTS via TSFN.
    // ArkTS handles path resolution (mini-app relative paths, sandbox paths),
    // network download, and image decoding. It then uploads RGBA pixels back
    // to the GL canvas via canvasUploadImage NAPI.
    JSValue imageIdVal = JS_GetPropertyStr(ctx, opObj, "imageId");
    JSValue srcVal = JS_GetPropertyStr(ctx, opObj, "src");
    JSValue onloadVal = JS_GetPropertyStr(ctx, opObj, "onload");
    JSValue onerrorVal = JS_GetPropertyStr(ctx, opObj, "onerror");

    const char *imageId = JS_ToCString(ctx, imageIdVal);
    const char *src = JS_ToCString(ctx, srcVal);
    const char *onload = JS_ToCString(ctx, onloadVal);
    const char *onerror = JS_ToCString(ctx, onerrorVal);

    OHLog("[canvas] handleImageSetSrcGL: forwarding to TSFN imageId=%{public}s src=%{public}s",
          imageId ? imageId : "null", src ? src : "null");

    if (src && imageId) {
        // Build a minimal JSON payload with just the imageSetSrc op
        // Use std::string to handle long URLs safely
        std::string json = "{\"nodeId\":\"" + state->nodeId + "\",\"operations\":[{\"op\":\"imageSetSrc\","
            "\"imageId\":\"" + std::string(imageId) + "\","
            "\"src\":\"" + std::string(src) + "\","
            "\"onload\":\"" + std::string(onload ? onload : "") + "\","
            "\"onerror\":\"" + std::string(onerror ? onerror : "") + "\"}]}";
        napi_threadsafe_function tsfn = getCanvasTsfn(state->appIndex);
        if (tsfn) {
            auto *data = new CanvasTsfnData();
            data->type = 1;
            data->json = json;
            data->promise = nullptr;
            napi_call_threadsafe_function(tsfn, data, napi_tsfn_nonblocking);
        }
    }

    if (imageId) JS_FreeCString(ctx, imageId);
    if (src) JS_FreeCString(ctx, src);
    if (onload) JS_FreeCString(ctx, onload);
    if (onerror) JS_FreeCString(ctx, onerror);
    JS_FreeValue(ctx, imageIdVal);
    JS_FreeValue(ctx, srcVal);
    JS_FreeValue(ctx, onloadVal);
    JS_FreeValue(ctx, onerrorVal);
    return true; // Consumed — forwarded to TSFN
}
#endif

// _bufferOp(nodeId, opObj) — push a draw operation to the op queue.
// Serializes the single op to JSON and pushes to state->opQueue.
// A rAF callback (_render) drains the queue and presents the frame.
static JSValue canvas_buffer_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_bufferOp: nodeId required");
    }

    CanvasState *state = nullptr;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            state = it->second;
        }
    }
    if (!state) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowReferenceError(ctx, "_bufferOp: unknown nodeId");
    }

#ifdef CANVAS2D_AVAILABLE
    // Intercept imageSetSrc for GL path — forward via TSFN to ArkTS
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
        DMCanvasRef glCanvas = state->glCanvas.load();
        if (glCanvas) {
            // Push to opQueue regardless of glInitialized — canvas_render
            // handles lazy GL init.  This avoids a race where glInitialized
            // changes (via canvasBindSurface on the main thread) between
            // consecutive _bufferOp calls, splitting ops between pendingOpsJson
            // and opQueue and causing out-of-order execution.
            state->opQueue.emplace_back(jsonStr);
            schedule_deferred_swap(state);
        } else {
            // No GL canvas yet — buffer for later replay
            state->pendingOpsJson.emplace_back(jsonStr);
        }
        JS_FreeCString(ctx, jsonStr);
    }
    JS_FreeValue(ctx, jsonVal);
#else
    // Non-GL path: serialize and buffer for TSFN flush
    JSValue wrapper = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, wrapper, "nodeId", JS_NewString(ctx, nodeId));
    JSValue opsArr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, opsArr, 0, JS_DupValue(ctx, argv[1]));
    JS_SetPropertyStr(ctx, wrapper, "operations", opsArr);

    JSValue jsonVal = js_json_stringify(ctx, wrapper);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);
    JS_FreeValue(ctx, wrapper);

    if (jsonStr) {
        napi_threadsafe_function tsfn = getCanvasTsfn(state->appIndex);
        if (tsfn) {
            auto *data = new CanvasTsfnData();
            data->type = 1;
            data->json = jsonStr;
            data->promise = nullptr;
            napi_status status = napi_call_threadsafe_function(tsfn, data, napi_tsfn_nonblocking);
            if (status != napi_ok) {
                OHError("[canvas] _bufferOp: TSFN call failed status=%{public}d", status);
                delete data;
            }
        }
        JS_FreeCString(ctx, jsonStr);
    }
    JS_FreeValue(ctx, jsonVal);
#endif

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _syncOp(nodeId, paramsObj) — synchronous canvas operation (getImageData, toDataURL, measureText)
static JSValue canvas_sync_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_syncOp: nodeId required");
    }

    CanvasState *state = nullptr;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            state = it->second;
        }
    }
    if (!state) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowReferenceError(ctx, "_syncOp: unknown nodeId");
    }

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

#ifdef CANVAS2D_AVAILABLE
    // Drain any GL resources queued for destruction by the main thread
    drainPendingGLDestroys();

    // GL direct rendering path for sync operations
    DMCanvasRef glCanvas = state->glCanvas.load();
    if (glCanvas && state->glInitialized.load()) {
        // Flush queued ops so the FBO reflects all prior draws
        if (!state->opQueue.empty()) {
            dm_canvas_begin_frame(glCanvas);
            for (const auto &op : state->opQueue) {
                dm_canvas_execute_ops(glCanvas, op.c_str(), op.size());
            }
            state->opQueue.clear();
            dm_canvas_end_frame(glCanvas);
        }
        // End any active NanoVG frame so all draw commands are flushed to the FBO
        // before we read pixels back. dm_canvas_end_frame is a no-op if no frame is active.
        dm_canvas_end_frame(glCanvas);

        char *result = nullptr;
        if (type == 2) {
            // getImageData — parse x, y, w, h from argv[1]
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
            result = dm_canvas_get_image_data(glCanvas, x, y, w, h);
        } else if (type == 3) {
            // toDataURL — parse mime, quality from argv[1]
            JSValue mv = JS_GetPropertyStr(ctx, argv[1], "mime");
            JSValue qv = JS_GetPropertyStr(ctx, argv[1], "quality");
            const char *mime = JS_ToCString(ctx, mv);
            double quality = 0.92;
            JS_ToFloat64(ctx, &quality, qv);
            result = dm_canvas_to_data_url(glCanvas, mime ? mime : "image/png", quality);
            if (mime) JS_FreeCString(ctx, mime);
            JS_FreeValue(ctx, mv); JS_FreeValue(ctx, qv);
        } else if (type == 4) {
            // measureText — parse text, font from argv[1]
            JSValue tv = JS_GetPropertyStr(ctx, argv[1], "text");
            JSValue fv = JS_GetPropertyStr(ctx, argv[1], "font");
            const char *text = JS_ToCString(ctx, tv);
            const char *font = JS_ToCString(ctx, fv);
            result = dm_canvas_measure_text(glCanvas, text ? text : "", font ? font : "");
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
                // getImageData / measureText return JSON
                jsResult = JS_ParseJSON(ctx, result, strlen(result), "<canvas_gl_sync>");
            }
            dm_canvas_free_string(result);
            return jsResult;
        }
        return JS_UNDEFINED;
    }
#endif

    // TSFN fallback path
    JSValue params = JS_DupValue(ctx, argv[1]);
    JS_SetPropertyStr(ctx, params, "nodeId", JS_NewString(ctx, nodeId));

    // JSON.stringify params
    JSValue jsonVal = js_json_stringify(ctx, params);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);
    JS_FreeValue(ctx, params);

    if (!jsonStr) {
        OHError("[canvas] canvas_sync_op: JSON.stringify failed");
        JS_FreeValue(ctx, jsonVal);
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }

    // Send via TSFN (blocking) and wait for result — fallback
    napi_threadsafe_function tsfn = getCanvasTsfn(state->appIndex);
    if (!tsfn) {
        OHError("[canvas] canvas_sync_op: no tsfn for appIndex=%{public}d", state->appIndex);
        JS_FreeCString(ctx, jsonStr);
        JS_FreeValue(ctx, jsonVal);
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }

    auto *promise = new std::promise<std::string>();
    auto future = promise->get_future();

    auto *data = new CanvasTsfnData();
    data->type = type;
    data->json = jsonStr;
    data->promise = promise;

    napi_status status = napi_call_threadsafe_function(tsfn, data, napi_tsfn_blocking);

    JS_FreeCString(ctx, jsonStr);
    JS_FreeValue(ctx, jsonVal);

    if (status != napi_ok) {
        OHError("[canvas] canvas_sync_op: napi_call_threadsafe_function failed status=%{public}d", status);
        delete promise;
        delete data;
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }

    // Wait for the main thread callback to return the result
    std::string resultJson;
    try {
        resultJson = future.get();
    } catch (const std::exception &e) {
        OHError("[canvas] canvas_sync_op: future error: %{public}s", e.what());
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }
    delete promise;

    OHLog("[canvas] canvas_sync_op: nodeId=%{public}s type=%{public}d resultLen=%{public}zu", nodeId, type, resultJson.size());
    JS_FreeCString(ctx, nodeId);

    // Parse the result JSON back to JSValue
    JSValue result = JS_ParseJSON(ctx, resultJson.c_str(), resultJson.size(), "<canvas_sync_result>");
    if (JS_IsException(result)) {
        OHError("[canvas] canvas_sync_op: JS_ParseJSON failed");
        return JS_EXCEPTION;
    }

    return result;
}

// _putImageData(nodeId, dataArray, dataW, dataH, dx, dy [, dirtyX, dirtyY, dirtyW, dirtyH])
// Direct pixel write — bypasses JSON serialization since pixel data is large.
static JSValue canvas_put_image_data(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 6) {
        return JS_ThrowTypeError(ctx, "_putImageData: requires at least 6 args");
    }
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_ThrowTypeError(ctx, "_putImageData: nodeId required");
    }

    CanvasState *state = nullptr;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            state = it->second;
        }
    }
    if (!state) {
        JS_FreeCString(ctx, nodeId);
        return JS_ThrowReferenceError(ctx, "_putImageData: unknown nodeId");
    }

#ifdef CANVAS2D_AVAILABLE
    drainPendingGLDestroys();
    DMCanvasRef glCanvas = state->glCanvas.load();
    if (glCanvas && state->glInitialized.load()) {
        // Flush queued ops first so putImageData goes on top
        if (!state->opQueue.empty()) {
            dm_canvas_begin_frame(glCanvas);
            for (const auto &op : state->opQueue) {
                dm_canvas_execute_ops(glCanvas, op.c_str(), op.size());
            }
            state->opQueue.clear();
            dm_canvas_end_frame(glCanvas);
        }
        // End any active frame — putImageData writes directly to the FBO via GL,
        // which requires the NanoVG frame to be finalized first.
        dm_canvas_end_frame(glCanvas);

        // Extract pixel data from Uint8ClampedArray / Uint8Array / ArrayBuffer
        size_t dataLen = 0;
        uint8_t *dataBuf = nullptr;
        dataBuf = JS_GetArrayBuffer(ctx, &dataLen, argv[1]);
        if (!dataBuf) {
            // Try typed array (Uint8ClampedArray.buffer)
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
            OHError("[canvas] _putImageData: failed to extract pixel data");
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

        OHLog("[canvas] _putImageData: nodeId=%{public}s %{public}dx%{public}d at (%{public}d,%{public}d) dirty=(%{public}d,%{public}d,%{public}d,%{public}d)",
              nodeId, dataW, dataH, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH);

        dm_canvas_put_image_data(glCanvas, dataBuf, dataW, dataH,
                                 dx, dy, dirtyX, dirtyY, dirtyW, dirtyH);

        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }
#endif

    // Fallback: no GL path — putImageData not supported via TSFN (would need large data transfer)
    OHError("[canvas] _putImageData: GL canvas not available for nodeId=%{public}s, putImageData not supported via TSFN", nodeId);
    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// ─── Main-thread TSFN callback ───

static void canvasOnMessageCb(napi_env env, napi_value js_cb, void *context, void *rawData) {
    if (!rawData) {
        OHError("[canvas] canvasOnMessageCb: rawData is null");
        return;
    }

    auto *data = static_cast<CanvasTsfnData *>(rawData);
    OHLog("[canvas] canvasOnMessageCb: type=%{public}d jsonLen=%{public}zu hasPromise=%{public}d",
          data->type, data->json.size(), data->promise ? 1 : 0);

    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);

    // Create args: callback(type, jsonString)
    napi_value typeVal, jsonVal;
    napi_create_int32(env, data->type, &typeVal);
    napi_create_string_utf8(env, data->json.c_str(), NAPI_AUTO_LENGTH, &jsonVal);

    napi_value args[2] = { typeVal, jsonVal };
    napi_value undefined, result;
    napi_get_undefined(env, &undefined);

    napi_status status = napi_call_function(env, undefined, js_cb, 2, args, &result);
    OHLog("[canvas] canvasOnMessageCb: napi_call_function status=%{public}d", status);

    if (status == napi_pending_exception) {
        napi_value exception;
        napi_get_and_clear_last_exception(env, &exception);
        OHError("[canvas] canvasOnMessageCb: JS exception during callback");
    }

    if (data->promise) {
        // Sync operation: read the return string and resolve the promise
        std::string resultStr;
        if (status == napi_ok && result) {
            napi_valuetype vtype;
            napi_typeof(env, result, &vtype);
            if (vtype == napi_string) {
                size_t len = 0;
                napi_get_value_string_utf8(env, result, nullptr, 0, &len);
                resultStr.resize(len);
                napi_get_value_string_utf8(env, result, &resultStr[0], len + 1, &len);
            }
        }
        data->promise->set_value(resultStr);
    }

    napi_close_handle_scope(env, scope);
    delete data;
}

// ─── NAPI export: RegisterCanvasTsfn ───

napi_value RegisterCanvasTsfn(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);

    napi_value workName;
    napi_create_string_utf8(env, "canvasOnMessage", NAPI_AUTO_LENGTH, &workName);

    napi_threadsafe_function tsfn;
    napi_create_threadsafe_function(
        env, args[1], nullptr, workName,
        0,   // max_queue_size (0 = unlimited)
        2,   // initial_thread_count (main thread + QuickJS pthread)
        nullptr, nullptr, nullptr,
        canvasOnMessageCb,
        &tsfn
    );

    canvasTsfnMap[appIndex] = tsfn;
    OHLog("[canvas] RegisterCanvasTsfn: appIndex=%{public}d tsfn=%{public}p", appIndex, (void *)tsfn);

    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

// _render(nodeId) — rAF callback: execute all queued ops in one frame, then swap.
// All _bufferOp calls within a tick push to opQueue; this function drains
// the queue in a single NanoVG frame and presents the result.
static JSValue canvas_render(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) return JS_UNDEFINED;

    CanvasState *state = nullptr;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            state = it->second;
        }
    }

#ifdef CANVAS2D_AVAILABLE
    // Drain any GL resources queued for destruction by the main thread
    drainPendingGLDestroys();

    if (state) {
        state->swapScheduled = false;
        DMCanvasRef glCanvas = state->glCanvas.load();
        bool glInit = state->glInitialized.load();
        OHNativeWindow *nw = state->nativeWindow.load();

        // Safety: detect stale glInit from a replaced canvas
        if (glCanvas && glInit && !dm_canvas_is_ready(glCanvas)) {
            OHLog("[canvas] canvas_render: glInit stale (canvas not ready), resetting for nodeId=%{public}s", nodeId);
            state->glInitialized.store(false);
            glInit = false;
        }

        if (!glCanvas || !glInit) {
            // Try lazy GL init if surface is available
            if (glCanvas && !glInit && nw) {
                int rc = dm_canvas_init_surface(glCanvas, nw);
                // Guard: only set glInitialized if the canvas hasn't been
                // replaced by a concurrent canvasBindSurface on the main thread.
                // Without this, a stale store(true) for canvas A can overwrite
                // the store(false) that was meant for canvas B.
                if (state->glCanvas.load() == glCanvas) {
                    state->glInitialized.store(rc == 0);
                    glInit = (rc == 0);
                } else {
                    OHLog("[canvas] canvas_render: canvas replaced during init, discarding for nodeId=%{public}s", nodeId);
                    glInit = false;
                    glCanvas = state->glCanvas.load(); // update local
                }
                OHLog("[canvas] canvas_render: lazy GL init nodeId=%{public}s rc=%{public}d glInit=%{public}d", nodeId, rc, glInit);
            }
            if (!glInit) {
                OHLog("[canvas] canvas_render: GL not ready for nodeId=%{public}s glCanvas=%{public}p nw=%{public}p opQueue=%{public}zu pendingOps=%{public}zu",
                      nodeId, (void*)glCanvas, (void*)nw, state->opQueue.size(), state->pendingOpsJson.size());
                // Reschedule so queued ops aren't stranded
                if (!state->opQueue.empty() || !state->pendingOpsJson.empty()) {
                    schedule_deferred_swap(state);
                }
                JS_FreeCString(ctx, nodeId);
                return JS_UNDEFINED;
            }
        }

        // Handle pending EGL surface rebind before rendering
        if (state->rebindPending.load()) {
            OHNativeWindow *rebindNw = state->nativeWindow.load();
            if (rebindNw) {
                int sw = state->surfaceWidth.load();
                int sh = state->surfaceHeight.load();
                if (sw > 0 && sh > 0) {
                    dm_canvas_set_surface_size(glCanvas, sw, sh);
                }
                int rc = dm_canvas_rebind_surface(glCanvas, rebindNw);
                state->rebindPending.store(false);
                if (rc == 0) {
                    OHLog("[canvas] canvas_render: EGL surface rebound OK for nodeId=%{public}s", nodeId);
                } else {
                    OHError("[canvas] canvas_render: EGL rebind FAILED for nodeId=%{public}s", nodeId);
                    state->glInitialized.store(false);
                    schedule_deferred_swap(state);
                    JS_FreeCString(ctx, nodeId);
                    return JS_UNDEFINED;
                }
            }
        }

        // Execute ALL queued ops in one frame
        if (!state->opQueue.empty()) {
            // Safety check: verify the GL canvas is fully usable.
            // The glInitialized flag may be stale if the canvas was re-bound
            // and the old one destroyed between the flag check and here.
            if (!dm_canvas_is_ready(glCanvas)) {
                OHError("[canvas] canvas_render: canvas not usable (glInit stale) nodeId=%{public}s — attempting re-init", nodeId);
                // Reset flag so next render attempt will trigger lazy GL init
                state->glInitialized.store(false);
                OHNativeWindow *nw2 = state->nativeWindow.load();
                if (nw2) {
                    int rc = dm_canvas_init_surface(glCanvas, nw2);
                    if (state->glCanvas.load() == glCanvas) {
                        state->glInitialized.store(rc == 0);
                    } else {
                        OHLog("[canvas] canvas_render: canvas replaced during re-init for nodeId=%{public}s", nodeId);
                        schedule_deferred_swap(state);
                        JS_FreeCString(ctx, nodeId);
                        return JS_UNDEFINED;
                    }
                    OHLog("[canvas] canvas_render: re-init nodeId=%{public}s rc=%{public}d", nodeId, rc);
                    if (rc != 0) {
                        schedule_deferred_swap(state);
                        JS_FreeCString(ctx, nodeId);
                        return JS_UNDEFINED;
                    }
                    // Re-init succeeded, fall through to execute ops
                } else {
                    schedule_deferred_swap(state);
                    JS_FreeCString(ctx, nodeId);
                    return JS_UNDEFINED;
                }
            }
            OHLog("[canvas] canvas_render: executing %{public}zu ops for nodeId=%{public}s",
                  state->opQueue.size(), nodeId);
            dm_canvas_begin_frame(glCanvas);
            for (const auto &op : state->opQueue) {
                dm_canvas_execute_ops(glCanvas, op.c_str(), op.size());

                // Record ops in history for replay on surface rebind.
                // NOTE: we do NOT clear opHistory on setCanvasProperty width/height.
                // The mini-app sets width and height separately (two ops), so clearing
                // on the first would lose it when the second clears again.
                // dm_canvas_reset_for_replay handles FBO clearing before replay,
                // and the setCanvasProperty ops in history will resize correctly.
                if (state->opHistoryComplete) {
                    if (state->opHistory.size() < CanvasState::OP_HISTORY_MAX) {
                        state->opHistory.push_back(op);
                    } else {
                        state->opHistoryComplete = false;
                        OHLog("[canvas] canvas_render: opHistory cap reached for nodeId=%{public}s, "
                              "stopping recording (content may be lost on resize)", nodeId);
                    }
                }
            }
            state->opQueue.clear();
            dm_canvas_end_frame(glCanvas);

            // Compose & present (skip for offscreen — no display to present to)
            if (!state->offscreen) {
                dm_canvas_swap_buffers(glCanvas);
            }
        }
    }
#endif

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _replayPendingOps(nodeId) — called on QuickJS thread to replay buffered ops after GL surface binds
static JSValue canvas_replay_pending(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) {
        return JS_UNDEFINED;
    }

    CanvasState *state = nullptr;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            state = it->second;
        }
    }
    if (!state) {
        JS_FreeCString(ctx, nodeId);
        return JS_UNDEFINED;
    }

#ifdef CANVAS2D_AVAILABLE
    DMCanvasRef glCanvas = state->glCanvas.load();
    bool glInit = state->glInitialized.load();
    OHNativeWindow *nw = state->nativeWindow.load();
    // Drain any GL resources queued for destruction by the main thread
    drainPendingGLDestroys();

    OHLog("[canvas] canvas_replay_pending: nodeId=%{public}s glCanvas=%{public}p glInit=%{public}d nw=%{public}p pendingCount=%{public}zu ctx=%{public}p",
          nodeId, (void*)glCanvas, glInit, (void*)nw, state->pendingOpsJson.size(), (void*)state->ctx);

    // Safety: if glInit claims true but the canvas isn't actually usable
    // (vg=nil), the flag is stale from a previous canvas that was replaced
    // by a concurrent canvasBindSurface.  Reset and re-init.
    if (glCanvas && glInit && !dm_canvas_is_ready(glCanvas)) {
        OHLog("[canvas] canvas_replay_pending: glInit stale (canvas not ready), resetting for nodeId=%{public}s", nodeId);
        state->glInitialized.store(false);
        glInit = false;
    }

    if (glCanvas && !glInit && nw) {
        OHLog("[canvas] canvas_replay_pending: attempting GL init for nodeId=%{public}s", nodeId);
        int rc = dm_canvas_init_surface(glCanvas, nw);
        // Guard: only set glInitialized if the canvas hasn't been replaced
        // by a concurrent canvasBindSurface on the main thread.
        if (state->glCanvas.load() == glCanvas) {
            glInit = (rc == 0);
            state->glInitialized.store(glInit);
        } else {
            OHLog("[canvas] canvas_replay_pending: canvas replaced during init, discarding for nodeId=%{public}s", nodeId);
            glInit = false;
            glCanvas = state->glCanvas.load();
            nw = state->nativeWindow.load();
        }
        OHLog("[canvas] canvas_replay_pending: GL init nodeId=%{public}s rc=%{public}d glInit=%{public}d", nodeId, rc, glInit);
    } else if (!glCanvas) {
        OHLog("[canvas] canvas_replay_pending: SKIP — no glCanvas for nodeId=%{public}s", nodeId);
    } else if (!nw) {
        OHLog("[canvas] canvas_replay_pending: SKIP — no nativeWindow for nodeId=%{public}s", nodeId);
    }

    // Handle EGL surface rebind: same surfaceId but underlying XComponent
    // surface was recreated by HarmonyOS during rebuild().  The NanoVG context
    // and FBO are preserved — we just need a new EGL surface to present to.
    bool didRebind = false;
    if (glCanvas && glInit && state->rebindPending.load()) {
        nw = state->nativeWindow.load(); // re-read — may have been swapped
        if (nw) {
            // Update surface dimensions on the DMCanvas before rebind
            int sw = state->surfaceWidth.load();
            int sh = state->surfaceHeight.load();
            if (sw > 0 && sh > 0) {
                dm_canvas_set_surface_size(glCanvas, sw, sh);
            }
            int rc = dm_canvas_rebind_surface(glCanvas, nw);
            state->rebindPending.store(false);
            if (rc == 0) {
                didRebind = true;
                OHLog("[canvas] canvas_replay_pending: EGL surface rebound OK for nodeId=%{public}s — presenting existing FBO", nodeId);
                // Present existing FBO content on the new surface
                dm_canvas_swap_buffers(glCanvas);
            } else {
                OHError("[canvas] canvas_replay_pending: EGL rebind FAILED for nodeId=%{public}s — marking GL as uninitialized", nodeId);
                state->glInitialized.store(false);
                glInit = false;
            }
        }
    }

    // Replay op history on the new canvas to restore previous content.
    // This handles the case where a full rebind (different surfaceId)
    // destroyed the old GL canvas — the rendered content is re-created
    // by replaying all recorded ops.
    // NOTE: for same-surfaceId rebind (didRebind path above), the FBO
    // is preserved so opHistory replay is NOT needed — swap_buffers suffices.
    if (glInit && !didRebind && !state->opHistory.empty() && state->opHistoryComplete) {
        OHLog("[canvas] canvas_replay_pending: replaying %{public}zu opHistory entries for nodeId=%{public}s",
              state->opHistory.size(), nodeId);
        dm_canvas_reset_for_replay(glCanvas);
        dm_canvas_begin_frame(glCanvas);
        for (const auto &op : state->opHistory) {
            dm_canvas_execute_ops(glCanvas, op.c_str(), op.size());
        }
        dm_canvas_end_frame(glCanvas);
        dm_canvas_swap_buffers(glCanvas);
        OHLog("[canvas] canvas_replay_pending: opHistory replay complete for nodeId=%{public}s", nodeId);
    } else if (glInit && !didRebind && !state->opHistory.empty() && !state->opHistoryComplete) {
        OHLog("[canvas] canvas_replay_pending: opHistory truncated, skipping replay for nodeId=%{public}s "
              "(content may be incomplete)", nodeId);
    }

    if (glInit && !state->pendingOpsJson.empty()) {
        OHLog("[canvas] canvas_replay_pending: moving %{public}zu pending ops to opQueue for nodeId=%{public}s",
              state->pendingOpsJson.size(), nodeId);
        // Insert pending ops at the FRONT of opQueue so they execute before
        // any ops that may have been pushed directly to opQueue (e.g. if
        // glCanvas was set but glInitialized was still false when _bufferOp ran).
        state->opQueue.insert(state->opQueue.begin(),
            std::make_move_iterator(state->pendingOpsJson.begin()),
            std::make_move_iterator(state->pendingOpsJson.end()));
        state->pendingOpsJson.clear();
        schedule_deferred_swap(state);
        OHLog("[canvas] canvas_replay_pending: scheduled render for nodeId=%{public}s", nodeId);
    } else if (glInit) {
        OHLog("[canvas] canvas_replay_pending: GL ready but no pending ops for nodeId=%{public}s", nodeId);
    }

    // After GL init succeeds, also process any pending image uploads that were
    // requeued because GL wasn't ready when they first arrived
    if (glInit) {
        bool hasPendingImages = false;
        {
            std::lock_guard<std::mutex> lock(canvasStatesMutex);
            hasPendingImages = !state->pendingImageUploads.empty();
        }
        if (hasPendingImages) {
            OHLog("[canvas] canvas_replay_pending: processing pending image uploads for nodeId=%{public}s", nodeId);
            // Call _uploadPendingImages inline (we're already on QuickJS thread)
            JSValue global = JS_GetGlobalObject(ctx);
            std::string uploadScript = "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._uploadPendingImages)"
                                       "__GLCanvas._uploadPendingImages('" + std::string(nodeId) + "')";
            JSValue result = JS_Eval(ctx, uploadScript.c_str(), uploadScript.size(), "<upload>", JS_EVAL_TYPE_GLOBAL);
            JS_FreeValue(ctx, result);
            JS_FreeValue(ctx, global);
        }
    }

    if (!glInit) {
        OHLog("[canvas] canvas_replay_pending: cannot replay — GL not ready for nodeId=%{public}s (pendingCount=%{public}zu)",
              nodeId, state->pendingOpsJson.size());
    }
#endif

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _uploadPendingImages(nodeId) — process queued network image uploads on QuickJS/GL thread
static JSValue canvas_upload_pending_images(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *nodeId = JS_ToCString(ctx, argv[0]);
    if (!nodeId) return JS_UNDEFINED;

#ifdef CANVAS2D_AVAILABLE
    CanvasState *state = nullptr;
    std::vector<PendingImageUpload> uploads;
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            state = it->second;
            uploads = std::move(state->pendingImageUploads);
            state->pendingImageUploads.clear();
        }
    }

    if (state && !uploads.empty()) {
        DMCanvasRef glCanvas = state->glCanvas.load();
        bool glInit = state->glInitialized.load();
        OHNativeWindow *nw = state->nativeWindow.load();
        OHLog("[canvas] canvas_upload_pending_images: nodeId=%{public}s count=%{public}zu glCanvas=%{public}p glInit=%{public}d",
              nodeId, uploads.size(), (void*)glCanvas, glInit);

        // Attempt lazy GL init if surface is bound but not yet initialized
        if (glCanvas && !glInit && nw) {
            int rc = dm_canvas_init_surface(glCanvas, nw);
            if (state->glCanvas.load() == glCanvas) {
                state->glInitialized.store(rc == 0);
                glInit = (rc == 0);
            } else {
                OHLog("[canvas] canvas_upload_pending_images: canvas replaced during init for nodeId=%{public}s", nodeId);
                glInit = false;
            }
            OHLog("[canvas] canvas_upload_pending_images: lazy GL init nodeId=%{public}s rc=%{public}d", nodeId, rc);
        }

        std::vector<PendingImageUpload> retryUploads;
        for (auto &img : uploads) {
            if (glCanvas && glInit) {
                int rc = dm_canvas_load_image_rgba(glCanvas, img.imageId.c_str(),
                                                   img.width, img.height, img.rgbaData.data());
                if (rc == 0 && !img.onloadCallbackId.empty()) {
                    char loadJson[128];
                    snprintf(loadJson, sizeof(loadJson), "{\"width\":%d,\"height\":%d}", img.width, img.height);
                    invokeJSCallback(ctx, img.onloadCallbackId.c_str(), loadJson);
                    OHLog("[canvas] canvas_upload_pending_images: uploaded imageId=%{public}s %{public}dx%{public}d",
                          img.imageId.c_str(), img.width, img.height);
                } else if (rc != 0) {
                    OHError("[canvas] canvas_upload_pending_images: upload failed imageId=%{public}s", img.imageId.c_str());
                }
            } else {
                // GL not ready — put back for retry instead of dropping
                OHLog("[canvas] canvas_upload_pending_images: GL not ready, requeueing imageId=%{public}s for retry", img.imageId.c_str());
                retryUploads.push_back(std::move(img));
            }
        }

        // Put un-uploaded images back into the queue for later processing
        if (!retryUploads.empty()) {
            std::lock_guard<std::mutex> lock(canvasStatesMutex);
            state->pendingImageUploads.insert(state->pendingImageUploads.begin(),
                std::make_move_iterator(retryUploads.begin()),
                std::make_move_iterator(retryUploads.end()));
            OHLog("[canvas] canvas_upload_pending_images: requeued %{public}zu images for nodeId=%{public}s",
                  retryUploads.size(), nodeId);
        }
    }
#endif

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// ─── Register __GLCanvas on JSContext ───

void registerGLCanvas(JSContext *ctx) {
    int appIndex = -1;
    for (const auto &pair : engineMap) {
        if (pair.second->getContext() == ctx) {
            appIndex = pair.first;
            break;
        }
    }

    // Cache ctx → appIndex mapping
    if (appIndex >= 0) {
        ctxAppIndexMap[ctx] = appIndex;
    }

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue glCanvasObj = JS_NewObject(ctx);

    // Mark as available
    JS_SetPropertyStr(ctx, glCanvasObj, "available", JS_TRUE);

    // Store appIndex for reference
    JS_SetPropertyStr(ctx, glCanvasObj, "_appIndex", JS_NewInt32(ctx, appIndex));

    // Register C functions
    JS_SetPropertyStr(ctx, glCanvasObj, "_createCanvas",
        JS_NewCFunction(ctx, canvas_create, "_createCanvas", 4));
    JS_SetPropertyStr(ctx, glCanvasObj, "_destroyCanvas",
        JS_NewCFunction(ctx, canvas_destroy, "_destroyCanvas", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_bufferOp",
        JS_NewCFunction(ctx, canvas_buffer_op, "_bufferOp", 2));
    JS_SetPropertyStr(ctx, glCanvasObj, "_flush",
        JS_NewCFunction(ctx, canvas_flush, "_flush", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_syncOp",
        JS_NewCFunction(ctx, canvas_sync_op, "_syncOp", 2));
    JS_SetPropertyStr(ctx, glCanvasObj, "_replayPendingOps",
        JS_NewCFunction(ctx, canvas_replay_pending, "_replayPendingOps", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_render",
        JS_NewCFunction(ctx, canvas_render, "_render", 1));
    // Keep _deferredSwap as alias for compatibility
    JS_SetPropertyStr(ctx, glCanvasObj, "_deferredSwap",
        JS_NewCFunction(ctx, canvas_render, "_deferredSwap", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_uploadPendingImages",
        JS_NewCFunction(ctx, canvas_upload_pending_images, "_uploadPendingImages", 1));
    JS_SetPropertyStr(ctx, glCanvasObj, "_putImageData",
        JS_NewCFunction(ctx, canvas_put_image_data, "_putImageData", 10));

    JS_SetPropertyStr(ctx, global, "__GLCanvas", glCanvasObj);
    JS_FreeValue(ctx, global);

    OHLog("[canvas] registerGLCanvas: done appIndex=%{public}d available=true", appIndex);
}

// ─── Cleanup ───

void cleanupCanvasBindings(int appIndex) {
    // Remove all CanvasState entries for this appIndex
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.begin();
        while (it != canvasStates.end()) {
            if (it->second->appIndex == appIndex) {
                CanvasState *state = it->second;
#ifdef CANVAS2D_AVAILABLE
                // Defer GL destruction to the QuickJS thread (EGL context is thread-local).
                // During shutdown the drain may not execute, but OS cleans up on process exit.
                DMCanvasRef gc = state->glCanvas.exchange(nullptr);
                OHNativeWindow *nw = state->nativeWindow.exchange(nullptr);
                if (gc || nw) {
                    queueGLDestroy(gc, nw);
                }
#endif
                delete state;
                it = canvasStates.erase(it);
            } else {
                ++it;
            }
        }
    }

#ifdef CANVAS2D_AVAILABLE
    // Try to schedule GL drain on the QuickJS thread before engine shutdown.
    // If the engine is already shutting down, the resources will be cleaned up
    // by OS process exit — still safer than crashing with a cross-thread EGL call.
    JSEngine *engine = getEngine(appIndex);
    if (engine) {
        engine->executeJavaScript("if(typeof __GLCanvas!=='undefined'&&__GLCanvas._render)__GLCanvas._render('')");
    }
#endif

    // Remove ctx → appIndex mappings
    auto ctxIt = ctxAppIndexMap.begin();
    while (ctxIt != ctxAppIndexMap.end()) {
        if (ctxIt->second == appIndex) {
            ctxIt = ctxAppIndexMap.erase(ctxIt);
        } else {
            ++ctxIt;
        }
    }

    // Release canvas TSFN
    auto tsfnIt = canvasTsfnMap.find(appIndex);
    if (tsfnIt != canvasTsfnMap.end()) {
        napi_release_threadsafe_function(tsfnIt->second, napi_tsfn_release);
        canvasTsfnMap.erase(tsfnIt);
        OHLog("[canvas] cleanupCanvasBindings: released tsfn for appIndex=%{public}d", appIndex);
    }

    OHLog("[canvas] cleanupCanvasBindings: done for appIndex=%{public}d", appIndex);
}

// ─── GL surface binding ───

napi_value canvasBindSurface(napi_env env, napi_callback_info info) {
    size_t argc = 6;
    napi_value args[6];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);

    size_t len = 0;
    napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
    std::string nodeId(len, '\0');
    napi_get_value_string_utf8(env, args[1], &nodeId[0], len + 1, &len);

    // args[2] = surfaceId (string), args[3] = width (px), args[4] = height (px), args[5] = dpr
    size_t sidLen = 0;
    napi_get_value_string_utf8(env, args[2], nullptr, 0, &sidLen);
    std::string surfaceIdStr(sidLen, '\0');
    napi_get_value_string_utf8(env, args[2], &surfaceIdStr[0], sidLen + 1, &sidLen);

    int width = 0, height = 0;
    napi_get_value_int32(env, args[3], &width);
    napi_get_value_int32(env, args[4], &height);

    double dpr = 1.0;
    if (argc >= 6) {
        napi_get_value_double(env, args[5], &dpr);
    }

    uint32_t gen = 0;

#ifdef CANVAS2D_AVAILABLE
    // Convert surfaceId string to uint64_t and obtain OHNativeWindow
    uint64_t surfaceId = strtoull(surfaceIdStr.c_str(), nullptr, 10);
    OHNativeWindow *nativeWindow = nullptr;
    int ret = OH_NativeWindow_CreateNativeWindowFromSurfaceId(surfaceId, &nativeWindow);
    if (ret != 0 || !nativeWindow) {
        OHError("[canvas] canvasBindSurface: OH_NativeWindow_CreateNativeWindowFromSurfaceId failed ret=%{public}d surfaceId=%{public}s",
                ret, surfaceIdStr.c_str());
        napi_value result;
        napi_create_int32(env, -1, &result);
        return result;
    }

    // Create DMCanvas at physical pixel dimensions (EGL init deferred to QuickJS thread)
    DMCanvasRef glCanvas = dm_canvas_create(width, height);
    if (!glCanvas) {
        OHError("[canvas] canvasBindSurface: dm_canvas_create failed width=%{public}d height=%{public}d", width, height);
        OH_NativeWindow_DestroyNativeWindow(nativeWindow);
        napi_value result;
        napi_create_int32(env, -1, &result);
        return result;
    }
    // DPR stays at 1.0 — the mini-app JS handles retina scaling by setting
    // canvas.width/height to physical pixels (logicalW * dpr).  NanoVG's
    // coordinate space must match the pixel buffer 1:1, just like HTML Canvas.
    // The DPR from the embed is only used by ArkTS to size the XComponent /
    // EGL surface in physical pixels.
    (void)dpr; // received but intentionally unused for NanoVG

    // Find the CanvasState and attach GL resources
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            CanvasState *state = it->second;

            // Dedup: if the same surfaceId is already bound and GL is alive,
            // don't destroy the NanoVG context or FBO — just rebind the EGL
            // surface.  HarmonyOS recreates the underlying XComponent surface
            // on rebuild() even when the surfaceId string stays the same, so
            // the old EGL surface becomes stale.  We must create a new EGL
            // surface from the new OHNativeWindow while preserving everything
            // else (NanoVG context, FBO, gradient/image state, op history).
            if (state->lastSurfaceId == surfaceIdStr &&
                state->glCanvas.load() != nullptr) {
                // Increment gen so the OLD component's unbind (with old gen)
                // becomes stale and won't accidentally destroy the live canvas.
                state->bindGeneration++;
                gen = state->bindGeneration;
                // Destroy the newly created (unused) DMCanvas — we keep the existing one
                dm_canvas_destroy(glCanvas);
                // Swap nativeWindow: store new one, destroy old wrapper
                OHNativeWindow *oldNw = state->nativeWindow.exchange(nativeWindow);
                if (oldNw) {
                    OH_NativeWindow_DestroyNativeWindow(oldNw);
                }
                // Update surface dimensions in case XComponent size changed
                state->surfaceWidth.store(width);
                state->surfaceHeight.store(height);
                // Schedule EGL surface rebind on QuickJS thread
                state->rebindPending.store(true);
                OHLog("[canvas] canvasBindSurface: REBIND scheduled nodeId=%{public}s surfaceId=%{public}s gen=%{public}u size=%{public}dx%{public}d",
                      nodeId.c_str(), surfaceIdStr.c_str(), gen, width, height);
                // Don't return here — fall through to schedule replay below
            } else {
                // Different surfaceId or no existing GL canvas — full bind
                // Detach old GL resources if re-binding (e.g. duplicate embed CREATE)
                // Defer destruction to QuickJS thread (EGL context is thread-local)
                DMCanvasRef oldGc = state->glCanvas.exchange(nullptr);
                OHNativeWindow *oldNw = state->nativeWindow.exchange(nullptr);
                if (oldGc || oldNw) {
                    OHLog("[canvas] canvasBindSurface: queuing old GL destroy for nodeId=%{public}s (rebind)", nodeId.c_str());
                    queueGLDestroy(oldGc, oldNw);
                }
                state->glInitialized.store(false);
                state->surfaceWidth.store(width);
                state->surfaceHeight.store(height);
                state->lastSurfaceId = surfaceIdStr;
                state->rebindPending.store(false);
                // Store glCanvas LAST with release semantics so QuickJS thread
                // sees all preceding writes when it loads glCanvas with acquire
                state->glCanvas.store(glCanvas);
                state->nativeWindow.store(nativeWindow);
                state->bindGeneration++;
                gen = state->bindGeneration;
                OHLog("[canvas] canvasBindSurface: bound GL surface nodeId=%{public}s width=%{public}d height=%{public}d surfaceId=%{public}s gen=%{public}u ctx=%{public}p pendingOps=%{public}zu",
                      nodeId.c_str(), width, height, surfaceIdStr.c_str(), gen,
                      (void*)state->ctx, state->pendingOpsJson.size());
            }
        } else {
            OHLog("[canvas] canvasBindSurface: CanvasState not yet created for nodeId=%{public}s, storing GL resources for later",
                  nodeId.c_str());
            auto *newState = new CanvasState();
            newState->nodeId = nodeId;
            newState->appIndex = appIndex;
            newState->ctx = nullptr;
            newState->glInitialized.store(false);
            newState->surfaceWidth.store(width);
            newState->surfaceHeight.store(height);
            newState->glCanvas.store(glCanvas);
            newState->nativeWindow.store(nativeWindow);
            newState->lastSurfaceId = surfaceIdStr;
            newState->bindGeneration = 1;
            gen = 1;
            canvasStates[nodeId] = newState;
        }
    }

    // Schedule replay of pending ops on the QuickJS thread
    JSEngine *engine = getEngine(appIndex);
    if (engine) {
        std::string replayScript = "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._replayPendingOps)__GLCanvas._replayPendingOps('" + nodeId + "')";
        engine->executeJavaScript(replayScript);
        OHLog("[canvas] canvasBindSurface: scheduled replay for nodeId=%{public}s on QuickJS thread", nodeId.c_str());
    }
#else
    OHLog("[canvas] canvasBindSurface: CANVAS2D not available, appIndex=%{public}d nodeId=%{public}s", appIndex, nodeId.c_str());
#endif

    // Return bind generation (callers pass it back to canvasUnbindSurface for ownership check)
    napi_value result;
    napi_create_uint32(env, gen, &result);
    return result;
}

napi_value canvasUnbindSurface(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);

    size_t len = 0;
    napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
    std::string nodeId(len, '\0');
    napi_get_value_string_utf8(env, args[1], &nodeId[0], len + 1, &len);

    // 3rd arg: bind generation (returned by canvasBindSurface)
    uint32_t unbindGen = 0;
    if (argc >= 3) {
        napi_get_value_uint32(env, args[2], &unbindGen);
    }

#ifdef CANVAS2D_AVAILABLE
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            CanvasState *state = it->second;
            // Only destroy if this caller owns the current binding
            if (unbindGen > 0 && state->bindGeneration != unbindGen) {
                OHLog("[canvas] canvasUnbindSurface: skipped stale unbind nodeId=%{public}s callerGen=%{public}u currentGen=%{public}u",
                      nodeId.c_str(), unbindGen, state->bindGeneration);
            } else {
                // Atomically detach GL resources — prevents QuickJS thread from using them
                DMCanvasRef gc = state->glCanvas.exchange(nullptr);
                OHNativeWindow *nw = state->nativeWindow.exchange(nullptr);
                state->surfaceWidth.store(0);
                state->surfaceHeight.store(0);
                state->glInitialized.store(false);
                state->rebindPending.store(false);
                state->swapScheduled = false;
                // Defer actual destruction to the QuickJS thread (EGL context is thread-local)
                if (gc || nw) {
                    queueGLDestroy(gc, nw);
                    OHLog("[canvas] canvasUnbindSurface: queued GL destroy nodeId=%{public}s gen=%{public}u", nodeId.c_str(), unbindGen);
                    // Schedule QuickJS thread to drain the destroy queue
                    JSEngine *engine = getEngine(appIndex);
                    if (engine) {
                        engine->executeJavaScript("if(typeof __GLCanvas!=='undefined'&&__GLCanvas._render)__GLCanvas._render('')");
                    }
                }
            }
        }
    }
#endif

    OHLog("[canvas] canvasUnbindSurface: appIndex=%{public}d nodeId=%{public}s gen=%{public}u", appIndex, nodeId.c_str(), unbindGen);

    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

// canvasResizeSurface(appIndex, nodeId, width, height)
// Called from ArkTS main thread when XComponent size changes without a surface rebind.
// Updates CanvasState::surfaceWidth/Height; the QuickJS thread applies to DMCanvas
// on next canvas_render before swap_buffers.
napi_value canvasResizeSurface(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);

    size_t len = 0;
    napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
    std::string nodeId(len, '\0');
    napi_get_value_string_utf8(env, args[1], &nodeId[0], len + 1, &len);

    int width = 0, height = 0;
    napi_get_value_int32(env, args[2], &width);
    napi_get_value_int32(env, args[3], &height);

#ifdef CANVAS2D_AVAILABLE
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            CanvasState *state = it->second;
            state->surfaceWidth.store(width);
            state->surfaceHeight.store(height);
            OHLog("[canvas] canvasResizeSurface: nodeId=%{public}s %{public}dx%{public}d",
                  nodeId.c_str(), width, height);
        }
    }
#endif

    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

// canvasUploadImage(appIndex, nodeId, imageId, pixelBuffer, width, height, onloadCallbackId)
// Called from ArkTS main thread after downloading and decoding a network image.
// Stores RGBA pixel data in CanvasState, then schedules QuickJS thread to upload to GPU.
napi_value canvasUploadImage(napi_env env, napi_callback_info info) {
    size_t argc = 7;
    napi_value args[7];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    int appIndex;
    napi_get_value_int32(env, args[0], &appIndex);

    size_t len = 0;
    napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
    std::string nodeId(len, '\0');
    napi_get_value_string_utf8(env, args[1], &nodeId[0], len + 1, &len);

    size_t imgIdLen = 0;
    napi_get_value_string_utf8(env, args[2], nullptr, 0, &imgIdLen);
    std::string imageId(imgIdLen, '\0');
    napi_get_value_string_utf8(env, args[2], &imageId[0], imgIdLen + 1, &imgIdLen);

    // args[3] = ArrayBuffer with RGBA pixel data
    void *pixelData = nullptr;
    size_t pixelDataLen = 0;
    napi_get_arraybuffer_info(env, args[3], &pixelData, &pixelDataLen);

    int imgW = 0, imgH = 0;
    napi_get_value_int32(env, args[4], &imgW);
    napi_get_value_int32(env, args[5], &imgH);

    size_t cbLen = 0;
    napi_get_value_string_utf8(env, args[6], nullptr, 0, &cbLen);
    std::string onloadCbId(cbLen, '\0');
    napi_get_value_string_utf8(env, args[6], &onloadCbId[0], cbLen + 1, &cbLen);

    OHLog("[canvas] canvasUploadImage: nodeId=%{public}s imageId=%{public}s %{public}dx%{public}d dataLen=%{public}zu onloadCbId=%{public}s",
          nodeId.c_str(), imageId.c_str(), imgW, imgH, pixelDataLen, onloadCbId.c_str());

#ifdef CANVAS2D_AVAILABLE
    // Store pixel data in CanvasState for QuickJS thread to process
    {
        std::lock_guard<std::mutex> lock(canvasStatesMutex);
        auto it = canvasStates.find(nodeId);
        if (it != canvasStates.end()) {
            PendingImageUpload pending;
            pending.imageId = imageId;
            pending.width = imgW;
            pending.height = imgH;
            pending.onloadCallbackId = onloadCbId;
            pending.rgbaData.resize(pixelDataLen);
            memcpy(pending.rgbaData.data(), pixelData, pixelDataLen);
            it->second->pendingImageUploads.push_back(std::move(pending));
        }
    }

    // Schedule processing on QuickJS thread
    JSEngine *engine = getEngine(appIndex);
    if (engine) {
        std::string script = "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._uploadPendingImages)"
                             "__GLCanvas._uploadPendingImages('" + nodeId + "')";
        engine->executeJavaScript(script);
        OHLog("[canvas] canvasUploadImage: scheduled _uploadPendingImages for nodeId=%{public}s", nodeId.c_str());
    }
#endif

    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}
