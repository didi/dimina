#ifndef DIMINA_EGL_SURFACE_H
#define DIMINA_EGL_SURFACE_H

#if defined(DIMINA_PLATFORM_ANDROID) || defined(DIMINA_PLATFORM_HARMONY)

#include <EGL/egl.h>

struct EGLState {
    EGLDisplay display  = EGL_NO_DISPLAY;
    EGLConfig  config   = nullptr;
    EGLContext context   = EGL_NO_CONTEXT;
    EGLSurface surface   = EGL_NO_SURFACE;
    bool       ownsDisplay = false;
};

/**
 * Initialize EGL display + context (off-screen, no surface yet).
 * Returns 0 on success, -1 on failure.
 */
int egl_init(EGLState *state);

/**
 * Create an on-screen EGL surface from a native window handle
 * (ANativeWindow on Android, OHNativeWindow on Harmony).
 * Returns 0 on success.
 */
int egl_create_surface(EGLState *state, void *native_window);

/**
 * Destroy the EGL surface (but keep context alive).
 */
void egl_destroy_surface(EGLState *state);

/**
 * Make the EGL context current on the calling thread.
 */
int egl_make_current(EGLState *state);

/**
 * Swap buffers (present rendered frame).
 */
void egl_swap_buffers(EGLState *state);

/**
 * Tear down everything (context + display).
 */
void egl_cleanup(EGLState *state);

#elif defined(DIMINA_PLATFORM_IOS)

/* iOS uses ANGLE or Metal — EGL state is managed by platform-specific code */
struct EGLState {
    void *angleDisplay  = nullptr;
    void *angleContext  = nullptr;
    void *angleSurface  = nullptr;
};

int  egl_init(EGLState *state);
int  egl_create_surface(EGLState *state, void *native_window);
void egl_destroy_surface(EGLState *state);
int  egl_make_current(EGLState *state);
void egl_swap_buffers(EGLState *state);
void egl_cleanup(EGLState *state);

#endif

#endif /* DIMINA_EGL_SURFACE_H */
