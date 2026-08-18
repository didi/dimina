package com.didi.dimina.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class AtomicZipInstallerTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `valid archive replaces existing directory`() {
        val target = temporaryFolder.newFolder("app")
        target.resolve("old.txt").writeText("old")

        val installed = AtomicZipInstaller.install(
            inputProvider = { zipOf("main/logic.js" to "new") },
            targetDir = target,
            requiredPaths = listOf("main/logic.js"),
        )

        assertTrue(installed)
        assertFalse(target.resolve("old.txt").exists())
        assertEquals("new", target.resolve("main/logic.js").readText())
    }

    @Test
    fun `invalid archive keeps existing directory`() {
        val target = temporaryFolder.newFolder("app")
        target.resolve("old.txt").writeText("old")

        val installed = AtomicZipInstaller.install(
            inputProvider = { zipOf("unrelated.txt" to "new") },
            targetDir = target,
            requiredPaths = listOf("main/logic.js"),
        )

        assertFalse(installed)
        assertEquals("old", target.resolve("old.txt").readText())
        assertFalse(target.resolve("unrelated.txt").exists())
    }

    @Test
    fun `zip traversal is rejected without writing outside target`() {
        val root = temporaryFolder.newFolder("root")
        val target = root.resolve("app").apply { mkdirs() }
        target.resolve("old.txt").writeText("old")

        val installed = AtomicZipInstaller.install(
            inputProvider = { zipOf("../escaped.txt" to "bad") },
            targetDir = target,
        )

        assertFalse(installed)
        assertEquals("old", target.resolve("old.txt").readText())
        assertFalse(root.resolve("escaped.txt").exists())
    }

    @Test
    fun `failed commit restores old target and pending source`() {
        val target = temporaryFolder.newFolder("active")
        target.resolve("version.txt").writeText("old")
        val pending = temporaryFolder.newFolder("pending")
        pending.resolve("version.txt").writeText("new")

        val result = runCatching {
            AtomicZipInstaller.replaceDirectory(pending, target) {
                error("version marker write failed")
            }
        }

        assertTrue(result.isFailure)
        assertEquals("old", target.resolve("version.txt").readText())
        assertEquals("new", pending.resolve("version.txt").readText())
    }

    private fun zipOf(vararg entries: Pair<String, String>): ByteArrayInputStream {
        val bytes = ByteArrayOutputStream()
        ZipOutputStream(bytes).use { zip ->
            entries.forEach { (path, contents) ->
                zip.putNextEntry(ZipEntry(path))
                zip.write(contents.toByteArray())
                zip.closeEntry()
            }
        }
        return ByteArrayInputStream(bytes.toByteArray())
    }
}
