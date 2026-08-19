package com.didi.dimina.ui.container

/**
 * 判定一次窗口几何变化该不该上报给页面。
 *
 * 宿主只上报页面**确实渲染过**的几何。
 * Configuration 与实际布局是两个会错开的事实：被上层 Activity 覆盖的页面处于 STOPPED，收不到那次转屏，返回时它先补收到那条错过的配置、随即又被改回来，而窗口自始至终没有按那条配置布局过。
 * 照着 Configuration 直接上报，页面就会收到一份它从未渲染过的尺寸。
 *
 * 判据因此是「配置算出的方向」与「窗口已经布局出的长宽关系」一致。
 * 布局与配置两个信号谁后到都会走这里判一次，所以两种到达顺序都收敛到同一次上报，不需要延时或重试。
 *
 * 去重只有一份、且只按小程序（不按页）：decorView 每跑一次布局都会来问一次，这一步把「布局了一次」收敛成「窗口真的变了」，与微信宿主只在窗口尺寸真变时调 `handleWindowResize` 是同一件事。
 * 「哪一页收到 `Page.onResize`」不在这里决定——它由上报时指名的 bridgeId 决定，路由落地时另有一次无条件上报，见 [DiminaActivity]。
 */
object WindowGeometryGate {

    sealed interface Decision {
        /** 没有可用的布局，或几何与上次被采纳的相同：什么都不做 */
        data object Ignore : Decision

        /** 配置已经翻转、窗口还没按它布局：这份几何没在屏幕上存在过，丢弃 */
        data object NotSettled : Decision

        /** 这个小程序的第一份几何，只记基线——窗口此刻刚布局出来，没有发生过尺寸变化 */
        data class Baseline(val settledSize: Pair<Int, Int>) : Decision

        data class Report(val settledSize: Pair<Int, Int>) : Decision
    }

    /**
     * 窗口是不是已经按当前配置布局出来了。
     *
     * @param laidOutWidth/[laidOutHeight] 承载页面的窗口**已经布局出来**的像素尺寸
     * @param deviceOrientation 由当前 Configuration 算出的方向，只取 portrait/landscape
     */
    fun isSettled(laidOutWidth: Int, laidOutHeight: Int, deviceOrientation: String): Boolean {
        if (laidOutWidth <= 0 || laidOutHeight <= 0) {
            return false
        }
        return (deviceOrientation == "landscape") == (laidOutWidth > laidOutHeight)
    }

    /**
     * @param laidOutWidth/[laidOutHeight] 承载页面的窗口**已经布局出来**的像素尺寸
     * @param previousAppSize 这个小程序上一次被采纳的窗口尺寸，null 表示窗口还没布局过
     * @param deviceOrientation 由当前 Configuration 算出的方向，只取 portrait/landscape。
     * 窗口每跑一次布局都会来问一次，而算这个方向要读系统资源，所以做成惰性的，只有几何真的变了才求值
     */
    fun decide(
        laidOutWidth: Int,
        laidOutHeight: Int,
        previousAppSize: Pair<Int, Int>?,
        deviceOrientation: () -> String,
    ): Decision {
        if (laidOutWidth <= 0 || laidOutHeight <= 0) {
            return Decision.Ignore
        }

        val laidOutSize = laidOutWidth to laidOutHeight
        if (previousAppSize == laidOutSize) {
            return Decision.Ignore
        }

        if (!isSettled(laidOutWidth, laidOutHeight, deviceOrientation())) {
            return Decision.NotSettled
        }

        // 窗口本身还没被采纳过任何尺寸：它布局出的第一份几何不是一次「变化」。
        // 真正的首次上报由路由落地那条无条件上报承担，service 的应用级基线也从那一条开始。
        if (previousAppSize == null) {
            return Decision.Baseline(laidOutSize)
        }

        return Decision.Report(laidOutSize)
    }
}

/**
 * The geometry baseline belongs to the mini-program window, not to an Activity.
 * Android keeps one Activity per non-tab page, so a page can return to the same local size after another Activity changed the shared service geometry.
 * Comparing per Activity would judge that unchanged.
 *
 * 基线按 appId 存，随所属小程序的运行时一起作废——见 [release]。
 */
internal class WindowGeometryLedger {
    private val appSizes = mutableMapOf<String, Pair<Int, Int>>()

    /**
     * 只判，不记。
     * 基线推进的唯一入口是 [record]——判成 Report 就记的话，这份几何要是没能送到 service（资源还没起来，`Bridge.pageResize` 直接返回 false），下一次同尺寸的布局就会被判成「没变过」，这次变化永久丢失、再也没有补发者。
     */
    @Synchronized
    fun decide(
        appId: String,
        laidOutWidth: Int,
        laidOutHeight: Int,
        deviceOrientation: () -> String,
    ): WindowGeometryGate.Decision = WindowGeometryGate.decide(
        laidOutWidth = laidOutWidth,
        laidOutHeight = laidOutHeight,
        previousAppSize = appSizes[appId],
        deviceOrientation = deviceOrientation,
    )

    /**
     * 记下一份 service 已经知道的几何，让后续同尺寸的布局回调判成 [WindowGeometryGate.Decision.Ignore]。
     * 调用方只有两种事实可以据此推进基线：这份几何真的送达了 service，或者它是窗口的第一份几何（[WindowGeometryGate.Decision.Baseline]，本就不该上报）。
     */
    @Synchronized
    fun record(appId: String, laidOutWidth: Int, laidOutHeight: Int) {
        appSizes[appId] = laidOutWidth to laidOutHeight
    }

    @Synchronized
    fun release(appId: String) {
        appSizes.remove(appId)
    }

    /** 所有小程序的运行时一起被销毁时用，语义等同于逐个 [release]。 */
    @Synchronized
    fun releaseAll() {
        appSizes.clear()
    }
}
