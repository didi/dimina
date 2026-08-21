/**
 * canvas_metal_angle.mm — iOS ANGLE (GLES2→Metal) initialization.
 *
 * ANGLE EGL integration is now handled directly in egl_surface.cpp, which uses
 * ANGLE's standard EGL API (eglGetPlatformDisplayEXT with Metal backend).
 * The iOS EGL implementation is unified with Android/Harmony — ANGLE provides
 * the same EGL/GLES2 API surface on all platforms.
 *
 * This file is retained for reference and potential platform-specific extensions.
 */

#ifdef DIMINA_PLATFORM_IOS

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

/* No additional Objective-C code required.
   Swift calls the C API (dimina_canvas2d.h) directly via bridging header.
   ANGLE provides EGL + GLES2 backed by Metal. */

#endif /* DIMINA_PLATFORM_IOS */
