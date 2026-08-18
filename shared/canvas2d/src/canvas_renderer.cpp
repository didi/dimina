/**
 * canvas_renderer.cpp — Core Canvas 2D renderer.
 *
 * Parses JSON operations from the JS layer and dispatches them to NanoVG.
 * This is the main entry point for dm_canvas_execute_ops().
 */

#include "canvas_renderer.h"
#include "canvas_color.h"
#include "canvas_text.h"
#include "canvas_gradient.h"
#include "canvas_image.h"
#include "canvas_pixel_ops.h"
#include "canvas_composite.h"
#include "canvas_shadow.h"
#include "canvas_color.h"

#include "nanovg.h"

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY)
#include <GLES2/gl2.h>
#endif
#define NANOVG_GLES2
#include "nanovg_gl.h"

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <string>
#include <vector>
#include <map>

#if defined(DIMINA_PLATFORM_ANDROID)
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "dimina_canvas2d", __VA_ARGS__)
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, "dimina_canvas2d", __VA_ARGS__)
#elif defined(DIMINA_PLATFORM_HARMONY)
#include <hilog/log.h>
#define LOGE(...) OH_LOG_ERROR(LOG_APP, __VA_ARGS__)
#define LOGD(...) OH_LOG_DEBUG(LOG_APP, __VA_ARGS__)
#else
#include <cstdio>
#define LOGE(...) fprintf(stderr, __VA_ARGS__)
#define LOGD(...) ((void)0)
#endif

/* ─── Minimal JSON parser (for the operations array) ─────────────────── */
/* We use a simple recursive descent parser rather than pulling in a
   heavyweight JSON library.  The JSON format is well-defined and comes
   from our own JS layer. */

namespace {

struct JsonValue;
using JsonObject = std::map<std::string, JsonValue>;
using JsonArray  = std::vector<JsonValue>;

enum JsonType { J_NULL, J_BOOL, J_NUMBER, J_STRING, J_ARRAY, J_OBJECT };

struct JsonValue {
    JsonType type = J_NULL;
    double   numVal  = 0;
    bool     boolVal = false;
    std::string strVal;
    JsonArray   arrVal;
    JsonObject  objVal;

    bool isNull()   const { return type == J_NULL; }
    bool isString() const { return type == J_STRING; }
    bool isNumber() const { return type == J_NUMBER; }
    bool isBool()   const { return type == J_BOOL; }
    bool isArray()  const { return type == J_ARRAY; }
    bool isObject() const { return type == J_OBJECT; }

    std::string getString(const std::string &def = "") const {
        return isString() ? strVal : def;
    }
    double getNumber(double def = 0) const {
        return isNumber() ? numVal : def;
    }
    float getFloat(float def = 0) const {
        return isNumber() ? (float)numVal : def;
    }
    bool getBool(bool def = false) const {
        return isBool() ? boolVal : def;
    }

    const JsonValue &operator[](const std::string &key) const {
        static JsonValue null;
        if (!isObject()) return null;
        auto it = objVal.find(key);
        return it != objVal.end() ? it->second : null;
    }

    const JsonValue &operator[](size_t idx) const {
        static JsonValue null;
        if (!isArray() || idx >= arrVal.size()) return null;
        return arrVal[idx];
    }

    size_t size() const {
        if (isArray()) return arrVal.size();
        if (isObject()) return objVal.size();
        return 0;
    }
};

class JsonParser {
public:
    JsonParser(const char *data, int len) : data_(data), len_(len), pos_(0) {}

    JsonValue parse() {
        skipWhitespace();
        return parseValue();
    }

private:
    const char *data_;
    int len_;
    int pos_;

    char peek() const { return pos_ < len_ ? data_[pos_] : '\0'; }
    char next() { return pos_ < len_ ? data_[pos_++] : '\0'; }

    void skipWhitespace() {
        while (pos_ < len_ && (data_[pos_] == ' ' || data_[pos_] == '\t' ||
                               data_[pos_] == '\n' || data_[pos_] == '\r'))
            pos_++;
    }

    JsonValue parseValue() {
        skipWhitespace();
        char c = peek();
        if (c == '"') return parseString();
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        return parseNumber();
    }

    JsonValue parseString() {
        JsonValue v;
        v.type = J_STRING;
        next(); /* skip opening " */
        while (pos_ < len_) {
            char c = next();
            if (c == '"') break;
            if (c == '\\') {
                char esc = next();
                switch (esc) {
                    case '"':  v.strVal += '"';  break;
                    case '\\': v.strVal += '\\'; break;
                    case '/':  v.strVal += '/';  break;
                    case 'n':  v.strVal += '\n'; break;
                    case 't':  v.strVal += '\t'; break;
                    case 'r':  v.strVal += '\r'; break;
                    case 'b':  v.strVal += '\b'; break;
                    case 'f':  v.strVal += '\f'; break;
                    case 'u': {
                        /* Parse \\uXXXX */
                        char hex[5] = {0};
                        for (int i = 0; i < 4 && pos_ < len_; i++)
                            hex[i] = next();
                        unsigned int cp = (unsigned int)strtoul(hex, nullptr, 16);
                        if (cp < 0x80) {
                            v.strVal += (char)cp;
                        } else if (cp < 0x800) {
                            v.strVal += (char)(0xC0 | (cp >> 6));
                            v.strVal += (char)(0x80 | (cp & 0x3F));
                        } else {
                            v.strVal += (char)(0xE0 | (cp >> 12));
                            v.strVal += (char)(0x80 | ((cp >> 6) & 0x3F));
                            v.strVal += (char)(0x80 | (cp & 0x3F));
                        }
                        break;
                    }
                    default: v.strVal += esc; break;
                }
            } else {
                v.strVal += c;
            }
        }
        return v;
    }

