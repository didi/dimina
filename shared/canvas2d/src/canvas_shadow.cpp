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

/*
 * Multi-pass blur approximation for shape shadows.
 * Draws the shape multiple times at jittered offsets around the shadow
 * position with reduced alpha per pass. This simulates a Gaussian blur.
 * The kernel uses concentric samples weighted by a Gaussian-like falloff.
 */
static void drawShadowBlurred(NVGcontext *vg, const CanvasDrawState &state,
                               NVGcolor shadowCol, ShadowDrawFn drawFn, void *userData) {
    float radius = state.shadowBlur * 0.5f;
    /* Number of rings and samples per ring */
    const int rings = 3;
    const float offsets[] = { 0.25f, 0.5f, 1.0f };
    const float weights[] = { 0.40f, 0.30f, 0.15f };
    const int samplesPerRing[] = { 4, 6, 8 };

    for (int ring = 0; ring < rings; ring++) {
        float r = radius * offsets[ring];
        int n = samplesPerRing[ring];
        NVGcolor c = shadowCol;
        c.a *= weights[ring] / (float)n;
        if (c.a < 1.0f / 255.0f) continue;

        for (int i = 0; i < n; i++) {
            float angle = (float)i / (float)n * 6.2831853f;
            float ox = cosf(angle) * r;
            float oy = sinf(angle) * r;

            nvgSave(vg);
            nvgTranslate(vg, state.shadowOffsetX + ox, state.shadowOffsetY + oy);
            nvgFillColor(vg, c);
            nvgStrokeColor(vg, c);
            drawFn(vg, userData);
            nvgRestore(vg);
        }
    }

    /* Center sample (strongest weight) */
    NVGcolor cc = shadowCol;
    cc.a *= 0.15f;
    if (cc.a >= 1.0f / 255.0f) {
        nvgSave(vg);
        nvgTranslate(vg, state.shadowOffsetX, state.shadowOffsetY);
        nvgFillColor(vg, cc);
        nvgStrokeColor(vg, cc);
        drawFn(vg, userData);
        nvgRestore(vg);
    }
}

void drawWithShadow(NVGcontext *vg, const CanvasDrawState &state,
                    ShadowDrawFn drawFn, void *userData) {
    if (!shouldDrawShadow(state)) {
        return;
    }

    NVGcolor shadowCol = parseCanvasColor(state.shadowColor);
    shadowCol.a *= state.globalAlpha;

    if (state.shadowBlur > 0.0f) {
        /* Multi-pass blur approximation for shapes */
        drawShadowBlurred(vg, state, shadowCol, drawFn, userData);
    } else {
        /* Offset-only shadow (no blur) */
        nvgSave(vg);
        nvgTranslate(vg, state.shadowOffsetX, state.shadowOffsetY);
        nvgFillColor(vg, shadowCol);
        nvgStrokeColor(vg, shadowCol);
        drawFn(vg, userData);
        nvgRestore(vg);
    }
}
