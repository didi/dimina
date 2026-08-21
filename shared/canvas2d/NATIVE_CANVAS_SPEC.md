# Native Canvas 2D Spec

## Overview

Native Canvas provides GPU-accelerated Canvas 2D rendering that bypasses the WebView canvas, using **NanoVG + OpenGL ES 2.0** with FBO off-screen rendering. It integrates with each platform's same-layer rendering mechanism (HarmonyOS XComponent, Android NativeView, iOS pending ANGLE Metal).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Mini-App JS (Service Thread)                           │
│  canvas.getContext('2d').fillRect(...)                   │
│  ↓                                                      │
│  GLContext2D._call() → __GLCanvas._bufferOp(nodeId, op) │
└──────────────────────────┬──────────────────────────────┘
                           │ (QuickJS / JSCore thread)
┌──────────────────────────▼──────────────────────────────┐
│  Platform Bindings (C++)                                │
│  canvas_bindings.cpp                                    │
│  - Op queue (per nodeId)                                │
│  - Deferred swap via rAF / setTimeout                   │
│  - Lazy GL init on first render                         │
│  - Image upload pipeline (TSFN / JNI)                   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Shared Canvas2D Library (C)                            │
│  dimina_canvas2d.h                                      │
│  - NanoVG context + GLES2 backend                       │
│  - EGL surface management                               │
│  - FBO off-screen rendering                             │
│  - JSON op parser + executor                            │
│  - stb_image decode, stb_image_write encode             │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Platform Surface                                       │
│  HarmonyOS: XComponent (TEXTURE) via same-layer embed   │
│  Android:   NativeCanvasGLView (GLSurfaceView)          │
│  iOS:       pending (ANGLE Metal)                       │
└─────────────────────────────────────────────────────────┘
```

## Shared C API (`dimina_canvas2d.h`)

### Lifecycle

| Function | Description |
|---|---|
| `dm_canvas_create(w, h)` | Allocate canvas struct (no GL yet) |
| `dm_canvas_destroy(canvas)` | Free all resources (EGL, NanoVG, FBO) |
| `dm_canvas_resize(canvas, w, h)` | Update logical size, rebuild FBO if GL ready |
| `dm_canvas_set_pixel_ratio(canvas, dpr)` | Set device pixel ratio for hi-DPI |
| `dm_canvas_set_surface_size(canvas, sw, sh)` | Set EGL surface dimensions |
| `dm_canvas_is_ready(canvas)` | Returns 1 if vg != NULL and surface is ready |

### EGL Surface

| Function | Description |
|---|---|
| `dm_canvas_init_surface(canvas, nw)` | Create EGL display/context/surface, init NanoVG, load fonts, create FBO |
| `dm_canvas_destroy_surface(canvas)` | Tear down EGL (keep DMCanvas struct alive) |
| `dm_canvas_rebind_surface(canvas, nw)` | Rebind EGL surface without destroying NanoVG context/FBO |

### Frame Rendering

| Function | Description |
|---|---|
| `dm_canvas_begin_frame(canvas)` | Bind FBO, call `nvgBeginFrame` |
| `dm_canvas_end_frame(canvas)` | Call `nvgEndFrame` |
| `dm_canvas_execute_ops(canvas, json, len)` | Parse and execute a JSON op string |
| `dm_canvas_swap_buffers(canvas)` | Blit FBO to screen surface, `eglSwapBuffers` |

### Synchronous Queries

| Function | Description |
|---|---|
| `dm_canvas_get_image_data(canvas, x, y, w, h)` | Read FBO pixels via `glReadPixels`, return JSON |
| `dm_canvas_to_data_url(canvas, mime, quality)` | Encode FBO as base64 PNG/JPEG |
| `dm_canvas_measure_text(canvas, text, font)` | Measure text bounds via NanoVG |
| `dm_canvas_is_point_in_path(canvas, x, y)` | Hit test current path |

### Image Loading

| Function | Description |
|---|---|
| `dm_canvas_load_image_rgba(canvas, id, data, w, h)` | Upload raw RGBA pixels as NanoVG texture |
| `dm_canvas_load_image_data(canvas, id, data, len)` | Decode PNG/JPEG via stb_image, upload |

## JS Bindings (`__GLCanvas`)

Registered on `globalThis` by the C++ layer during engine init. The `available` property is `true` when the native GL backend is compiled in.

### Methods

| Method | Description |
|---|---|
| `_createCanvas(nodeId, w, h)` | Create a CanvasState for the given nodeId |
| `_destroyCanvas(nodeId)` | Destroy CanvasState and queue GL resource cleanup |
| `_bufferOp(nodeId, opObj)` | JSON-stringify op, push to opQueue, schedule rAF |
| `_flush(nodeId)` | (Android) Immediately flush ops and swap |
| `_render(nodeId)` | (HarmonyOS) rAF callback: drain opQueue, render frame, swap |
| `_syncOp(nodeId, params)` | Blocking: flush pending ops, execute sync query, return result |
| `_putImageData(nodeId, data, w, h, dx, dy, ...)` | Upload pixel data directly |
| `_replayPendingOps(nodeId)` | Replay buffered ops after GL init |
| `_uploadPendingImages(nodeId)` | Upload queued image data as NanoVG textures |

### Op Format

All ops are JSON objects with an `op` field:

```json
{ "op": "getContext", "contextId": "ctx_1", "contextType": "2d" }
{ "op": "contextCall", "contextId": "ctx_1", "method": "fillRect", "args": [0, 0, 100, 50] }
{ "op": "contextSetProperty", "contextId": "ctx_1", "prop": "fillStyle", "value": "#ff0000" }
{ "op": "setCanvasProperty", "prop": "width", "value": 300 }
{ "op": "imageSetSrc", "imageId": "img_1", "src": "https://...", "onload": "cb_1", "onerror": "cb_2" }
{ "op": "resourceCall", "resourceId": "res_1", "method": "addColorStop", "args": [0, "red"] }
```

## Service-Side JS Classes (`native-node.js`)

### GLCanvasNode

Wraps a native canvas instance. Created when `isGLAvailable` is true.

```javascript
class GLCanvasNode {
    constructor({ nodeId, width, height })  // calls _createCanvas
    getContext('2d') → GLContext2D
    createImage() → NativeImage
    toDataURL(type, quality) → string       // sync via _syncOp
    requestAnimationFrame(fn) → id
    cancelAnimationFrame(id)
    get/set width, height                   // _bufferOp setCanvasProperty
}
```

### GLContext2D

All drawing methods call `_bufferOp` with `op: 'contextCall'`.

**Supported methods:** fillRect, strokeRect, clearRect, beginPath, moveTo, lineTo, closePath, arc, arcTo, bezierCurveTo, quadraticCurveTo, ellipse, rect, fill, stroke, clip, fillText, strokeText, translate, rotate, scale, transform, setTransform, resetTransform, save, restore, setLineDash, drawImage, createLinearGradient, createRadialGradient, createPattern

**Sync methods (via `_syncOp`):** getImageData, putImageData, measureText, createImageData, isPointInPath, isPointInStroke

**Properties (via `contextSetProperty`):** fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, miterLimit, font, textAlign, textBaseline, globalAlpha, globalCompositeOperation, shadowBlur, shadowColor, shadowOffsetX, shadowOffsetY, lineDashOffset, imageSmoothingEnabled

### NativeImage

```javascript
class NativeImage {
    set src(url)   // _bufferOp imageSetSrc with onload/onerror callbacks
    get src()
    width, height  // populated on load
    onload, onerror
}
```

### Fallback

When `isGLAvailable` is false, `CanvasNode` falls back to `CanvasNodeFallback` (canvas-node.js), which serializes ops to the render-side WebView `<canvas>`.

## Platform Integration

### HarmonyOS

**Same-layer rendering:**
1. Canvas.vue renders `<embed type="native/canvas" :id="canvasNodeId">`
2. `onNativeEmbedLifecycleChange` → `createSameLayerNode` → `DMPNodeController`
3. `DMPCanvasComponent` builds `XComponent(type: TEXTURE)`
4. `XComponent.onLoad` → `canvasBindSurface(appIndex, nodeId, surfaceId, w, h, dpr)`
5. C++ creates `DMCanvas`, stores `OHNativeWindow`, schedules `_replayPendingOps`
6. QuickJS thread: lazy GL init → `dm_canvas_init_surface` → EGL + NanoVG + FBO

**Image loading pipeline:**
1. C++ `imageSetSrc` → TSFN → ArkTS `DMPCanvasManager.handleImageSetSrc`
2. ArkTS: HTTP fetch → `image.createImageSource` → `createPixelMap` → RGBA buffer
3. ArkTS: `canvasUploadImage(appIndex, nodeId, imageId, buffer, w, h, callbackId)`
4. C++: queues `PendingImageUpload`, schedules `_uploadPendingImages`
5. QuickJS: `dm_canvas_load_image_rgba` → NanoVG GL texture
6. Invokes JS onload callback with `{width, height}`

**Touch events:**
- `onNativeEmbedGestureEvent`: for canvas embeds, injects synthetic `TouchEvent` on `<embed>` via `runJavaScript`, calls `setGestureEventResult(false)` for scroll pass-through

**Threading:**
- Main thread (ArkTS): surface lifecycle, image decode, NAPI calls
- QuickJS thread: EGL context owner, NanoVG rendering, op execution
- Atomics (`glCanvas`, `nativeWindow`, `glInitialized`) for cross-thread state

### Android

**Same-layer rendering:**
1. Canvas.vue renders `<embed type="application/view" comp_type="native/canvas">`
2. Native side creates `NativeCanvasGLView` (GLSurfaceView)
3. Surface ready → `setCanvasGLHandle(nodeId, glCanvas)`
4. C++ bindings: `_bufferOp` queues ops, `_flush` executes + swaps immediately

**Image loading:**
- JNI callback to Java for HTTP fetch + decode
- Java returns RGBA pixel buffer
- C++ uploads via `dm_canvas_load_image_rgba`

### iOS

**Status:** Stub only. `__GLCanvas.available = false`. Falls back to WebView canvas.

**Planned:** ANGLE Metal backend integration.

## Op Rendering Pipeline

```
_bufferOp(nodeId, op)
  ├── JSON.stringify(op) → push to opQueue
  └── schedule rAF / setTimeout(16)
         │
    _render(nodeId)  [rAF callback]
         │
    ┌────▼────────────────────────────────┐
    │  Lazy GL init (if !glInitialized)   │
    │  dm_canvas_init_surface(glCanvas,nw)│
    │  → EGL init → surface → NanoVG     │
    │  → font loading → FBO creation     │
    └────┬────────────────────────────────┘
         │
    ┌────▼────────────────────────────────┐
    │  dm_canvas_begin_frame(glCanvas)    │
    │  for each op in opQueue:            │
    │    dm_canvas_execute_ops(op)        │
    │    record to opHistory              │
    │  dm_canvas_end_frame(glCanvas)      │
    │  dm_canvas_swap_buffers(glCanvas)   │
    └─────────────────────────────────────┘
