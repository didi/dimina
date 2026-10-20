package com.didi.dimina.api.media

import com.didi.dimina.engine.qjs.NativeVideoPixels
import java.nio.ByteBuffer

internal data class VideoPlane(val buffer: ByteBuffer, val rowStride: Int, val pixelStride: Int)

internal fun decodedVideoFrameRgba(width: Int, height: Int, left: Int, top: Int,
    planes: Array<VideoPlane>, fullRange: Boolean, bt709: Boolean): ByteArray {
    require(planes.size == 3) { "expected three YUV planes" }
    // Image.Plane buffers are direct. Retain the portable path for other inputs.
    if (!planes.all { it.buffer.isDirect }) return videoFrameRgba(width, height, left, top, planes, fullRange, bt709)
    val layout = IntArray(12)
    planes.forEachIndexed { index, plane ->
        val offset = index * 4
        layout[offset] = plane.buffer.position(); layout[offset + 1] = plane.buffer.limit()
        layout[offset + 2] = plane.rowStride; layout[offset + 3] = plane.pixelStride
    }
    return NativeVideoPixels.rgba(width, height, left, top, planes[0].buffer, planes[1].buffer, planes[2].buffer,
        layout, fullRange, bt709)
}

/** Convert a cropped flexible YUV420 image into independently owned RGBA bytes. */
internal fun videoFrameRgba(width: Int, height: Int, left: Int, top: Int,
    planes: Array<VideoPlane>, fullRange: Boolean, bt709: Boolean): ByteArray {
    require(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width.toLong() * height <= 2_097_152) { "video frame exceeds pixel budget" }
    val pixels = ByteArray(width * height * 4)
    val yPlane = planes[0]; val uPlane = planes[1]; val vPlane = planes[2]
    val yBuffer = yPlane.buffer; val uBuffer = uPlane.buffer; val vBuffer = vPlane.buffer
    val yPosition = yBuffer.position(); val uPosition = uBuffer.position(); val vPosition = vBuffer.position()
    val chromaScale = if (fullRange) 1.0 else 255.0 / 224
    val redV = if (bt709) 1.5748 else 1.402
    val greenU = if (bt709) 0.1873 else 0.3441
    val greenV = if (bt709) 0.4681 else 0.7141
    val blueU = if (bt709) 1.8556 else 1.772
    var offset = 0
    for (y in 0 until height) {
        val sy = y + top
        var yIndex = yPosition + sy * yPlane.rowStride + left * yPlane.pixelStride
        val uRow = uPosition + sy / 2 * uPlane.rowStride
        val vRow = vPosition + sy / 2 * vPlane.rowStride
        var lastChroma = -1
        var red = 0.0; var greenFromU = 0.0; var greenFromV = 0.0; var blue = 0.0
        for (x in 0 until width) {
            val chroma = (x + left) / 2
            if (chroma != lastChroma) {
                val u = (uBuffer.get(uRow + chroma * uPlane.pixelStride).toInt() and 255) - 128.0
                val v = (vBuffer.get(vRow + chroma * vPlane.pixelStride).toInt() and 255) - 128.0
                // Keep the original multiplication order and truncation, including
                // full/limited range and BT.601/709 clipping at channel boundaries.
                red = redV * v * chromaScale
                greenFromU = greenU * u * chromaScale
                greenFromV = greenV * v * chromaScale
                blue = blueU * u * chromaScale
                lastChroma = chroma
            }
            val luma = yBuffer.get(yIndex).toInt() and 255
            yIndex += yPlane.pixelStride
            val yy = if (fullRange) luma.toDouble() else (luma - 16) * 255.0 / 219
            pixels[offset++] = (yy + red).toInt().coerceIn(0, 255).toByte()
            pixels[offset++] = (yy - greenFromU - greenFromV).toInt().coerceIn(0, 255).toByte()
            pixels[offset++] = (yy + blue).toInt().coerceIn(0, 255).toByte()
            pixels[offset++] = 255.toByte()
        }
    }
    return pixels
}
