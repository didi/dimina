package com.didi.dimina.ui.container

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins *how* the container hands pageShow out. [PageShowGateTest] proves the gate itself defers and releases correctly; it cannot see whether the Activity feeds it the right verdict, nor whether every deferred pageShow has a reachable releaser.
 * That gap is exactly where the defect this test guards lived: `onResume` deferred pageShow unconditionally while the only two releasers - the decorView layout listener and onConfigurationChanged - were both registered behind the capability flag, so a host on the default configuration never received pageShow at all. `Page.onShow` never fired, and service kept the page marked hidden, dropping resize too.
 *
 * Driving a real Activity through onResume instead would need an Android runtime, which this module's unit tests do not have and cannot be given without editing the build script.
 * Each lookup below throws when it cannot find what it is checking, so a rename or an extraction fails this test rather than quietly emptying it.
 */
class DiminaActivityPageShowWiringTest {

    private companion object {
        const val TAB_START_WITH_VISIBILITY =
            """\.start\(\s*visible\s*=\s*index\s*==\s*selectedTabIndex\.intValue\s*\)"""
        const val BARE_START = """\.start\(\s*\)"""
    }

    private val relativeSourcePath = "src/main/kotlin/com/didi/dimina/ui/container/DiminaActivity.kt"

    private val source: String by lazy {
        val candidates = listOf(relativeSourcePath, "dimina/$relativeSourcePath").map(::File)
        val found = candidates.firstOrNull(File::isFile)
            ?: throw AssertionError(
                "DiminaActivity.kt not found from working directory ${File(".").absolutePath}; " +
                    "tried ${candidates.map(File::getPath)}. Fix the path rather than deleting this test - " +
                    "it is the only thing holding pageShow delivery together on the default configuration.",
            )
        found.readText()
    }