```

## Canvas State Management

### Draw State Stack

Each canvas maintains a state stack (save/restore):
- Fill/stroke style (color, gradient, pattern)
- Transform matrix (a, b, c, d, e, f)
- Line properties (width, cap, join, miter, dash)
- Text properties (font, size, weight, align, baseline)
- Shadow (offsetX/Y, blur, color)
- globalAlpha, globalCompositeOperation
- imageSmoothingEnabled

### FBO Architecture

- Off-screen FBO (`nvgluCreateFramebuffer`) at `width × height × devicePixelRatio`
- All drawing targets FBO (not screen surface directly)
- `swap_buffers`: binds screen FBO (0), blits FBO texture as fullscreen quad, `eglSwapBuffers`
- Preserves content across frames (no implicit clear)

### Op History

- Records all executed ops for replay on surface rebind/resize
- Max 10,000 ops; exceeding cap stops recording (content may be lost on resize)
- Cleared when `canvas.width` or `canvas.height` is set (matches Web Canvas spec)

## Supported Composite Operations

| Operation | NanoVG Blend |
|---|---|
| source-over (default) | NVG_SOURCE_OVER |
| source-in | NVG_SOURCE_IN |
| source-out | NVG_SOURCE_OUT |
| source-atop | NVG_ATOP |
| destination-over | NVG_DESTINATION_OVER |
| destination-in | NVG_DESTINATION_IN |
| destination-out | NVG_DESTINATION_OUT |
| destination-atop | NVG_DESTINATION_ATOP |
| lighter | NVG_LIGHTER |
| copy | NVG_COPY |
| xor | NVG_XOR |
