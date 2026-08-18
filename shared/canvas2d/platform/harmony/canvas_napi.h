#ifndef DIMINA_CANVAS_NAPI_H
#define DIMINA_CANVAS_NAPI_H

/**
 * Harmony (OpenHarmony) NAPI bridge for Canvas 2D GL renderer.
 *
 * Called from ArkTS XComponent to pass the OHNativeWindow handle.
 * The EGL surface is created from OHNativeWindow, which is the
 * Harmony equivalent of Android's ANativeWindow.
 */

#ifdef DIMINA_PLATFORM_HARMONY

#include <napi/native_api.h>

napi_value CanvasNapi_CreateCanvas(napi_env env, napi_callback_info info);
napi_value CanvasNapi_DestroyCanvas(napi_env env, napi_callback_info info);
napi_value CanvasNapi_InitSurface(napi_env env, napi_callback_info info);
napi_value CanvasNapi_DestroySurface(napi_env env, napi_callback_info info);
napi_value CanvasNapi_Resize(napi_env env, napi_callback_info info);
napi_value CanvasNapi_SwapBuffers(napi_env env, napi_callback_info info);

#endif /* DIMINA_PLATFORM_HARMONY */

#endif /* DIMINA_CANVAS_NAPI_H */
