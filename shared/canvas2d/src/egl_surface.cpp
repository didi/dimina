#include "egl_surface.h"

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

/* ─── Android / Harmony / iOS (real EGL) ─────────────────────────────── */

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY) || defined(DIMINA_PLATFORM_IOS)

int egl_init(EGLState *state) {
    /* Skip if already initialized — prevents leaking EGL contexts on retry */
    if (state->context != EGL_NO_CONTEXT) {
        LOGD("egl_init: already initialized, skipping");
        return 0;
    }

#if defined(DIMINA_PLATFORM_IOS)
    /* ANGLE on iOS: request the Metal backend via eglGetPlatformDisplayEXT.
       This creates an EGL display backed by Metal, translating all GLES2
       calls to Metal API internally. */
    PFNEGLGETPLATFORMDISPLAYEXTPROC eglGetPlatformDisplayEXT =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    if (eglGetPlatformDisplayEXT) {
        EGLint displayAttribs[] = {
            EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,
            EGL_NONE
        };
        state->display = eglGetPlatformDisplayEXT(
            EGL_PLATFORM_ANGLE_ANGLE, EGL_DEFAULT_DISPLAY, displayAttribs);
    }
    if (state->display == EGL_NO_DISPLAY) {
        /* Fallback to default display if platform extension unavailable */
        state->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    }
#else
    state->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
#endif

    if (state->display == EGL_NO_DISPLAY) {
        LOGE("egl_init: eglGetDisplay failed");
        return -1;
    }

    EGLint major, minor;
    if (!eglInitialize(state->display, &major, &minor)) {
        LOGE("egl_init: eglInitialize failed");
        return -1;
    }
    state->ownsDisplay = true;
    LOGD("egl_init: EGL %d.%d", major, minor);

    /* Choose config: GLES2, RGBA8, depth/stencil */
    const EGLint configAttribs[] = {
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_SURFACE_TYPE,    EGL_WINDOW_BIT | EGL_PBUFFER_BIT,
        EGL_RED_SIZE,        8,
        EGL_GREEN_SIZE,      8,
        EGL_BLUE_SIZE,       8,
        EGL_ALPHA_SIZE,      8,
        EGL_DEPTH_SIZE,      0,
        EGL_STENCIL_SIZE,    8,
        EGL_NONE
    };

    EGLint numConfigs = 0;
    if (!eglChooseConfig(state->display, configAttribs, &state->config, 1, &numConfigs)
        || numConfigs == 0) {
        LOGE("egl_init: eglChooseConfig failed");
        return -1;
    }

    /* Create GLES2 context */
    const EGLint contextAttribs[] = {
        EGL_CONTEXT_CLIENT_VERSION, 2,
        EGL_NONE
    };
    state->context = eglCreateContext(state->display, state->config,
                                       EGL_NO_CONTEXT, contextAttribs);
    if (state->context == EGL_NO_CONTEXT) {
        LOGE("egl_init: eglCreateContext failed");
        return -1;
    }

    LOGD("egl_init: context created");
    return 0;
}

int egl_create_surface(EGLState *state, void *native_window) {
    if (state->surface != EGL_NO_SURFACE) {
        egl_destroy_surface(state);
    }

    state->surface = eglCreateWindowSurface(state->display, state->config,
                                             (EGLNativeWindowType)native_window,
                                             nullptr);
    if (state->surface == EGL_NO_SURFACE) {
        LOGE("egl_create_surface: eglCreateWindowSurface failed (0x%x)",
             eglGetError());
        return -1;
    }

    return egl_make_current(state);
}

void egl_destroy_surface(EGLState *state) {
    if (state->surface != EGL_NO_SURFACE) {
        eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE,
                        EGL_NO_CONTEXT);
        eglDestroySurface(state->display, state->surface);
        state->surface = EGL_NO_SURFACE;
    }
}

int egl_make_current(EGLState *state) {
    /* Skip if this context is already current — avoids driver side-effects
       (some HarmonyOS drivers reset FBO binding on redundant eglMakeCurrent). */
    if (eglGetCurrentContext() == state->context &&
        eglGetCurrentSurface(EGL_DRAW) == state->surface) {
        return 0;
    }
    if (!eglMakeCurrent(state->display, state->surface, state->surface,
                         state->context)) {
        LOGE("egl_make_current: failed (0x%x)", eglGetError());
        return -1;
    }
    return 0;
}

void egl_swap_buffers(EGLState *state) {
    if (state->surface != EGL_NO_SURFACE) {
        eglSwapBuffers(state->display, state->surface);
    }
}

void egl_cleanup(EGLState *state) {
    egl_destroy_surface(state);
    if (state->context != EGL_NO_CONTEXT) {
        eglDestroyContext(state->display, state->context);
        state->context = EGL_NO_CONTEXT;
    }
    /* Do NOT call eglTerminate here.  eglGetDisplay(EGL_DEFAULT_DISPLAY)
       returns a process-global display that is shared by ALL canvases.
       Terminating it would invalidate every EGL context/surface on the
       display, destroying NanoVG state for canvases that are still alive. */
    state->display = EGL_NO_DISPLAY;
    state->ownsDisplay = false;
}

#endif
