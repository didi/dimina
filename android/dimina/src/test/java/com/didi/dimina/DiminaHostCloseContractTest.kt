package com.didi.dimina

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Pins the public host close entry to the lifecycle-aware Activity exit path. */
class DiminaHostCloseContractTest {
    private fun readSource(relativePath: String): String {
        val candidates = listOf(relativePath, "dimina/$relativePath").map(::File)
        val found = candidates.firstOrNull(File::isFile)
            ?: throw AssertionError("source not found; tried ${candidates.map(File::getPath)}")
        return found.readText()
    }

    private fun bodyOf(source: String, signature: String): String {
        val start = source.indexOf(signature)
        if (start < 0) throw AssertionError("declaration not found: $signature")
        val open = source.indexOf('{', start)
        var depth = 0
        for (index in open until source.length) {
            when (source[index]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return source.substring(open + 1, index)
            }
        }
        throw AssertionError("unbalanced declaration: $signature")
    }

    @Test
    fun `public close delegates to the host Activity exit entry`() {
        val facade = readSource("src/main/kotlin/com/didi/dimina/Dimina.kt")
        val close = bodyOf(facade, "fun closeMiniProgram(appId: String): Boolean")

        assertTrue(close.contains("DiminaActivity.closeMiniProgramFromHost(normalizedAppId)"))
        assertFalse(close.contains("MiniApp.getInstance().clear(normalizedAppId)"))
    }

    @Test
    fun `host Activity close starts from the top page and reuses exitMiniProgram`() {
        val activity = readSource(
            "src/main/kotlin/com/didi/dimina/ui/container/DiminaActivity.kt",
        )
        val body = bodyOf(
            activity,
            "internal fun closeMiniProgramFromHost(appId: String): Boolean",
        )

        assertTrue(body.contains("activityRegistry.lastRegistered(appId)"))
        assertTrue(body.contains("activity.exitMiniProgram()"))
        assertFalse(body.contains("activity.finish()"))
        assertFalse(body.contains("miniApp.clear"))
    }
}