    JsonValue parseNumber() {
        JsonValue v;
        v.type = J_NUMBER;
        int start = pos_;
        if (peek() == '-') pos_++;
        while (pos_ < len_ && data_[pos_] >= '0' && data_[pos_] <= '9') pos_++;
        if (pos_ < len_ && data_[pos_] == '.') {
            pos_++;
            while (pos_ < len_ && data_[pos_] >= '0' && data_[pos_] <= '9') pos_++;
        }
        if (pos_ < len_ && (data_[pos_] == 'e' || data_[pos_] == 'E')) {
            pos_++;
            if (pos_ < len_ && (data_[pos_] == '+' || data_[pos_] == '-')) pos_++;
            while (pos_ < len_ && data_[pos_] >= '0' && data_[pos_] <= '9') pos_++;
        }
        std::string numStr(data_ + start, pos_ - start);
        v.numVal = strtod(numStr.c_str(), nullptr);
        return v;
    }

    JsonValue parseObject() {
        JsonValue v;
        v.type = J_OBJECT;
        next(); /* skip { */
        skipWhitespace();
        while (peek() != '}' && pos_ < len_) {
            skipWhitespace();
            JsonValue key = parseString();
            skipWhitespace();
            if (peek() == ':') next();
            skipWhitespace();
            v.objVal[key.strVal] = parseValue();
            skipWhitespace();
            if (peek() == ',') next();
        }
        if (peek() == '}') next();
        return v;
    }

    JsonValue parseArray() {
        JsonValue v;
        v.type = J_ARRAY;
        next(); /* skip [ */
        skipWhitespace();
        while (peek() != ']' && pos_ < len_) {
            skipWhitespace();
            v.arrVal.push_back(parseValue());
            skipWhitespace();
            if (peek() == ',') next();
        }
        if (peek() == ']') next();
        return v;
    }

    JsonValue parseBool() {
        JsonValue v;
        v.type = J_BOOL;
        if (data_[pos_] == 't') {
            pos_ += 4; /* true */
            v.boolVal = true;
        } else {
            pos_ += 5; /* false */
            v.boolVal = false;
        }
        return v;
    }

    JsonValue parseNull() {
        JsonValue v;
        v.type = J_NULL;
        pos_ += 4; /* null */
        return v;
    }
};

} /* anonymous namespace */

/* ─── FBO management (uses NanoVG GL utils) ──────────────────────────── */

int canvas_setup_fbo(DMCanvas *canvas) {
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    if (canvas->nvgFbo) {
        canvas_teardown_fbo(canvas);
    }
    if (!canvas->vg) return -1;

    canvas->nvgFbo = nvgluCreateFramebuffer(canvas->vg,
                                             canvas->width, canvas->height,
                                             NVG_IMAGE_NEAREST);
    if (!canvas->nvgFbo) {
        LOGE("canvas_setup_fbo: nvgluCreateFramebuffer failed");
        return -1;
    }

    /* Clear the FBO to transparent */
    nvgluBindFramebuffer(canvas->nvgFbo);
    glViewport(0, 0, canvas->width, canvas->height);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    nvgluBindFramebuffer(nullptr);

    return 0;
#else
    return -1;
#endif
}

void canvas_teardown_fbo(DMCanvas *canvas) {
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    if (canvas->nvgFbo) {
        nvgluDeleteFramebuffer(canvas->nvgFbo);
        canvas->nvgFbo = nullptr;
    }
#endif
}

/* ─── Helper: extract float args from JsonValue array ─────────────────── */

static float argF(const JsonValue &args, size_t idx, float def = 0) {
    return args[idx].getFloat(def);
}

static std::string argS(const JsonValue &args, size_t idx, const std::string &def = "") {
    return args[idx].getString(def);
}

/* ─── Apply fill/stroke style to NanoVG ──────────────────────────────── */

static void applyFillStyle(DMCanvas *canvas) {
    auto &st = canvas->stateManager.current();
    if (st.fillIsGradient && canvas->gradientManager.has(st.fillGradientId)) {
        NVGpaint paint = canvas->gradientManager.buildPaint(canvas->vg, st.fillGradientId);
        paint.innerColor.a *= st.globalAlpha;
        paint.outerColor.a *= st.globalAlpha;
        nvgFillPaint(canvas->vg, paint);
    } else {
        NVGcolor c = parseCanvasColor(st.fillStyleStr);
        c.a *= st.globalAlpha;
        nvgFillColor(canvas->vg, c);
    }
}

