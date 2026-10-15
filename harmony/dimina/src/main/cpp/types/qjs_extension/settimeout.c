#include "types/qjs_extension/settimeout.h"
#include "quickjs.h"
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <uv.h>

extern uv_loop_t *js_core_get_loop_from_ctx(JSContext *ctx);

void setLogger(DebugLog newDebugLog, ExceptionLog newExceptionLog) {
    debugLog = newDebugLog;
    exceptionLog = newExceptionLog;
}

typedef struct {
    JSContext *ctx;
    JSRuntime *rt;
    uv_timer_t handle;
    JSValue func;
    int argc;
    int isInterval;
    JSValue argv[];
} UVTimer;

static JSClassID uv_timer_class_id;

static void clearTimer(UVTimer *timer) {
    JSValue func = timer->func;
    timer->func = JS_UNDEFINED;
    JS_FreeValueRT(timer->rt, func);
    int argc = timer->argc;
    timer->argc = 0;
    for (int i = 0; i < argc; i++) {
        JSValue value = timer->argv[i];
        timer->argv[i] = JS_UNDEFINED;
        JS_FreeValueRT(timer->rt, value);
    }
}

static void on_uv_close(uv_handle_t *handle) {
    // libuv owns the allocation until this callback, including cancellation
    // from inside the timer's own JavaScript callback.
    void *data = handle->data;
    handle->data = NULL;
    free(data);
}

static void closeTimerHandle(UVTimer *timer) {
    uv_timer_stop(&timer->handle);
    clearTimer(timer);
    if (!uv_is_closing((uv_handle_t *)&timer->handle))
        uv_close((uv_handle_t *)&timer->handle, on_uv_close);
}

static void uv_timer_finalizer(JSRuntime *rt, JSValue value) {
    UVTimer *timer = JS_GetOpaque(value, uv_timer_class_id);
    if (timer)
        closeTimerHandle(timer);
}

static void uv_timer_mark(JSRuntime *rt, JSValueConst value, JS_MarkFunc *mark) {
    UVTimer *timer = JS_GetOpaque(value, uv_timer_class_id);
    if (!timer)
        return;
    JS_MarkValue(rt, timer->func, mark);
    for (int i = 0; i < timer->argc; i++)
        JS_MarkValue(rt, timer->argv[i], mark);
}

static JSClassDef uv_timer_class = {
    "UVTimer",
    .finalizer = uv_timer_finalizer,
    .gc_mark = uv_timer_mark,
};

static void retireTimer(JSContext *ctx, JSValueConst registry, JSAtom key) {
    JSValue value = JS_GetProperty(ctx, registry, key);
    UVTimer *timer = JS_GetOpaque(value, uv_timer_class_id);
    if (timer) {
        // Detach before deleting the registry's owning reference. The libuv
        // close callback, rather than a JS finalizer, now owns the allocation.
        JS_SetOpaque(value, NULL);
        JS_DeleteProperty(ctx, registry, key, 0);
        closeTimerHandle(timer);
    }
    JS_FreeValue(ctx, value);
}

static void retireById(JSContext *ctx, int64_t id) {
    char key[21];
    snprintf(key, sizeof(key), "%lld", (long long)id);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue registry = JS_GetPropertyStr(ctx, global, "globalTimerMap");
    JSAtom atom = JS_NewAtom(ctx, key);
    retireTimer(ctx, registry, atom);
    JS_FreeAtom(ctx, atom);
    JS_FreeValue(ctx, registry);
    JS_FreeValue(ctx, global);
}

static void reportException(JSContext *ctx) {
    if (exceptionLog)
        exceptionLog(ctx);
    else
        JS_FreeValue(ctx, JS_GetException(ctx));
}

void processPendingJobs(JSContext *ctx) {
    JSContext *jobContext;
    int result;
    while ((result = JS_ExecutePendingJob(JS_GetRuntime(ctx), &jobContext)) > 0) {
    }
    if (result < 0)
        reportException(jobContext);
}

static void timerCallback(uv_timer_t *handle) {
    UVTimer *timer = handle->data;
    if (!timer || JS_IsUndefined(timer->func))
        return;
    JSContext *ctx = timer->ctx;
    processPendingJobs(ctx);
    // A Promise job can cancel this timer before its callback starts.
    if (JS_IsUndefined(timer->func))
        return;
    JSValue func = JS_DupValue(ctx, timer->func);
    int argc = timer->argc;
    JSValue *args = argc ? js_malloc(ctx, (size_t)argc * sizeof(JSValue)) : NULL;
    if (argc && !args) {
        JS_FreeValue(ctx, func);
        retireById(ctx, (int64_t)(uintptr_t)timer);
        reportException(ctx);
        return;
    }
    for (int i = 0; i < argc; i++)
        args[i] = JS_DupValue(ctx, timer->argv[i]);
    if (!timer->isInterval)
        retireById(ctx, (int64_t)(uintptr_t)timer);
    // Only these owned JS values survive the call. It may clear itself, clear
    // every timer, run GC or schedule a replacement.
    JSValue result = JS_Call(ctx, func, JS_UNDEFINED, argc, (JSValueConst *)args);
    JS_FreeValue(ctx, func);
    for (int i = 0; i < argc; i++)
        JS_FreeValue(ctx, args[i]);
    js_free(ctx, args);
    if (JS_IsException(result))
        reportException(ctx);
    JS_FreeValue(ctx, result);
}