    /** The brace-matched body of `fun [name]`, or a failure if that declaration is gone. */
    private fun bodyOf(name: String): String {
        val signature = Regex("""\n\s*(override |private |internal )*fun $name\(""").find(source)
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
    fun `the deferral is decided per page by whether the window will move`() {
        // Deferring on anything weaker - "an orientation was requested", or a literal true - re-creates the defect: with the capability off nothing ever requests an orientation, and a page already on its own axis never moves the window, so no geometry event exists to release a deferred pageShow.
        val defers = bodyOf("defersPageShowFor")
        assertTrue(
            "the capability must short-circuit the predicate; with it off the container never " +
                "requests an orientation, so a deferred pageShow has no releaser. Found:\n$defers",
            Regex("""if\s*\(\s*!pageOrientationEnabled\s*\)\s*\{\s*return false""")
                .containsMatchIn(defers),
        )
        assertTrue(
            "the verdict must come from PageOrientation.defersPageShow, which is where the " +
                "cross-platform semantics live. Found:\n$defers",
            defers.contains("PageOrientation.defersPageShow("),
        )
        assertTrue(
            "the predicate must compare against the window's CURRENT orientation; comparing " +
                "against anything else cannot tell a move from a no-op. Found:\n$defers",
            defers.contains("Configuration.ORIENTATION_LANDSCAPE"),
        )

        val notify = bodyOf("notifyPageShowAfterGeometrySettles")
        assertTrue(
            "arming must pass that per-page verdict through; found:\n$notify",
            Regex("""arm\([^)]*defer\s*=\s*defersPageShowFor\(""").containsMatchIn(notify),
        )
    }

    @Test
    fun `multi-window short-circuits the deferral, where the platform ignores the request`() {
        // 分屏/自由窗口/画中画里 setRequestedOrientation 被系统忽略，窗口不会转，于是没有任何几何回调会来放行押着的 pageShow：那一页的 onShow 永远不触发，service 一直把它当 hidden，两条 resize 通道也跟着全丢。
        // 押后的前提是能证明窗口会转，多窗口下证明不了。
        val defers = bodyOf("defersPageShowFor")
        assertTrue(
            "multi-window must short-circuit before the axis comparison; the axis can never " +
                "flip there, so a deferred pageShow would have no releaser. Found:\n$defers",
            Regex("""if\s*\(\s*isInMultiWindowMode\s*\)\s*\{\s*return false""")
                .containsMatchIn(defers),
        )
        val multiWindowAt = defers.indexOf("isInMultiWindowMode")
        val verdictAt = defers.indexOf("PageOrientation.defersPageShow(")
        assertTrue(
            "the multi-window check must come before the verdict, not after it. Found:\n$defers",
            multiWindowAt in 0 until verdictAt,
        )
    }

    @Test
    fun `pageShow is only ever sent through the gate`() {
        // One source of truth for "this page is now visible".
        // A direct bridge.pageShow() elsewhere would bypass both the identity check (showing a page that has already been replaced) and the geometry ordering (onShow reading the previous page's window size).
        val sends = Regex("""\.pageShow\(\)""").findAll(source).count()
        val throughGate = Regex("""pageShowGate\.(arm|release)\([^)]*\)[\s\S]{0,80}?\.pageShow\(\)""")
            .findAll(source)
            .count()

        assertEquals(
            "every pageShow must come from a PageShowGate arm()/release() result; a direct call " +
                "skips the identity check and the geometry ordering",
            sends,
            throughGate,
        )
    }

    @Test
    fun `every deferred pageShow has a releaser that does not depend on the capability`() {
        // The only releasers - the decorView layout listener and onConfigurationChanged - are registered behind the capability flag.
        // So every path that arms must either be able to prove a geometry event is coming, or send pageShow on the spot.
        val onResume = bodyOf("onResume")
        assertTrue(
            "onResume must route pageShow through notifyPageShowAfterGeometrySettles so the gate " +
                "decides between deferring and sending now; found:\n$onResume",
            onResume.contains("notifyPageShowAfterGeometrySettles"),
        )

        val notify = bodyOf("notifyPageShowAfterGeometrySettles")
        assertTrue(
            "notifyPageShowAfterGeometrySettles must send immediately when the gate hands the page " +
                "back rather than waiting for a geometry event that will never arrive; found:\n$notify",
            Regex("""arm\([\s\S]{0,120}?\.pageShow\(\)""").containsMatchIn(notify),
        )
    }

    @Test
    fun `the geometry ledger is not advanced when there is no page to deliver to`() {
        // The ledger records what service has been TOLD. `decide` commits the size it returns, so discovering "no active bridge" afterwards loses that geometry for good: the next real change compares against a size service never saw and is judged unchanged.
        val report = bodyOf("reportWindowGeometryIfSettled")
        val bridgeAt = report.indexOf("getActiveBridge()")
        val ledgerAt = report.indexOf("windowGeometryLedger.decide(")
        assertTrue("reportWindowGeometryIfSettled no longer resolves the active bridge", bridgeAt >= 0)
        assertTrue("reportWindowGeometryIfSettled no longer consults the ledger", ledgerAt >= 0)
        assertTrue(
            "the recipient must be resolved BEFORE the ledger is consulted, and the method must " +
                "return when there is none. Found:\n$report",
            bridgeAt < ledgerAt,
        )
        assertTrue(
            "the missing-recipient path must return instead of falling through into the ledger; " +
                "found:\n$report",
            Regex("""getActiveBridge\(\)\s*\?:\s*return""").containsMatchIn(report),
        )
    }

    @Test
    fun `an undeliverable report does not advance the ledger`() {
        // Bridge.pageResize drops the message when service's resources are not up yet.
        // Recording it anyway would make the next layout at that same size an Ignore, so the page would never hear the geometry it is actually living in.
        val send = bodyOf("sendGeometry")
        assertTrue(
            "sendGeometry must consult pageResize's delivery verdict; found:\n$send",
            Regex("""val sent\s*=\s*target\.pageResize\(""").containsMatchIn(send),
        )
        val guardAt = send.indexOf("if (!sent)")
        val recordAt = send.indexOf("windowGeometryLedger.record(")
        assertTrue("sendGeometry no longer guards on the delivery verdict; found:\n$send", guardAt >= 0)
        assertTrue("sendGeometry no longer records the geometry; found:\n$send", recordAt >= 0)
        assertTrue(
            "the undeliverable path must return BEFORE the ledger is recorded; found:\n$send",
            guardAt < recordAt,
        )
    }

    @Test
    fun `route completion reports the current page's geometry unconditionally`() {
        // The host reports the current page after every route without comparing geometry, and service dispatches Page.onResize to whoever the host names.
        // A cached page returning to a window that moved while it was hidden has no other way to hear about it.
        //
        // 上报必须挂在「pageShow 真的送到 service」这个事实上，而不是挂在容器调没调 pageShow：新建页的 pageShow 是 Bridge 在资源装好时自己发的，根本不经过这道门，挂在门上就等于绝大多数路由（冷启动 / navigateTo / redirectTo / reLaunch）的落点页一次都收不到。
        // 真机实测过这个缺陷：新建页 0 条 pageResize。
        val create = bodyOf("createBridge")
        assertTrue(
            "createBridge must hook the bridge's own pageShow delivery to the route report; " +
                "found:\n$create",
            Regex("""onPageShownToService\s*=[\s\S]{0,120}?reportRouteGeometry\(""")
                .containsMatchIn(create),
        )

        val bridgeSource = File(
            listOf(
                "src/main/kotlin/com/didi/dimina/core/Bridge.kt",
                "dimina/src/main/kotlin/com/didi/dimina/core/Bridge.kt",
            ).first { File(it).isFile },
        ).readText()
        val flush = Regex("""private fun flushPageVisibility\(\)[\s\S]*?\n    \}""")
            .find(bridgeSource)?.value
            ?: throw AssertionError("Bridge no longer declares flushPageVisibility()")
        val postAt = flush.indexOf("options.jscore.postMessage(")
        val notifyAt = flush.indexOf("onPageShownToService?.invoke(")
        assertTrue("flushPageVisibility no longer posts the lifecycle; found:\n$flush", postAt >= 0)
        assertTrue(
            "flushPageVisibility must tell its owner that pageShow actually went out, or a newly " +
                "created page never gets its route geometry; found:\n$flush",
            notifyAt >= 0,
        )
        assertTrue(
            "the notification must follow the pageShow it reports, not precede it; found:\n$flush",
            postAt < notifyAt,
        )

        val route = bodyOf("reportRouteGeometry")
        assertTrue(
            "reportRouteGeometry must actually send the geometry; found:\n$route",
            route.contains("sendGeometry(showNow"),
        )
        assertFalse(
            "the route report must not be gated on the geometry having changed; found:\n$route",
            route.contains("windowGeometryLedger.decide("),
        )
    }

    @Test
    fun `a background page's own pageShow does not report geometry as if it were current`() {
        // 后台 Activity 里的 bridge 也会在自己资源装好时发出 pageShow，回调照样会来。
        // 拿它的几何上报就是把另一个窗口的尺寸冒充成当前页的，而 Page.onResize 的收件人由宿主指名，指错了再也纠正不回来。
        val route = bodyOf("reportRouteGeometry")
        assertTrue(
            "reportRouteGeometry must refuse a bridge that is not the current page; found:\n$route",
            Regex("""getActiveBridge\(\)\s*!==\s*showNow[\s\S]{0,40}?return""")
                .containsMatchIn(route),
        )
        val guardAt = route.indexOf("getActiveBridge()")
        val sendAt = route.indexOf("sendGeometry(showNow")
        assertTrue("the guard must precede the send; found:\n$route", guardAt in 0 until sendAt)
    }

    @Test
    fun `a tab bridge that starts after its tab lost focus does not start out visible`() {
        // webview 就绪是异步的，start() 落在回调里时选中的可能已经是别的 tab。
        // 默认按可见启动会把 Bridge 的 sentPageVisible 提前置真，用户真正切回这个 tab 时那次 pageShow 成了无操作——而路由几何上报挂的正是这次可见性跃迁，于是这一页一次都收不到。
        val ready = bodyOf("onTabWebViewReady")
        assertTrue(
            "the tab bridge must be started with the visibility it actually has; found:\n$ready",
            Regex(TAB_START_WITH_VISIBILITY).containsMatchIn(ready),
        )
        assertFalse(
            "a bare start() leaves the bridge defaulting to visible; found:\n$ready",
            Regex(BARE_START).containsMatchIn(ready),
        )
    }
    @Test
    fun `a route report that cannot settle yet is retried by the next layout`() {
        // The window is laid out for the new configuration AFTER onResume, so the report attempted there can find the layout still on the old axis.
        // Dropping it silently would lose the only Page.onResize the arriving page gets.
        val route = bodyOf("reportRouteGeometry")
        assertTrue(
            "the arriving page must be remembered so a later layout can report it; found:\n$route",
            Regex("""pageAwaitingRouteGeometry\s*=\s*showNow""").containsMatchIn(route),
        )
        assertTrue(
            "the immediate attempt must be skipped unless the window is laid out for the current " +
                "configuration; found:\n$route",
            route.contains("WindowGeometryGate.isSettled("),
        )

        val report = bodyOf("reportWindowGeometryIfSettled")
        assertTrue(
            "an unchanged geometry must still flush a pending route report; found:\n$report",
            Regex("""pageAwaitingRouteGeometry\s*===\s*activeBridge""").containsMatchIn(report),
        )
    }

    @Test
    fun `an unchanged geometry re-checks what the deferred pageShow is waiting for`() {
        // Releasing unconditionally hands the page its pageShow before the rotation, so onShow reads the very geometry the deferral existed to avoid.
        // Never releasing is the opposite failure: a request the platform silently ignored leaves pageShow stuck forever, because only a geometry change can release it.
        val report = bodyOf("reportWindowGeometryIfSettled")
        val ignoreAt = report.indexOf("WindowGeometryGate.Decision.Ignore,")
        assertTrue("reportWindowGeometryIfSettled no longer branches on Ignore", ignoreAt >= 0)
        val branch = report.substring(ignoreAt)
        assertTrue(
            "the unchanged-geometry branch must re-evaluate the deferral predicate before " +
                "releasing; found:\n$branch",
            Regex("""if\s*\(defersPageShowFor\(activeBridge\)\)\s*\{\s*null""")
                .containsMatchIn(branch),
        )
        assertTrue(
            "the branch must still be able to release the gate; found:\n$branch",
            branch.contains("pageShowGate.release("),
        )
    }

    @Test
    fun `a pageShow released without a geometry change still reports the page's geometry`() {
        // Whatever path sends pageShow, the page becomes the recipient service registers for Page.onResize only at that moment — so the geometry has to follow it, not precede it.
        // 这一分支里放行出去的 pageShow 由 Bridge 的回调带上几何，这里只补一次曾经报不出去的路由上报；两条都送就是同一次变化被报两次。
        val report = bodyOf("reportWindowGeometryIfSettled")
        val branch = report.substring(report.indexOf("WindowGeometryGate.Decision.Ignore,"))
        val showAt = branch.indexOf("shown?.pageShow()")
        val sendAt = branch.indexOf("sendGeometry(activeBridge, geometry)")
        assertTrue("the unchanged-geometry branch no longer sends pageShow; found:\n$branch", showAt >= 0)
        assertTrue("the unchanged-geometry branch no longer reports geometry; found:\n$branch", sendAt >= 0)
        assertTrue("pageShow must come before the report; found:\n$branch", showAt < sendAt)
        assertTrue(
            "the retry must be the only thing this branch reports — the released pageShow already " +
                "carried its own geometry through Bridge.onPageShownToService; found:\n$branch",
            Regex("""if\s*\(pageAwaitingRouteGeometry\s*===\s*activeBridge\)""")
                .containsMatchIn(branch),
        )
    }

    @Test
    fun `a window change is not reported twice when it also released a pageShow`() {
        // 放行出去的 pageShow 会让 Bridge 的回调把这同一份几何当作路由落地报一次并记进账本。
        // Report 分支若无条件再送一次，业务同一次转屏会收到两条 Page.onResize。
        val report = bodyOf("reportWindowGeometryIfSettled")
        val branch = report.substring(
            report.indexOf("is WindowGeometryGate.Decision.Report ->"),
            report.indexOf("WindowGeometryGate.Decision.Ignore,"),
        )
        val releaseAt = branch.indexOf("pageShowGate.release(activeBridge)?.pageShow()")
        val recheckAt = branch.indexOf("windowGeometryLedger.decide(")
        assertTrue("the Report branch no longer releases the pending pageShow; found:\n$branch", releaseAt >= 0)
        assertTrue(
            "the Report branch must re-consult the ledger after releasing pageShow, so a geometry " +
                "the release already reported is not sent again; found:\n$branch",
            recheckAt > releaseAt,
        )
    }

    @Test
    fun `destroying a mini-app's runtime also invalidates its geometry ledger`() {
        // The ledger mirrors service's baseline, so it has to die with service.
        // A cold restart rebuilds service with an empty baseline; a surviving ledger entry turns the new session's first layout into a Report and fires a resize out of thin air at startup.
        val clears = Regex("""miniApp\.clear\(""").findAll(source).count()
        assertEquals(
            "every miniApp.clear(appId) must go through clearMiniAppRuntime so the ledger is " +
                "released with the runtime it mirrors",
            1,
            clears,
        )
        val helper = bodyOf("clearMiniAppRuntime")
        assertTrue(
            "clearMiniAppRuntime must release the ledger; found:\n$helper",
            helper.contains("windowGeometryLedger.release("),
        )
        assertTrue(
            "clearMiniAppRuntime must clear the runtime; found:\n$helper",
            helper.contains("miniApp.clear("),
        )
        assertTrue(
            "the clearAll() path must release every ledger entry too",
            Regex("""windowGeometryLedger\.releaseAll\(\)[\s\S]{0,80}?miniApp\.clearAll\(\)""")
                .containsMatchIn(source),
        )
    }

    @Test
    fun `the reported size carries the screen dimensions next to the window ones`() {
        // 基础库把 `size` 原样交给业务回调，所以少放一个字段业务就直接读到 undefined，而这里没有任何运行时断言会发现。
        // 屏幕尺寸必须与窗口尺寸取自同一份 systemInfo：分两处读会在旋转的中间态拿到不属于同一时刻的两组数。
        val geometry = bodyOf("currentWindowGeometry")
        assertTrue(
            "screen dimensions must come from the same getMiniProgramSystemInfo snapshot as the " +
                "window ones; found:\n$geometry",
            Regex("""systemInfo\.getInt\("screenWidth"\)""").containsMatchIn(geometry)
                && Regex("""systemInfo\.getInt\("screenHeight"\)""").containsMatchIn(geometry),
        )

        val send = bodyOf("sendGeometry")
        assertTrue(
            "sendGeometry must forward the screen dimensions to pageResize; found:\n$send",
            Regex("""pageResize\(\s*geometry\.screenWidth,\s*geometry\.screenHeight,""")
                .containsMatchIn(send),
        )
    }

    @Test
    fun `losing visibility invalidates a pending pageShow`() {
        val onPause = bodyOf("onPause")
        assertTrue(
            "onPause must cancel the gate; a layout callback arriving after the page went away " +
                "would otherwise show a page that is no longer visible. Found:\n$onPause",
            onPause.contains("pageShowGate.cancel()"),
        )
    }
}