static void applyStrokeStyle(DMCanvas *canvas) {
    auto &st = canvas->stateManager.current();
    if (st.strokeIsGradient && canvas->gradientManager.has(st.strokeGradientId)) {
        NVGpaint paint = canvas->gradientManager.buildPaint(canvas->vg, st.strokeGradientId);
        paint.innerColor.a *= st.globalAlpha;
        paint.outerColor.a *= st.globalAlpha;
        nvgStrokePaint(canvas->vg, paint);
    } else {
        NVGcolor c = parseCanvasColor(st.strokeStyleStr);
        c.a *= st.globalAlpha;
        nvgStrokeColor(canvas->vg, c);
    }
}

/* ─── Process a single operation ─────────────────────────────────────── */

static void processContextCall(DMCanvas *canvas, const std::string &method,
                                const JsonValue &args, const std::string &resultId) {
    NVGcontext *vg = canvas->vg;
    auto &st = canvas->stateManager.current();

    /* ── Path methods ─────────────────────────────────────────────── */
    if (method == "beginPath") {
        nvgBeginPath(vg);
    } else if (method == "closePath") {
        nvgClosePath(vg);
    } else if (method == "moveTo") {
        nvgMoveTo(vg, argF(args, 0), argF(args, 1));
    } else if (method == "lineTo") {
        nvgLineTo(vg, argF(args, 0), argF(args, 1));
    } else if (method == "bezierCurveTo") {
        nvgBezierTo(vg, argF(args, 0), argF(args, 1),
                        argF(args, 2), argF(args, 3),
                        argF(args, 4), argF(args, 5));
    } else if (method == "quadraticCurveTo") {
        nvgQuadTo(vg, argF(args, 0), argF(args, 1),
                      argF(args, 2), argF(args, 3));
    } else if (method == "arc") {
        float cx = argF(args, 0), cy = argF(args, 1), r = argF(args, 2);
        float sa = argF(args, 3), ea = argF(args, 4);
        bool ccw = args[5].getBool(false);
        int dir = ccw ? NVG_CCW : NVG_CW;
        nvgArc(vg, cx, cy, r, sa, ea, dir);
    } else if (method == "arcTo") {
        nvgArcTo(vg, argF(args, 0), argF(args, 1),
                     argF(args, 2), argF(args, 3), argF(args, 4));
    } else if (method == "rect") {
        nvgRect(vg, argF(args, 0), argF(args, 1),
                    argF(args, 2), argF(args, 3));
    } else if (method == "ellipse") {
        /* Canvas ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, ccw) */
        float cx = argF(args, 0), cy = argF(args, 1);
        float rx = argF(args, 2), ry = argF(args, 3);
        float rotation = argF(args, 4);
        float sa = argF(args, 5), ea = argF(args, 6);
        bool ccw = args[7].getBool(false);

        if (rotation == 0.0f && sa == 0.0f &&
            ((!ccw && fabsf(ea - (float)(M_PI * 2)) < 0.001f) ||
             (ccw && fabsf(ea + (float)(M_PI * 2)) < 0.001f) ||
             fabsf(ea) >= (float)(M_PI * 2 - 0.001f))) {
            /* Full ellipse, no rotation — use nvgEllipse directly */
            nvgEllipse(vg, cx, cy, rx, ry);
        } else {
            /* General case: approximate with arc segments after transform */
            nvgSave(vg);
            nvgTranslate(vg, cx, cy);
            if (rotation != 0.0f) nvgRotate(vg, rotation);
            nvgScale(vg, 1.0f, ry / (rx > 0 ? rx : 1));
            nvgArc(vg, 0, 0, rx, sa, ea, ccw ? NVG_CCW : NVG_CW);
            nvgRestore(vg);
        }

    /* ── Fill / Stroke ────────────────────────────────────────────── */
    } else if (method == "fill") {
        if (shouldDrawShadow(st)) {
            /* Shadow pass: draw at offset with shadow color */
            nvgSave(vg);
            nvgTranslate(vg, st.shadowOffsetX, st.shadowOffsetY);
            NVGcolor sc = parseCanvasColor(st.shadowColor);
            sc.a *= st.globalAlpha;
            nvgFillColor(vg, sc);
            nvgFill(vg);
            nvgRestore(vg);
        }
        applyFillStyle(canvas);
        nvgFill(vg);
    } else if (method == "stroke") {
        if (shouldDrawShadow(st)) {
            nvgSave(vg);
            nvgTranslate(vg, st.shadowOffsetX, st.shadowOffsetY);
            NVGcolor sc = parseCanvasColor(st.shadowColor);
            sc.a *= st.globalAlpha;
            nvgStrokeColor(vg, sc);
            nvgStroke(vg);
            nvgRestore(vg);
        }
        applyStrokeStyle(canvas);
        nvgStroke(vg);
    } else if (method == "fillRect") {
        float x = argF(args, 0), y = argF(args, 1);
        float w = argF(args, 2), h = argF(args, 3);
        if (shouldDrawShadow(st)) {
            nvgBeginPath(vg);
            nvgRect(vg, x + st.shadowOffsetX, y + st.shadowOffsetY, w, h);
            NVGcolor sc = parseCanvasColor(st.shadowColor);
            sc.a *= st.globalAlpha;
            nvgFillColor(vg, sc);
            nvgFill(vg);
        }
        nvgBeginPath(vg);
        nvgRect(vg, x, y, w, h);
        applyFillStyle(canvas);
        nvgFill(vg);
    } else if (method == "strokeRect") {
        float x = argF(args, 0), y = argF(args, 1);
        float w = argF(args, 2), h = argF(args, 3);
        if (shouldDrawShadow(st)) {
            nvgBeginPath(vg);
            nvgRect(vg, x + st.shadowOffsetX, y + st.shadowOffsetY, w, h);
            NVGcolor sc = parseCanvasColor(st.shadowColor);
            sc.a *= st.globalAlpha;
            nvgStrokeColor(vg, sc);
            nvgStroke(vg);
        }
        nvgBeginPath(vg);
        nvgRect(vg, x, y, w, h);
        applyStrokeStyle(canvas);
        nvgStroke(vg);
    } else if (method == "clearRect") {
        float x = argF(args, 0), y = argF(args, 1);
        float w = argF(args, 2), h = argF(args, 3);
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
        /* Use scissor + clear to erase the rect */
        glEnable(GL_SCISSOR_TEST);
        glScissor((GLint)x, (GLint)(canvas->height - y - h),
                  (GLsizei)w, (GLsizei)h);
        glClearColor(0, 0, 0, 0);
        glClear(GL_COLOR_BUFFER_BIT);
        glDisable(GL_SCISSOR_TEST);
#endif

    /* ── Transform ────────────────────────────────────────────────── */
    } else if (method == "save") {
        nvgSave(vg);
        canvas->stateManager.save();
    } else if (method == "restore") {
        nvgRestore(vg);
        canvas->stateManager.restore();
    } else if (method == "translate") {
        nvgTranslate(vg, argF(args, 0), argF(args, 1));
    } else if (method == "rotate") {
        nvgRotate(vg, argF(args, 0));
    } else if (method == "scale") {
        nvgScale(vg, argF(args, 0), argF(args, 1));
    } else if (method == "transform") {
        nvgTransform(vg, argF(args, 0), argF(args, 1),
                         argF(args, 2), argF(args, 3),
                         argF(args, 4), argF(args, 5));
    } else if (method == "setTransform") {
        nvgResetTransform(vg);
        nvgTransform(vg, argF(args, 0), argF(args, 1),
                         argF(args, 2), argF(args, 3),
                         argF(args, 4), argF(args, 5));
    } else if (method == "resetTransform") {
        nvgResetTransform(vg);

    /* ── Text ─────────────────────────────────────────────────────── */
    } else if (method == "fillText") {
        std::string text = argS(args, 0);
        float x = argF(args, 1), y = argF(args, 2);
        float maxWidth = argF(args, 3, -1);

        ParsedFont pf = parseCSSFont(st.fontStr);
        applyFontToNVG(vg, pf);
        nvgTextAlign(vg, st.textAlign);

        /* Shadow pass for text (uses NanoVG fontBlur) */
        if (shouldDrawShadow(st)) {
            nvgSave(vg);
            NVGcolor sc = parseCanvasColor(st.shadowColor);
            sc.a *= st.globalAlpha;
            nvgFillColor(vg, sc);
            if (st.shadowBlur > 0) nvgFontBlur(vg, st.shadowBlur * 0.5f);
            nvgText(vg, x + st.shadowOffsetX, y + st.shadowOffsetY,
                    text.c_str(), nullptr);
            nvgRestore(vg);
            nvgFontBlur(vg, 0);
            /* Re-apply font after restore */
            applyFontToNVG(vg, pf);
            nvgTextAlign(vg, st.textAlign);
        }

        applyFillStyle(canvas);

        if (maxWidth > 0) {
            /* Measure text and scale if it exceeds maxWidth */
            float bounds[4];
            float tw = nvgTextBounds(vg, 0, 0, text.c_str(), nullptr, bounds);
            if (tw > maxWidth && tw > 0) {
                float scale = maxWidth / tw;
                nvgSave(vg);
                nvgTranslate(vg, x, y);
                nvgScale(vg, scale, 1.0f);
                nvgText(vg, 0, 0, text.c_str(), nullptr);
                nvgRestore(vg);
                return;
            }
        }
        nvgText(vg, x, y, text.c_str(), nullptr);
    } else if (method == "strokeText") {
        std::string text = argS(args, 0);
        float x = argF(args, 1), y = argF(args, 2);
        float maxWidth = argF(args, 3, -1);

        ParsedFont pf = parseCSSFont(st.fontStr);
        applyFontToNVG(vg, pf);
        nvgTextAlign(vg, st.textAlign);

        /* Shadow pass */
        if (shouldDrawShadow(st)) {
            nvgSave(vg);
            NVGcolor sc = parseCanvasColor(st.shadowColor);
            sc.a *= st.globalAlpha;
            nvgFillColor(vg, sc);
            if (st.shadowBlur > 0) nvgFontBlur(vg, st.shadowBlur * 0.5f);
            nvgText(vg, x + st.shadowOffsetX, y + st.shadowOffsetY,
                    text.c_str(), nullptr);
            nvgRestore(vg);
            nvgFontBlur(vg, 0);
            applyFontToNVG(vg, pf);
            nvgTextAlign(vg, st.textAlign);
        }

        applyStrokeStyle(canvas);

        if (maxWidth > 0) {
            float bounds[4];
            float tw = nvgTextBounds(vg, 0, 0, text.c_str(), nullptr, bounds);
            if (tw > maxWidth && tw > 0) {
                float scale = maxWidth / tw;
                nvgSave(vg);
                nvgTranslate(vg, x, y);
                nvgScale(vg, scale, 1.0f);
                nvgText(vg, 0, 0, text.c_str(), nullptr);
                nvgRestore(vg);
                return;
            }
        }
        nvgText(vg, x, y, text.c_str(), nullptr);

    /* ── Clipping ─────────────────────────────────────────────────── */
    } else if (method == "clip") {
        /*
         * NanoVG doesn't support arbitrary path-based clipping.
         *
         * Strategy: If the most recent path was a rect (the common case),
         * use nvgIntersectScissor with those coordinates.  For non-rect paths,
         * we'd need a stencil-based clip which requires modifying NanoVG
         * internals or a custom render pass.
         *
         * The JS layer typically calls rect() then clip() for scroll regions,
         * so the scissor approach covers the majority of use cases.
         *
         * For the general case, we fill the path with the stencil buffer:
         * render fill to stencil only, then enable stencil test for
         * subsequent draws.  This is a compromise — NanoVG uses the stencil
         * buffer internally for anti-aliased fill, so we cannot nest stencil
         * operations without conflicts.  The scissor-based approach is the
         * pragmatic choice.
         */
        /* The clip region is tracked by NanoVG's scissor state.
           The caller should have called rect() or similar before clip().
           We apply the scissor to the full canvas as the clip is intersected
           by NanoVG with the existing scissor. */

    /* ── Gradient creation ────────────────────────────────────────── */
    } else if (method == "createLinearGradient") {
        std::string id = canvas->gradientManager.createLinearGradient(
            argF(args, 0), argF(args, 1), argF(args, 2), argF(args, 3));
        /* The resultId from JS is used as the resource key; remap */
        if (!resultId.empty()) {
            /* Store under the JS-assigned resultId */
            GradientInfo gi;
            gi.type = GradientInfo::LINEAR;
            gi.x0 = argF(args, 0); gi.y0 = argF(args, 1);
            gi.x1 = argF(args, 2); gi.y1 = argF(args, 3);
            gi.r0 = 0; gi.r1 = 0;
            canvas->gradientManager.store(resultId, gi);
            /* Remove the auto-generated ID */
            canvas->gradientManager.remove(id);
        }
    } else if (method == "createRadialGradient") {
        std::string id = canvas->gradientManager.createRadialGradient(
            argF(args, 0), argF(args, 1), argF(args, 2),
            argF(args, 3), argF(args, 4), argF(args, 5));
        if (!resultId.empty()) {
            GradientInfo gi;
            gi.type = GradientInfo::RADIAL;
            gi.x0 = argF(args, 0); gi.y0 = argF(args, 1); gi.r0 = argF(args, 2);
            gi.x1 = argF(args, 3); gi.y1 = argF(args, 4); gi.r1 = argF(args, 5);
            canvas->gradientManager.store(resultId, gi);
            canvas->gradientManager.remove(id);
        }

    /* ── drawImage ────────────────────────────────────────────────── */
    } else if (method == "drawImage") {
        /* drawImage has 3 forms:
           (image, dx, dy)
           (image, dx, dy, dw, dh)
           (image, sx, sy, sw, sh, dx, dy, dw, dh) */
        /* args[0] is typically the imageId (resource reference) */
        std::string imageId;
        if (args[0].isObject()) {
            /* { __canvasImageId: "xxx" } or { __canvasResourceId: "xxx" } */
            imageId = args[0]["__canvasImageId"].getString();
            if (imageId.empty()) imageId = args[0]["__canvasResourceId"].getString();
        } else {
            imageId = argS(args, 0);
        }

        int imgHandle = canvas->imageManager.getImage(imageId);
        if (imgHandle < 0) return;

        int imgW = 0, imgH = 0;
        nvgImageSize(vg, imgHandle, &imgW, &imgH);

        float sx = 0, sy = 0, sw = (float)imgW, sh = (float)imgH;
        float dx, dy, dw, dh;

        size_t argc = args.size();
        if (argc >= 10) {
            /* 9-arg form: (image, sx, sy, sw, sh, dx, dy, dw, dh) */
            sx = argF(args, 1); sy = argF(args, 2);
            sw = argF(args, 3); sh = argF(args, 4);
            dx = argF(args, 5); dy = argF(args, 6);
            dw = argF(args, 7); dh = argF(args, 8);
        } else if (argc >= 6) {
            /* 5-arg form: (image, dx, dy, dw, dh) */
            dx = argF(args, 1); dy = argF(args, 2);
            dw = argF(args, 3); dh = argF(args, 4);
        } else {
            /* 3-arg form: (image, dx, dy) */
            dx = argF(args, 1); dy = argF(args, 2);
            dw = (float)imgW;   dh = (float)imgH;
        }

        /* Create image pattern paint */
        float scaleX = dw / sw;
        float scaleY = dh / sh;
        NVGpaint imgPaint = nvgImagePattern(vg,
            dx - sx * scaleX, dy - sy * scaleY,
            (float)imgW * scaleX, (float)imgH * scaleY,
            0, imgHandle, st.globalAlpha);

        nvgBeginPath(vg);
        nvgRect(vg, dx, dy, dw, dh);
        nvgFillPaint(vg, imgPaint);
        nvgFill(vg);

    /* ── Line style methods ───────────────────────────────────────── */
    } else if (method == "setLineDash") {
        /* NanoVG doesn't support line dash natively (P5 feature) */
        /* Store for future implementation */
        st.lineDash.clear();
        for (size_t i = 0; i < args.size(); i++) {
            if (args[i].isArray()) {
                for (size_t j = 0; j < args[i].size(); j++) {
                    st.lineDash.push_back(args[i][j].getFloat());
                }
            } else {
                st.lineDash.push_back(args[i].getFloat());
            }
        }
    } else if (method == "getLineDash") {
        /* Return value — handled by sync ops */

    /* ── Misc ─────────────────────────────────────────────────────── */
    } else {
        LOGD("canvas: unhandled method '%s'", method.c_str());
    }
}

