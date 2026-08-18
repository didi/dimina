#include "canvas_composite.h"

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)

void applyCompositeOperation(const std::string &op) {
    glEnable(GL_BLEND);

    if (op == "source-over" || op.empty()) {
        glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    } else if (op == "source-in") {
        glBlendFunc(GL_DST_ALPHA, GL_ZERO);
    } else if (op == "source-out") {
        glBlendFunc(GL_ONE_MINUS_DST_ALPHA, GL_ZERO);
    } else if (op == "source-atop") {
        glBlendFunc(GL_DST_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    } else if (op == "destination-over") {
        glBlendFunc(GL_ONE_MINUS_DST_ALPHA, GL_ONE);
    } else if (op == "destination-in") {
        glBlendFunc(GL_ZERO, GL_SRC_ALPHA);
    } else if (op == "destination-out") {
        glBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_ALPHA);
    } else if (op == "destination-atop") {
        glBlendFunc(GL_ONE_MINUS_DST_ALPHA, GL_SRC_ALPHA);
    } else if (op == "lighter" || op == "add") {
        glBlendFunc(GL_ONE, GL_ONE);
    } else if (op == "copy") {
        glBlendFunc(GL_ONE, GL_ZERO);
    } else if (op == "xor") {
        glBlendFunc(GL_ONE_MINUS_DST_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    } else if (op == "multiply") {
        /* Approximate: true multiply needs shader-based approach */
        glBlendFunc(GL_DST_COLOR, GL_ONE_MINUS_SRC_ALPHA);
    } else if (op == "screen") {
        glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_COLOR);
    } else {
        /* Default fallback */
        glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    }
}

#else

void applyCompositeOperation(const std::string &) {
    /* No-op on unsupported platforms */
}

#endif
