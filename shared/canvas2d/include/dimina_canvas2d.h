/**
 * dimina_canvas2d.h — Public C API for the cross-platform Canvas 2D renderer.
 *
 * Uses NanoVG + GLES2 to provide a unified rendering backend for Android, iOS,
 * and HarmonyOS.  All functions must be called from the thread that owns the
 * EGL context (normally the JS / QuickJS thread).
 */

#ifndef DIMINA_CANVAS2D_H
#define DIMINA_CANVAS2D_H

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handle ----------------------------------------------------------- */

typedef struct DMCanvas *DMCanvasRef;

/* Lifecycle --------------------------------------------------------------- */

DMCanvasRef dm_canvas_create(int width, int height);
void        dm_canvas_destroy(DMCanvasRef canvas);
void        dm_canvas_resize(DMCanvasRef canvas, int width, int height);
void        dm_canvas_set_pixel_ratio(DMCanvasRef canvas, float ratio);

/** Set the display surface size (EGL surface / XComponent physical pixels).
 *  Independent of the drawing buffer size (canvas.width/height).
 *  swap_buffers uses this to scale the FBO to the on-screen area,
 *  analogous to CSS width/height vs canvas.width/height in HTML. */
void        dm_canvas_set_surface_size(DMCanvasRef canvas, int sw, int sh);

/** Reset canvas state for full replay — clears FBO, resets state & gradients.
 *  Called before re-rendering the full op history. */
void        dm_canvas_reset_for_replay(DMCanvasRef canvas);

/** Returns non-zero if the canvas is fully initialised and ready to render
 *  (NanoVG context created, EGL surface bound, FBO allocated). */
int dm_canvas_is_ready(DMCanvasRef canvas);

/* EGL surface binding (platform passes native window handle) -------------- */

int  dm_canvas_init_surface(DMCanvasRef canvas, void *native_window);
int  dm_canvas_init_offscreen(DMCanvasRef canvas);
void dm_canvas_destroy_surface(DMCanvasRef canvas);

/** Rebind the EGL surface to a new native window without destroying the
 *  NanoVG context or FBO.  Used when the XComponent is rebuilt but the
 *  surfaceId is reused — the underlying surface is recreated by the system
 *  but we want to preserve all rendered content. */
int  dm_canvas_rebind_surface(DMCanvasRef canvas, void *native_window);
void dm_canvas_swap_buffers(DMCanvasRef canvas);

/* Frame management -------------------------------------------------------- */

void dm_canvas_begin_frame(DMCanvasRef canvas);
void dm_canvas_end_frame(DMCanvasRef canvas);

/* Batch execution (flush payload JSON) ------------------------------------ */

/** Execute ops within an existing frame (between begin_frame/end_frame).
 *  If no frame is active, wraps in begin_frame/end_frame automatically. */
void dm_canvas_execute_ops(DMCanvasRef canvas, const char *json, int json_len);

/* Synchronous queries (blocking, caller must free returned string) -------- */

char *dm_canvas_get_image_data(DMCanvasRef canvas,
                               int x, int y, int w, int h);
char *dm_canvas_to_data_url(DMCanvasRef canvas,
                            const char *mime, double quality);
char *dm_canvas_measure_text(DMCanvasRef canvas,
                             const char *text, const char *font);
void  dm_canvas_free_string(char *str);

/* Pixel manipulation ------------------------------------------------------ */

void dm_canvas_put_image_data(DMCanvasRef canvas,
                              const unsigned char *data,
                              int dataW, int dataH,
                              int dx, int dy,
                              int dirtyX, int dirtyY,
                              int dirtyW, int dirtyH);

/* Image loading ----------------------------------------------------------- */

/**
 * Load an image from encoded file data (PNG/JPEG/etc, decoded via stb_image).
 * Returns 0 on success, -1 on failure.
 * On success, *out_w and *out_h receive the image dimensions.
 */
int dm_canvas_load_image_data(DMCanvasRef canvas, const char *imageId,
                              const unsigned char *fileData, int dataLen,
                              int *out_w, int *out_h);

/**
 * Load an image from raw RGBA pixel data.
 * Returns 0 on success, -1 on failure.
 */
int dm_canvas_load_image_rgba(DMCanvasRef canvas, const char *imageId,
                              int w, int h, const unsigned char *rgbaData);

/* Font registration ------------------------------------------------------- */

int dm_canvas_register_font(const char *name,
                            const unsigned char *data, int len);

#ifdef __cplusplus
}
#endif

#endif /* DIMINA_CANVAS2D_H */