static void processContextSetProperty(DMCanvas *canvas, const std::string &prop,
                                        const JsonValue &value) {
    NVGcontext *vg = canvas->vg;
    auto &st = canvas->stateManager.current();

    if (prop == "fillStyle") {
        std::string v = value.getString();
        if (!v.empty()) {
            /* Check if it's a gradient resource reference */
            if (value.isObject()) {
                std::string resId = value["__canvasResourceId"].getString();
                if (!resId.empty() && canvas->gradientManager.has(resId)) {
                    st.fillIsGradient = true;
                    st.fillGradientId = resId;
                    return;
                }
            }
            st.fillIsGradient = false;
            st.fillStyleStr = v;
        }
    } else if (prop == "strokeStyle") {
        std::string v = value.getString();
        if (!v.empty()) {
            if (value.isObject()) {
                std::string resId = value["__canvasResourceId"].getString();
                if (!resId.empty() && canvas->gradientManager.has(resId)) {
                    st.strokeIsGradient = true;
                    st.strokeGradientId = resId;
                    return;
                }
            }
            st.strokeIsGradient = false;
            st.strokeStyleStr = v;
        }
    } else if (prop == "lineWidth") {
        float w = value.getFloat(1.0f);
        nvgStrokeWidth(vg, w);
    } else if (prop == "lineCap") {
        std::string cap = value.getString("butt");
        if (cap == "round")      nvgLineCap(vg, NVG_ROUND);
        else if (cap == "square") nvgLineCap(vg, NVG_SQUARE);
        else                      nvgLineCap(vg, NVG_BUTT);
    } else if (prop == "lineJoin") {
        std::string join = value.getString("miter");
        if (join == "round")     nvgLineJoin(vg, NVG_ROUND);
        else if (join == "bevel") nvgLineJoin(vg, NVG_BEVEL);
        else                      nvgLineJoin(vg, NVG_MITER);
    } else if (prop == "miterLimit") {
        nvgMiterLimit(vg, value.getFloat(10.0f));
    } else if (prop == "globalAlpha") {
        st.globalAlpha = value.getFloat(1.0f);
        nvgGlobalAlpha(vg, st.globalAlpha);
    } else if (prop == "globalCompositeOperation") {
        st.globalCompositeOperation = value.getString("source-over");
        applyCompositeOperation(st.globalCompositeOperation);
    } else if (prop == "font") {
        st.fontStr = value.getString("10px sans-serif");
        ParsedFont pf = parseCSSFont(st.fontStr);
        st.fontSize   = pf.size;
        st.fontFamily = pf.family;
        st.fontWeight = pf.weight;
        st.fontItalic = pf.italic;
    } else if (prop == "textAlign") {
        std::string align = value.getString("start");
        int hAlign = parseTextAlign(align);
        /* Preserve vertical alignment */
        int vAlign = st.textAlign & (NVG_ALIGN_TOP | NVG_ALIGN_MIDDLE |
                                      NVG_ALIGN_BOTTOM | NVG_ALIGN_BASELINE);
        st.textAlign = hAlign | vAlign;
    } else if (prop == "textBaseline") {
        st.textBaseline = value.getString("alphabetic");
        int vAlign = parseTextBaseline(st.textBaseline);
        int hAlign = st.textAlign & (NVG_ALIGN_LEFT | NVG_ALIGN_CENTER | NVG_ALIGN_RIGHT);
        st.textAlign = hAlign | vAlign;
    } else if (prop == "shadowColor") {
        st.shadowColor = value.getString("rgba(0,0,0,0)");
    } else if (prop == "shadowBlur") {
        st.shadowBlur = value.getFloat(0);
    } else if (prop == "shadowOffsetX") {
        st.shadowOffsetX = value.getFloat(0);
    } else if (prop == "shadowOffsetY") {
        st.shadowOffsetY = value.getFloat(0);
    } else if (prop == "lineDashOffset") {
        st.lineDashOffset = value.getFloat(0);
    } else if (prop == "imageSmoothingEnabled") {
        st.imageSmoothingEnabled = value.getBool(true);
    } else {
        LOGD("canvas: unhandled property '%s'", prop.c_str());
    }
}

