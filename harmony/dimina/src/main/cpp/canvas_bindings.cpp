#include "canvas_bindings.h"
#include "js_engine.h"
#include "log.h"
#include "utils.h"
#include <map>
#include <string>
#include <mutex>
#include <future>
#include <vector>

// ─── External access to engine map (defined in js_thread.cpp) ───
extern std::map<int, JSEngine *> engineMap;
extern JSEngine *getEngine(int appIndex);

// ─── Data structures ───

struct CanvasState {
    std::string nodeId;
    int appIndex;
    JSContext *ctx;
    JSValue opsArray;      // JS Array, caches operation objects
    int opsCount;
};

// Threadsafe function callback data
struct CanvasTsfnData {
    int type;              // 1 = async flush, 2 = getImageData, 3 = toDataURL
    std::string json;
    std::promise<std::string> *promise; // non-null for sync ops (type 2, 3)
};

// ─── Global state ───

static std::map<std::string, CanvasState *> canvasStates;      // nodeId → state
static std::map<int, napi_threadsafe_function> canvasTsfnMap;   // appIndex → main-thread tsfn
static std::map<JSContext *, int> ctxAppIndexMap;                // ctx → appIndex (set during registerSkiaCanvas)

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

// ─── Flush helper: serialize pending ops and send via TSFN ───

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
    JSValue jsonVal = js_json_stringify(ctx, payload);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);

    // Reset state — create new empty array for next batch
    state->opsArray = JS_NewArray(ctx);
    state->opsCount = 0;

    JS_FreeValue(ctx, payload);

    if (!jsonStr) {
        OHError("canvas_flush_state: JSON.stringify failed for nodeId=%{public}s", state->nodeId.c_str());
        JS_FreeValue(ctx, jsonVal);
        return;
    }

    // Send via TSFN (nonblocking)
    napi_threadsafe_function tsfn = getCanvasTsfn(state->appIndex);
    if (!tsfn) {
        OHError("canvas_flush_state: no tsfn for appIndex=%{public}d", state->appIndex);
        JS_FreeCString(ctx, jsonStr);
        JS_FreeValue(ctx, jsonVal);
        return;
    }

    auto *data = new CanvasTsfnData();
    data->type = 1;
    data->json = jsonStr;
    data->promise = nullptr;

    napi_status status = napi_call_threadsafe_function(tsfn, data, napi_tsfn_nonblocking);
    if (status != napi_ok) {
        OHError("canvas_flush_state: napi_call_threadsafe_function failed status=%{public}d", status);
        delete data;
    } else {
        OHLog("canvas_flush_state: flushed nodeId=%{public}s jsonLen=%{public}zu", state->nodeId.c_str(), strlen(jsonStr));
    }

    JS_FreeCString(ctx, jsonStr);
    JS_FreeValue(ctx, jsonVal);
}

// _flush(nodeId) — called from JS microtask to flush pending operations
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

// ─── C functions registered on __SkiaCanvas ───

// _createCanvas(nodeId, width, height)
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

    auto *state = new CanvasState();
    state->nodeId = nodeId;
    state->appIndex = appIndex;
    state->ctx = ctx;
    state->opsArray = JS_NewArray(ctx);
    state->opsCount = 0;

    canvasStates[nodeId] = state;

    OHLog("canvas_create: nodeId=%{public}s appIndex=%{public}d", nodeId, appIndex);
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
        delete state;
        canvasStates.erase(it);
        OHLog("canvas_destroy: nodeId=%{public}s", nodeId);
    }

    JS_FreeCString(ctx, nodeId);
    return JS_UNDEFINED;
}

