package com.didi.dimina.ui.view

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Image download+decode helper for native canvas.
 * Handles imageSetSrc ops: downloads images via URL, decodes to RGBA pixels,
 * and uploads to the native GL canvas via NativeCanvasGLView.nativeUploadImage.
 */
object CanvasImageLoader {
    private const val TAG = "CanvasImageLoader"

    /** Registry of active NativeCanvasGLView instances by nodeId */
    private val glViews = ConcurrentHashMap<String, NativeCanvasGLView>()

    private val httpClient = OkHttpClient()

    fun registerView(nodeId: String, view: NativeCanvasGLView) {
        glViews[nodeId] = view
    }

    fun unregisterView(nodeId: String) {
        glViews.remove(nodeId)
    }

    /**
     * Handle an imageSetSrc request from native canvas_bindings.
     * Called on the main thread. Downloads the image on a background thread,
     * decodes to RGBA, and calls nativeUploadImage.
     *
     * @param instanceId the QuickJSEngine instance
     * @param json JSON with {nodeId, imageId, src, onload, onerror}
     */
    fun handleImageSetSrc(instanceId: Int, json: String) {
        try {
            val obj = JSONObject(json)
            val nodeId = obj.optString("nodeId")
            val imageId = obj.optString("imageId")
            val src = obj.optString("src")
            val onload = obj.optString("onload", "")
            val onerror = obj.optString("onerror", "")

            if (nodeId.isEmpty() || imageId.isEmpty() || src.isEmpty()) {
                Log.e(TAG, "handleImageSetSrc: missing fields in json")
                return
            }

            Log.d(TAG, "handleImageSetSrc: nodeId=$nodeId imageId=$imageId src=$src")

            // Download and decode on a background thread
            Thread {
                try {
                    val bitmap = downloadAndDecode(src)
                    if (bitmap != null) {
                        val rgba = bitmapToRGBA(bitmap)
                        val width = bitmap.width
                        val height = bitmap.height
                        bitmap.recycle()

                        // Upload to native canvas
                        val view = glViews[nodeId]
                        if (view != null) {
                            view.uploadImage(imageId, rgba, width, height, onload)
                            Log.d(TAG, "handleImageSetSrc: uploaded imageId=$imageId ${width}x${height}")
                        } else {
                            Log.e(TAG, "handleImageSetSrc: no GLView for nodeId=$nodeId")
                        }
                    } else {
                        Log.e(TAG, "handleImageSetSrc: decode failed for src=$src")
                        // TODO: invoke onerror callback if needed
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "handleImageSetSrc: error downloading/decoding", e)
                }
            }.start()
        } catch (e: Exception) {
            Log.e(TAG, "handleImageSetSrc: JSON parse error", e)
        }
    }

    private fun downloadAndDecode(src: String): Bitmap? {
        return try {
            if (src.startsWith("http://") || src.startsWith("https://")) {
                // Network image
                val request = Request.Builder().url(src).build()
                val response = httpClient.newCall(request).execute()
                response.use {
                    if (it.isSuccessful) {
                        val bytes = it.body?.bytes()
                        if (bytes != null) {
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        } else null
                    } else null
                }
            } else {
                // Local file
                BitmapFactory.decodeFile(src)
            }
        } catch (e: Exception) {
            Log.e(TAG, "downloadAndDecode: failed for src=$src", e)
            null
        }
    }

    private fun bitmapToRGBA(bitmap: Bitmap): ByteArray {
        // Ensure ARGB_8888 format
        val argbBitmap = if (bitmap.config != Bitmap.Config.ARGB_8888) {
            bitmap.copy(Bitmap.Config.ARGB_8888, false)
        } else {
            bitmap
        }

        val width = argbBitmap.width
        val height = argbBitmap.height

        // Extract pixel data and convert ARGB → RGBA
        val pixels = IntArray(width * height)
        argbBitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        if (argbBitmap !== bitmap) {
            argbBitmap.recycle()
        }

        val rgba = ByteArray(width * height * 4)
        for (i in pixels.indices) {
            val pixel = pixels[i]
            val offset = i * 4
            rgba[offset] = ((pixel shr 16) and 0xFF).toByte()     // R
            rgba[offset + 1] = ((pixel shr 8) and 0xFF).toByte()  // G
            rgba[offset + 2] = (pixel and 0xFF).toByte()           // B
            rgba[offset + 3] = ((pixel shr 24) and 0xFF).toByte() // A
        }
        return rgba
    }
}