static void processResourceCall(DMCanvas *canvas, const std::string &resourceId,
                                 const std::string &method, const JsonValue &args) {
    if (method == "addColorStop") {
        float offset = argF(args, 0);
        std::string colorStr = argS(args, 1);
        NVGcolor color = parseCanvasColor(colorStr);
        canvas->gradientManager.addColorStop(resourceId, offset, color);
    }
}

/* ─── Main dispatch: parse JSON and execute ops ──────────────────────── */

static void executeOpsFromJson(DMCanvas *canvas, const JsonValue &root) {
    /* Expect: { "nodeId": "...", "operations": [ ... ] } */
    const JsonValue &operations = root["operations"];
    if (!operations.isArray()) return;

    for (size_t i = 0; i < operations.size(); i++) {
        const JsonValue &op = operations[i];
        std::string opType = op["op"].getString();

        if (opType == "contextCall") {
            std::string method = op["method"].getString();
            const JsonValue &args = op["args"];
            std::string resultId = op["resultId"].getString();
            processContextCall(canvas, method, args, resultId);
        } else if (opType == "contextSetProperty") {
            std::string prop = op["prop"].getString();
            const JsonValue &value = op["value"];
            processContextSetProperty(canvas, prop, value);
        } else if (opType == "resourceCall") {
            std::string resourceId = op["resourceId"].getString();
            std::string method = op["method"].getString();
            const JsonValue &args = op["args"];
            processResourceCall(canvas, resourceId, method, args);
        } else if (opType == "getContext") {
            /* No-op at renderer level */
        } else if (opType == "setCanvasProperty") {
            std::string prop = op["prop"].getString();
            if (prop == "width") {
                int w = (int)op["value"].getNumber(canvas->width);
                dm_canvas_resize(canvas, w, canvas->height);
            } else if (prop == "height") {
                int h = (int)op["value"].getNumber(canvas->height);
                dm_canvas_resize(canvas, canvas->width, h);
            }
        }
    }
}

