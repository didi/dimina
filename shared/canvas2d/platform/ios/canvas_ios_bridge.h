/**
 * canvas_ios_bridge.h — C bridge for Swift integration on iOS.
 *
 * These functions are called from Swift (DMPEngineCanvas, NativeCanvasGLView)
 * using @_silgen_name or a bridging header.
 */

#ifndef DIMINA_CANVAS_IOS_BRIDGE_H
#define DIMINA_CANVAS_IOS_BRIDGE_H

#include "dimina_canvas2d.h"

/*
 * All functions are already declared in dimina_canvas2d.h.
 * This header serves as documentation for the iOS integration layer.
 *
 * Swift usage:
 *
 *   // In bridging header:
 *   #include "dimina_canvas2d.h"
 *
 *   // In Swift:
 *   let canvas = dm_canvas_create(width, height)
 *   dm_canvas_init_surface(canvas, metalLayer)
 *   dm_canvas_execute_ops(canvas, jsonCStr, Int32(jsonLen))
 *   dm_canvas_swap_buffers(canvas)
 *   dm_canvas_destroy(canvas)
 */

#endif /* DIMINA_CANVAS_IOS_BRIDGE_H */
