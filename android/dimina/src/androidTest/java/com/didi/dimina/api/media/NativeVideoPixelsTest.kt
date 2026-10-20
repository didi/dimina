package com.didi.dimina.api.media

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.didi.dimina.engine.qjs.NativeVideoPixels
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer

@RunWith(AndroidJUnit4::class)
class NativeVideoPixelsTest {
    @Test fun nativePixelsMatchEveryByteAcrossColorsStridesCropsAndBufferViews() {
        for (full in listOf(false, true)) for (bt709 in listOf(false, true)) {
            for (stride in listOf(1, 2, 3)) for (left in listOf(0, 1)) for (top in listOf(0, 1)) {
                val planes = Array(3) { plane ->
                    val allocation = ByteBuffer.allocateDirect(1024)
                    for (index in 0 until allocation.capacity()) allocation.put(index, (index * 37 + plane * 71).toByte())
                    allocation.position(5)
                    val buffer = allocation.slice().asReadOnlyBuffer().apply { position(plane + 3); limit(512) }
                    VideoPlane(buffer, 31 + plane * 7, stride)
                }
                assertSamePixels(7, 5, left, top, planes, full, bt709)
            }
        }
    }

    @Test fun interleavedChromaAndHeapFallbackKeepOwnedOutput() {
        for (full in listOf(false, true)) for (bt709 in listOf(false, true)) {
            for (swap in listOf(false, true)) {
                val y = ByteBuffer.allocateDirect(128)
                val uv = ByteBuffer.allocateDirect(128)
                for (index in 0 until 128) { y.put(index, (index * 13).toByte()); uv.put(index, (index * 17).toByte()) }
                val planes = arrayOf(VideoPlane(y, 13, 1),
                    VideoPlane(uv.duplicate().apply { position(if (swap) 1 else 0) }, 14, 2),
                    VideoPlane(uv.duplicate().apply { position(if (swap) 0 else 1) }, 14, 2))
                val expected = videoFrameRgba(7, 5, 1, 1, planes, full, bt709)
                val actual = decodedVideoFrameRgba(7, 5, 1, 1, planes, full, bt709)
                assertArrayEquals(expected, actual)
                for (index in 0 until 128) { y.put(index, 0); uv.put(index, 0) }
                assertArrayEquals(expected, actual)
                val heap = Array(3) { index ->
                    val plane = planes[index]
                    VideoPlane(ByteBuffer.wrap(ByteArray(128) { (it * 37 + index).toByte() }), plane.rowStride, plane.pixelStride)
                }
                assertSamePixels(7, 5, 1, 1, heap, full, bt709)
            }
        }
    }

    @Test fun rejectsTruncatedPlanesInvalidLayoutsAndOversizedFramesBeforeReading() {
        val buffers = Array(3) { ByteBuffer.allocateDirect(64) }
        val layout = intArrayOf(0, 64, 8, 1, 0, 64, 8, 1, 0, 64, 8, 1)
        fun convert(width: Int = 4, height: Int = 4, left: Int = 0, top: Int = 0, fields: IntArray = layout) =
            NativeVideoPixels.rgba(width, height, left, top, buffers[0], buffers[1], buffers[2], fields, false, false)
        for ((width, height) in listOf(0 to 4, 4097 to 1, 4096 to 4096)) {
            assertThrows(IllegalArgumentException::class.java) { convert(width, height) }
        }
        for ((index, value) in listOf(0 to -1, 1 to 8, 1 to 65, 2 to 0, 3 to -1, 4 to 64)) {
            assertThrows(IllegalArgumentException::class.java) { convert(fields = layout.copyOf().apply { this[index] = value }) }
        }
        assertThrows(IllegalArgumentException::class.java) { convert(left = Int.MAX_VALUE) }
        assertThrows(IllegalArgumentException::class.java) { convert(top = -1) }
        assertThrows(IllegalArgumentException::class.java) { convert(fields = IntArray(11)) }
        assertThrows(IllegalArgumentException::class.java) {
            NativeVideoPixels.rgba(4, 4, 0, 0, ByteBuffer.allocate(64), buffers[1], buffers[2], layout, false, false)
        }
        // A valid call still succeeds after rejected metadata, with no pending JNI exception.
        assertEquals(64, convert().size)
    }

    private fun assertSamePixels(width: Int, height: Int, left: Int, top: Int,
        planes: Array<VideoPlane>, full: Boolean, bt709: Boolean) {
        val positions = planes.map { it.buffer.position() }
        val limits = planes.map { it.buffer.limit() }
        val expected = videoFrameRgba(width, height, left, top, planes, full, bt709)
        val actual = decodedVideoFrameRgba(width, height, left, top, planes, full, bt709)
        assertArrayEquals("full=$full bt709=$bt709 crop=$left,$top", expected, actual)
        assertEquals(positions, planes.map { it.buffer.position() })
        assertEquals(limits, planes.map { it.buffer.limit() })
    }
}
