#ifndef DIMINA_CANVAS_BINDINGS_H
#define DIMINA_CANVAS_BINDINGS_H

#include "quickjs.h"
#include "napi/native_api.h"

#ifdef CANVAS2D_AVAILABLE
#include "dimina_canvas2d.h"
#endif

// Register __GLCanvas global object with C bindings (_createCanvas, _destroyCanvas, _bufferOp, _syncOp)
void registerGLCanvas(JSContext *ctx);

// NAPI export: register a per-appIndex threadsafe function for canvas messages to the main (UI) thread
napi_value RegisterCanvasTsfn(napi_env env, napi_callback_info info);

// Cleanup canvas TSFN and all CanvasState entries for a given appIndex
void cleanupCanvasBindings(int appIndex);

// NAPI: upload decoded image pixels to GL canvas (called from ArkTS after network download)
napi_value canvasUploadImage(napi_env env, napi_callback_info info);

#endif // DIMINA_CANVAS_BINDINGS_H
