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

    /** The brace-matched body of `fun [name]`, or a failure if that declaration is gone. */
    private fun bodyOf(name: String): String {
        val signature = Regex("""\n\s*(?:private\s+)?(?:override\s+)?fun $name\(""").find(source)
            ?: throw AssertionError("DiminaActivity no longer declares `fun $name(`")
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
            onStart.contains("dispatchMiniProgramShow"),
        )

        val onStop = bodyOf("onStop")
        assertTrue(
            "onStop must consult the visibility tracker; a mini program with several pages must not " +
                "go to the background when one of them stops. Found:\n$onStop",
            onStop.contains("visibilityTracker.onActivityHidden"),
        )
        assertTrue(
            "onStop must report the mini program to the *background*; found:\n$onStop",
            onStop.contains("dispatchMiniProgramHide"),
        )
    }

    @Test
    fun `onPause does not change app visibility and onResume only repairs a failed cross app launch`() {
        val onPause = bodyOf("onPause")
        assertFalse(onPause.contains("setBackgrounded"))
        assertFalse(onPause.contains("visibilityTracker"))

        val onResume = bodyOf("onResume")
        assertFalse(onResume.contains("setBackgrounded"))
        assertTrue(onResume.contains("suspendedForMiniProgramNavigation"))
        assertTrue(onResume.contains("visibilityTracker.onActivityVisible"))
    }

    @Test
    fun `page and app visibility follow their distinct Android lifecycle facts`() {
        val onStart = bodyOf("onStart")
        assertTrue(onStart.contains("dispatchMiniProgramShow"))
        assertFalse(onStart.contains(".pageShow("))

        val onResume = bodyOf("onResume")
        assertTrue(onResume.contains(".pageShow("))
        assertFalse(onResume.contains(".appShow("))
        assertFalse(onResume.contains("consumePendingAppShowOptions"))

        val onPause = bodyOf("onPause")
        assertTrue(onPause.contains(".pageHide("))
        assertFalse(onPause.contains(".appHide("))

        val onStop = bodyOf("onStop")
        assertTrue(onStop.contains("dispatchMiniProgramHide"))
        assertFalse(onStop.contains(".pageHide("))

        val appShow = bodyOf("dispatchMiniProgramShow")
        assertTrue(appShow.contains(".appShow("))
        assertTrue(appShow.contains("consumePendingAppShowOptions"))
        assertTrue(
            "dispatchMiniProgramShow must look up the JsCore without creating one: getJsCore() " +
                "would synchronously unzip and evaluate service.js on the calling (main) thread, and " +
                "leaves a permanently broken instance behind for a Context-less caller. Found:\n$appShow",
            appShow.contains("peekJsCore"),
        )
        assertFalse(
            "dispatchMiniProgramShow must not call the creating getJsCore()",
            appShow.contains("getJsCore"),
        )
        assertTrue(
            "dispatchMiniProgramShow must report the mini program to the *foreground* verdict; " +
                "found:\n$appShow",
            Regex("""setBackgrounded\(\s*miniProgram\.appId\s*,\s*false\s*\)""").containsMatchIn(appShow),
        )

        val appHide = bodyOf("dispatchMiniProgramHide")
        assertTrue(appHide.contains(".appHide("))
        assertTrue(
            "dispatchMiniProgramHide must look up the JsCore without creating one",
            appHide.contains("peekJsCore"),
        )
        assertFalse(
            "dispatchMiniProgramHide must not call the creating getJsCore()",
            appHide.contains("getJsCore"),
        )
        assertTrue(
            "dispatchMiniProgramHide must report the mini program to the *background* verdict; " +
                "found:\n$appHide",
            Regex("""setBackgrounded\(\s*miniProgram\.appId\s*,\s*true\s*\)""").containsMatchIn(appHide),
        )
    }

    @Test
    fun `a JsCore created without a Context is never left permanently uninitialized`() {
        // dispatchMiniProgramShow/Hide run off onStart/onStop on the main thread and must not pay
        // for service.js bootstrap there; but a config-change or process-death recreate that
        // bypasses MiniApp#openApp has no other JsCore yet when onStart fires. Reconciliation must
        // exist and must be reachable from wherever a real, Context-bearing JsCore is first handed
        // to a Bridge - otherwise the visibility intent recorded on the tracker while there was no
        // JsCore is silently dropped forever.
        val createBridge = bodyOf("createBridge")
        assertTrue(
            "createBridge must reconcile app visibility once a real (Context-bearing) JsCore " +
                "exists for this appId; found:\n$createBridge",
            createBridge.contains("reconcileAppVisibilityWithCore"),
        )

        val reconcile = bodyOf("reconcileAppVisibilityWithCore")
        assertTrue(reconcile.contains("visibilityTracker.isForeground"))
        assertTrue(reconcile.contains("dispatchMiniProgramShow"))
        assertTrue(reconcile.contains("dispatchMiniProgramHide"))
    }

    @Test
    fun `app visibility dispatchers are the only callers of setBackgrounded`() {
        val calls = Regex("""setBackgrounded""")
        val inHooks = calls.findAll(
            bodyOf("dispatchMiniProgramShow") + bodyOf("dispatchMiniProgramHide"),
        ).count()
        val inWholeFile = calls.findAll(source).count()

        assertEquals(
            "the mini program's foreground/background state has exactly one source of truth. Something " +
            "outside the app visibility dispatchers now calls setBackgrounded; if that caller is genuinely needed, it " +
                "has to be reconciled with the tracker's accounting rather than added alongside it.",
            inHooks,
            inWholeFile,
        )
    }

    @Test
    fun `native close affordances go through exitMiniProgram so a live opener is restored`() {
        // closeMiniProgram is the raw "finish every Activity of this appId" primitive: it neither
        // queues the opener's scene 1038 payload nor runs the page-hide-before-app-hide ordering.
        // The capsule "x" and the menu's 关闭小程序 are the *only* ways a user closes a mini program
        // that was opened by another one, so wiring either of them straight to the primitive loses
        // the opener restoration that navigateBackMiniProgram gets for free - a real-device
        // reproduction showed the opener resuming with an empty appShow body and scene 1001.
        val content = bodyOf("DiminaContent")
        assertTrue(
            "the close affordances in DiminaContent must route through exitMiniProgram; found:\n$content",
            content.contains("exitMiniProgram()"),
        )
        assertFalse(
            "no UI affordance may call the raw closeMiniProgram(): it skips the opener return " +
                "payload and the suspension ordering. Route it through exitMiniProgram() instead.",
            content.contains("closeMiniProgram("),
        )

        // Pins the same invariant file-wide, so the check survives the handlers moving out of
        // DiminaContent: the primitive stays reachable only from the two functions that first give
        // a live opener its scene 1038 payload.
        val callSites = Regex("""(?<!fun )closeMiniProgram\(\)""")
        val inRouters = callSites.findAll(
            bodyOf("navigateBackMiniProgram") + bodyOf("exitMiniProgram"),
        ).count()
        assertEquals(
            "closeMiniProgram() gained a caller outside navigateBackMiniProgram/exitMiniProgram. " +
                "A new caller has to decide what happens to a live opener rather than silently " +
                "dropping it.",
            inRouters,
            callSites.findAll(source).count(),
        )

        val exit = bodyOf("exitMiniProgram")
        assertTrue(
            "exitMiniProgram must queue the opener's return payload before closing; found:\n$exit",
            exit.indexOf("queueOpenerReturn") in 0 until exit.indexOf("closeMiniProgram("),
        )
    }

    @Test
    fun `cross mini program suspension dispatches page hide before app hide`() {
        val suspend = bodyOf("suspendForMiniProgramNavigation")
        val pageHide = suspend.indexOf(".pageHide(")
        val appHide = suspend.indexOf("dispatchMiniProgramHide")

        assertTrue(pageHide >= 0)
        assertTrue(appHide > pageHide)
        assertTrue(bodyOf("navigateToMiniProgram").contains("suspendForMiniProgramNavigation"))
        assertTrue(bodyOf("navigateBackMiniProgram").contains("suspendForMiniProgramNavigation"))
    }
}
