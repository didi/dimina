/**
 * canvas_metal_angle.mm — iOS ANGLE (GLES2→Metal) initialization.
 *
 * This file provides the iOS-specific EGL setup using ANGLE.
 * ANGLE translates GLES2 calls to Metal on iOS, providing the same
 * rendering pipeline as Android/Harmony without native GL support.
 *
 * Build note: This file is only compiled for the iOS target.
 * ANGLE must be linked as a dependency (via CocoaPods or SPM).
 */

#ifdef DIMINA_PLATFORM_IOS

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

/*
 * ANGLE integration is deferred to P3 (iOS integration phase).
 *
 * When ANGLE is available, this file will:
 * 1. Call eglGetPlatformDisplayEXT(EGL_PLATFORM_ANGLE_ANGLE, ...)
 * 2. Create EGL context with GLES2
 * 3. Create window surface from CAMetalLayer
 *
 * Alternative: Use MetalNanoVG backend directly (avoids ANGLE dependency).
 */

#endif /* DIMINA_PLATFORM_IOS */
