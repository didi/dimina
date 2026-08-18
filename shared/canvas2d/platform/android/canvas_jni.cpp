#include "canvas_jni.h"
#include "dimina_canvas2d.h"

#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <android/log.h>

#define LOG_TAG "dimina_canvas2d_jni"

/* Declared in canvas_bindings.cpp */
extern void setCanvasGLHandle(const char *nodeId, DMCanvasRef glCanvas);

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeCreateCanvas(
        JNIEnv *env, jobject thiz, jint width, jint height) {
    DMCanvasRef canvas = dm_canvas_create(width, height);
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
                        "nativeCreateCanvas: %dx%d handle=%p", width, height, canvas);
    return reinterpret_cast<jlong>(canvas);
}

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeDestroyCanvas(
        JNIEnv *env, jobject thiz, jlong handle) {
    auto canvas = reinterpret_cast<DMCanvasRef>(handle);
    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
                        "nativeDestroyCanvas: handle=%p", canvas);
    dm_canvas_destroy(canvas);
}

JNIEXPORT jint JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeInitSurface(
        JNIEnv *env, jobject thiz, jlong handle, jobject surface) {
    auto canvas = reinterpret_cast<DMCanvasRef>(handle);
    ANativeWindow *window = ANativeWindow_fromSurface(env, surface);
    if (!window) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG,
                            "nativeInitSurface: ANativeWindow_fromSurface failed");
        return -1;
    }

    int result = dm_canvas_init_surface(canvas, window);
    ANativeWindow_release(window);

    __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG,
                        "nativeInitSurface: result=%d", result);
    return result;
}

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeDestroySurface(
        JNIEnv *env, jobject thiz, jlong handle) {
    auto canvas = reinterpret_cast<DMCanvasRef>(handle);
    dm_canvas_destroy_surface(canvas);
}

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeResize(
        JNIEnv *env, jobject thiz, jlong handle, jint width, jint height) {
    auto canvas = reinterpret_cast<DMCanvasRef>(handle);
    dm_canvas_resize(canvas, width, height);
}

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeSwapBuffers(
        JNIEnv *env, jobject thiz, jlong handle) {
    auto canvas = reinterpret_cast<DMCanvasRef>(handle);
    dm_canvas_swap_buffers(canvas);
}

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeBindCanvasToNode(
        JNIEnv *env, jobject thiz, jstring nodeId, jlong handle) {
    auto canvas = reinterpret_cast<DMCanvasRef>(handle);
    const char *nodeIdStr = env->GetStringUTFChars(nodeId, nullptr);
    if (nodeIdStr) {
        setCanvasGLHandle(nodeIdStr, canvas);
        env->ReleaseStringUTFChars(nodeId, nodeIdStr);
    }
}

} /* extern "C" */