static JSValue js_uv_setTimer(JSContext *ctx, JSValueConst thisValue, int argc, JSValueConst *argv, int repeat) {
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "Argument must be a function");
    double delay = 0;
    if (argc > 1 && JS_ToFloat64(ctx, &delay, argv[1]))
        return JS_EXCEPTION;
    if (!isfinite(delay) || delay < 0)
        delay = 0;
    if (delay > INT32_MAX)
        delay = INT32_MAX;
    uint64_t timeout = (uint64_t)delay;
    if (repeat && timeout == 0)
        timeout = 1;
    int nargs = argc > 2 ? argc - 2 : 0;
    UVTimer *timer = calloc(1, offsetof(UVTimer, argv) + (size_t)nargs * sizeof(JSValue));
    if (!timer)
        return JS_ThrowOutOfMemory(ctx);
    timer->ctx = ctx;
    timer->rt = JS_GetRuntime(ctx);
    timer->func = JS_DupValue(ctx, argv[0]);
    timer->argc = nargs;
    timer->isInterval = repeat;
    for (int i = 0; i < nargs; i++)
        timer->argv[i] = JS_DupValue(ctx, argv[i + 2]);
    uv_loop_t *loop = js_core_get_loop_from_ctx(ctx);
    if (!loop || uv_timer_init(loop, &timer->handle) != 0) {
        clearTimer(timer);
        free(timer);
        return JS_ThrowInternalError(ctx, "Cannot initialize timer");
    }
    timer->handle.data = timer;
    JSValue value = JS_NewObjectClass(ctx, uv_timer_class_id);
    if (JS_IsException(value)) {
        closeTimerHandle(timer);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(value, timer);
    char key[21];
    int64_t id = (int64_t)(uintptr_t)timer;
    snprintf(key, sizeof(key), "%lld", (long long)id);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue registry = JS_GetPropertyStr(ctx, global, "globalTimerMap");
    int stored = JS_IsException(registry) ? -1 : JS_SetPropertyStr(ctx, registry, key, value);
    if (JS_IsException(registry))
        JS_FreeValue(ctx, value);
    JS_FreeValue(ctx, registry);
    JS_FreeValue(ctx, global);
    if (stored < 0)
        return JS_EXCEPTION;
    if (uv_timer_start(&timer->handle, timerCallback, timeout, repeat ? timeout : 0) != 0) {
        retireById(ctx, id);
        return JS_ThrowInternalError(ctx, "Cannot start timer");
    }
    return JS_NewInt64(ctx, id);
}

static JSValue js_uv_setTimeout(JSContext *ctx, JSValueConst value, int argc, JSValueConst *argv) {
    return js_uv_setTimer(ctx, value, argc, argv, 0);
}
static JSValue js_uv_setInterval(JSContext *ctx, JSValueConst value, int argc, JSValueConst *argv) {
    return js_uv_setTimer(ctx, value, argc, argv, 1);
}
static JSValue js_uv_clearTimer(JSContext *ctx, JSValueConst value, int argc, JSValueConst *argv) {
    if (!argc)
        return JS_UNDEFINED;
    int64_t id;
    if (JS_ToInt64(ctx, &id, argv[0]))
        return JS_EXCEPTION;
    retireById(ctx, id);
    return JS_UNDEFINED;
}

void timeoutInit(JSContext *ctx) {
    JS_NewClassID(&uv_timer_class_id);
    if (!JS_IsRegisteredClass(JS_GetRuntime(ctx), uv_timer_class_id))
        JS_NewClass(JS_GetRuntime(ctx), uv_timer_class_id, &uv_timer_class);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "globalTimerMap", JS_NewObject(ctx));
    JS_SetPropertyStr(ctx, global, "setTimeout", JS_NewCFunction(ctx, js_uv_setTimeout, "setTimeout", 2));
    JS_SetPropertyStr(ctx, global, "clearTimeout", JS_NewCFunction(ctx, js_uv_clearTimer, "clearTimeout", 1));
    JS_SetPropertyStr(ctx, global, "setInterval", JS_NewCFunction(ctx, js_uv_setInterval, "setInterval", 2));
    JS_SetPropertyStr(ctx, global, "clearInterval", JS_NewCFunction(ctx, js_uv_clearTimer, "clearInterval", 1));
    JS_FreeValue(ctx, global);
}

void clearAllTimers(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue registry = JS_GetPropertyStr(ctx, global, "globalTimerMap");
    JSPropertyEnum *properties;
    uint32_t count;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, registry, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < count; i++) {
            retireTimer(ctx, registry, properties[i].atom);
            JS_FreeAtom(ctx, properties[i].atom);
        }
        js_free(ctx, properties);
    }
    JS_FreeValue(ctx, registry);
    JS_FreeValue(ctx, global);
}
