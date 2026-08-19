package com.didi.dimina.ui.container

import com.didi.dimina.ui.container.WindowGeometryGate.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private val PORTRAIT = 1080 to 2400
private val LANDSCAPE = 2400 to 1080

class WindowGeometryGateTest {

    private fun decide(
        laidOut: Pair<Int, Int>,
        previous: Pair<Int, Int>?,
        deviceOrientation: String,
    ): Decision = WindowGeometryGate.decide(
        laidOutWidth = laidOut.first,
        laidOutHeight = laidOut.second,
        previousAppSize = previous,
        deviceOrientation = { deviceOrientation },
    )

    @Test
    fun `the first layout only establishes a baseline`() {
        assertEquals(Decision.Baseline(PORTRAIT), decide(PORTRAIT, null, "portrait"))
    }

    @Test
    fun `a real rotation reports the geometry the window is laid out at`() {
        assertEquals(Decision.Report(LANDSCAPE), decide(LANDSCAPE, PORTRAIT, "landscape"))
        assertEquals(Decision.Report(PORTRAIT), decide(PORTRAIT, LANDSCAPE, "portrait"))
    }

    /**
     * 被覆盖的页面恢复时会补收到一条它错过的横屏配置，而它的窗口一直是竖屏布局。
     * 那份横屏几何从没渲染过，任何情况下都不许被上报出去。
     */
    @Test
    fun `a configuration the window never laid out is never reported`() {
        assertEquals(Decision.Ignore, decide(PORTRAIT, PORTRAIT, "landscape"))
        assertEquals(Decision.NotSettled, decide(PORTRAIT, LANDSCAPE, "landscape"))
        assertEquals(Decision.NotSettled, decide(LANDSCAPE, PORTRAIT, "portrait"))
    }

    /** 配置比布局先到时不上报，等布局跟上那一次再上报，中间不需要任何延时 */
    @Test
    fun `config arriving before the layout defers to the layout that follows`() {
        assertEquals(Decision.Ignore, decide(PORTRAIT, PORTRAIT, "landscape"))
        assertEquals(Decision.Report(LANDSCAPE), decide(LANDSCAPE, PORTRAIT, "landscape"))
    }

    /** 布局比配置先到时同样收敛：配置到达后拿同一份布局再判一次就能上报 */
    @Test
    fun `layout arriving before the config converges on the same single report`() {
        assertEquals(Decision.NotSettled, decide(LANDSCAPE, PORTRAIT, "portrait"))
        assertEquals(Decision.Report(LANDSCAPE), decide(LANDSCAPE, PORTRAIT, "landscape"))
    }

    /**
     * decorView 每跑一次布局都会来问一次。
     * 判据把「布局了一次」收敛成「窗口真的变了」，否则一次滚动、一次键盘都会变成一条 resize。
     */
    @Test
    fun `an unchanged window geometry is not reported again`() {
        assertEquals(Decision.Ignore, decide(PORTRAIT, PORTRAIT, "portrait"))
        assertEquals(Decision.Ignore, decide(LANDSCAPE, LANDSCAPE, "landscape"))
    }

    @Test
    fun `a window with no measured size yet is ignored`() {
        assertEquals(Decision.Ignore, decide(0 to 0, null, "landscape"))
        assertEquals(Decision.Ignore, decide(0 to 2400, PORTRAIT, "portrait"))
        assertEquals(Decision.Ignore, decide(1080 to 0, PORTRAIT, "portrait"))
    }

    @Test
    fun `a same-orientation window resize is reported`() {
        val split = 1080 to 1400
        assertEquals(Decision.Report(split), decide(split, PORTRAIT, "portrait"))
    }

    @Test
    fun `isSettled only accepts a layout whose aspect matches the configuration`() {
        assertTrue(WindowGeometryGate.isSettled(LANDSCAPE.first, LANDSCAPE.second, "landscape"))
        assertTrue(WindowGeometryGate.isSettled(PORTRAIT.first, PORTRAIT.second, "portrait"))
        assertFalse(WindowGeometryGate.isSettled(PORTRAIT.first, PORTRAIT.second, "landscape"))
        assertFalse(WindowGeometryGate.isSettled(LANDSCAPE.first, LANDSCAPE.second, "portrait"))
        assertFalse(WindowGeometryGate.isSettled(0, 0, "portrait"))
    }

    /**
     * 账本只经 [WindowGeometryLedger.record] 推进，判定本身不写。
     * 测试照宿主的真实用法走：Baseline 直接认下，Report 只有真的送达 service 才认下。
     */
    private fun WindowGeometryLedger.adopt(
        appId: String,
        size: Pair<Int, Int>,
        deviceOrientation: String,
        delivered: Boolean = true,
    ): Decision {
        val decision = decide(appId, size.first, size.second) { deviceOrientation }
        when {
            decision is Decision.Baseline -> record(appId, size.first, size.second)
            decision is Decision.Report && delivered -> record(appId, size.first, size.second)
        }
        return decision
    }

