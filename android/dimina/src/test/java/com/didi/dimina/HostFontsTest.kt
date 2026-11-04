package com.didi.dimina

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class HostFontsTest {
    @Test fun registeredFileIsReadDirectlyAndCanBeReplacedAndUnregistered() {
        val file = File.createTempFile("host-font-", ".ttf")
        try {
            file.writeBytes(byteArrayOf(0, 1, 2, 3))
            HostFonts.registerFile("brand", file)
            val resource = HostFonts.open("brand")!!
            assertEquals("font/ttf", resource.first)
            assertArrayEquals(byteArrayOf(0, 1, 2, 3), resource.second.use { it.readBytes() })
            file.writeBytes(byteArrayOf(4, 5))
            assertArrayEquals(byteArrayOf(4, 5), HostFonts.open("brand")!!.second.use { it.readBytes() })
            HostFonts.unregister("brand")
            assertNull(HostFonts.open("brand"))
            assertNull(HostFonts.open("../brand"))
        } finally { HostFonts.unregister("brand"); file.delete() }
    }

    @Test fun rejectsPathIdsAndUnsupportedFormats() {
        for (id in listOf("", "../font", "a/b", "a?b", "x".repeat(129))) {
            assertThrows(IllegalArgumentException::class.java) { HostFonts.requireValidId(id) }
        }
        assertThrows(IllegalArgumentException::class.java) { HostFonts.fontMimeType("js") }
        assertEquals("font/woff2", HostFonts.fontMimeType("WOFF2"))
    }
}
