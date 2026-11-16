package com.didi.dimina

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class HostImagesTest {
    @Test fun readsRegisteredFilesDirectlyAndUnregisters() {
        val file = File.createTempFile("host-image-", ".png")
        try {
            file.writeBytes(byteArrayOf(0, 1, 2, 3))
            HostImages.registerFile("Light_ON", file)
            val image = HostImages.open("Light_ON")!!
            assertEquals("image/png", image.first)
            assertArrayEquals(file.readBytes(), image.second.use { it.readBytes() })
            file.writeBytes(byteArrayOf(9))
            assertArrayEquals(byteArrayOf(9), HostImages.open("Light_ON")!!.second.use { it.readBytes() })
            assertNull(HostImages.open("Light_ON/extra.png"))
            HostImages.unregister("Light_ON")
            assertNull(HostImages.open("Light_ON"))
        } finally { HostImages.unregister("Light_ON"); file.delete() }
    }

    @Test fun confinesNestedDirectoryReadsAndDoesNotExposeNonImages() {
        val temporary = Files.createTempDirectory("host-images-").toFile()
        val root = File(temporary, "images").apply { mkdirs() }
        try {
            val file = File(root, "nested/灯 on.WeBp").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(3, 5)) }
            HostImages.registerDirectory("icons", root)
            val image = HostImages.open("icons/nested/灯 on.WeBp")!!
            assertEquals("image/webp", image.first)
            assertArrayEquals(file.readBytes(), image.second.use { it.readBytes() })
            for (key in listOf("icons/../outside.png", "icons//x.png", "icons/./x.png", "icons/%2e%2e/x.png", "icons/a\\b.png", "icons/", "icons/a?b.png")) {
                assertNull(key, HostImages.open(key))
            }
            File(root, "secret.json").writeText("private")
            assertThrows(IllegalArgumentException::class.java) { HostImages.open("icons/secret.json") }
            val outside = File(temporary, "outside.png").apply { writeText("outside") }
            Files.createSymbolicLink(File(root, "escape.png").toPath(), outside.toPath())
            assertThrows(IllegalArgumentException::class.java) { HostImages.open("icons/escape.png") }
            assertNull(HostImages.open("icons/missing.png"))
        } finally { HostImages.unregister("icons"); temporary.deleteRecursively() }
    }

    @Test fun validatesIdsAndMapsAllSupportedFormats() {
        val file = File.createTempFile("host-image-", ".png")
        try {
            for (id in listOf("", "../image", "a/b", "x".repeat(129))) {
                assertThrows(IllegalArgumentException::class.java) { HostImages.registerFile(id, file) }
            }
            val formats = mapOf("PNG" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
                "webp" to "image/webp", "svg" to "image/svg+xml", "gif" to "image/gif", "avif" to "image/avif")
            formats.forEach { (ext, mime) -> assertEquals(mime, HostImages.imageMimeType(ext)) }
            assertThrows(IllegalArgumentException::class.java) { HostImages.imageMimeType("html") }
        } finally { file.delete() }
    }
}
