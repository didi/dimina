#ifdef DIMINA_PLATFORM_HARMONY

#include "canvas_napi.h"
#include "dimina_canvas2d.h"

#include <native_window/external_window.h>
#include <hilog/log.h>

#define LOG_TAG "dimina_canvas2d_napi"

napi_value CanvasNapi_CreateCanvas(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    int32_t width = 0, height = 0;
    napi_get_value_int32(env, argv[0], &width);
    napi_get_value_int32(env, argv[1], &height);

    DMCanvasRef canvas = dm_canvas_create(width, height);

    napi_value result;
    napi_create_int64(env, reinterpret_cast<int64_t>(canvas), &result);
    return result;
}

napi_value CanvasNapi_DestroyCanvas(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    int64_t handle = 0;
    napi_get_value_int64(env, argv[0], &handle);
    dm_canvas_destroy(reinterpret_cast<DMCanvasRef>(handle));

    return nullptr;
}

napi_value CanvasNapi_InitSurface(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    int64_t handle = 0;
    napi_get_value_int64(env, argv[0], &handle);

    /* argv[1] is the XComponent ID; the OHNativeWindow is obtained
       from the XComponent callback. For now, this is a placeholder —
       the actual OHNativeWindow pointer is passed via the XComponent
       onSurfaceCreated callback in the NAPI layer. */
    void *nativeWindow = nullptr;
    napi_get_value_external(env, argv[1], &nativeWindow);

    int result = dm_canvas_init_surface(
        reinterpret_cast<DMCanvasRef>(handle), nativeWindow);

    napi_value retVal;
    napi_create_int32(env, result, &retVal);
    return retVal;
}

napi_value CanvasNapi_DestroySurface(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    int64_t handle = 0;
    napi_get_value_int64(env, argv[0], &handle);
    dm_canvas_destroy_surface(reinterpret_cast<DMCanvasRef>(handle));

    return nullptr;
}

napi_value CanvasNapi_Resize(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    int64_t handle = 0;
    int32_t width = 0, height = 0;
    napi_get_value_int64(env, argv[0], &handle);
    napi_get_value_int32(env, argv[1], &width);
    napi_get_value_int32(env, argv[2], &height);

    dm_canvas_resize(reinterpret_cast<DMCanvasRef>(handle), width, height);
    return nullptr;
}

napi_value CanvasNapi_SwapBuffers(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    int64_t handle = 0;
    napi_get_value_int64(env, argv[0], &handle);
    dm_canvas_swap_buffers(reinterpret_cast<DMCanvasRef>(handle));

    return nullptr;
}

#endif /* DIMINA_PLATFORM_HARMONY */
