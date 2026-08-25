#ifndef DIMINA_CANVAS_STATE_H
#define DIMINA_CANVAS_STATE_H

#include "nanovg.h"
#include <string>
#include <vector>
#include <map>
#include <cstring>
#include <cmath>

/**
 * Canvas 2D state that NanoVG doesn't track (or tracks differently).
 * Mirrors the HTML Canvas 2D rendering context state.
 */
struct CanvasDrawState {
    /* Fill / stroke style (color string or gradient/pattern resource ID) */
    std::string fillStyleStr   = "#000000";
    std::string strokeStyleStr = "#000000";
    bool fillIsGradient   = false;
    bool strokeIsGradient = false;
    std::string fillGradientId;
    std::string strokeGradientId;

    /* Text */
    std::string fontStr = "10px sans-serif";
    float fontSize      = 10.0f;
    std::string fontFamily = "sans-serif";
    int   fontWeight    = 400;       /* 400=normal, 700=bold */
    bool  fontItalic    = false;
    int   textAlign     = NVG_ALIGN_LEFT | NVG_ALIGN_BASELINE;
    std::string textBaseline = "alphabetic";

    /* Compositing */
    float globalAlpha = 1.0f;
    std::string globalCompositeOperation = "source-over";

    /* Shadow */
    float shadowOffsetX  = 0.0f;
    float shadowOffsetY  = 0.0f;
    float shadowBlur     = 0.0f;
    std::string shadowColor = "rgba(0,0,0,0)";

    /* Line style (tracked here because nvgBeginFrame resets NanoVG state) */
    float lineWidth  = 1.0f;
    int   lineCap    = NVG_BUTT;    // NVG_BUTT, NVG_ROUND, NVG_SQUARE
    int   lineJoin   = NVG_MITER;   // NVG_MITER, NVG_ROUND, NVG_BEVEL
    float miterLimit = 10.0f;

    /* Line dash */
    std::vector<float> lineDash;
    float lineDashOffset = 0.0f;

    /* Image smoothing */
    bool imageSmoothingEnabled = true;

    /* Clip path tracking — records the last path for clip().
       When clip() is called, if the path was a single rect, we use
       nvgIntersectScissor for hardware clipping.  Otherwise we fall
       back to bounding-box scissor (lossy). */
    enum ClipPathType { CLIP_NONE, CLIP_RECT, CLIP_OTHER };
    ClipPathType lastPathType = CLIP_NONE;
    float lastPathRect[4] = {0,0,0,0};  /* x, y, w, h (valid when CLIP_RECT) */

    /* Stencil-based clip active flag.
       Set to true when clip() is called, cleared on restore(). */
    bool clipActive = false;

    /* Transform matrix (affine 3x2, same layout as NanoVG: a,b,c,d,e,f)
       Identity = {1,0,0,1,0,0} */
    float xform[6] = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f};

    /* ── Helpers to update the tracked transform ────────────────── */

    void xformReset() {
        xform[0]=1; xform[1]=0; xform[2]=0; xform[3]=1; xform[4]=0; xform[5]=0;
    }

    /* Premultiply: self = mat * self  (same semantics as NanoVG) */
    void xformPremultiply(const float *s) {
        float t[6];
        std::memcpy(t, xform, sizeof(t));
        xform[0] = s[0]*t[0] + s[1]*t[2];
        xform[1] = s[0]*t[1] + s[1]*t[3];
        xform[2] = s[2]*t[0] + s[3]*t[2];
        xform[3] = s[2]*t[1] + s[3]*t[3];
        xform[4] = s[4]*t[0] + s[5]*t[2] + t[4];
        xform[5] = s[4]*t[1] + s[5]*t[3] + t[5];
    }

    void xformTranslate(float tx, float ty) {
        float s[6] = {1,0,0,1,tx,ty};
        xformPremultiply(s);
    }

    void xformScale(float sx, float sy) {
        float s[6] = {sx,0,0,sy,0,0};
        xformPremultiply(s);
    }

    void xformRotate(float angle) {
        float cs = cosf(angle), sn = sinf(angle);
        float s[6] = {cs, sn, -sn, cs, 0, 0};
        xformPremultiply(s);
    }

    void xformSet(float a,float b,float c,float d,float e,float f) {
        xform[0]=a; xform[1]=b; xform[2]=c; xform[3]=d; xform[4]=e; xform[5]=f;
    }

    void xformConcat(float a,float b,float c,float d,float e,float f) {
        float s[6] = {a,b,c,d,e,f};
        xformPremultiply(s);
    }
};

/**
 * Manages the Canvas 2D state stack (save/restore) alongside NanoVG's own
 * save/restore.
 */
class CanvasStateManager {
public:
    CanvasStateManager();

    void save();
    void restore();

    CanvasDrawState &current();
    const CanvasDrawState &current() const;

    /* Number of save() calls on the stack (0 = base state, no saves) */
    int saveDepth() const { return static_cast<int>(stack_.size()) - 1; }

    /* Access the state at a specific stack level (0 = base) */
    const CanvasDrawState &at(int level) const { return stack_[level]; }

    /* Total number of entries in the stack (base + saves) */
    int stackSize() const { return static_cast<int>(stack_.size()); }

    void reset();

private:
    std::vector<CanvasDrawState> stack_;
};

#endif /* DIMINA_CANVAS_STATE_H */
