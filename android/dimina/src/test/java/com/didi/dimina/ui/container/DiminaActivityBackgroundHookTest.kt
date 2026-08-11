package com.didi.dimina.ui.container

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins *which lifecycle callback* the mini program's background verdict hangs off, which the
 * [MiniProgramVisibilityTracker] tests cannot see: those prove the tracker computes the right
 * transitions, not that the container feeds it from the right callbacks. Wiring the verdict back
 * onto onResume/onPause would leave every tracker test green while the original defect returns -
 * a permission dialog, a system share sheet or a dialog-style picker only pauses the activity, and
 * a user who lingers past the background grace period would lose every WebSocket connection.
 *
 * The assertion reads the source text. Driving a real Activity through onStart/onStop instead would
 * need an Android runtime, which this module's unit tests do not have and cannot be given without
 * editing the build script. Each lookup below throws when it cannot find what it is checking, so a
 * rename or an extraction fails this test rather than quietly emptying it.
 */
class DiminaActivityBackgroundHookTest {

    private val relativeSourcePath = "src/main/kotlin/com/didi/dimina/ui/container/DiminaActivity.kt"

    private val source: String by lazy {
        val candidates = listOf(relativeSourcePath, "dimina/$relativeSourcePath").map(::File)
        val found = candidates.firstOrNull(File::isFile)
            ?: throw AssertionError(
                "DiminaActivity.kt not found from working directory ${File(".").absolutePath}; " +
                    "tried ${candidates.map(File::getPath)}. Fix the path rather than deleting this test - " +
                    "it is the only thing holding the background verdict on onStart/onStop.",
            )
        found.readText()
    }

    /** The brace-matched body of `override fun [name]`, or a failure if that override is gone. */
    private fun bodyOf(name: String): String {
        val signature = Regex("""\n\s*override fun $name\(""").find(source)
            ?: throw AssertionError("DiminaActivity no longer declares `override fun $name(`")
        val open = source.indexOf('{', signature.range.last)
        if (open < 0) throw AssertionError("no body found for `$name`")

        var depth = 0
        for (i in open until source.length) {
            when (source[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return source.substring(open + 1, i)
            }
        }
        throw AssertionError("unbalanced braces while reading the body of `$name`")
    }

    @Test
    fun `the background verdict is driven by onStart and onStop`() {
        // Pins the two names *and* the boolean each one reports. Checking only that the names
        // appear leaves a swapped foreground/background argument indistinguishable from correct,
        // which is the mistake worth catching here; the surrounding control flow is deliberately
        // not pinned, so extracting a local or reshaping the condition stays a passing refactor.
        val onStart = bodyOf("onStart")
        assertTrue(
            "onStart must consult the visibility tracker; without it every start would re-announce " +
                "a foreground transition. Found:\n$onStart",
            onStart.contains("visibilityTracker.onActivityVisible"),
        )
        assertTrue(
            "onStart must report the mini program back to the *foreground*; found:\n$onStart",
            Regex("""setBackgrounded\(\s*miniProgram\.appId\s*,\s*false\s*\)""").containsMatchIn(onStart),
        )

        val onStop = bodyOf("onStop")
        assertTrue(
            "onStop must consult the visibility tracker; a mini program with several pages must not " +
                "go to the background when one of them stops. Found:\n$onStop",
            onStop.contains("visibilityTracker.onActivityHidden"),
        )
        assertTrue(
            "onStop must report the mini program to the *background*; found:\n$onStop",
            Regex("""setBackgrounded\(\s*miniProgram\.appId\s*,\s*true\s*\)""").containsMatchIn(onStop),
        )
    }

    @Test
    fun `onResume and onPause do not touch the background verdict`() {
        for (name in listOf("onResume", "onPause")) {
            val body = bodyOf(name)
            assertFalse(
                "$name must not drive the WebSocket background verdict: a permission dialog, a system share " +
                    "sheet and a dialog-style picker all pause the activity while the mini program is still on " +
                    "screen, so a user who lingers past the background grace period would lose every connection",
                body.contains("setBackgrounded"),
            )
            assertFalse(
                "$name must not consult the visibility tracker either - the tracker's accounting only lines up " +
                    "when it is fed from onStart/onStop",
                body.contains("visibilityTracker"),
            )
        }
    }

    @Test
    fun `onStart and onStop are the only callers of setBackgrounded`() {
        val calls = Regex("""setBackgrounded""")
        val inHooks = calls.findAll(bodyOf("onStart") + bodyOf("onStop")).count()
        val inWholeFile = calls.findAll(source).count()

        assertEquals(
            "the mini program's foreground/background state has exactly one source of truth. Something " +
                "outside onStart/onStop now calls setBackgrounded; if that caller is genuinely needed, it " +
                "has to be reconciled with the tracker's accounting rather than added alongside it.",
            inHooks,
            inWholeFile,
        )
    }
}
