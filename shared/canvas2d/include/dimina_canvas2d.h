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

/* EGL surface binding (platform passes native window handle) -------------- */

int  dm_canvas_init_surface(DMCanvasRef canvas, void *native_window);
void dm_canvas_destroy_surface(DMCanvasRef canvas);
void dm_canvas_swap_buffers(DMCanvasRef canvas);

/* Batch execution (flush payload JSON) ------------------------------------ */

void dm_canvas_execute_ops(DMCanvasRef canvas, const char *json, int json_len);

/* Synchronous queries (blocking, caller must free returned string) -------- */

char *dm_canvas_get_image_data(DMCanvasRef canvas,
                               int x, int y, int w, int h);
char *dm_canvas_to_data_url(DMCanvasRef canvas,
                            const char *mime, double quality);
char *dm_canvas_measure_text(DMCanvasRef canvas,
                             const char *text, const char *font);
void  dm_canvas_free_string(char *str);

/* Font registration ------------------------------------------------------- */

int dm_canvas_register_font(const char *name,
                            const unsigned char *data, int len);

#ifdef __cplusplus
}
#endif

#endif /* DIMINA_CANVAS2D_H */
