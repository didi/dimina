package com.didi.dimina.api.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageApiCanvasValidationTest {
    private val api = ImageApi()

    @Test
    fun rejectsTraversalAndSeparatorsInCanvasAppId() {
        assertFalse(api.isValidCanvasAppId("../other-app"))
        assertFalse(api.isValidCanvasAppId("foo/bar"))
        assertFalse(api.isValidCanvasAppId("foo\\bar"))
        assertFalse(api.isValidCanvasAppId(".."))
        assertTrue(api.isValidCanvasAppId("wx92269e3b2f304afc"))
    }

    @Test
    fun canvasImageSignatureMustMatchFileType() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())
        val fake = byteArrayOf(0, 0, 0)

        assertTrue(api.matchesImageType(png, "png"))
        assertFalse(api.matchesImageType(png, "jpg"))
        assertTrue(api.matchesImageType(jpeg, "jpg"))
        assertFalse(api.matchesImageType(jpeg, "png"))
        assertFalse(api.matchesImageType(fake, "png"))
    }

    @Test
    fun canvasTempFileResultsCarryTheSameErrMsgIntoComplete() {
        val success = canvasTempFileSuccess("difile://tmp/canvas.png")
        val failure = canvasTempFileFailure("write failed")

        assertTrue(success.completeCarriesResult)
        assertEquals("canvasToTempFilePath:ok", success.value.getString("errMsg"))
        assertEquals("difile://tmp/canvas.png", success.value.getString("tempFilePath"))
        assertTrue(failure.completeCarriesResult)
        assertEquals("canvasToTempFilePath:fail write failed", failure.value.getString("errMsg"))
    }
}
