#ifndef DIMINA_CANVAS_JNI_H
#define DIMINA_CANVAS_JNI_H

#include <jni.h>

/**
 * JNI bridge for the Canvas 2D GL renderer on Android.
 *
 * Called from NativeCanvasGLView.kt to:
 *   - Initialize/destroy the EGL surface from a native window
 *   - Trigger swap buffers after flush
 */

#ifdef __cplusplus
extern "C" {
#endif

JNIEXPORT jlong JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeCreateCanvas(
    JNIEnv *env, jobject thiz, jint width, jint height);

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeDestroyCanvas(
    JNIEnv *env, jobject thiz, jlong handle);

JNIEXPORT jint JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeInitSurface(
    JNIEnv *env, jobject thiz, jlong handle, jobject surface);

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeDestroySurface(
    JNIEnv *env, jobject thiz, jlong handle);

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeResize(
    JNIEnv *env, jobject thiz, jlong handle, jint width, jint height);

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeSwapBuffers(
    JNIEnv *env, jobject thiz, jlong handle);

JNIEXPORT void JNICALL
Java_com_didi_dimina_ui_view_NativeCanvasGLView_nativeBindCanvasToNode(
    JNIEnv *env, jobject thiz, jstring nodeId, jlong handle);

#ifdef __cplusplus
}
#endif

#endif /* DIMINA_CANVAS_JNI_H */
