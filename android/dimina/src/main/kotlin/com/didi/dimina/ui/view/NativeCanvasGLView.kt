package com.didi.dimina.ui.view

import android.content.Context
import android.graphics.SurfaceTexture
import android.util.AttributeSet
import android.util.Log
import android.view.TextureView

/**
 * TextureView-based Canvas 2D view backed by NanoVG + GLES2.
 *
 * This view creates an EGL surface from the TextureView's SurfaceTexture,
 * then all Canvas 2D operations are rendered directly by the C++ renderer
 * (dimina_canvas2d) without going through Android's Canvas API.
 *
 * The EGL context is bound on the JS thread (via canvas_bindings.cpp),
 * so all rendering happens on the JS thread — no cross-thread sync needed.
 */
class NativeCanvasGLView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : TextureView(context, attrs, defStyleAttr), TextureView.SurfaceTextureListener {

    companion object {
        private const val TAG = "NativeCanvasGLView"

        init {
            System.loadLibrary("dimina")
        }
    }

    /** Native canvas handle (pointer to DMCanvas) */
    private var nativeHandle: Long = 0

    /** The nodeId this view is associated with */
    var nodeId: String = ""
        private set

    /** The instanceId of the QuickJSEngine this canvas belongs to */
    var instanceId: Int = -1
        private set

    /** Whether the surface is currently available */
    private var surfaceAvailable = false

    init {
        surfaceTextureListener = this
        isOpaque = false // Support transparency
    }

    /**
     * Initialize the GL canvas for a given nodeId and dimensions.
     * Called from CanvasManager when the canvas view is registered.
     */
    fun initCanvas(nodeId: String, width: Int, height: Int, instanceId: Int = -1) {
        this.nodeId = nodeId
        this.instanceId = instanceId
        if (nativeHandle == 0L) {
            nativeHandle = nativeCreateCanvas(width, height)
            Log.d(TAG, "initCanvas: nodeId=$nodeId size=${width}x${height} handle=$nativeHandle instanceId=$instanceId")
        }

        // If surface is already available, init it now
        if (surfaceAvailable && surfaceTexture != null) {
            initSurfaceInternal()
        }
    }

    /**
     * Get the native canvas handle for use with canvas_bindings.cpp.
     */
    fun getNativeHandle(): Long = nativeHandle

    /**
     * Upload decoded image pixels to the native canvas.
     * Called from CanvasImageLoader after downloading and decoding an image.
     */
    fun uploadImage(imageId: String, rgba: ByteArray, width: Int, height: Int, callbackId: String) {
        if (nativeHandle != 0L) {
            nativeUploadImage(nodeId, imageId, rgba, width, height, callbackId)
        }
    }

    // ─── SurfaceTextureListener ─────────────────────────────────────

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        Log.d(TAG, "onSurfaceTextureAvailable: ${width}x${height} nodeId=$nodeId")
        surfaceAvailable = true

        if (nativeHandle != 0L) {
            initSurfaceInternal()
        }
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        Log.d(TAG, "onSurfaceTextureSizeChanged: ${width}x${height} nodeId=$nodeId")
        if (nativeHandle != 0L) {
            nativeResize(nativeHandle, width, height)
        }
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        Log.d(TAG, "onSurfaceTextureDestroyed: nodeId=$nodeId")
        surfaceAvailable = false

        if (nativeHandle != 0L) {
            nativeDestroySurface(nativeHandle)
        }
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
        // No-op: rendering is driven by flush, not by surface updates
    }

    // ─── Internal ───────────────────────────────────────────────────

    private fun initSurfaceInternal() {
        val surface = android.view.Surface(surfaceTexture)
        val result = nativeInitSurface(nativeHandle, surface)
        surface.release()

        if (result == 0) {
            Log.d(TAG, "initSurfaceInternal: success nodeId=$nodeId")
            // Bind the GL canvas to the nodeId in canvas_bindings
            nativeBindCanvasToNode(nodeId, nativeHandle)
        } else {
            Log.e(TAG, "initSurfaceInternal: failed result=$result nodeId=$nodeId")
        }
    }

    /**
     * Release all native resources.
     */
    fun destroy() {
        if (nativeHandle != 0L) {
            nativeDestroyCanvas(nativeHandle)
            nativeHandle = 0
            Log.d(TAG, "destroy: nodeId=$nodeId")
        }
    }

    // ─── Native methods ─────────────────────────────────────────────

    private external fun nativeCreateCanvas(width: Int, height: Int): Long
    private external fun nativeDestroyCanvas(handle: Long)
    private external fun nativeInitSurface(handle: Long, surface: android.view.Surface): Int
    private external fun nativeDestroySurface(handle: Long)
    private external fun nativeResize(handle: Long, width: Int, height: Int)
    private external fun nativeSwapBuffers(handle: Long)
    private external fun nativeBindCanvasToNode(nodeId: String, handle: Long)
    private external fun nativeUploadImage(
        nodeId: String, imageId: String, rgba: ByteArray,
        width: Int, height: Int, callbackId: String
    )
}