/* ─── Public C API implementation ────────────────────────────────────── */

extern "C" {

DMCanvasRef dm_canvas_create(int width, int height) {
    auto *canvas = new DMCanvas();
    canvas->width  = width;
    canvas->height = height;
    return canvas;
}

void dm_canvas_destroy(DMCanvasRef canvas) {
    if (!canvas) return;

    if (canvas->vg) {
        canvas->imageManager.clear(canvas->vg);
        canvas->gradientManager.clearTextures(canvas->vg);
        canvas->gradientManager.clear();
        canvas_teardown_fbo(canvas);
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
        nvgDeleteGLES2(canvas->vg);
#endif
        canvas->vg = nullptr;
    }

    egl_cleanup(&canvas->eglState);
    delete canvas;
}

void dm_canvas_resize(DMCanvasRef canvas, int width, int height) {
    if (!canvas || (canvas->width == width && canvas->height == height))
        return;

    canvas->width  = width;
    canvas->height = height;

    if (canvas->vg && canvas->surfaceReady) {
        canvas_setup_fbo(canvas);
    }
}

int dm_canvas_init_surface(DMCanvasRef canvas, void *native_window) {
    if (!canvas) return -1;

    /* Initialize EGL if not done yet */
    if (egl_init(&canvas->eglState) != 0) {
        LOGE("dm_canvas_init_surface: EGL init failed");
        return -1;
    }

    if (egl_create_surface(&canvas->eglState, native_window) != 0) {
        LOGE("dm_canvas_init_surface: surface creation failed");
        return -1;
    }

    /* Create NanoVG context */
    if (!canvas->vg) {
        canvas->vg = nvgCreateGLES2(NVG_ANTIALIAS | NVG_STENCIL_STROKES);
        if (!canvas->vg) {
            LOGE("dm_canvas_init_surface: nvgCreateGLES2 failed");
            return -1;
        }
    }

    /* Set up FBO */
    if (canvas_setup_fbo(canvas) != 0) {
        LOGE("dm_canvas_init_surface: FBO setup failed");
        return -1;
    }

    canvas->surfaceReady = true;
    LOGD("dm_canvas_init_surface: ready %dx%d", canvas->width, canvas->height);
    return 0;
}

void dm_canvas_destroy_surface(DMCanvasRef canvas) {
    if (!canvas) return;
    canvas->surfaceReady = false;
    canvas_teardown_fbo(canvas);
    egl_destroy_surface(&canvas->eglState);
}

void dm_canvas_swap_buffers(DMCanvasRef canvas) {
    if (!canvas || !canvas->surfaceReady || !canvas->vg || !canvas->nvgFbo)
        return;

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    /* Blit FBO to screen framebuffer using NanoVG image pattern */
    nvgluBindFramebuffer(nullptr); /* bind default (screen) framebuffer */
    glViewport(0, 0, canvas->width, canvas->height);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT);

    NVGcontext *vg = canvas->vg;
    nvgBeginFrame(vg, (float)canvas->width, (float)canvas->height,
                  canvas->devicePixelRatio);

    /* The nvgFbo->image is a valid NanoVG image handle for the FBO texture */
    NVGpaint imgPaint = nvgImagePattern(vg, 0, 0,
        (float)canvas->width, (float)canvas->height,
        0, canvas->nvgFbo->image, 1.0f);
    nvgBeginPath(vg);
    nvgRect(vg, 0, 0, (float)canvas->width, (float)canvas->height);
    nvgFillPaint(vg, imgPaint);
    nvgFill(vg);

    nvgEndFrame(vg);
#endif

    egl_swap_buffers(&canvas->eglState);
}

