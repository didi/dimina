#ifndef DIMINA_CANVAS_GRADIENT_H
#define DIMINA_CANVAS_GRADIENT_H

#include "nanovg.h"
#include <string>
#include <vector>
#include <map>

struct ColorStop {
    float  offset;
    NVGcolor color;
};

struct GradientInfo {
    enum Type { LINEAR, RADIAL } type;
    /* Linear: (x0,y0) → (x1,y1) */
    float x0, y0, x1, y1;
    /* Radial: inner (x0,y0,r0), outer (x1,y1,r1) */
    float r0, r1;
    std::vector<ColorStop> stops;

    /* Cached NanoVG texture image for multi-stop gradients */
    mutable int textureImage = -1;
};

/**
 * Manages gradient resources created by createLinearGradient / createRadialGradient.
 * Each gradient is identified by a string resourceId assigned by the JS layer.
 *
 * For gradients with > 2 color stops, a 1D gradient texture is generated and
 * used as an NanoVG image pattern.
 */
class GradientManager {
public:
    std::string createLinearGradient(float x0, float y0, float x1, float y1);
    std::string createRadialGradient(float x0, float y0, float r0,
                                     float x1, float y1, float r1);
    void addColorStop(const std::string &id, float offset, NVGcolor color);

    /**
     * Build an NVGpaint for the given gradient.
     *
     * - 0-1 stops: solid color paint
     * - 2 stops: native NanoVG linear/radial gradient
     * - 3+ stops: 1D texture-based gradient for correct multi-stop rendering
     */
    NVGpaint buildPaint(NVGcontext *vg, const std::string &id) const;

    bool has(const std::string &id) const;
    void remove(const std::string &id);
    void clear();
    void clearTextures(NVGcontext *vg);

    void store(const std::string &id, const GradientInfo &info);

private:
    std::map<std::string, GradientInfo> gradients_;
    int nextId_ = 0;

    /** Generate a 1D gradient texture (256 pixels wide) from color stops. */
    int generateGradientTexture(NVGcontext *vg, const GradientInfo &gi) const;
};

#endif /* DIMINA_CANVAS_GRADIENT_H */
