package com.didi.dimina.ui.container

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins *which* page teardowns dispatch Page.onUnload.
 *
 * 微信的 unloadPage 只由路由事件驱动（reLaunch/redirectTo/navigateBack/switchTab）；退出小程序
 * 走 onAppEnterBackground，只派发 App.onHide，页面不收 onUnload。Android 上每个页面都是一个
 * Activity，所以退出和 navigateBack 共用 onDestroy -> releasePageResources -> Bridge.destroy 这
 * 一条销毁链，唯一的区别就是关栈的一方在 finish() 前留下的 [com.didi.dimina.core.PageStateTeardown]。
 * 把它接错的两个方向都是真缺陷：退出时多发 onUnload（三端不一致），或路由时漏发 onUnload（页面
 * 永远收不到卸载，比前者更糟），所以下面两个方向各有断言。
 *
 * 断言读源码文本。真正驱动一个 Activity 走完 onDestroy 需要 Android 运行时，本模块的单元测试没有
 * 也不能在不改构建脚本的前提下拥有。每个查找在找不到目标时抛错，重命名或抽取会让这个测试失败，而
 * 不是悄悄变成空断言。
 */
class PageStateTeardownReasonTest {

    private fun sourceOf(relativePath: String): String {
        val candidates = listOf(relativePath, "dimina/$relativePath").map(::File)
        val found = candidates.firstOrNull(File::isFile)
            ?: throw AssertionError(
                "$relativePath not found from working directory ${File(".").absolutePath}; " +
                    "tried ${candidates.map(File::getPath)}. Fix the path rather than deleting this " +
                    "test - it is the only thing holding the exit path off Page.onUnload.",
            )
        return found.readText()
    }

    private val activitySource: String by lazy {
        sourceOf("src/main/kotlin/com/didi/dimina/ui/container/DiminaActivity.kt")
    }

    private val bridgeSource: String by lazy {
        sourceOf("src/main/kotlin/com/didi/dimina/core/Bridge.kt")
    }

    /** The brace-matched body of `fun [name]` in [source], or a failure if that declaration is gone. */
    private fun bodyOf(source: String, name: String): String {
        val signature = Regex("""\n\s*(?:private\s+)?(?:override\s+)?fun $name\(""").find(source)
            ?: throw AssertionError("no `fun $name(` declaration left to check")
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
    fun `Bridge dispatches pageUnload only for a routing teardown`() {
        val destroy = bodyOf(bridgeSource, "destroy")
        val unloadLine = destroy.lineSequence().firstOrNull { it.contains("\"pageUnload\"") }
            ?: throw AssertionError("Bridge.destroy no longer posts pageUnload at all:\n$destroy")
        val guard = destroy.lineSequence()
            .takeWhile { !it.contains("\"pageUnload\"") }
            .last { it.contains("if (") }
        assertTrue(
            "pageUnload must be gated on the routing reason; an unguarded post puts Android back " +
                "out of step with iOS on every mini program exit. Guard found:\n$guard\n$unloadLine",
            guard.contains("reason == PageStateTeardown.ROUTING"),
        )
    }

    @Test
    fun `exiting the mini program marks the whole stack as an exit teardown`() {
        val closeMiniProgram = bodyOf(activitySource, "closeMiniProgram")
        assertTrue(
            "closeMiniProgram is the single entry every exit funnels through (capsule close, menu " +
                "close, wx.exitMiniProgram, wx.navigateBackMiniProgram). It must stamp each Activity " +
                "before finish(), otherwise onDestroy falls back to the routing default and the " +
                "exiting pages get onUnload. Found:\n$closeMiniProgram",
            closeMiniProgram.contains("pageStateTeardownReason = PageStateTeardown.EXIT"),
        )
        assertTrue(
            "the stamp must land before finish(); afterwards the Activity is already tearing down",
            closeMiniProgram.indexOf("PageStateTeardown.EXIT") <
                closeMiniProgram.indexOf("finish()"),
        )
    }

    @Test
    fun `a cold restart is an exit teardown too`() {
        val prepare = bodyOf(activitySource, "prepareForColdRestart")
        assertTrue(
            "restart/re-enter/applyUpdate destroy the whole runtime and build a new one, so they " +
                "are exit-shaped rather than routing. Found:\n$prepare",
            prepare.contains("releasePageResources(PageStateTeardown.EXIT)"),
        )
    }

    @Test
    fun `onDestroy carries the reason the closer left instead of hard-coding one`() {
        val onDestroy = bodyOf(activitySource, "onDestroy")
        assertTrue(
            "onDestroy must forward the recorded reason; hard-coding either value collapses the " +
                "distinction it exists for. Found:\n$onDestroy",
            onDestroy.contains("releasePageResources(pageStateTeardownReason)"),
        )
    }

    @Test
    fun `routing teardowns keep dispatching onUnload`() {
        // The reverse mistake: stamping EXIT on a route would silently stop every navigateBack,
        // reLaunch and switchTab from unloading its page. These three all reach onDestroy or
        // Bridge.destroy through the routing default, so none of them may stamp EXIT.
        val relaunchStack = bodyOf(activitySource, "relaunchStack")
        assertFalse(
            "wx.reLaunch is a routing event - its pages must still receive onUnload. Found:\n$relaunchStack",
            relaunchStack.contains("PageStateTeardown.EXIT"),
        )
        val switchTabInRoot = bodyOf(activitySource, "switchTabInRoot")
        assertFalse(
            "wx.switchTab is a routing event - the tab it replaces must still receive onUnload. " +
                "Found:\n$switchTabInRoot",
            switchTabInRoot.contains("PageStateTeardown.EXIT"),
        )
        val switchTab = bodyOf(activitySource, "switchTab")
        assertFalse(
            "switchTab also closes the non-tab pages stacked above the root; those are routed away, " +
                "not exited. Found:\n$switchTab",
            switchTab.contains("PageStateTeardown.EXIT"),
        )
        val updatePath = bodyOf(activitySource, "updatePath")
        assertFalse(
            "wx.redirectTo replaces the page in place - the old one must still receive onUnload. " +
                "Found:\n$updatePath",
            updatePath.contains("PageStateTeardown.EXIT"),
        )
    }
}
