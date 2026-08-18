#include "canvas_gradient.h"
#include <cstdio>
#include <cstring>
#include <cmath>
#include <algorithm>

std::string GradientManager::createLinearGradient(float x0, float y0,
                                                   float x1, float y1) {
    char buf[64];
    snprintf(buf, sizeof(buf), "__grad_%d", nextId_++);
    GradientInfo gi;
    gi.type = GradientInfo::LINEAR;
    gi.x0 = x0; gi.y0 = y0;
    gi.x1 = x1; gi.y1 = y1;
    gi.r0 = 0;  gi.r1 = 0;
    gradients_[buf] = gi;
    return buf;
}

std::string GradientManager::createRadialGradient(float x0, float y0, float r0,
                                                   float x1, float y1, float r1) {
    char buf[64];
    snprintf(buf, sizeof(buf), "__grad_%d", nextId_++);
    GradientInfo gi;
    gi.type = GradientInfo::RADIAL;
    gi.x0 = x0; gi.y0 = y0; gi.r0 = r0;
    gi.x1 = x1; gi.y1 = y1; gi.r1 = r1;
    gradients_[buf] = gi;
    return buf;
}

void GradientManager::addColorStop(const std::string &id,
                                    float offset, NVGcolor color) {
    auto it = gradients_.find(id);
    if (it == gradients_.end()) return;
    it->second.stops.push_back({offset, color});
    /* Invalidate cached texture if any */
    if (it->second.textureImage >= 0) {
        it->second.textureImage = -1; /* Will be regenerated on next buildPaint */
    }
}

/* ─── Multi-stop gradient texture generation ─────────────────────────── */

static NVGcolor lerpColor(NVGcolor a, NVGcolor b, float t) {
    NVGcolor c;
    c.r = a.r + (b.r - a.r) * t;
    c.g = a.g + (b.g - a.g) * t;
    c.b = a.b + (b.b - a.b) * t;
    c.a = a.a + (b.a - a.a) * t;
    return c;
}

static NVGcolor sampleGradient(const std::vector<ColorStop> &stops, float t) {
    if (stops.empty()) return nvgRGBA(0, 0, 0, 255);
    if (t <= stops.front().offset) return stops.front().color;
    if (t >= stops.back().offset) return stops.back().color;

    for (size_t i = 0; i + 1 < stops.size(); i++) {
        if (t >= stops[i].offset && t <= stops[i + 1].offset) {
            float range = stops[i + 1].offset - stops[i].offset;
            float local = (range > 0.0f) ? (t - stops[i].offset) / range : 0.0f;
            return lerpColor(stops[i].color, stops[i + 1].color, local);
        }
    }
    return stops.back().color;
}

int GradientManager::generateGradientTexture(NVGcontext *vg,
                                              const GradientInfo &gi) const {
    static const int TEX_WIDTH = 256;
    unsigned char pixels[TEX_WIDTH * 4];

    /* Sort stops by offset */
    std::vector<ColorStop> sorted = gi.stops;
    std::sort(sorted.begin(), sorted.end(),
              [](const ColorStop &a, const ColorStop &b) {
                  return a.offset < b.offset;
              });

    for (int i = 0; i < TEX_WIDTH; i++) {
        float t = (float)i / (float)(TEX_WIDTH - 1);
        NVGcolor c = sampleGradient(sorted, t);
        /* Pre-multiply alpha for correct blending */
        pixels[i * 4 + 0] = (unsigned char)(c.r * c.a * 255.0f);
        pixels[i * 4 + 1] = (unsigned char)(c.g * c.a * 255.0f);
        pixels[i * 4 + 2] = (unsigned char)(c.b * c.a * 255.0f);
        pixels[i * 4 + 3] = (unsigned char)(c.a * 255.0f);
    }

    int img = nvgCreateImageRGBA(vg, TEX_WIDTH, 1,
                                  NVG_IMAGE_REPEATX | NVG_IMAGE_PREMULTIPLIED,
                                  pixels);
    return img;
}

