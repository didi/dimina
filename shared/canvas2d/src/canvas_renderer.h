#ifndef DIMINA_CANVAS_RENDERER_H
#define DIMINA_CANVAS_RENDERER_H

#include "dimina_canvas2d.h"
#include "nanovg.h"
#include "nanovg_gl_utils.h"
#include "canvas_state.h"
#include "canvas_gradient.h"
#include "canvas_image.h"
#include "egl_surface.h"

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY)
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#elif defined(DIMINA_PLATFORM_IOS)
#include <GLES2/gl2.h>
#endif

/**
 * DMCanvas — the internal implementation behind the opaque DMCanvasRef handle.
 *
 * Owns the NanoVG context, EGL state, FBO, and all canvas sub-managers
 * (state, gradients, images).
 */
struct DMCanvas {
    /* Drawing buffer size (set by mini-app via canvas.width/height).
       This is the FBO resolution — may differ from the display surface. */
    int width  = 0;
    int height = 0;

    /* Display surface size (EGL surface / XComponent physical pixels).
       Used by swap_buffers to scale the FBO to the on-screen area,
       analogous to CSS width/height vs canvas.width/height in HTML. */
    int surfaceWidth  = 0;
    int surfaceHeight = 0;

    /* NanoVG */
    NVGcontext *vg = nullptr;

    /* EGL */
    EGLState eglState;
    bool     surfaceReady = false;

    /* FBO for off-screen rendering (NanoVG GL utils) */
    NVGLUframebuffer *nvgFbo = nullptr;

    /* Sub-managers */
    CanvasStateManager stateManager;
    GradientManager    gradientManager;
    ImageManager       imageManager;

    /* Device pixel ratio (for HiDPI; defaults to 1.0) */
    float devicePixelRatio = 1.0f;

    /* Frame state — tracks whether nvgBeginFrame is active */
    bool frameActive = false;

    /* Offscreen canvas — uses PBuffer surface, no display presentation */
    bool offscreen = false;
};

/**
 * Set up the FBO for a given canvas size.
 * Returns 0 on success.
 */
int canvas_setup_fbo(DMCanvas *canvas);

/**
 * Tear down the FBO.
 */
void canvas_teardown_fbo(DMCanvas *canvas);

/**
 * Execute a single operation (parsed from JSON) on the canvas.
 */
void canvas_execute_single_op(DMCanvas *canvas,
                               const char *op,
                               const char *method,
                               const char *prop,
                               /* value can be string or numeric — caller parses */
                               const char *valueStr,
                               double valueNum,
                               bool   valueIsNum,
                               /* args array as JSON substring */
                               const char *argsJson,
                               /* resultId for resource-creating calls */
                               const char *resultId);

#endif /* DIMINA_CANVAS_RENDERER_H */
