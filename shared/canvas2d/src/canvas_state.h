#ifndef DIMINA_CANVAS_STATE_H
#define DIMINA_CANVAS_STATE_H

#include "nanovg.h"
#include <string>
#include <vector>
#include <map>

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

    /* Line dash */
    std::vector<float> lineDash;
    float lineDashOffset = 0.0f;

    /* Image smoothing */
    bool imageSmoothingEnabled = true;
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

    void reset();

private:
    std::vector<CanvasDrawState> stack_;
};

#endif /* DIMINA_CANVAS_STATE_H */
