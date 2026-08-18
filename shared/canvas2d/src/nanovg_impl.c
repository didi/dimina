/**
 * nanovg_impl.c — Compile NanoVG + GLES2 backend in a single translation unit.
 *
 * nanovg.c internally includes fontstash.h (with FONTSTASH_IMPLEMENTATION)
 * which in turn includes stb_truetype.h (with STB_TRUETYPE_IMPLEMENTATION).
 * So we must NOT pre-include stb_truetype here.
 *
 * Order:
 *   1. GL headers
 *   2. nanovg.c  (brings in fontstash + stb_truetype + stb_image)
 *   3. nanovg_gl.h (GLES2 backend implementation)
 *   4. nanovg_gl_utils.h (FBO utilities implementation)
 *   5. stb_image_write.h (not included by nanovg.c, needed separately)
 */

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY)
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#elif defined(DIMINA_PLATFORM_IOS)
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#endif

/* NanoVG core — includes fontstash, stb_truetype, stb_image internally */
#include "nanovg.c"

/* GLES2 backend */
#define NANOVG_GLES2_IMPLEMENTATION
#include "nanovg_gl.h"
#include "nanovg_gl_utils.h"

/* stb_image_write — not included by nanovg.c, compile once here */
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