/* ─── Build paint ────────────────────────────────────────────────────── */

NVGpaint GradientManager::buildPaint(NVGcontext *vg,
                                      const std::string &id) const {
    auto it = gradients_.find(id);
    if (it == gradients_.end()) {
        NVGpaint p;
        memset(&p, 0, sizeof(p));
        nvgTransformIdentity(p.xform);
        p.innerColor = nvgRGBA(0, 0, 0, 255);
        p.outerColor = nvgRGBA(0, 0, 0, 255);
        return p;
    }

    const auto &gi = it->second;

    if (gi.stops.empty()) {
        NVGpaint p;
        memset(&p, 0, sizeof(p));
        nvgTransformIdentity(p.xform);
        p.innerColor = nvgRGBA(0, 0, 0, 255);
        p.outerColor = nvgRGBA(0, 0, 0, 255);
        return p;
    }

    if (gi.stops.size() == 1) {
        NVGpaint p;
        memset(&p, 0, sizeof(p));
        nvgTransformIdentity(p.xform);
        p.innerColor = gi.stops[0].color;
        p.outerColor = gi.stops[0].color;
        return p;
    }

    /* 2-stop gradient: use native NanoVG */
    if (gi.stops.size() == 2) {
        NVGcolor c0 = gi.stops.front().color;
        NVGcolor c1 = gi.stops.back().color;

        if (gi.type == GradientInfo::LINEAR) {
            return nvgLinearGradient(vg, gi.x0, gi.y0, gi.x1, gi.y1, c0, c1);
        } else {
            return nvgRadialGradient(vg, gi.x1, gi.y1, gi.r0, gi.r1, c0, c1);
        }
    }

    /* 3+ stops: texture-based gradient */
    if (gi.textureImage < 0) {
        gi.textureImage = generateGradientTexture(vg, gi);
    }

    if (gi.textureImage < 0) {
        /* Fallback to first/last */
        NVGcolor c0 = gi.stops.front().color;
        NVGcolor c1 = gi.stops.back().color;
        if (gi.type == GradientInfo::LINEAR) {
            return nvgLinearGradient(vg, gi.x0, gi.y0, gi.x1, gi.y1, c0, c1);
        } else {
            return nvgRadialGradient(vg, gi.x1, gi.y1, gi.r0, gi.r1, c0, c1);
        }
    }

    /* Map the 1D texture to the gradient line direction */
    if (gi.type == GradientInfo::LINEAR) {
        /* Image pattern oriented along the gradient line */
        float dx = gi.x1 - gi.x0;
        float dy = gi.y1 - gi.y0;
        float len = sqrtf(dx * dx + dy * dy);
        float angle = atan2f(dy, dx);

        return nvgImagePattern(vg, gi.x0, gi.y0 - 0.5f,
                               len, 1.0f, angle, gi.textureImage, 1.0f);
    } else {
        /* Radial: approximate using the radial gradient texture */
        /* NanoVG doesn't support arbitrary image-based radial gradients,
           so fall back to the 2-stop native approach for radial multi-stop */
        NVGcolor c0 = gi.stops.front().color;
        NVGcolor c1 = gi.stops.back().color;
        return nvgRadialGradient(vg, gi.x1, gi.y1, gi.r0, gi.r1, c0, c1);
    }
}

bool GradientManager::has(const std::string &id) const {
    return gradients_.find(id) != gradients_.end();
}

void GradientManager::remove(const std::string &id) {
    gradients_.erase(id);
}

void GradientManager::clear() {
    gradients_.clear();
    nextId_ = 0;
}

void GradientManager::clearTextures(NVGcontext *vg) {
    for (auto &p : gradients_) {
        if (p.second.textureImage >= 0) {
            nvgDeleteImage(vg, p.second.textureImage);
            p.second.textureImage = -1;
        }
    }
}

void GradientManager::store(const std::string &id, const GradientInfo &info) {
    gradients_[id] = info;
}
