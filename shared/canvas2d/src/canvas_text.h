#ifndef DIMINA_CANVAS_TEXT_H
#define DIMINA_CANVAS_TEXT_H

#include "nanovg.h"
#include <string>

/**
 * Parse a CSS font shorthand string (e.g. "bold 14px Arial") and apply it
 * to the NanoVG context + return parsed values.
 */
struct ParsedFont {
    float       size    = 10.0f;
    std::string family  = "sans-serif";
    int         weight  = 400;   /* 400=normal, 700=bold */
    bool        italic  = false;
};

ParsedFont parseCSSFont(const std::string &fontStr);

/**
 * Convert Canvas textAlign string to NVG_ALIGN_* flags.
 *   "left" | "right" | "center" | "start" | "end"
 */
int parseTextAlign(const std::string &align);

/**
 * Convert Canvas textBaseline string to NVG_ALIGN_* vertical flags.
 *   "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom"
 */
int parseTextBaseline(const std::string &baseline);

/**
 * Apply parsed font to NanoVG context (fontSize, fontFace).
 */
void applyFontToNVG(NVGcontext *vg, const ParsedFont &font);

#endif /* DIMINA_CANVAS_TEXT_H */
