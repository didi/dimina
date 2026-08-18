package com.didi.dimina.api.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChooseMessageFileContractTest {
    @Test
    fun `classifies MIME first and falls back to file extension`() {
        assertEquals("image", ChooseMessageFileContract.classify("image/png", "unknown.bin"))
        assertEquals("video", ChooseMessageFileContract.classify(null, "clip.MP4"))
        assertEquals("file", ChooseMessageFileContract.classify("application/pdf", "report.pdf"))
    }

    @Test
    fun `file type excludes images and videos`() {
        assertFalse(ChooseMessageFileContract.accepts("file", emptySet(), "image/jpeg", "photo.jpg"))
        assertFalse(ChooseMessageFileContract.accepts("file", emptySet(), "video/mp4", "clip.mp4"))
        assertTrue(ChooseMessageFileContract.accepts("file", emptySet(), "application/pdf", "report.pdf"))
    }

    @Test
    fun `extension filtering is normalized and case insensitive`() {
        val extensions = setOf(ChooseMessageFileContract.normalizeExtension(".PDF"))

        assertTrue(ChooseMessageFileContract.accepts("file", extensions, "application/pdf", "REPORT.PDF"))
        assertFalse(ChooseMessageFileContract.accepts("file", extensions, "text/plain", "notes.txt"))
    }
}
