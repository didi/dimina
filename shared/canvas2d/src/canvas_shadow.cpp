#include "canvas_shadow.h"
#include "canvas_color.h"
#include <cmath>

bool shouldDrawShadow(const CanvasDrawState &state) {
    if (state.shadowBlur <= 0.0f &&
        state.shadowOffsetX == 0.0f &&
        state.shadowOffsetY == 0.0f) {
        return false;
    }
    NVGcolor sc = parseCanvasColor(state.shadowColor);
    return sc.a > 0.0f;
}

void drawWithShadow(NVGcontext *vg, const CanvasDrawState &state,
                    ShadowDrawFn drawFn, void *userData) {
    if (!shouldDrawShadow(state)) {
        /* No shadow — just draw normally */
        drawFn(vg, userData);
        return;
    }

    NVGcolor shadowCol = parseCanvasColor(state.shadowColor);

    /*
     * Shadow approximation strategy:
     *
     * A pixel-perfect Canvas 2D shadow requires:
     *   1. Render the shape to a temp FBO
     *   2. Apply a Gaussian blur (radius = shadowBlur/2)
     *   3. Composite at offset (shadowOffsetX, shadowOffsetY)
     *   4. Draw the original shape on top
     *
     * Full FBO blur is expensive. We use a practical approximation:
     *   - Save the NanoVG state
     *   - Translate by (shadowOffsetX, shadowOffsetY)
     *   - Set fill/stroke color to shadowColor
     *   - Use NanoVG's path feather (strokeWidth = shadowBlur) for blur
     *   - Draw the shape
     *   - Restore and draw the original shape
     *
     * For text, NanoVG supports fontBlur which gives proper Gaussian blur.
     */

    /* Shadow pass */
    nvgSave(vg);
    nvgTranslate(vg, state.shadowOffsetX, state.shadowOffsetY);

    /* Override colors with shadow color for this pass */
    shadowCol.a *= state.globalAlpha;
    nvgFillColor(vg, shadowCol);
    nvgStrokeColor(vg, shadowCol);

    /* NanoVG fontBlur for text shadows */
    if (state.shadowBlur > 0) {
        nvgFontBlur(vg, state.shadowBlur * 0.5f);
    }

    drawFn(vg, userData);
    nvgRestore(vg);

    /* Reset font blur */
    nvgFontBlur(vg, 0);

    /* Normal pass (on top of shadow) */
    drawFn(vg, userData);
}
