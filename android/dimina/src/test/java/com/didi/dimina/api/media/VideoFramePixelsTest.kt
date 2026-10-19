package com.didi.dimina.api.media

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class VideoFramePixelsTest {
    @Test fun preservesEveryByteForRangesStandardsStridesAndOddCrops() {
        for (full in listOf(false, true)) for (bt709 in listOf(false, true)) {
            for (pixelStride in listOf(1, 2, 3)) for (left in listOf(0, 1)) for (top in listOf(0, 1)) {
                val planes = Array(3) { plane ->
                    val buffer = ByteBuffer.allocateDirect(512)
                    for (index in 0 until buffer.capacity()) buffer.put(index, (index * 37 + plane * 71).toByte())
                    buffer.position(plane + 3)
                    VideoPlane(buffer, 31 + plane * 7, pixelStride)
                }
                val positions = planes.map { it.buffer.position() }
                val width = 7; val height = 5
                val expected = reference(width, height, left, top, planes, full, bt709)
                val actual = videoFrameRgba(width, height, left, top, planes, full, bt709)
                assertArrayEquals("full=$full bt709=$bt709 stride=$pixelStride crop=$left,$top", expected, actual)
                assertEquals(positions, planes.map { it.buffer.position() })
                planes[0].buffer.put(positions[0] + top * planes[0].rowStride + left * pixelStride, 0)
                assertArrayEquals(expected, actual)
            }
        }
    }

    @Test fun rejectsFramesBeyondTheExistingPixelBudget() {
        for ((width, height) in listOf(0 to 16, 4097 to 1, 4096 to 4096)) {
            assertThrows(IllegalArgumentException::class.java) {
                videoFrameRgba(width, height, 0, 0, emptyArray(), false, false)
            }
        }
    }

    // The former per-pixel path is an independent byte oracle for the optimized
    // row/chroma traversal. It deliberately does not share offsets or color terms.
    private fun reference(width: Int, height: Int, left: Int, top: Int,
        planes: Array<VideoPlane>, fullRange: Boolean, bt709: Boolean): ByteArray {
        fun component(plane: Int, x: Int, y: Int): Int {
            val p = planes[plane]
            return p.buffer.get(p.buffer.position() + y * p.rowStride + x * p.pixelStride).toInt() and 255
        }
        val pixels = ByteArray(width * height * 4)
        var offset = 0
        for (y in 0 until height) for (x in 0 until width) {
            val sx = x + left; val sy = y + top
            val luma = component(0, sx, sy)
            val u = component(1, sx / 2, sy / 2) - 128.0
            val v = component(2, sx / 2, sy / 2) - 128.0
            val yy = if (fullRange) luma.toDouble() else (luma - 16) * 255.0 / 219
            val chromaScale = if (fullRange) 1.0 else 255.0 / 224
            val r = yy + (if (bt709) 1.5748 else 1.402) * v * chromaScale
            val g = yy - (if (bt709) 0.1873 else 0.3441) * u * chromaScale -
                (if (bt709) 0.4681 else 0.7141) * v * chromaScale
            val b = yy + (if (bt709) 1.8556 else 1.772) * u * chromaScale
            pixels[offset++] = r.toInt().coerceIn(0, 255).toByte()
            pixels[offset++] = g.toInt().coerceIn(0, 255).toByte()
            pixels[offset++] = b.toInt().coerceIn(0, 255).toByte()
            pixels[offset++] = 255.toByte()
        }
        return pixels
    }
}
