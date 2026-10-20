#include <jni.h>
#include <new>
#include "../../../../../native/media/yuv_rgba.h"

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_didi_dimina_engine_qjs_NativeVideoPixels_rgba(JNIEnv *env, jobject, jint width, jint height,
    jint left, jint top, jobject y, jobject u, jobject v, jintArray layout, jboolean fullRange, jboolean bt709) {
    try {
        if (!layout || env->GetArrayLength(layout) != 12) throw std::invalid_argument("invalid video plane layout");
        jint fields[12];
        env->GetIntArrayRegion(layout, 0, 12, fields);
        if (env->ExceptionCheck()) return nullptr;
        const jobject buffers[] = {y, u, v};
        dimina::media::VideoPlane planes[3];
        for (size_t index = 0; index < 3; ++index) {
            if (!buffers[index]) throw std::invalid_argument("missing video plane");
            const auto capacity = env->GetDirectBufferCapacity(buffers[index]);
            const auto *bytes = static_cast<const uint8_t *>(env->GetDirectBufferAddress(buffers[index]));
            const auto *field = fields + index * 4;
            if (!bytes || capacity < 0 || field[0] < 0 || field[1] < field[0] || field[1] > capacity)
                throw std::invalid_argument("video planes must be direct buffers with valid limits");
            planes[index] = {bytes, static_cast<size_t>(field[1]), static_cast<size_t>(field[0]), field[2], field[3]};
        }
        const auto pixels = dimina::media::yuv420Rgba(width, height, left, top, planes, fullRange, bt709);
        auto result = env->NewByteArray(static_cast<jsize>(pixels.size()));
        if (result) env->SetByteArrayRegion(result, 0, static_cast<jsize>(pixels.size()), reinterpret_cast<const jbyte *>(pixels.data()));
        return result;
    } catch (const std::bad_alloc &) {
        if (!env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/OutOfMemoryError"), "Cannot allocate video pixels");
    } catch (const std::exception &error) {
        if (!env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/IllegalArgumentException"), error.what());
    }
    return nullptr;
}
