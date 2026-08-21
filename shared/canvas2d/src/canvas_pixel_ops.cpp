#include "canvas_pixel_ops.h"
#include "stb_image_write.h"
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>

/* Base64 encoder */
static const char kBase64Table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64Encode(const unsigned char *data, size_t len) {
    std::string result;
    result.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        unsigned int b = (unsigned int)data[i] << 16;
        if (i + 1 < len) b |= (unsigned int)data[i + 1] << 8;
        if (i + 2 < len) b |= (unsigned int)data[i + 2];

        result += kBase64Table[(b >> 18) & 0x3F];
        result += kBase64Table[(b >> 12) & 0x3F];
        result += (i + 1 < len) ? kBase64Table[(b >> 6) & 0x3F] : '=';
        result += (i + 2 < len) ? kBase64Table[b & 0x3F] : '=';
    }
    return result;
}

/* stb_image_write callback for writing to a vector */
struct WriteCtx {
    std::vector<unsigned char> data;
};

static void stbiWriteFunc(void *context, void *data, int size) {
    auto *ctx = (WriteCtx *)context;
    auto *ptr = (unsigned char *)data;
    ctx->data.insert(ctx->data.end(), ptr, ptr + size);
}

/* ─── Public API ─────────────────────────────────────────────────────── */

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)

char *pixelops_get_image_data(int fbo, int canvasWidth, int canvasHeight,
                              int x, int y, int w, int h) {
    /* Clamp to canvas bounds */
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > canvasWidth)  w = canvasWidth - x;
    if (y + h > canvasHeight) h = canvasHeight - y;
    if (w <= 0 || h <= 0) {
        return strdup("{\"data\":[],\"width\":0,\"height\":0}");
    }

    /* Bind the FBO and read pixels */
    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)fbo);

    std::vector<unsigned char> pixels(w * h * 4);
    glReadPixels(x, canvasHeight - y - h, w, h, GL_RGBA, GL_UNSIGNED_BYTE,
                 pixels.data());

    /* Flip vertically (GL reads bottom-up) */
    std::vector<unsigned char> flipped(w * h * 4);
    for (int row = 0; row < h; row++) {
        memcpy(&flipped[row * w * 4],
               &pixels[(h - 1 - row) * w * 4],
               w * 4);
    }

    /* Build JSON array of pixel values */
    std::string json = "{\"data\":[";
    int total = w * h * 4;
    for (int i = 0; i < total; i++) {
        if (i > 0) json += ',';
        char buf[8];
        snprintf(buf, sizeof(buf), "%d", flipped[i]);
        json += buf;
    }
    json += "],\"width\":";
    char dimBuf[32];
    snprintf(dimBuf, sizeof(dimBuf), "%d", w);
    json += dimBuf;
    json += ",\"height\":";
    snprintf(dimBuf, sizeof(dimBuf), "%d", h);
    json += dimBuf;
    json += "}";

    return strdup(json.c_str());
}

void pixelops_put_image_data(NVGcontext * /*vg*/, int fbo,
                             int canvasWidth, int canvasHeight,
                             const unsigned char *data,
                             int x, int y, int w, int h) {
    if (w <= 0 || h <= 0 || !data) return;

    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)fbo);

    /* Get the texture attached to this FBO's COLOR_ATTACHMENT0 */
    GLint fboTex = 0;
    glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                          GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME, &fboTex);
    if (fboTex <= 0) return;

    /* Flip data vertically for GL coordinate system */
    std::vector<unsigned char> flipped(w * h * 4);
    for (int row = 0; row < h; row++) {
        memcpy(&flipped[row * w * 4],
               &data[(h - 1 - row) * w * 4],
               w * 4);
    }

    /* Write directly to the FBO's color attachment texture */
    glBindTexture(GL_TEXTURE_2D, (GLuint)fboTex);
    int glY = canvasHeight - y - h;
    glTexSubImage2D(GL_TEXTURE_2D, 0, x, glY, w, h,
                    GL_RGBA, GL_UNSIGNED_BYTE, flipped.data());
    glBindTexture(GL_TEXTURE_2D, 0);
}

char *pixelops_to_data_url(int fbo, int canvasWidth, int canvasHeight,
                           const char *mime, double quality) {
    if (canvasWidth <= 0 || canvasHeight <= 0) {
        return strdup("data:,");
    }

    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)fbo);

    std::vector<unsigned char> pixels(canvasWidth * canvasHeight * 4);
    glReadPixels(0, 0, canvasWidth, canvasHeight, GL_RGBA, GL_UNSIGNED_BYTE,
                 pixels.data());

    /* Flip vertically */
    std::vector<unsigned char> flipped(canvasWidth * canvasHeight * 4);
    for (int row = 0; row < canvasHeight; row++) {
        memcpy(&flipped[row * canvasWidth * 4],
               &pixels[(canvasHeight - 1 - row) * canvasWidth * 4],
               canvasWidth * 4);
    }

    WriteCtx wctx;
    bool isJpeg = (mime && strcmp(mime, "image/jpeg") == 0);
    if (isJpeg) {
        int q = (int)(quality * 100);
        if (q < 1) q = 1;
        if (q > 100) q = 100;
        stbi_write_jpg_to_func(stbiWriteFunc, &wctx,
                                canvasWidth, canvasHeight, 4,
                                flipped.data(), q);
    } else {
        stbi_write_png_to_func(stbiWriteFunc, &wctx,
                                canvasWidth, canvasHeight, 4,
                                flipped.data(), canvasWidth * 4);
    }

    std::string b64 = base64Encode(wctx.data.data(), wctx.data.size());
    std::string dataUrl = "data:";
    dataUrl += isJpeg ? "image/jpeg" : "image/png";
    dataUrl += ";base64,";
    dataUrl += b64;

    return strdup(dataUrl.c_str());
}

#else

/* Stub for unsupported platforms */
char *pixelops_get_image_data(int, int, int, int, int, int, int) {
    return strdup("{\"data\":[],\"width\":0,\"height\":0}");
}
void pixelops_put_image_data(NVGcontext *, int, int, int,
                             const unsigned char *, int, int, int, int) {}
char *pixelops_to_data_url(int, int, int, const char *, double) {
    return strdup("data:,");
}

#endif
