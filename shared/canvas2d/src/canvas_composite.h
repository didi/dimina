#ifndef DIMINA_CANVAS_COMPOSITE_H
#define DIMINA_CANVAS_COMPOSITE_H

#include <string>

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY)
#include <GLES2/gl2.h>
#elif defined(DIMINA_PLATFORM_IOS)
#include <GLES2/gl2.h>
#endif

/**
 * Apply a Canvas 2D globalCompositeOperation as GL blend mode.
 */
void applyCompositeOperation(const std::string &op);

#endif /* DIMINA_CANVAS_COMPOSITE_H */
