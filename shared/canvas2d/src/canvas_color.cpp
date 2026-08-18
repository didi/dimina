#include "canvas_color.h"
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <cmath>
#include <algorithm>
#include <cctype>

/* ── Named CSS colors (subset covering the 17 standard + transparent) ──── */

struct NamedColor {
    const char *name;
    unsigned char r, g, b, a;
};

static const NamedColor kNamedColors[] = {
    {"transparent",   0,   0,   0,   0},
    {"black",         0,   0,   0, 255},
    {"white",       255, 255, 255, 255},
    {"red",         255,   0,   0, 255},
    {"green",         0, 128,   0, 255},
    {"blue",          0,   0, 255, 255},
    {"yellow",      255, 255,   0, 255},
    {"cyan",          0, 255, 255, 255},
    {"magenta",     255,   0, 255, 255},
    {"orange",      255, 165,   0, 255},
    {"purple",      128,   0, 128, 255},
    {"gray",        128, 128, 128, 255},
    {"grey",        128, 128, 128, 255},
    {"silver",      192, 192, 192, 255},
    {"maroon",      128,   0,   0, 255},
    {"olive",       128, 128,   0, 255},
    {"lime",          0, 255,   0, 255},
    {"aqua",          0, 255, 255, 255},
    {"teal",          0, 128, 128, 255},
    {"navy",          0,   0, 128, 255},
    {"fuchsia",     255,   0, 255, 255},
    {"brown",       165,  42,  42, 255},
    {"coral",       255, 127,  80, 255},
    {"crimson",     220,  20,  60, 255},
    {"darkblue",      0,   0, 139, 255},
    {"darkgray",    169, 169, 169, 255},
    {"darkgreen",     0, 100,   0, 255},
    {"darkred",     139,   0,   0, 255},
    {"gold",        255, 215,   0, 255},
    {"hotpink",     255, 105, 180, 255},
    {"indianred",   205,  92,  92, 255},
    {"ivory",       255, 255, 240, 255},
    {"khaki",       240, 230, 140, 255},
    {"lavender",    230, 230, 250, 255},
    {"lightblue",   173, 216, 230, 255},
    {"lightgray",   211, 211, 211, 255},
    {"lightgreen",  144, 238, 144, 255},
    {"lightyellow", 255, 255, 224, 255},
    {"pink",        255, 192, 203, 255},
    {"plum",        221, 160, 221, 255},
    {"salmon",      250, 128, 114, 255},
    {"skyblue",     135, 206, 235, 255},
    {"tomato",      255,  99,  71, 255},
    {"violet",      238, 130, 238, 255},
    {"wheat",       245, 222, 179, 255},
};

static int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
}

static std::string toLower(const std::string &s) {
    std::string r = s;
    for (auto &c : r) c = (char)std::tolower((unsigned char)c);
    return r;
}

static std::string trim(const std::string &s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end - start + 1);
}

/* ── HSL to RGB ───────────────────────────────────────────────────────── */

static float hue2rgb(float p, float q, float t) {
    if (t < 0.0f) t += 1.0f;
    if (t > 1.0f) t -= 1.0f;
    if (t < 1.0f / 6.0f) return p + (q - p) * 6.0f * t;
    if (t < 1.0f / 2.0f) return q;
    if (t < 2.0f / 3.0f) return p + (q - p) * (2.0f / 3.0f - t) * 6.0f;
    return p;
}

static NVGcolor hslToColor(float h, float s, float l, float a) {
    h = fmodf(h, 360.0f);
    if (h < 0) h += 360.0f;
    h /= 360.0f;
    s = std::max(0.0f, std::min(1.0f, s));
    l = std::max(0.0f, std::min(1.0f, l));

    float r, g, b;
    if (s == 0.0f) {
        r = g = b = l;
    } else {
        float q = l < 0.5f ? l * (1.0f + s) : l + s - l * s;
        float p = 2.0f * l - q;
        r = hue2rgb(p, q, h + 1.0f / 3.0f);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1.0f / 3.0f);
    }
    return nvgRGBAf(r, g, b, a);
}