// _bufferOp(nodeId, opObj) — buffer a draw operation (flush is triggered from JS via _flush)
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
    JSValue jsonVal = js_json_stringify(ctx, params);
    const char *jsonStr = JS_ToCString(ctx, jsonVal);
    JS_FreeValue(ctx, params);

    if (!jsonStr) {
        OHError("canvas_sync_op: JSON.stringify failed");
        JS_FreeValue(ctx, jsonVal);
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }

    // Send via TSFN (blocking) and wait for result
    napi_threadsafe_function tsfn = getCanvasTsfn(state->appIndex);
    if (!tsfn) {
        OHError("canvas_sync_op: no tsfn for appIndex=%{public}d", state->appIndex);
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
        OHError("canvas_sync_op: napi_call_threadsafe_function failed status=%{public}d", status);
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
        OHError("canvas_sync_op: future error: %{public}s", e.what());
        JS_FreeCString(ctx, nodeId);
        return JS_EXCEPTION;
    }
    delete promise;

    OHLog("canvas_sync_op: nodeId=%{public}s type=%{public}d resultLen=%{public}zu", nodeId, type, resultJson.size());
    JS_FreeCString(ctx, nodeId);

    // Parse the result JSON back to JSValue
    JSValue result = JS_ParseJSON(ctx, resultJson.c_str(), resultJson.size(), "<canvas_sync_result>");
    if (JS_IsException(result)) {
        OHError("canvas_sync_op: JS_ParseJSON failed");
        return JS_EXCEPTION;
    }

    return result;
}

// ─── Main-thread TSFN callback ───

static void canvasOnMessageCb(napi_env env, napi_value js_cb, void *context, void *rawData) {
    if (!rawData) {
        OHError("canvasOnMessageCb: rawData is null");
        return;
    }

    auto *data = static_cast<CanvasTsfnData *>(rawData);
    OHLog("canvasOnMessageCb: type=%{public}d jsonLen=%{public}zu hasPromise=%{public}d",
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
    OHLog("canvasOnMessageCb: napi_call_function status=%{public}d", status);

    if (status == napi_pending_exception) {
        napi_value exception;
        napi_get_and_clear_last_exception(env, &exception);
        OHError("canvasOnMessageCb: JS exception during callback");
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
    OHLog("RegisterCanvasTsfn: appIndex=%{public}d tsfn=%{public}p", appIndex, (void *)tsfn);

    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

// ─── Register __SkiaCanvas on JSContext ───

void registerSkiaCanvas(JSContext *ctx) {
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
    JSValue skiaCanvas = JS_NewObject(ctx);

    // Mark as available
    JS_SetPropertyStr(ctx, skiaCanvas, "available", JS_TRUE);

    // Store appIndex for reference
    JS_SetPropertyStr(ctx, skiaCanvas, "_appIndex", JS_NewInt32(ctx, appIndex));

    // Register C functions
    JS_SetPropertyStr(ctx, skiaCanvas, "_createCanvas",
        JS_NewCFunction(ctx, canvas_create, "_createCanvas", 3));
    JS_SetPropertyStr(ctx, skiaCanvas, "_destroyCanvas",
        JS_NewCFunction(ctx, canvas_destroy, "_destroyCanvas", 1));
    JS_SetPropertyStr(ctx, skiaCanvas, "_bufferOp",
        JS_NewCFunction(ctx, canvas_buffer_op, "_bufferOp", 2));
    JS_SetPropertyStr(ctx, skiaCanvas, "_flush",
        JS_NewCFunction(ctx, canvas_flush, "_flush", 1));
    JS_SetPropertyStr(ctx, skiaCanvas, "_syncOp",
        JS_NewCFunction(ctx, canvas_sync_op, "_syncOp", 2));

    JS_SetPropertyStr(ctx, global, "__SkiaCanvas", skiaCanvas);
    JS_FreeValue(ctx, global);

    OHLog("registerSkiaCanvas: done appIndex=%{public}d available=true", appIndex);
}

// ─── Cleanup ───

void cleanupCanvasBindings(int appIndex) {
    // Remove all CanvasState entries for this appIndex
    auto it = canvasStates.begin();
    while (it != canvasStates.end()) {
        if (it->second->appIndex == appIndex) {
            JS_FreeValue(it->second->ctx, it->second->opsArray);
            delete it->second;
            it = canvasStates.erase(it);
        } else {
            ++it;
        }
    }

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
        OHLog("cleanupCanvasBindings: released tsfn for appIndex=%{public}d", appIndex);
    }

    OHLog("cleanupCanvasBindings: done for appIndex=%{public}d", appIndex);
}