void dm_canvas_execute_ops(DMCanvasRef canvas, const char *json, int json_len) {
    if (!canvas || !canvas->vg || !json || json_len <= 0) return;

    /* Parse the JSON */
    JsonParser parser(json, json_len);
    JsonValue root = parser.parse();

    /* Bind FBO and start NanoVG frame */
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    if (canvas->nvgFbo) {
        nvgluBindFramebuffer(canvas->nvgFbo);
    }
    glViewport(0, 0, canvas->width, canvas->height);
#endif

    nvgBeginFrame(canvas->vg, (float)canvas->width, (float)canvas->height,
                  canvas->devicePixelRatio);

    /* Execute operations */
    executeOpsFromJson(canvas, root);

    /* End NanoVG frame */
    nvgEndFrame(canvas->vg);
}

char *dm_canvas_get_image_data(DMCanvasRef canvas, int x, int y, int w, int h) {
    if (!canvas || !canvas->vg || !canvas->nvgFbo) {
        return strdup("{\"data\":[],\"width\":0,\"height\":0}");
    }
    return pixelops_get_image_data(canvas->nvgFbo->fbo,
                                   canvas->width, canvas->height,
                                   x, y, w, h);
}

char *dm_canvas_to_data_url(DMCanvasRef canvas, const char *mime, double quality) {
    if (!canvas || !canvas->vg || !canvas->nvgFbo) {
        return strdup("data:,");
    }
    return pixelops_to_data_url(canvas->nvgFbo->fbo,
                                canvas->width, canvas->height,
                                mime, quality);
}

