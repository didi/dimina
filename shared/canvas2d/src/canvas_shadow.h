#ifndef DIMINA_CANVAS_SHADOW_H
#define DIMINA_CANVAS_SHADOW_H

#include "nanovg.h"
#include "nanovg_gl_utils.h"
#include "canvas_state.h"

/**
 * Determine whether shadow rendering is needed based on current state.
 */
bool shouldDrawShadow(const CanvasDrawState &state);

/**
 * Draw the shadow pass: re-render the current path offset by
 * (shadowOffsetX, shadowOffsetY) with the shadow color.
 *
 * Uses a secondary FBO + Gaussian blur approximation (two-pass box blur
 * via down-scale/up-scale).  For NanoVG, we approximate by rendering the
 * path with the shadow color at the offset and using NanoVG's feather to
 * create the blur appearance.
 *
 * @param vg        NanoVG context (must be within a begin/end frame)
 * @param state     Current canvas draw state
 * @param drawFn    Callback that draws the path to be shadowed.
 *                  Called twice: once for the shadow pass, once for normal.
 * @param userData  Passed to drawFn
 */
typedef void (*ShadowDrawFn)(NVGcontext *vg, void *userData);

void drawWithShadow(NVGcontext *vg, const CanvasDrawState &state,
                    ShadowDrawFn drawFn, void *userData);

#endif /* DIMINA_CANVAS_SHADOW_H */
