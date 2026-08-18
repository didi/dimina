#ifndef DIMINA_CANVAS_BINDINGS_H
#define DIMINA_CANVAS_BINDINGS_H

#include "quickjs.h"
#include "dimina_canvas2d.h"

// Register __SkiaCanvas global object with C bindings on the given JSContext.
// Must be called on the JS thread after context creation.
void registerSkiaCanvas(JSContext *ctx, int instanceId);

// Cleanup all canvas state for a given instance (call before engine destruction).
void cleanupCanvasBindings(int instanceId);

// Bind a GL canvas to a nodeId (called from NativeCanvasGLView when surface is ready).
void setCanvasGLHandle(const char *nodeId, DMCanvasRef glCanvas);

#endif // DIMINA_CANVAS_BINDINGS_H
