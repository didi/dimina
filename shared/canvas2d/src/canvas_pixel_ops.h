#ifndef DIMINA_CANVAS_PIXEL_OPS_H
#define DIMINA_CANVAS_PIXEL_OPS_H

#include "nanovg.h"

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY)
#include <GLES2/gl2.h>
#elif defined(DIMINA_PLATFORM_IOS)
#include <GLES2/gl2.h>
#endif

/**
 * Read pixel data from the current FBO.
 * Returns a JSON string: {"data":[r,g,b,a,...], "width":w, "height":h}
 * Caller must free the returned string with free().
 */
char *pixelops_get_image_data(int fbo, int canvasWidth, int canvasHeight,
                              int x, int y, int w, int h);

/**
 * Write pixel data to the current FBO.
 * data is an RGBA array of length w*h*4.
 */
void pixelops_put_image_data(NVGcontext *vg, int fbo,
                             int canvasWidth, int canvasHeight,
                             const unsigned char *data,
                             int x, int y, int w, int h);

/**
 * Render current FBO contents to a data URL (base64-encoded image).
 * Returns a malloced string "data:image/png;base64,..." or "data:image/jpeg;base64,...".
 * Caller must free the returned string with free().
 */
char *pixelops_to_data_url(int fbo, int canvasWidth, int canvasHeight,
                           const char *mime, double quality);

#endif /* DIMINA_CANVAS_PIXEL_OPS_H */
