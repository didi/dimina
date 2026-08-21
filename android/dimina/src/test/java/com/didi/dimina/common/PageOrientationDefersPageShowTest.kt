package com.didi.dimina.common

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 判据是「容器能不能证明窗口接下来一定会转」，不是「有没有发出方向请求」。
 * 证明不了却押后 pageShow，就没有任何几何事件会来放行它。
 */
class PageOrientationDefersPageShowTest {

    @Test
    fun `a fixed page whose axis differs from the window defers`() {
        assertTrue(
            "横屏页落在竖屏窗口上：窗口一定会转，pageShow 要等新几何",
            PageOrientation.defersPageShow(PageOrientation.LANDSCAPE, windowIsLandscape = false),
        )
        assertTrue(
            "竖屏页落在横屏窗口上：同上",
            PageOrientation.defersPageShow(PageOrientation.PORTRAIT, windowIsLandscape = true),
        )
    }

    @Test
    fun `a fixed page already on its own axis does not defer`() {
        // 窗口不会动，也就不会有几何事件；押后会把 pageShow 永久扣住。
        assertFalse(
            PageOrientation.defersPageShow(PageOrientation.PORTRAIT, windowIsLandscape = false),
        )
        assertFalse(
            PageOrientation.defersPageShow(PageOrientation.LANDSCAPE, windowIsLandscape = true),
        )
    }

    @Test
    fun `an auto page never defers because the container cannot read the device pose`() {
        // auto 请求的是「跟随传感器」。
        // 容器不知道设备此刻朝哪，证明不了窗口会不会转，只能立刻放行；窗口真转过去时由随后的 resize 纠正 JS 读到的尺寸。
        assertFalse(PageOrientation.defersPageShow(PageOrientation.AUTO, windowIsLandscape = false))
        assertFalse(PageOrientation.defersPageShow(PageOrientation.AUTO, windowIsLandscape = true))
    }

    @Test
    fun `an unrecognised value never defers`() {
        // resolve 已经把非法值折成 portrait，但判据不能假设调用方一定过了那一步：认不出来就等于证明不了。
        assertFalse(PageOrientation.defersPageShow("sideways", windowIsLandscape = false))
        assertFalse(PageOrientation.defersPageShow("", windowIsLandscape = true))
    }
}
