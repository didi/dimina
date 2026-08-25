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
#define LOGE(...) OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/canvas2d", __VA_ARGS__)
#define LOGD(...) OH_LOG_Print(LOG_APP, LOG_INFO,  0x8989, "dimina/canvas2d", __VA_ARGS__)
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
        st.lastPathType = CanvasDrawState::CLIP_NONE;
    } else if (method == "closePath") {
        nvgClosePath(vg);
    } else if (method == "moveTo") {
        nvgMoveTo(vg, argF(args, 0), argF(args, 1));
        st.lastPathType = CanvasDrawState::CLIP_OTHER;
    } else if (method == "lineTo") {
        nvgLineTo(vg, argF(args, 0), argF(args, 1));
        st.lastPathType = CanvasDrawState::CLIP_OTHER;
    } else if (method == "bezierCurveTo") {
        nvgBezierTo(vg, argF(args, 0), argF(args, 1),
                        argF(args, 2), argF(args, 3),
                        argF(args, 4), argF(args, 5));
        st.lastPathType = CanvasDrawState::CLIP_OTHER;
    } else if (method == "quadraticCurveTo") {
        nvgQuadTo(vg, argF(args, 0), argF(args, 1),
                      argF(args, 2), argF(args, 3));
        st.lastPathType = CanvasDrawState::CLIP_OTHER;
    } else if (method == "arc") {
        float cx = argF(args, 0), cy = argF(args, 1), r = argF(args, 2);
        float sa = argF(args, 3), ea = argF(args, 4);
        bool ccw = args[5].getBool(false);
        int dir = ccw ? NVG_CCW : NVG_CW;
        nvgArc(vg, cx, cy, r, sa, ea, dir);
        st.lastPathType = CanvasDrawState::CLIP_OTHER;
    } else if (method == "arcTo") {
        nvgArcTo(vg, argF(args, 0), argF(args, 1),
                     argF(args, 2), argF(args, 3), argF(args, 4));
        st.lastPathType = CanvasDrawState::CLIP_OTHER;
    } else if (method == "rect") {
        float rx = argF(args, 0), ry = argF(args, 1);
        float rw = argF(args, 2), rh = argF(args, 3);
        nvgRect(vg, rx, ry, rw, rh);
        st.lastPathType = CanvasDrawState::CLIP_RECT;
        st.lastPathRect[0] = rx;
        st.lastPathRect[1] = ry;
        st.lastPathRect[2] = rw;
        st.lastPathRect[3] = rh;
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
        st.lastPathType = CanvasDrawState::CLIP_OTHER;

    /* ── Fill / Stroke ────────────────────────────────────────────── */
    } else if (method == "fill") {
        drawWithShadow(vg, st,
            [](NVGcontext *v, void *) { nvgFill(v); }, nullptr);
        applyFillStyle(canvas);
        nvgFill(vg);
    } else if (method == "stroke") {
        drawWithShadow(vg, st,
            [](NVGcontext *v, void *) { nvgStroke(v); }, nullptr);
        applyStrokeStyle(canvas);
        nvgStroke(vg);
    } else if (method == "fillRect") {
        float x = argF(args, 0), y = argF(args, 1);
        float w = argF(args, 2), h = argF(args, 3);
        struct RectData { float x, y, w, h; };
        RectData rd = { x, y, w, h };
        drawWithShadow(vg, st, [](NVGcontext *v, void *ud) {
            auto *r = (RectData *)ud;
            nvgBeginPath(v);
            nvgRect(v, r->x, r->y, r->w, r->h);
            nvgFill(v);
        }, &rd);
        nvgBeginPath(vg);
        nvgRect(vg, x, y, w, h);
        applyFillStyle(canvas);
        nvgFill(vg);
    } else if (method == "strokeRect") {
        float x = argF(args, 0), y = argF(args, 1);
        float w = argF(args, 2), h = argF(args, 3);
        struct RectData { float x, y, w, h; };
        RectData rd = { x, y, w, h };
        drawWithShadow(vg, st, [](NVGcontext *v, void *ud) {
            auto *r = (RectData *)ud;
            nvgBeginPath(v);
            nvgRect(v, r->x, r->y, r->w, r->h);
            nvgStroke(v);
        }, &rd);
        nvgBeginPath(vg);
        nvgRect(vg, x, y, w, h);
        applyStrokeStyle(canvas);
        nvgStroke(vg);
    } else if (method == "clearRect") {
        float x = argF(args, 0), y = argF(args, 1);
        float w = argF(args, 2), h = argF(args, 3);
        /* Use NanoVG NVG_COPY composite to clear the rect to transparent.
           Direct glClear would execute before NanoVG renders pending commands,
           causing clearRect to be invisible when ops are batched in one frame. */
        nvgSave(vg);
        nvgGlobalCompositeOperation(vg, NVG_COPY);
        nvgBeginPath(vg);
        nvgRect(vg, x, y, w, h);
        nvgFillColor(vg, nvgRGBA(0, 0, 0, 0));
        nvgFill(vg);
        nvgRestore(vg);

    /* ── Transform ────────────────────────────────────────────────── */
    } else if (method == "save") {
        nvgSave(vg);
        canvas->stateManager.save();
    } else if (method == "restore") {
        bool wasClipActive = st.clipActive;
        canvas->stateManager.restore();
        nvgRestore(vg);
        {
            auto &newSt = canvas->stateManager.current();
            if (wasClipActive && !newSt.clipActive) {
                /* End frame to flush draws done with clip */
                nvgEndFrame(vg);
                /* Clear stencil bit 7 (clip mask) */
                nvglClearClipStencil(vg);
                /* Restart frame */
                float dpr = canvas->devicePixelRatio;
                float lw = (float)canvas->width / dpr;
                float lh = (float)canvas->height / dpr;
                nvgBeginFrame(vg, lw, lh, dpr);
                /* Re-apply NanoVG state for current stack level */
                int totalLevels = canvas->stateManager.stackSize();
                for (int i = 0; i < totalLevels; ++i) {
                    const auto &rst = canvas->stateManager.at(i);
                    nvgResetTransform(vg);
                    nvgTransform(vg, rst.xform[0], rst.xform[1],
                                      rst.xform[2], rst.xform[3],
                                      rst.xform[4], rst.xform[5]);
                    nvgStrokeWidth(vg, rst.lineWidth);
                    nvgLineCap(vg, rst.lineCap);
                    nvgLineJoin(vg, rst.lineJoin);
                    nvgMiterLimit(vg, rst.miterLimit);
                    nvgGlobalAlpha(vg, rst.globalAlpha);
                    {
                        ParsedFont pf = parseCSSFont(rst.fontStr);
                        applyFontToNVG(vg, pf);
                    }
                    nvgTextAlign(vg, rst.textAlign);
                    applyCompositeOperation(rst.globalCompositeOperation);

                    if (rst.fillIsGradient && canvas->gradientManager.has(rst.fillGradientId)) {
                        NVGpaint paint = canvas->gradientManager.buildPaint(vg, rst.fillGradientId);
                        paint.innerColor.a *= rst.globalAlpha;
                        paint.outerColor.a *= rst.globalAlpha;
                        nvgFillPaint(vg, paint);
                    } else {
                        NVGcolor fc = parseCanvasColor(rst.fillStyleStr);
                        fc.a *= rst.globalAlpha;
                        nvgFillColor(vg, fc);
                    }
                    if (rst.strokeIsGradient && canvas->gradientManager.has(rst.strokeGradientId)) {
                        NVGpaint paint = canvas->gradientManager.buildPaint(vg, rst.strokeGradientId);
                        paint.innerColor.a *= rst.globalAlpha;
                        paint.outerColor.a *= rst.globalAlpha;
                        nvgStrokePaint(vg, paint);
                    } else {
                        NVGcolor sc = parseCanvasColor(rst.strokeStyleStr);
                        sc.a *= rst.globalAlpha;
                        nvgStrokeColor(vg, sc);
                    }

                    if (i < totalLevels - 1) {
                        nvgSave(vg);
                    }
                }
            }
        }
    } else if (method == "translate") {
        float tx = argF(args, 0), ty = argF(args, 1);
        nvgTranslate(vg, tx, ty);
        canvas->stateManager.current().xformTranslate(tx, ty);
    } else if (method == "rotate") {
        float a = argF(args, 0);
        nvgRotate(vg, a);
        canvas->stateManager.current().xformRotate(a);
    } else if (method == "scale") {
        float sx = argF(args, 0), sy = argF(args, 1);
        nvgScale(vg, sx, sy);
        canvas->stateManager.current().xformScale(sx, sy);
    } else if (method == "transform") {
        float a=argF(args,0), b=argF(args,1), c=argF(args,2),
              d=argF(args,3), e=argF(args,4), f=argF(args,5);
        nvgTransform(vg, a, b, c, d, e, f);
        canvas->stateManager.current().xformConcat(a, b, c, d, e, f);
    } else if (method == "setTransform") {
        float a=argF(args,0), b=argF(args,1), c=argF(args,2),
              d=argF(args,3), e=argF(args,4), f=argF(args,5);
        nvgResetTransform(vg);
        nvgTransform(vg, a, b, c, d, e, f);
        canvas->stateManager.current().xformSet(a, b, c, d, e, f);
    } else if (method == "resetTransform") {
        nvgResetTransform(vg);
        canvas->stateManager.current().xformReset();

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

        /* NanoVG only supports filled text — nvgText uses fill color.
           For strokeText, set fill color to the stroke color so text
           appears with the stroke style. */
        if (st.strokeIsGradient && canvas->gradientManager.has(st.strokeGradientId)) {
            NVGpaint paint = canvas->gradientManager.buildPaint(canvas->vg, st.strokeGradientId);
            paint.innerColor.a *= st.globalAlpha;
            paint.outerColor.a *= st.globalAlpha;
            nvgFillPaint(vg, paint);
        } else {
            NVGcolor c = parseCanvasColor(st.strokeStyleStr);
            c.a *= st.globalAlpha;
            nvgFillColor(vg, c);
        }

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
        /* Stencil-based clip: render the current path to stencil bit 7.
           NanoVG's fill operations use bits 0-6, so the clip mask persists
           across subsequent draw calls. */
        if (st.lastPathType == CanvasDrawState::CLIP_RECT) {
            /* Rect paths can still use the efficient scissor path */
            nvgIntersectScissor(vg, st.lastPathRect[0], st.lastPathRect[1],
                                    st.lastPathRect[2], st.lastPathRect[3]);
        } else if (st.lastPathType != CanvasDrawState::CLIP_NONE) {
            /* Arbitrary path clip: render to stencil bit 7 */
            nvglSetNextFillAsClip(vg);
            nvgFill(vg);
        }
        st.clipActive = true;
        nvgBeginPath(vg);

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
        LOGD("drawImage: imageId=%{public}s handle=%{public}d", imageId.c_str(), imgHandle);
        if (imgHandle < 0) return;

        int imgW = 0, imgH = 0;
        nvgImageSize(vg, imgHandle, &imgW, &imgH);

        float sx = 0, sy = 0, sw = (float)imgW, sh = (float)imgH;
        float dx, dy, dw, dh;

        size_t argc = args.size();
        if (argc >= 9) {
            /* 9-arg form: (image, sx, sy, sw, sh, dx, dy, dw, dh) */
            sx = argF(args, 1); sy = argF(args, 2);
            sw = argF(args, 3); sh = argF(args, 4);
            dx = argF(args, 5); dy = argF(args, 6);
            dw = argF(args, 7); dh = argF(args, 8);
        } else if (argc >= 5) {
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

        /* Shadow pass for drawImage */
        if (shouldDrawShadow(st)) {
            struct ImgShadowData { float dx, dy, dw, dh; };
            ImgShadowData isd = { dx, dy, dw, dh };
            drawWithShadow(vg, st, [](NVGcontext *v, void *ud) {
                auto *d = (ImgShadowData *)ud;
                nvgBeginPath(v);
                nvgRect(v, d->dx, d->dy, d->dw, d->dh);
                nvgFill(v);
            }, &isd);
        }

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
        /* Check gradient/pattern object first — getString() returns empty for objects */
        if (value.isObject()) {
            std::string resId = value["__canvasResourceId"].getString();
            if (!resId.empty() && canvas->gradientManager.has(resId)) {
                st.fillIsGradient = true;
                st.fillGradientId = resId;
                return;
            }
        }
        std::string v = value.getString();
        if (!v.empty()) {
            st.fillIsGradient = false;
            st.fillStyleStr = v;
        }
    } else if (prop == "strokeStyle") {
        if (value.isObject()) {
            std::string resId = value["__canvasResourceId"].getString();
            if (!resId.empty() && canvas->gradientManager.has(resId)) {
                st.strokeIsGradient = true;
                st.strokeGradientId = resId;
                return;
            }
        }
        std::string v = value.getString();
        if (!v.empty()) {
            st.strokeIsGradient = false;
            st.strokeStyleStr = v;
        }
    } else if (prop == "lineWidth") {
        float w = value.getFloat(1.0f);
        st.lineWidth = w;
        nvgStrokeWidth(vg, w);
    } else if (prop == "lineCap") {
        std::string cap = value.getString("butt");
        int nvgCap = NVG_BUTT;
        if (cap == "round")      nvgCap = NVG_ROUND;
        else if (cap == "square") nvgCap = NVG_SQUARE;
        st.lineCap = nvgCap;
        nvgLineCap(vg, nvgCap);
    } else if (prop == "lineJoin") {
        std::string join = value.getString("miter");
        int nvgJoin = NVG_MITER;
        if (join == "round")     nvgJoin = NVG_ROUND;
        else if (join == "bevel") nvgJoin = NVG_BEVEL;
        st.lineJoin = nvgJoin;
        nvgLineJoin(vg, nvgJoin);
    } else if (prop == "miterLimit") {
        float ml = value.getFloat(10.0f);
        st.miterLimit = ml;
        nvgMiterLimit(vg, ml);
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

    LOGD("executeOpsFromJson: %{public}zu operations", operations.size());
    for (size_t i = 0; i < operations.size(); i++) {
        const JsonValue &op = operations[i];
        std::string opType = op["op"].getString();

        if (opType == "contextCall") {
            std::string method = op["method"].getString();
            const JsonValue &args = op["args"];
            std::string resultId = op["resultId"].getString();
            LOGD("  op[%{public}zu] contextCall: %{public}s args=%{public}zu", i, method.c_str(), args.size());
            processContextCall(canvas, method, args, resultId);
        } else if (opType == "contextSetProperty") {
            std::string prop = op["prop"].getString();
            const JsonValue &value = op["value"];
            std::string valStr = value.isString() ? value.strVal :
                                 value.isNumber() ? std::to_string(value.numVal) : "(other)";
            LOGD("  op[%{public}zu] setProperty: %{public}s = %{public}s", i, prop.c_str(), valStr.c_str());
            processContextSetProperty(canvas, prop, value);
        } else if (opType == "resourceCall") {
            std::string resourceId = op["resourceId"].getString();
            std::string method = op["method"].getString();
            const JsonValue &args = op["args"];
            LOGD("  op[%{public}zu] resourceCall: %{public}s.%{public}s", i, resourceId.c_str(), method.c_str());
            processResourceCall(canvas, resourceId, method, args);
        } else if (opType == "getContext") {
            LOGD("  op[%{public}zu] getContext (no-op)", i);
        } else if (opType == "setCanvasProperty") {
            std::string prop = op["prop"].getString();
            double val = op["value"].getNumber(0);
            LOGD("  op[%{public}zu] setCanvasProperty: %{public}s = %{public}.0f", i, prop.c_str(), val);
            // JS mini-app sets canvas.width/height to physical pixels (logicalWidth * dpr),
            // following the standard WeChat retina pattern. Accept as-is, no DPR multiplication.
            if (prop == "width" || prop == "height") {
                int newW = canvas->width, newH = canvas->height;
                if (prop == "width") {
                    newW = (int)op["value"].getNumber(canvas->width);
                } else {
                    newH = (int)op["value"].getNumber(canvas->height);
                }
                if (newW != canvas->width || newH != canvas->height) {
                    /* Resizing mid-frame: dm_canvas_resize recreates the FBO,
                       which unbinds the old FBO.  We must end the NanoVG frame
                       first, then resize, then restart the frame so subsequent
                       ops draw to the new FBO. */
                    if (canvas->frameActive) {
                        nvgEndFrame(canvas->vg);
                        canvas->frameActive = false;
                    }
                    dm_canvas_resize(canvas, newW, newH);
                    /* Per HTML Canvas spec: setting canvas.width or height
                       resets the context state to defaults. */
                    canvas->stateManager.reset();
                    /* Re-enter frame with new dimensions */
                    float dpr = canvas->devicePixelRatio;
                    float lw = (float)canvas->width / dpr;
                    float lh = (float)canvas->height / dpr;
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
                    if (canvas->nvgFbo) {
                        nvgluBindFramebuffer(canvas->nvgFbo);
                    }
                    glViewport(0, 0, canvas->width, canvas->height);
                    glClear(GL_STENCIL_BUFFER_BIT);
#endif
                    nvgBeginFrame(canvas->vg, lw, lh, dpr);
                    canvas->frameActive = true;
                }
            }
        } else if (opType == "imageSetSrc") {
            /* imageSetSrc is handled by canvas_bindings.cpp before reaching here.
               If it arrives here, it's a no-op (image loading is async). */
            LOGD("  op[%{public}zu] imageSetSrc: imageId=%{public}s (handled by bindings layer)",
                 i, op["imageId"].getString().c_str());
        } else if (opType == "createImage") {
            LOGD("  op[%{public}zu] createImage (no-op, handled by bindings layer)", i);
        } else {
            LOGD("  op[%{public}zu] unknown opType: %{public}s", i, opType.c_str());
        }
    }
}

/* ─── Public C API implementation ────────────────────────────────────── */

extern "C" {

DMCanvasRef dm_canvas_create(int width, int height) {
    auto *canvas = new DMCanvas();
    canvas->width  = width;
    canvas->height = height;
    /* Surface dimensions default to drawing buffer size;
       overwritten by dm_canvas_init_surface when EGL surface is created. */
    canvas->surfaceWidth  = width;
    canvas->surfaceHeight = height;
    return canvas;
}

int dm_canvas_is_ready(DMCanvasRef canvas) {
    return canvas && canvas->vg && canvas->surfaceReady ? 1 : 0;
}

void dm_canvas_destroy(DMCanvasRef canvas) {
    if (!canvas) return;

    if (canvas->vg) {
#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
        /* Make THIS canvas's EGL context current before deleting GL objects.
           nvgDeleteGLES2 calls glDeleteTextures/glDeleteProgram etc. — these
           must run on the context that owns them, not whatever context happens
           to be current (which may belong to a different canvas). */
        if (canvas->eglState.context != EGL_NO_CONTEXT &&
            canvas->eglState.surface != EGL_NO_SURFACE) {
            egl_make_current(&canvas->eglState);
        }
#endif
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

void dm_canvas_reset_for_replay(DMCanvasRef canvas) {
    if (!canvas || !canvas->vg) return;

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    egl_make_current(&canvas->eglState);
    if (canvas->nvgFbo) {
        nvgluBindFramebuffer(canvas->nvgFbo);
    }
    glViewport(0, 0, canvas->width, canvas->height);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
#endif

    /* Reset canvas state to defaults */
    canvas->stateManager.reset();

    /* Clear gradient textures and gradient state — ops will recreate them */
    canvas->gradientManager.clearTextures(canvas->vg);
    canvas->gradientManager.clear();

    /* NOTE: imageManager is NOT cleared — uploaded images persist across replays
       (image upload is done outside the ops queue via canvasUploadImage). */
}

void dm_canvas_set_pixel_ratio(DMCanvasRef canvas, float ratio) {
    if (!canvas || ratio <= 0) return;
    canvas->devicePixelRatio = ratio;
}

void dm_canvas_set_surface_size(DMCanvasRef canvas, int sw, int sh) {
    if (!canvas) return;
    canvas->surfaceWidth  = sw;
    canvas->surfaceHeight = sh;
    LOGD("dm_canvas_set_surface_size: %{public}dx%{public}d", sw, sh);
}

int dm_canvas_rebind_surface(DMCanvasRef canvas, void *native_window) {
    if (!canvas || !canvas->vg) return -1;

    LOGD("dm_canvas_rebind_surface: canvas=%{public}p nw=%{public}p fbo=%{public}dx%{public}d surface=%{public}dx%{public}d",
         (void*)canvas, native_window, canvas->width, canvas->height,
         canvas->surfaceWidth, canvas->surfaceHeight);

    /* Destroy old EGL surface and create a new one from the new native window.
       egl_create_surface internally calls egl_destroy_surface first, then
       creates a fresh EGL surface and makes it current.
       The NanoVG context and FBO are preserved — they live in the EGL context,
       not the EGL surface.  Only the display surface changes. */
    if (egl_create_surface(&canvas->eglState, native_window) != 0) {
        LOGE("dm_canvas_rebind_surface: egl_create_surface failed");
        canvas->surfaceReady = false;
        return -1;
    }

    canvas->surfaceReady = true;
    LOGD("dm_canvas_rebind_surface: OK — EGL surface rebound, NanoVG+FBO preserved");
    return 0;
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

/* ─── Shared font loading helper ─────────────────────────────────────── */

static void canvas_load_system_fonts(DMCanvas *canvas) {
#if defined(DIMINA_PLATFORM_HARMONY)
    /* Base Latin font */
    static const char *latinPaths[] = {
        "/system/fonts/HarmonyOS_Sans_Regular.ttf",
        "/system/fonts/HarmonyOS_Sans.ttf",
        "/system/fonts/DroidSans.ttf",
        nullptr
    };
    int sansId = -1;
    for (int i = 0; latinPaths[i]; i++) {
        sansId = nvgCreateFont(canvas->vg, "sans", latinPaths[i]);
        if (sansId >= 0) {
            LOGD("canvas_load_system_fonts: loaded Latin font '%{public}s' as 'sans' (id=%{public}d)", latinPaths[i], sansId);
            nvgCreateFont(canvas->vg, "sans-serif", latinPaths[i]);
            nvgCreateFont(canvas->vg, "default", latinPaths[i]);
            break;
        }
    }
    /* CJK (Chinese/Japanese/Korean) fallback font */
    static const char *cjkPaths[] = {
        "/system/fonts/HarmonyOS_Sans_SC_Regular.ttf",
        "/system/fonts/HarmonyOS_Sans_SC.ttf",
        "/system/fonts/NotoSansCJK-Regular.ttc",
        "/system/fonts/NotoSansSC-Regular.otf",
        "/system/fonts/DroidSansFallback.ttf",
        nullptr
    };
    int sansSerifId = -1, defaultId = -1;
    if (sansId >= 0) {
        sansSerifId = nvgFindFont(canvas->vg, "sans-serif");
        defaultId = nvgFindFont(canvas->vg, "default");
    }
    for (int i = 0; cjkPaths[i]; i++) {
        int cjkId = nvgCreateFont(canvas->vg, "cjk", cjkPaths[i]);
        if (cjkId >= 0) {
            LOGD("canvas_load_system_fonts: loaded CJK font '%{public}s' (id=%{public}d)", cjkPaths[i], cjkId);
            if (sansId >= 0) nvgAddFallbackFontId(canvas->vg, sansId, cjkId);
            if (sansSerifId >= 0) nvgAddFallbackFontId(canvas->vg, sansSerifId, cjkId);
            if (defaultId >= 0) nvgAddFallbackFontId(canvas->vg, defaultId, cjkId);
            break;
        }
    }
    /* Bold variants */
    static const char *boldPaths[] = {
        "/system/fonts/HarmonyOS_Sans_Bold.ttf",
        nullptr
    };
    int boldId = -1;
    for (int i = 0; boldPaths[i]; i++) {
        boldId = nvgCreateFont(canvas->vg, "sans-bold", boldPaths[i]);
        if (boldId >= 0) {
            LOGD("canvas_load_system_fonts: loaded bold font '%{public}s' (id=%{public}d)", boldPaths[i], boldId);
            break;
        }
    }
    static const char *boldCjkPaths[] = {
        "/system/fonts/HarmonyOS_Sans_SC_Bold.ttf",
        "/system/fonts/NotoSansCJK-Bold.ttc",
        nullptr
    };
    for (int i = 0; boldCjkPaths[i]; i++) {
        int bcjkId = nvgCreateFont(canvas->vg, "cjk-bold", boldCjkPaths[i]);
        if (bcjkId >= 0) {
            LOGD("canvas_load_system_fonts: loaded bold CJK font '%{public}s' (id=%{public}d)", boldCjkPaths[i], bcjkId);
            if (boldId >= 0) nvgAddFallbackFontId(canvas->vg, boldId, bcjkId);
            break;
        }
    }
    if (sansId < 0) {
        LOGE("canvas_load_system_fonts: WARNING — no system font found, text rendering will fail");
    }
#elif defined(DIMINA_PLATFORM_ANDROID)
    int sansId = nvgCreateFont(canvas->vg, "sans", "/system/fonts/Roboto-Regular.ttf");
    nvgCreateFont(canvas->vg, "sans-serif", "/system/fonts/Roboto-Regular.ttf");
    int boldId = nvgCreateFont(canvas->vg, "sans-bold", "/system/fonts/Roboto-Bold.ttf");
    int cjkId = nvgCreateFont(canvas->vg, "cjk", "/system/fonts/NotoSansCJK-Regular.ttc");
    if (cjkId < 0) cjkId = nvgCreateFont(canvas->vg, "cjk", "/system/fonts/DroidSansFallback.ttf");
    if (cjkId >= 0 && sansId >= 0) nvgAddFallbackFontId(canvas->vg, sansId, cjkId);
    if (cjkId >= 0 && boldId >= 0) nvgAddFallbackFontId(canvas->vg, boldId, cjkId);
#elif defined(DIMINA_PLATFORM_IOS)
    static const char *latinPaths[] = {
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/SFNSText.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Core/Helvetica.ttc",
        nullptr
    };
    int sansId = -1;
    for (int i = 0; latinPaths[i]; i++) {
        sansId = nvgCreateFont(canvas->vg, "sans", latinPaths[i]);
        if (sansId >= 0) {
            LOGD("canvas_load_system_fonts: loaded Latin font '%s' as 'sans' (id=%d)", latinPaths[i], sansId);
            nvgCreateFont(canvas->vg, "sans-serif", latinPaths[i]);
            nvgCreateFont(canvas->vg, "default", latinPaths[i]);
            break;
        }
    }
    static const char *cjkPaths[] = {
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Core/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        nullptr
    };
    int sansSerifId = -1, defaultId = -1;
    if (sansId >= 0) {
        sansSerifId = nvgFindFont(canvas->vg, "sans-serif");
        defaultId = nvgFindFont(canvas->vg, "default");
    }
    for (int i = 0; cjkPaths[i]; i++) {
        int cjkId = nvgCreateFont(canvas->vg, "cjk", cjkPaths[i]);
        if (cjkId >= 0) {
            LOGD("canvas_load_system_fonts: loaded CJK font '%s' (id=%d)", cjkPaths[i], cjkId);
            if (sansId >= 0) nvgAddFallbackFontId(canvas->vg, sansId, cjkId);
            if (sansSerifId >= 0) nvgAddFallbackFontId(canvas->vg, sansSerifId, cjkId);
            if (defaultId >= 0) nvgAddFallbackFontId(canvas->vg, defaultId, cjkId);
            break;
        }
    }
    static const char *boldPaths[] = {
        "/System/Library/Fonts/SFNS-Bold.ttf",
        "/System/Library/Fonts/SFNSText-Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        nullptr
    };
    int boldId = -1;
    for (int i = 0; boldPaths[i]; i++) {
        boldId = nvgCreateFont(canvas->vg, "sans-bold", boldPaths[i]);
        if (boldId >= 0) {
            LOGD("canvas_load_system_fonts: loaded bold font '%s' (id=%d)", boldPaths[i], boldId);
            break;
        }
    }
    if (sansId < 0) {
        LOGE("canvas_load_system_fonts: WARNING — no system font found, text rendering will fail");
    }
#endif
}

int dm_canvas_init_surface(DMCanvasRef canvas, void *native_window) {
    if (!canvas) return -1;

    LOGD("dm_canvas_init_surface: START canvas=%{public}p nw=%{public}p size=%{public}dx%{public}d dpr=%{public}.2f",
         (void*)canvas, native_window, canvas->width, canvas->height, canvas->devicePixelRatio);

    /* Initialize EGL if not done yet */
    if (egl_init(&canvas->eglState) != 0) {
        LOGE("dm_canvas_init_surface: EGL init failed");
        return -1;
    }
    LOGD("dm_canvas_init_surface: EGL init OK");

    if (egl_create_surface(&canvas->eglState, native_window) != 0) {
        LOGE("dm_canvas_init_surface: surface creation failed");
        return -1;
    }
    LOGD("dm_canvas_init_surface: EGL surface OK");

    /* Create NanoVG context */
    if (!canvas->vg) {
        /* Verify GL context is actually current before NanoVG init */
        const char *glVendor = (const char *)glGetString(GL_VENDOR);
        const char *glRenderer = (const char *)glGetString(GL_RENDERER);
        const char *glVersion = (const char *)glGetString(GL_VERSION);
        GLenum glErr = glGetError();
        LOGD("dm_canvas_init_surface: GL check — vendor=%{public}s renderer=%{public}s version=%{public}s glError=0x%{public}x",
             glVendor ? glVendor : "(null)",
             glRenderer ? glRenderer : "(null)",
             glVersion ? glVersion : "(null)",
             glErr);

        canvas->vg = nvgCreateGLES2(NVG_ANTIALIAS | NVG_STENCIL_STROKES);
        if (!canvas->vg) {
            GLenum err = glGetError();
            LOGE("dm_canvas_init_surface: nvgCreateGLES2 failed glError=0x%{public}x", err);
            return -1;
        }
        LOGD("dm_canvas_init_surface: NanoVG context OK");
        canvas_load_system_fonts(canvas);
    }

    /* Set up FBO */
    if (canvas_setup_fbo(canvas) != 0) {
        LOGE("dm_canvas_init_surface: FBO setup failed");
        return -1;
    }
    LOGD("dm_canvas_init_surface: FBO OK");

    canvas->surfaceReady = true;
    /* Record the display surface size — this is the EGL surface / XComponent
       size in physical pixels.  swap_buffers uses this to scale the FBO
       (which may be larger or smaller) to the on-screen area. */
    canvas->surfaceWidth  = canvas->width;
    canvas->surfaceHeight = canvas->height;
    LOGD("dm_canvas_init_surface: DONE ready %{public}dx%{public}d surface=%{public}dx%{public}d dpr=%{public}.2f",
         canvas->width, canvas->height, canvas->surfaceWidth, canvas->surfaceHeight, canvas->devicePixelRatio);
    return 0;
}

int dm_canvas_init_offscreen(DMCanvasRef canvas) {
    if (!canvas) return -1;
    canvas->offscreen = true;

    LOGD("dm_canvas_init_offscreen: START canvas=%{public}p size=%{public}dx%{public}d",
         (void*)canvas, canvas->width, canvas->height);

    if (egl_init(&canvas->eglState) != 0) {
        LOGE("dm_canvas_init_offscreen: EGL init failed");
        return -1;
    }

    if (egl_create_pbuffer_surface(&canvas->eglState, canvas->width, canvas->height) != 0) {
        LOGE("dm_canvas_init_offscreen: PBuffer surface creation failed");
        return -1;
    }

    if (!canvas->vg) {
        canvas->vg = nvgCreateGLES2(NVG_ANTIALIAS | NVG_STENCIL_STROKES);
        if (!canvas->vg) {
            LOGE("dm_canvas_init_offscreen: nvgCreateGLES2 failed");
            return -1;
        }
        canvas_load_system_fonts(canvas);
    }

    if (canvas_setup_fbo(canvas) != 0) {
        LOGE("dm_canvas_init_offscreen: FBO setup failed");
        return -1;
    }

    canvas->surfaceReady = true;
    canvas->surfaceWidth  = canvas->width;
    canvas->surfaceHeight = canvas->height;
    LOGD("dm_canvas_init_offscreen: DONE ready %{public}dx%{public}d",
         canvas->width, canvas->height);
    return 0;
}

void dm_canvas_destroy_surface(DMCanvasRef canvas) {
    if (!canvas) return;
    canvas->surfaceReady = false;
    canvas_teardown_fbo(canvas);
    egl_destroy_surface(&canvas->eglState);
}

void dm_canvas_swap_buffers(DMCanvasRef canvas) {
    if (!canvas || !canvas->surfaceReady || !canvas->vg || !canvas->nvgFbo) {
        LOGD("dm_canvas_swap_buffers: SKIP canvas=%{public}p ready=%{public}d vg=%{public}p fbo=%{public}p",
             (void*)canvas, canvas ? canvas->surfaceReady : 0,
             canvas ? (void*)canvas->vg : nullptr,
             canvas ? (void*)canvas->nvgFbo : nullptr);
        return;
    }
    if (canvas->offscreen) return;  /* no display to present to */
    /* Surface = EGL display area (XComponent physical pixels).
       FBO = drawing buffer (canvas.width/height, may be larger for HD export). */
    int sw = canvas->surfaceWidth  > 0 ? canvas->surfaceWidth  : canvas->width;
    int sh = canvas->surfaceHeight > 0 ? canvas->surfaceHeight : canvas->height;
    LOGD("dm_canvas_swap_buffers: canvas=%{public}p fbo=%{public}dx%{public}d surface=%{public}dx%{public}d",
         (void*)canvas, canvas->width, canvas->height, sw, sh);

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    /* Ensure this canvas's EGL context is current before blitting */
    egl_make_current(&canvas->eglState);
    /* Blit FBO to screen framebuffer — scale drawing buffer to display surface,
       just like a browser scales canvas drawing buffer to CSS display size. */
    nvgluBindFramebuffer(nullptr); /* bind default (screen) framebuffer */
    glViewport(0, 0, sw, sh);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT);

    NVGcontext *vg = canvas->vg;
    float dispW = (float)sw;
    float dispH = (float)sh;
    nvgBeginFrame(vg, dispW, dispH, 1.0f);

    /* Stretch the FBO texture to fill the entire display surface */
    NVGpaint imgPaint = nvgImagePattern(vg, 0, 0,
        dispW, dispH,
        0, canvas->nvgFbo->image, 1.0f);
    nvgBeginPath(vg);
    nvgRect(vg, 0, 0, dispW, dispH);
    nvgFillPaint(vg, imgPaint);
    nvgFill(vg);

    nvgEndFrame(vg);
    glFinish();  /* ensure GPU completes before presenting */
#endif

    egl_swap_buffers(&canvas->eglState);
}

void dm_canvas_begin_frame(DMCanvasRef canvas) {
    if (!canvas || !canvas->vg) return;
    if (canvas->frameActive) return;  /* already in a frame */

    float dpr = canvas->devicePixelRatio;
    float logicalW = (float)canvas->width / dpr;
    float logicalH = (float)canvas->height / dpr;

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)
    egl_make_current(&canvas->eglState);
    if (canvas->nvgFbo) {
        nvgluBindFramebuffer(canvas->nvgFbo);
    }
    glViewport(0, 0, canvas->width, canvas->height);
    glClear(GL_STENCIL_BUFFER_BIT);
#endif

    nvgBeginFrame(canvas->vg, logicalW, logicalH, dpr);
    canvas->frameActive = true;

    /* Restore canvas state that nvgBeginFrame resets.
       nvgBeginFrame wipes NanoVG's internal state (transform, font, composite,
       stroke/fill, save stack, etc.) back to defaults.  We re-apply our
       tracked CanvasStateManager so that drawing across frame boundaries
       appears continuous.

       Key insight: NanoVG save/restore is a memcpy-based stack.  We must
       rebuild each level with the correct state so that nvgRestore pops
       to the right content — not to the beginFrame-reset defaults. */
    {
        NVGcontext *vg = canvas->vg;
        int totalLevels = canvas->stateManager.stackSize(); // base(1) + saves

        /* Walk the stack bottom-up: apply level 0 (base) to NanoVG current
           state, then nvgSave + apply level 1, nvgSave + apply level 2, …
           After the loop, NanoVG's stack[0] = base, stack[1] = save-1, etc.
           and the current (top) state matches stateManager.current(). */
        for (int i = 0; i < totalLevels; ++i) {
            const auto &st = canvas->stateManager.at(i);

            /* Apply this level's full state to NanoVG's current slot */
            nvgResetTransform(vg);
            nvgTransform(vg, st.xform[0], st.xform[1],
                              st.xform[2], st.xform[3],
                              st.xform[4], st.xform[5]);
            nvgStrokeWidth(vg, st.lineWidth);
            nvgLineCap(vg, st.lineCap);
            nvgLineJoin(vg, st.lineJoin);
            nvgMiterLimit(vg, st.miterLimit);
            nvgGlobalAlpha(vg, st.globalAlpha);
            {
                ParsedFont pf = parseCSSFont(st.fontStr);
                applyFontToNVG(vg, pf);
            }
            nvgTextAlign(vg, st.textAlign);
            applyCompositeOperation(st.globalCompositeOperation);

            /* Fill / stroke paint — apply at every level so nvgRestore
               pops to the correct paint, not the beginFrame default. */
            if (st.fillIsGradient && canvas->gradientManager.has(st.fillGradientId)) {
                NVGpaint paint = canvas->gradientManager.buildPaint(vg, st.fillGradientId);
                paint.innerColor.a *= st.globalAlpha;
                paint.outerColor.a *= st.globalAlpha;
                nvgFillPaint(vg, paint);
            } else {
                NVGcolor fc = parseCanvasColor(st.fillStyleStr);
                fc.a *= st.globalAlpha;
                nvgFillColor(vg, fc);
            }
            if (st.strokeIsGradient && canvas->gradientManager.has(st.strokeGradientId)) {
                NVGpaint paint = canvas->gradientManager.buildPaint(vg, st.strokeGradientId);
                paint.innerColor.a *= st.globalAlpha;
                paint.outerColor.a *= st.globalAlpha;
                nvgStrokePaint(vg, paint);
            } else {
                NVGcolor sc = parseCanvasColor(st.strokeStyleStr);
                sc.a *= st.globalAlpha;
                nvgStrokeColor(vg, sc);
            }

            /* Push this level into NanoVG's stack (except for the last
               level — that stays as the active/current state). */
            if (i < totalLevels - 1) {
                nvgSave(vg);
            }
        }
    }
}

void dm_canvas_end_frame(DMCanvasRef canvas) {
    if (!canvas || !canvas->vg || !canvas->frameActive) return;
    nvgEndFrame(canvas->vg);
    canvas->frameActive = false;
}

void dm_canvas_execute_ops(DMCanvasRef canvas, const char *json, int json_len) {
    if (!canvas || !canvas->vg || !json || json_len <= 0) {
        LOGD("dm_canvas_execute_ops: SKIP canvas=%{public}p vg=%{public}p json=%{public}p len=%{public}d",
             (void*)canvas, canvas ? (void*)canvas->vg : nullptr, (void*)json, json_len);
        return;
    }
    LOGD("dm_canvas_execute_ops: canvas=%{public}p jsonLen=%{public}d surfaceReady=%{public}d fbo=%{public}p frameActive=%{public}d",
         (void*)canvas, json_len, canvas->surfaceReady, (void*)canvas->nvgFbo, canvas->frameActive);

    /* Parse the JSON */
    JsonParser parser(json, json_len);
    JsonValue root = parser.parse();

    /* If no frame is active, manage it automatically (backward compat) */
    bool ownFrame = !canvas->frameActive;
    if (ownFrame) {
        dm_canvas_begin_frame(canvas);
    }

    /* Execute operations */
    executeOpsFromJson(canvas, root);

    if (ownFrame) {
        dm_canvas_end_frame(canvas);
    }
}

char *dm_canvas_get_image_data(DMCanvasRef canvas, int x, int y, int w, int h) {
    if (!canvas || !canvas->vg || !canvas->nvgFbo) {
        return strdup("{\"data\":[],\"width\":0,\"height\":0}");
    }
    egl_make_current(&canvas->eglState);
    return pixelops_get_image_data(canvas->nvgFbo->fbo,
                                   canvas->width, canvas->height,
                                   x, y, w, h);
}

void dm_canvas_put_image_data(DMCanvasRef canvas,
                              const unsigned char *data,
                              int dataW, int dataH,
                              int dx, int dy,
                              int dirtyX, int dirtyY,
                              int dirtyW, int dirtyH) {
    if (!canvas || !canvas->vg || !canvas->nvgFbo || !data) return;
    if (dataW <= 0 || dataH <= 0) return;

    // Apply dirty rect clipping
    if (dirtyX < 0) { dirtyW += dirtyX; dirtyX = 0; }
    if (dirtyY < 0) { dirtyH += dirtyY; dirtyY = 0; }
    if (dirtyX + dirtyW > dataW) dirtyW = dataW - dirtyX;
    if (dirtyY + dirtyH > dataH) dirtyH = dataH - dirtyY;
    if (dirtyW <= 0 || dirtyH <= 0) return;

    // Extract the dirty sub-rectangle from the full imageData
    std::vector<unsigned char> subData(dirtyW * dirtyH * 4);
    for (int row = 0; row < dirtyH; row++) {
        memcpy(&subData[row * dirtyW * 4],
               &data[((dirtyY + row) * dataW + dirtyX) * 4],
               dirtyW * 4);
    }

    egl_make_current(&canvas->eglState);
    pixelops_put_image_data(canvas->vg, canvas->nvgFbo->fbo,
                            canvas->width, canvas->height,
                            subData.data(),
                            dx + dirtyX, dy + dirtyY,
                            dirtyW, dirtyH);
}

char *dm_canvas_to_data_url(DMCanvasRef canvas, const char *mime, double quality) {
    if (!canvas || !canvas->vg || !canvas->nvgFbo) {
        return strdup("data:,");
    }
    egl_make_current(&canvas->eglState);
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

int dm_canvas_load_image_data(DMCanvasRef canvas, const char *imageId,
                              const unsigned char *fileData, int dataLen,
                              int *out_w, int *out_h) {
    if (!canvas || !canvas->vg || !imageId || !fileData || dataLen <= 0) return -1;

    egl_make_current(&canvas->eglState);

    int handle = canvas->imageManager.createImageFromData(canvas->vg, imageId, fileData, dataLen);
    if (handle < 0) {
        LOGE("dm_canvas_load_image_data: decode failed for imageId=%{public}s", imageId);
        return -1;
    }

    int w = 0, h = 0;
    nvgImageSize(canvas->vg, handle, &w, &h);
    if (out_w) *out_w = w;
    if (out_h) *out_h = h;
    LOGD("dm_canvas_load_image_data: loaded imageId=%{public}s %{public}dx%{public}d handle=%{public}d",
         imageId, w, h, handle);
    return 0;
}

int dm_canvas_load_image_rgba(DMCanvasRef canvas, const char *imageId,
                              int w, int h, const unsigned char *rgbaData) {
    if (!canvas || !canvas->vg || !imageId || !rgbaData || w <= 0 || h <= 0) return -1;

    egl_make_current(&canvas->eglState);

    int handle = canvas->imageManager.createImageFromRGBA(canvas->vg, imageId, w, h, rgbaData);
    if (handle < 0) {
        LOGE("dm_canvas_load_image_rgba: upload failed for imageId=%{public}s", imageId);
        return -1;
    }
    LOGD("dm_canvas_load_image_rgba: loaded imageId=%{public}s %{public}dx%{public}d handle=%{public}d",
         imageId, w, h, handle);
    return 0;
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