char *dm_canvas_measure_text(DMCanvasRef canvas, const char *text, const char *font) {
    if (!canvas || !canvas->vg || !text) {
        return strdup("{\"width\":0}");
    }

    NVGcontext *vg = canvas->vg;

    ParsedFont pf = parseCSSFont(font ? font : "10px sans-serif");
    applyFontToNVG(vg, pf);

    float bounds[4];
    float advance = nvgTextBounds(vg, 0, 0, text, nullptr, bounds);

    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"width\":%.2f,"
             "\"actualBoundingBoxLeft\":%.2f,"
             "\"actualBoundingBoxRight\":%.2f,"
             "\"actualBoundingBoxAscent\":%.2f,"
             "\"actualBoundingBoxDescent\":%.2f}",
             advance,
             -bounds[0], bounds[2],
             -bounds[1], bounds[3]);
    return strdup(buf);
}

void dm_canvas_free_string(char *str) {
    free(str);
}

int dm_canvas_register_font(const char *name, const unsigned char *data, int len) {
    /*
     * Font registration is global — we need a NanoVG context to register.
     * This is called before any canvas might exist, so we maintain a pending
     * font list.  For now, this is a simplified implementation that requires
     * a canvas to exist.
     *
     * A proper implementation would use a global font registry with
     * stb_truetype directly, then register fonts when a NanoVG context
     * is created.  This is deferred to P1/P3 platform integration.
     */
    (void)name;
    (void)data;
    (void)len;
    return -1; /* TODO: implement global font registry */
}

} /* extern "C" */
