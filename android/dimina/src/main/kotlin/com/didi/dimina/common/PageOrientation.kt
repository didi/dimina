package com.didi.dimina.common

import android.content.pm.ActivityInfo

/**
 * `pageOrientation` 配置的合法取值与平台映射，语义对齐微信小程序：`portrait` 锁竖屏、`landscape` 锁横屏、`auto` 跟随系统。
 * 这里是全仓唯一的取值校验与 Android 方向常量映射来源，避免解析（Utils.mergePageConfig）与应用（DiminaActivity 的 requestedOrientation）两处各自解释同一份取值。
 */
object PageOrientation {
    const val PORTRAIT = "portrait"
    const val AUTO = "auto"
    const val LANDSCAPE = "landscape"

    /** 页面与应用两级配置都缺失或非法时的回落值，与微信默认一致。 */
    const val DEFAULT = PORTRAIT

    private val VALID_VALUES = setOf(PORTRAIT, AUTO, LANDSCAPE)

    fun isValid(value: String?): Boolean = value != null && VALID_VALUES.contains(value)

    /**
     * 页面级配置 ??
     * 应用级配置 ?? portrait。
     * 非法值等同于没写，落到下一级继续找，不会短路成 portrait。
     */
    fun resolve(pageValue: String?, appValue: String?): String {
        if (isValid(pageValue)) return pageValue!!
        if (isValid(appValue)) return appValue!!
        return DEFAULT
    }

    /**
     * 配置值到 Android 方向常量的映射。
     *
     * `auto` 用 SCREEN_ORIENTATION_USER 而非 FULL_SENSOR：USER 跟随系统当前方向，且尊重用户关闭的系统「自动旋转」开关；`portrait`/`landscape` 是小程序的显式请求，不经传感器判断，即便用户开着旋转锁也要生效。
     *
     * `landscape` 用 SENSOR_LANDSCAPE 而非 LANDSCAPE：LANDSCAPE 只钉死一个横屏方向，用户把设备转到另一个横屏时画面不跟随、内容相对设备是倒的。
     * iOS 侧 `supportedInterfaceOrientations` 返回 `.landscape` 天然含左右两个方向，用 SENSOR_LANDSCAPE 才能让两端表现一致。
     */
    fun toRequestedOrientation(computed: String): Int = when (computed) {
        PORTRAIT -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        LANDSCAPE -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        AUTO -> ActivityInfo.SCREEN_ORIENTATION_USER
        else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }

    /**
     * 这一页上屏时，容器能不能**证明**窗口接下来一定会转——也就是 pageShow 该不该押到新几何写进 service 之后。
     *
     * 只有固定方向证得了：请求的方向轴与窗口当前的方向轴不同，窗口就一定会转，此时立刻放行会让 onShow 读到上一页的尺寸。
     * `auto` 请求的是「跟随传感器」，容器读不到设备姿态，证明不了，只能立刻放行——押后就再没有放行者。
     * 轴相同（竖屏页在竖屏窗口上）同理：窗口不会动，没有几何事件会来。
     *
     * 与 HarmonyOS 的 `DMPPageOrientation.defersPageShow` 是同一条语义，判据都是「能不能证明窗口会变」，不是「有没有发出请求」。
     */
    fun defersPageShow(computed: String, windowIsLandscape: Boolean): Boolean = when (computed) {
        PORTRAIT -> windowIsLandscape
        LANDSCAPE -> !windowIsLandscape
        else -> false
    }
}