/* ── Public ────────────────────────────────────────────────────────────── */

NVGcolor parseCanvasColor(const std::string &colorStr) {
    std::string s = trim(colorStr);
    if (s.empty()) return nvgRGBA(0, 0, 0, 255);

    /* Named colors */
    std::string low = toLower(s);
    for (const auto &nc : kNamedColors) {
        if (low == nc.name) {
            return nvgRGBA(nc.r, nc.g, nc.b, nc.a);
        }
    }

    /* Hex: #RGB, #RRGGBB, #RGBA, #RRGGBBAA */
    if (s[0] == '#') {
        size_t len = s.size() - 1;
        const char *p = s.c_str() + 1;
        unsigned char r = 0, g = 0, b = 0, a = 255;
        if (len == 3) {
            r = (unsigned char)(hexVal(p[0]) * 17);
            g = (unsigned char)(hexVal(p[1]) * 17);
            b = (unsigned char)(hexVal(p[2]) * 17);
        } else if (len == 4) {
            r = (unsigned char)(hexVal(p[0]) * 17);
            g = (unsigned char)(hexVal(p[1]) * 17);
            b = (unsigned char)(hexVal(p[2]) * 17);
            a = (unsigned char)(hexVal(p[3]) * 17);
        } else if (len == 6) {
            r = (unsigned char)(hexVal(p[0]) * 16 + hexVal(p[1]));
            g = (unsigned char)(hexVal(p[2]) * 16 + hexVal(p[3]));
            b = (unsigned char)(hexVal(p[4]) * 16 + hexVal(p[5]));
        } else if (len == 8) {
            r = (unsigned char)(hexVal(p[0]) * 16 + hexVal(p[1]));
            g = (unsigned char)(hexVal(p[2]) * 16 + hexVal(p[3]));
            b = (unsigned char)(hexVal(p[4]) * 16 + hexVal(p[5]));
            a = (unsigned char)(hexVal(p[6]) * 16 + hexVal(p[7]));
        }
        return nvgRGBA(r, g, b, a);
    }

    /* rgb(r, g, b) / rgba(r, g, b, a) */
    if (low.rfind("rgb", 0) == 0) {
        int r = 0, g = 0, b = 0;
        float a = 1.0f;
        auto paren = s.find('(');
        if (paren != std::string::npos) {
            auto inner = s.substr(paren + 1);
            /* Remove trailing ')' */
            auto cp = inner.find(')');
            if (cp != std::string::npos) inner = inner.substr(0, cp);

            if (sscanf(inner.c_str(), "%d , %d , %d , %f", &r, &g, &b, &a) < 3) {
                sscanf(inner.c_str(), "%d %d %d / %f", &r, &g, &b, &a);
            }
        }
        r = std::max(0, std::min(255, r));
        g = std::max(0, std::min(255, g));
        b = std::max(0, std::min(255, b));
        a = std::max(0.0f, std::min(1.0f, a));
        return nvgRGBA((unsigned char)r, (unsigned char)g, (unsigned char)b,
                       (unsigned char)(a * 255.0f));
    }

    /* hsl(h, s%, l%) / hsla(h, s%, l%, a) */
    if (low.rfind("hsl", 0) == 0) {
        float h = 0, s = 0, l = 0, a = 1.0f;
        auto paren = low.find('(');
        if (paren != std::string::npos) {
            auto inner = low.substr(paren + 1);
            auto cp = inner.find(')');
            if (cp != std::string::npos) inner = inner.substr(0, cp);

            /* Replace % with space for easier parsing */
            for (auto &c : inner) { if (c == '%') c = ' '; }
            sscanf(inner.c_str(), "%f , %f , %f , %f", &h, &s, &l, &a);
        }
        return hslToColor(h, s / 100.0f, l / 100.0f,
                          std::max(0.0f, std::min(1.0f, a)));
    }

    /* Fallback: black */
    return nvgRGBA(0, 0, 0, 255);
}