    @Test
    fun `the ledger reports a returning activity whose own old size is unchanged`() {
        val ledger = WindowGeometryLedger()

        assertEquals(Decision.Baseline(PORTRAIT), ledger.adopt("app", PORTRAIT, "portrait"))
        assertEquals(Decision.Report(LANDSCAPE), ledger.adopt("app", LANDSCAPE, "landscape"))
        assertEquals(Decision.Report(PORTRAIT), ledger.adopt("app", PORTRAIT, "portrait"))
    }

    /**
     * 判定不推进基线，是为了让送不出去的那一次还能重来：service 的资源还没起来时 `Bridge.pageResize` 会直接丢掉这条消息，基线要是已经推进，下一次同尺寸的布局就判成「没变过」，这次变化永久缺席。
     */
    @Test
    fun `an undelivered report is offered again by the next layout`() {
        val ledger = WindowGeometryLedger()
        ledger.adopt("app", PORTRAIT, "portrait")

        assertEquals(
            Decision.Report(LANDSCAPE),
            ledger.adopt("app", LANDSCAPE, "landscape", delivered = false),
        )
        assertEquals(Decision.Report(LANDSCAPE), ledger.adopt("app", LANDSCAPE, "landscape"))
        assertEquals(Decision.Ignore, ledger.adopt("app", LANDSCAPE, "landscape"))
    }

    /**
     * 基线记的是「service 已经知道的几何」。
     * 路由落地那条无条件上报也送同一份几何，记进来之后紧跟的布局回调才不会再报一次。
     */
    @Test
    fun `a recorded geometry silences the layout callback that follows it`() {
        val ledger = WindowGeometryLedger()
        ledger.record("app", LANDSCAPE.first, LANDSCAPE.second)

        assertEquals(
            Decision.Ignore,
            ledger.decide("app", LANDSCAPE.first, LANDSCAPE.second) { "landscape" },
        )
        assertEquals(
            Decision.Report(PORTRAIT),
            ledger.decide("app", PORTRAIT.first, PORTRAIT.second) { "portrait" },
        )
    }

    /** 两个小程序各记各的，互不干扰。 */
    @Test
    fun `baselines are scoped to their own app`() {
        val ledger = WindowGeometryLedger()
        ledger.adopt("a", PORTRAIT, "portrait")

        assertEquals(Decision.Baseline(PORTRAIT), ledger.adopt("b", PORTRAIT, "portrait"))
    }

    @Test
    fun `releasing an app makes its next layout a fresh baseline`() {
        val ledger = WindowGeometryLedger()
        ledger.adopt("app", PORTRAIT, "portrait")

        ledger.release("app")

        assertEquals(Decision.Baseline(PORTRAIT), ledger.adopt("app", PORTRAIT, "portrait"))
    }

    /** release 只作废自己那一个小程序。 */
    @Test
    fun `releasing one app leaves another app's baseline intact`() {
        val ledger = WindowGeometryLedger()
        ledger.adopt("a", PORTRAIT, "portrait")
        ledger.adopt("b", PORTRAIT, "portrait")

        ledger.release("a")

        assertEquals(Decision.Ignore, ledger.adopt("b", PORTRAIT, "portrait"))
    }

    @Test
    fun `releaseAll makes every app's next layout a fresh baseline`() {
        val ledger = WindowGeometryLedger()
        ledger.adopt("a", PORTRAIT, "portrait")
        ledger.adopt("b", LANDSCAPE, "landscape")

        ledger.releaseAll()

        assertEquals(Decision.Baseline(PORTRAIT), ledger.adopt("a", PORTRAIT, "portrait"))
        assertEquals(Decision.Baseline(LANDSCAPE), ledger.adopt("b", LANDSCAPE, "landscape"))
    }

    /**
     * 账本存活跨越了 service 的重建（冷重启走 miniApp.clear + 新 service），此时旧基线是假的：不作废的话新会话的第一次布局会被判成 Report，业务代码启动瞬间收到一次凭空的 resize。
     */
    @Test
    fun `a relaunched app must not inherit the previous session's baseline`() {
        val ledger = WindowGeometryLedger()
        ledger.adopt("app", PORTRAIT, "portrait")
        ledger.adopt("app", LANDSCAPE, "landscape")

        ledger.release("app")

        assertEquals(Decision.Baseline(PORTRAIT), ledger.adopt("app", PORTRAIT, "portrait"))
    }

    /** 求值方向要读系统资源，几何没变时一次都不该问 */
    @Test
    fun `the orientation is only computed when the geometry actually changed`() {
        var calls = 0
        val orientation = { calls++; "portrait" }

        WindowGeometryGate.decide(PORTRAIT.first, PORTRAIT.second, PORTRAIT, orientation)
        WindowGeometryGate.decide(0, 0, null, orientation)
        assertEquals(0, calls)

        WindowGeometryGate.decide(LANDSCAPE.first, LANDSCAPE.second, PORTRAIT, orientation)
        assertEquals(1, calls)
    }
}
