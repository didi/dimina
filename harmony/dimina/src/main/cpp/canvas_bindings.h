#ifndef DIMINA_CANVAS_BINDINGS_H
#define DIMINA_CANVAS_BINDINGS_H

#include "quickjs.h"
#include "napi/native_api.h"

// Register __SkiaCanvas global object with C bindings (_createCanvas, _destroyCanvas, _bufferOp, _syncOp)
void registerSkiaCanvas(JSContext *ctx);

// NAPI export: register a per-appIndex threadsafe function for canvas messages to the main (UI) thread
napi_value RegisterCanvasTsfn(napi_env env, napi_callback_info info);

// Cleanup canvas TSFN and all CanvasState entries for a given appIndex
void cleanupCanvasBindings(int appIndex);

#endif // DIMINA_CANVAS_BINDINGS_H
