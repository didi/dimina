#ifndef DIMINA_CANVAS_COLOR_H
#define DIMINA_CANVAS_COLOR_H

#include "nanovg.h"
#include <string>

/**
 * Parse a CSS color string into an NVGcolor.
 *
 * Supported formats:
 *   - Named colors (red, blue, transparent, ...)
 *   - #RGB, #RRGGBB, #RGBA, #RRGGBBAA
 *   - rgb(r, g, b), rgba(r, g, b, a)
 *   - hsl(h, s%, l%), hsla(h, s%, l%, a)
 *
 * Returns nvgRGBA(0,0,0,255) on parse failure.
 */
NVGcolor parseCanvasColor(const std::string &colorStr);

#endif /* DIMINA_CANVAS_COLOR_H */
